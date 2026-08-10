import { dailySessionId } from "../scheduler/rollover.ts";
import type { DeliveryService } from "./delivery.ts";
import {
  type ApplicationDatabase,
  normalizeJid,
} from "../storage/application-db.ts";
import { deriveAuthorizationOperation } from "./owner-authorization.ts";

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
    metadata: {
      sourceMessageId: string;
      authorizationEnvelopeId?: string;
      quotedText?: string;
    };
  }): Promise<string>;
}

export interface OwnerSend {
  (text: string, sourceMessageId: string): Promise<{ messageId: string }>;
}

export class OwnerIngress {
  private readonly database: ApplicationDatabase;
  private readonly dispatch: OwnerDispatch;
  private readonly send: OwnerSend;

  constructor(input: {
    database: ApplicationDatabase;
    ownerPhone: string;
    dispatch: OwnerDispatch;
    send: OwnerSend;
  }) {
    this.database = input.database;
    this.dispatch = input.dispatch;
    this.send = input.send;
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
    const claimed = this.database.claimInbound({
      id: message.id,
      senderIdentity: ownerIdentity,
      body: message.text,
      ...(message.quotedText === undefined
        ? {}
        : { quotedText: message.quotedText }),
      receivedAt: message.receivedAt,
    });
    if (!claimed) return { status: "duplicate" };

    try {
      const operation = deriveAuthorizationOperation(message.text);
      const envelope = operation
        ? this.database.createAuthorization({
            sourceMessageId: message.id,
            operation,
            ...(message.quotedText === undefined
              ? {}
              : { quotedText: message.quotedText }),
          })
        : undefined;
      const sessionId = dailySessionId(message.receivedAt);
      this.database.setInboundState(message.id, "dispatched", { sessionId });
      const response = await this.dispatch({
        sessionId,
        body: message.text,
        metadata: {
          sourceMessageId: message.id,
          ...(envelope ? { authorizationEnvelopeId: envelope.id } : {}),
          ...(message.quotedText === undefined
            ? {}
            : { quotedText: message.quotedText }),
        },
      });
      this.database.setInboundState(message.id, "reply_pending", {
        responseText: response,
      });
      const outbound = await this.send(response, message.id);
      this.database.setInboundState(message.id, "delivered", {
        outboundMessageId: outbound.messageId,
      });
      return { status: "delivered" };
    } catch (error) {
      this.database.setInboundState(message.id, "failed", {
        error: safeError(error),
      });
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
): Promise<number> {
  const rows = database.database
    .prepare(
      `SELECT provider_message_id, response_text FROM inbound_messages
       WHERE state IN ('reply_pending', 'failed', 'unknown')
         AND response_text IS NOT NULL AND outbound_message_id IS NULL
       ORDER BY received_at LIMIT 5`,
    )
    .all() as { provider_message_id: string; response_text: string }[];
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
      database.setInboundState(row.provider_message_id, "failed", {
        error: safeError(error),
      });
    }
  }
  return rows.length;
}

function safeError(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 500)
    : "Unknown ingress failure";
}
