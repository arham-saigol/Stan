import { dailySessionId, pakistanRoutingDate } from "../scheduler/rollover.ts";
import type { DeliveryService } from "./delivery.ts";
import {
  type ApplicationDatabase,
  normalizeJid,
} from "../storage/application-db.ts";
import {
  deriveAuthorization,
  deriveAutomationAuthorization,
  deriveMemoryAuthorization,
  deriveHeartbeatSettingsAuthorization,
  deriveWorkspaceAuthorization,
} from "./owner-authorization.ts";

export interface InboundMessage {
  id: string;
  type: "notify" | "append";
  remoteJid: string;
  remoteJidAlt?: string;
  participant?: string;
  fromMe: boolean;
  text: string;
  quotedText?: string;
  receivedAt: string;
}

export interface OwnerDispatch {
  (delivery: {
    sessionId: string;
    body: string;
    idempotencyKey: string;
    metadata: {
      sourceMessageId: string;
      quotedText?: string;
    };
  }): Promise<string>;
}

export interface OwnerRead {
  (sessionId: string, submissionId: string): Promise<string>;
}

export interface OwnerSend {
  (text: string, sourceMessageId: string): Promise<{ messageId: string }>;
}

export class OwnerIngress {
  private readonly database: ApplicationDatabase;
  private readonly dispatch: OwnerDispatch;
  private readonly read: OwnerRead;
  private readonly send: OwnerSend;
  private readonly now: () => Date;
  private readonly processing = new Set<string>();
  private turnQueue: Promise<void> = Promise.resolve();

  constructor(input: {
    database: ApplicationDatabase;
    ownerPhone: string;
    dispatch: OwnerDispatch;
    read: OwnerRead;
    send: OwnerSend;
    now?: () => Date;
  }) {
    this.database = input.database;
    this.dispatch = input.dispatch;
    this.read = input.read;
    this.send = input.send;
    this.now = input.now ?? (() => new Date());
    this.database.configureOwnerIdentity(
      `${input.ownerPhone.slice(1)}@s.whatsapp.net`,
    );
  }

  async handle(
    message: InboundMessage,
  ): Promise<{ status: "ignored" | "duplicate" | "delivered" | "failed" }> {
    if (!this.acceptsTraffic(message)) return { status: "ignored" };
    const identities = [message.remoteJid, message.remoteJidAlt].filter(
      (identity): identity is string => Boolean(identity),
    );
    const ownerIdentity = identities.find((identity) =>
      this.database.isOwnerIdentity(identity),
    );
    if (!ownerIdentity) return { status: "ignored" };
    for (const identity of identities) {
      if (isDirectIdentity(identity))
        this.database.bindOwnerIdentity(
          identity,
          identity.endsWith("@lid") ? "lid" : "pn",
        );
    }
    if (!message.text.trim()) return { status: "ignored" };
    const admittedAt = this.now();
    const claimed = this.database.claimInbound({
      id: message.id,
      senderIdentity: ownerIdentity,
      body: message.text,
      ...(message.quotedText === undefined
        ? {}
        : { quotedText: message.quotedText }),
      receivedAt: message.receivedAt,
      admittedAt: admittedAt.toISOString(),
    });
    if (!claimed) return { status: "duplicate" };

    return this.enqueueProcess(message, undefined, undefined, admittedAt);
  }

  async reconcilePending(limit = 5, now = new Date()): Promise<number> {
    const rows = this.database.database
      .prepare(
        `SELECT provider_message_id, sender_identity, body, quoted_text, received_at, admitted_at, session_id, flue_submission_id
         FROM inbound_messages
         WHERE state IN ('claimed', 'dispatched', 'failed', 'unknown') AND response_text IS NULL
           AND recovery_attempts < 3 AND (next_retry_at IS NULL OR next_retry_at <= ?)
         ORDER BY received_at LIMIT ?`,
      )
      .all(now.toISOString(), limit) as {
      provider_message_id: string;
      sender_identity: string;
      body: string;
      quoted_text: string | null;
      received_at: string;
      admitted_at: string;
      session_id: string | null;
      flue_submission_id: string | null;
    }[];
    let processed = 0;
    for (const row of rows) {
      if (this.processing.has(row.provider_message_id)) continue;
      if (!this.database.isOwnerIdentity(row.sender_identity)) {
        this.database.rejectFormerOwnerInbound(row.provider_message_id, now);
        processed += 1;
        continue;
      }
      await this.enqueueProcess(
        {
          id: row.provider_message_id,
          type: "notify",
          remoteJid: row.sender_identity,
          fromMe: false,
          text: row.body,
          ...(row.quoted_text === null ? {} : { quotedText: row.quoted_text }),
          receivedAt: row.received_at,
        },
        row.session_id ?? undefined,
        row.flue_submission_id ?? undefined,
        new Date(row.admitted_at),
      );
      processed += 1;
    }
    return processed;
  }

  private enqueueProcess(
    message: InboundMessage,
    persistedSessionId?: string,
    persistedSubmissionId?: string,
    now = new Date(),
  ): Promise<{ status: "delivered" | "failed" }> {
    this.processing.add(message.id);
    return this.enqueue(() =>
      this.process(message, persistedSessionId, persistedSubmissionId, now),
    ).finally(() => this.processing.delete(message.id));
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.turnQueue.then(task, task);
    this.turnQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async process(
    message: InboundMessage,
    persistedSessionId?: string,
    persistedSubmissionId?: string,
    now = new Date(),
  ): Promise<{ status: "delivered" | "failed" }> {
    try {
      if (!this.database.getAuthorizationForSource(message.id)) {
        const authorization = deriveAuthorization(
          message.text,
          message.quotedText,
        );
        if (authorization) {
          this.database.createAuthorization({
            sourceMessageId: message.id,
            operation: authorization.operation,
            now,
            ...(authorization.targetPostId
              ? { targetPostId: authorization.targetPostId }
              : {}),
            ...(authorization.authorizedContent
              ? { authorizedContent: authorization.authorizedContent }
              : {}),
            ...(authorization.authorizedScheduledFor
              ? {
                  authorizedScheduledFor: authorization.authorizedScheduledFor,
                }
              : {}),
            ...(message.quotedText === undefined
              ? {}
              : { quotedText: message.quotedText }),
          });
        }
      }
      const automationOperation = deriveAutomationAuthorization(message.text);
      if (automationOperation) {
        this.database.createAutomationAuthorization(
          message.id,
          automationOperation.operation,
          automationOperation.payloadJson,
          now,
        );
      }
      const workspaceAuthorization = deriveWorkspaceAuthorization(message.text);
      if (workspaceAuthorization) {
        this.database.createWorkspaceAuthorization(
          message.id,
          workspaceAuthorization.payloadJson,
          now,
        );
      }
      const memoryAuthorization = deriveMemoryAuthorization(message.text);
      if (memoryAuthorization) {
        this.database.createMemoryAuthorization(
          message.id,
          memoryAuthorization.operation,
          memoryAuthorization.payloadJson,
          now,
        );
      }
      const heartbeatAuthorization = deriveHeartbeatSettingsAuthorization(
        message.text,
      );
      if (heartbeatAuthorization) {
        this.database.createHeartbeatSettingsAuthorization(
          message.id,
          heartbeatAuthorization.payloadJson,
          now,
        );
      }
      const sessionId =
        persistedSessionId ?? dailySessionId(message.receivedAt);
      this.database.database
        .prepare(
          `INSERT INTO daily_sessions(local_date, conversation_id, state, created_at)
           VALUES (?, ?, 'active', ?) ON CONFLICT(local_date) DO UPDATE SET
           state = 'active', closed_at = NULL, transcript_complete = 0`,
        )
        .run(
          pakistanRoutingDate(message.receivedAt),
          sessionId,
          message.receivedAt,
        );
      this.database.setInboundState(message.id, "dispatched", { sessionId });
      const submissionId =
        persistedSubmissionId ??
        (await this.dispatch({
          sessionId,
          body: message.text,
          idempotencyKey: `whatsapp:${message.id}`,
          metadata: {
            sourceMessageId: message.id,
            ...(message.quotedText === undefined
              ? {}
              : { quotedText: message.quotedText }),
          },
        }));
      this.database.setInboundState(message.id, "dispatched", {
        flueSubmissionId: submissionId,
      });
      const response = await this.read(sessionId, submissionId);
      this.database.setInboundState(message.id, "reply_pending", {
        responseText: response,
      });
      const outbound = await this.send(response, message.id);
      this.database.setInboundState(message.id, "delivered", {
        outboundMessageId: outbound.messageId,
      });
      return { status: "delivered" };
    } catch (error) {
      this.database.recordInboundFailure(message.id, safeError(error), now);
      return { status: "failed" };
    }
  }

  private acceptsTraffic(message: InboundMessage): boolean {
    if (message.type !== "notify" || message.fromMe) return false;
    const jid = normalizeJid(message.remoteJid);
    return isDirectIdentity(jid);
  }
}

function isDirectIdentity(identity: string): boolean {
  const jid = normalizeJid(identity);
  return jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid");
}

export async function reconcilePendingReplies(
  database: ApplicationDatabase,
  delivery: DeliveryService,
  now = new Date(),
): Promise<number> {
  const rows = database.database
    .prepare(
      `SELECT provider_message_id, response_text FROM inbound_messages
       WHERE state IN ('reply_pending', 'failed', 'unknown')
         AND response_text IS NOT NULL AND outbound_message_id IS NULL
         AND recovery_attempts < 3 AND (next_retry_at IS NULL OR next_retry_at <= ?)
       ORDER BY received_at LIMIT 5`,
    )
    .all(now.toISOString()) as {
    provider_message_id: string;
    response_text: string;
  }[];
  for (const row of rows) {
    try {
      const outbound = await delivery.sendOwner(
        row.response_text,
        `owner-reply:${row.provider_message_id}`,
      );
      database.setInboundState(row.provider_message_id, "delivered", {
        outboundMessageId: outbound.messageId,
      });
    } catch (error) {
      database.recordInboundFailure(
        row.provider_message_id,
        safeError(error),
        now,
      );
    }
  }
  return rows.length;
}

function safeError(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 500)
    : "Unknown ingress failure";
}
