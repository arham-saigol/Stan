import { createHash } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import { redactForLogging } from "../logging.ts";
import type {
  ApplicationDatabase,
  AuthorizationOperation,
  XOperation,
  XOperationStatus,
} from "../storage/application-db.ts";

export interface TrustedWriteContext {
  sourceMessageId: string;
  selectedAccountId: string;
}

export type ZernioMutationRequest =
  | { operation: "draft"; content: string }
  | { operation: "publish"; content: string }
  | { operation: "schedule"; content: string; scheduledFor: string }
  | { operation: "reply"; content: string; replyToPostId: string }
  | { operation: "edit"; providerPostId: string; content: string }
  | { operation: "cancel"; providerPostId: string }
  | { operation: "delete"; providerPostId: string };

export interface ProviderMutationResult {
  status:
    | "draft"
    | "scheduled"
    | "publishing"
    | "published"
    | "partial"
    | "failed"
    | "cancelled";
  providerId?: string;
  publicId?: string;
  publicUrl?: string;
  scheduledFor?: string;
  error?: string;
}

export interface ZernioMutationProvider {
  verifyPostAccount?(postId: string, accountId: string): Promise<boolean>;
  resolveProviderPostId?(postId: string, accountId: string): Promise<string>;
  mutate(input: {
    requestId: string;
    accountId: string;
    request: ZernioMutationRequest;
  }): Promise<ProviderMutationResult>;
}

export class ZernioWriteService {
  constructor(
    private readonly database: ApplicationDatabase,
    private readonly provider: ZernioMutationProvider,
  ) {}

  async execute(
    context: TrustedWriteContext,
    request: ZernioMutationRequest,
  ): Promise<XOperation> {
    const envelope = this.database.getAuthorizationForSource(
      context.sourceMessageId,
    );
    if (!envelope) {
      throw new Error(
        "Current owner authorization is required for public X mutations",
      );
    }
    const targetPostId =
      "providerPostId" in request
        ? request.providerPostId
        : request.operation === "reply"
          ? request.replyToPostId
          : undefined;
    if (
      ("providerPostId" in request || request.operation === "reply") &&
      !targetPostId?.trim()
    )
      throw new Error("A target X post ID is required");
    const content = getContent(request);
    const scheduledFor =
      request.operation === "schedule"
        ? normalizeScheduledFor(request.scheduledFor)
        : undefined;
    const payloadHash = hashPayload({
      accountId: context.selectedAccountId,
      request,
    });
    const begin = () =>
      this.database.beginXOperation({
        envelopeId: envelope.id,
        sourceMessageId: context.sourceMessageId,
        operation: request.operation as AuthorizationOperation,
        payloadHash,
        accountId: context.selectedAccountId,
        requestJson: stableJson(request),
        ...(targetPostId ? { targetPostId } : {}),
        ...(content ? { content } : {}),
        ...(scheduledFor ? { scheduledFor } : {}),
      });
    const existing = this.database.getXOperationByEnvelope(envelope.id);
    let recovered: XOperation | undefined;
    if (existing) {
      recovered = begin();
      if (isTerminal(recovered.status)) return recovered;
      if (
        recovered.providerId &&
        recovered.error !== "Provider call has not completed"
      ) {
        trackProviderPoll(this.database, recovered, new Date());
        return recovered;
      }
      if (recovered.nextRetryAt || isRetryableCreate(recovered.operation)) {
        if (!recovered.nextRetryAt) {
          const recoveredAt = new Date().toISOString();
          this.database.database
            .prepare(
              "UPDATE x_operations SET next_retry_at = ?, updated_at = ? WHERE logical_id = ?",
            )
            .run(recoveredAt, recoveredAt, recovered.logicalId);
          recovered = this.database.getXOperation(recovered.logicalId)!;
        }
        return recovered;
      }
    }
    let resolvedTargetPostId = recovered?.providerId ?? targetPostId;
    if ("providerPostId" in request && targetPostId && !recovered?.providerId) {
      if (this.provider.resolveProviderPostId) {
        resolvedTargetPostId = await this.provider.resolveProviderPostId(
          targetPostId,
          context.selectedAccountId,
        );
      } else {
        if (!this.provider.verifyPostAccount) {
          throw new Error(
            "The Zernio account boundary cannot verify this post",
          );
        }
        if (
          !(await this.provider.verifyPostAccount(
            targetPostId,
            context.selectedAccountId,
          ))
        ) {
          throw new Error(
            "The target post does not belong to the configured X account",
          );
        }
      }
    }
    if (
      request.operation === "schedule" &&
      Date.parse(scheduledFor!) <= Date.now() + 60_000
    ) {
      throw new Error(
        "A scheduled X post must be at least one minute in the future",
      );
    }
    let operation = begin();
    if (isTerminal(operation.status)) return operation;
    if (
      !isRetryableCreate(request.operation) &&
      resolvedTargetPostId &&
      !operation.providerId
    ) {
      operation = this.database.updateXOperation(operation.logicalId, {
        status: "publishing",
        providerId: resolvedTargetPostId,
        error: "Provider call has not completed",
      });
      trackProviderPoll(this.database, operation, new Date());
    }

    try {
      const providerRequest =
        "providerPostId" in request && resolvedTargetPostId
          ? { ...request, providerPostId: resolvedTargetPostId }
          : request;
      const result = await this.provider.mutate({
        requestId: operation.requestId,
        accountId: context.selectedAccountId,
        request: providerRequest,
      });
      const unverifiableSchedule =
        request.operation === "schedule" &&
        result.providerId !== undefined &&
        (result.scheduledFor === undefined ||
          !sameScheduledInstant(result.scheduledFor, scheduledFor!));
      let driftCancelled = false;
      if (unverifiableSchedule && result.providerId) {
        try {
          const cancellation = await this.provider.mutate({
            requestId: `schedule-drift:${operation.logicalId}`,
            accountId: context.selectedAccountId,
            request: {
              operation: "cancel",
              providerPostId: result.providerId,
            },
          });
          driftCancelled = cancellation.status === "cancelled";
        } catch {
          // Persist and reconcile until cancellation can be verified.
        }
      }
      const status = unverifiableSchedule
        ? driftCancelled
          ? "partial"
          : "publishing"
        : verifiedStatus(request.operation, result);
      const updated = this.database.updateXOperation(operation.logicalId, {
        status,
        ...(result.providerId === undefined
          ? {}
          : { providerId: result.providerId }),
        ...(result.publicId === undefined ? {} : { publicId: result.publicId }),
        ...(result.publicUrl === undefined
          ? {}
          : { publicUrl: result.publicUrl }),
        ...(result.scheduledFor === undefined
          ? {}
          : { scheduledFor: result.scheduledFor }),
        error: unverifiableSchedule
          ? driftCancelled
            ? "Zernio did not verify the exact owner-authorized instant; the unsafe schedule was cancelled"
            : "Zernio did not verify the exact owner-authorized instant; cancellation is not yet verified"
          : (result.error ?? null),
      });
      if (
        updated.status === "cancelled" &&
        updated.providerId &&
        (request.operation === "cancel" || request.operation === "delete")
      ) {
        this.database.database
          .prepare(
            "UPDATE x_operations SET status = 'cancelled', updated_at = ? WHERE provider_id = ?",
          )
          .run(new Date().toISOString(), updated.providerId);
        this.database.database
          .prepare("DELETE FROM scheduled_publications WHERE provider_id = ?")
          .run(updated.providerId);
      }
      if (
        isRetryableCreate(request.operation) &&
        (updated.status === "scheduled" ||
          updated.status === "publishing" ||
          updated.status === "partial") &&
        updated.providerId
      ) {
        trackProviderPoll(this.database, updated, new Date());
      } else if (
        (updated.status === "publishing" || updated.status === "partial") &&
        isRetryableCreate(request.operation) &&
        !updated.providerId
      ) {
        return this.database.scheduleXOperationRetry(
          updated.logicalId,
          result.error ??
            "Zernio accepted the request but returned no provider post ID",
        );
      } else if (
        (updated.status === "publishing" ||
          (request.operation === "edit" && updated.status === "partial")) &&
        !isRetryableCreate(request.operation) &&
        resolvedTargetPostId
      ) {
        const pollable = this.database.updateXOperation(updated.logicalId, {
          status: "publishing",
          providerId: updated.providerId ?? resolvedTargetPostId,
          error: updated.error,
        });
        trackProviderPoll(this.database, pollable, new Date());
        return pollable;
      }
      return updated;
    } catch (error) {
      if (
        recovered &&
        (request.operation === "cancel" || request.operation === "delete") &&
        isNotFound(error)
      ) {
        return this.database.updateXOperation(operation.logicalId, {
          status: "cancelled",
          ...(resolvedTargetPostId ? { providerId: resolvedTargetPostId } : {}),
          error: null,
        });
      }
      const status = isDefinitiveProviderFailure(error)
        ? "failed"
        : "publishing";
      const message =
        status === "publishing"
          ? `Provider outcome unknown: ${safeError(error)}`
          : safeError(error);
      if (status === "publishing" && isRetryableCreate(request.operation)) {
        return this.database.scheduleXOperationRetry(
          operation.logicalId,
          message,
        );
      }
      const updated = this.database.updateXOperation(operation.logicalId, {
        status,
        ...(status === "publishing" && resolvedTargetPostId
          ? { providerId: resolvedTargetPostId }
          : {}),
        error: message,
      });
      if (status === "publishing" && resolvedTargetPostId)
        trackProviderPoll(this.database, updated, new Date());
      return updated;
    }
  }
}

function sameScheduledInstant(value: string, expected: string): boolean {
  try {
    return (
      Temporal.Instant.compare(
        Temporal.Instant.from(value),
        Temporal.Instant.from(expected),
      ) === 0
    );
  } catch {
    return false;
  }
}

function normalizeScheduledFor(value: string): string {
  try {
    Temporal.Instant.from(value);
  } catch {
    throw new Error("A scheduled X post must use a valid ISO timestamp");
  }
  return new Date(value).toISOString();
}

export function verifiedStatus(
  operation: ZernioMutationRequest["operation"],
  result: ProviderMutationResult,
): XOperationStatus {
  if (operation === "draft" && result.status === "draft" && !result.providerId)
    return "publishing";
  if (result.status === "published" && (!result.publicId || !result.publicUrl))
    return "partial";
  if (
    result.status === "scheduled" &&
    (!result.providerId || !result.scheduledFor)
  )
    return "partial";
  if (
    result.status === "failed" ||
    result.status === "partial" ||
    result.status === "publishing"
  ) {
    return result.status;
  }
  const matches =
    (operation === "draft" && result.status === "draft") ||
    (operation === "schedule" && result.status === "scheduled") ||
    ((operation === "publish" ||
      operation === "reply" ||
      operation === "edit") &&
      result.status === "published") ||
    ((operation === "cancel" || operation === "delete") &&
      result.status === "cancelled");
  return matches ? result.status : "partial";
}

function isTerminal(status: XOperationStatus): boolean {
  return status !== "publishing";
}

function isRetryableCreate(
  operation: ZernioMutationRequest["operation"],
): boolean {
  return (
    operation === "draft" ||
    operation === "publish" ||
    operation === "schedule" ||
    operation === "reply"
  );
}

function hashPayload(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("status" in error && error.status === 404) return true;
  if ("statusCode" in error && error.statusCode === 404) return true;
  return (
    "response" in error &&
    Boolean(
      error.response &&
      typeof error.response === "object" &&
      "status" in error.response &&
      error.response.status === 404,
    )
  );
}

function isDefinitiveProviderFailure(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("statusCode" in error))
    return false;
  const statusCode = error.statusCode;
  return (
    typeof statusCode === "number" &&
    statusCode >= 400 &&
    statusCode < 500 &&
    statusCode !== 408 &&
    statusCode !== 409 &&
    statusCode !== 429
  );
}

function getContent(request: ZernioMutationRequest): string | undefined {
  return "content" in request ? request.content : undefined;
}

export function trackProviderPoll(
  database: ApplicationDatabase,
  operation: XOperation,
  now: Date,
  preserveRetry = false,
): void {
  database.database
    .prepare(
      `INSERT INTO scheduled_publications(logical_operation_id, provider_id, next_poll_at, last_status)
       VALUES (?, ?, ?, ?) ON CONFLICT(logical_operation_id) DO UPDATE SET
       provider_id = excluded.provider_id, next_poll_at = excluded.next_poll_at,
       last_status = excluded.last_status, poll_count = 0,
       notification_message = NULL, notification_attempts = 0`,
    )
    .run(
      operation.logicalId,
      operation.providerId,
      operation.status === "scheduled"
        ? firstSchedulePoll(operation.scheduledFor, now)
        : new Date(now.getTime() + 60_000).toISOString(),
      operation.status,
    );
  if (!preserveRetry) {
    database.database
      .prepare(
        "UPDATE x_operations SET next_retry_at = NULL WHERE logical_id = ?",
      )
      .run(operation.logicalId);
  }
}

export function firstSchedulePoll(
  scheduledFor: string | null,
  now: Date,
): string {
  const scheduled = scheduledFor ? Date.parse(scheduledFor) : Number.NaN;
  return new Date(
    Math.max(
      now.getTime() + 60_000,
      Number.isFinite(scheduled) ? scheduled + 60_000 : 0,
    ),
  ).toISOString();
}

function safeError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message.slice(0, 500)
      : "Unknown Zernio error";
  return String(redactForLogging(message));
}
