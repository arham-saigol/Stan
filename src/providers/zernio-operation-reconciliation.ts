import { Temporal } from "@js-temporal/polyfill";
import type { DeliveryService } from "../gateway/delivery.ts";
import { redactForLogging } from "../logging.ts";
import type {
  ApplicationDatabase,
  XOperation,
} from "../storage/application-db.ts";
import {
  trackProviderPoll,
  verifiedStatus,
  type ProviderMutationResult,
  type ZernioMutationProvider,
  type ZernioMutationRequest,
} from "./zernio-write-service.ts";

export async function reconcilePendingXOperations(
  database: ApplicationDatabase,
  provider: ZernioMutationProvider,
  delivery: DeliveryService | undefined,
  now = new Date(),
): Promise<number> {
  const rows = database.database
    .prepare(
      `SELECT logical_id FROM x_operations
       WHERE next_retry_at IS NOT NULL AND next_retry_at <= ?
       ORDER BY next_retry_at LIMIT 5`,
    )
    .all(now.toISOString()) as { logical_id: string }[];
  for (const row of rows) {
    const operation = database.getXOperation(row.logical_id);
    if (!operation) continue;
    if (operation.notificationMessage) {
      await deliverQueuedResult(database, delivery, operation, now);
      continue;
    }
    if (operation.status !== "publishing") {
      await deliverTerminalResult(database, delivery, operation, now);
      continue;
    }
    if (operation.retryCount >= 3) {
      await deliverUnknownResult(database, delivery, operation, now);
      continue;
    }
    if (now.getTime() - Date.parse(operation.createdAt) >= 5 * 60_000) {
      database.database
        .prepare(
          `UPDATE x_operations SET retry_count = 3, next_retry_at = ?,
           error = 'Provider create deduplication window expired before reconciliation', updated_at = ?
           WHERE logical_id = ?`,
        )
        .run(now.toISOString(), now.toISOString(), operation.logicalId);
      await deliverUnknownResult(
        database,
        delivery,
        database.getXOperation(operation.logicalId)!,
        now,
      );
      continue;
    }
    let request: ZernioMutationRequest;
    let result: ProviderMutationResult;
    try {
      request = parseRequest(operation.requestJson);
      result = await provider.mutate({
        requestId: operation.requestId,
        accountId: operation.accountId,
        request,
      });
    } catch (error) {
      const updated = database.scheduleXOperationRetry(
        operation.logicalId,
        `Provider outcome remains unknown: ${safeError(error)}`,
        now,
      );
      if (!updated.nextRetryAt) {
        await queueAndDeliverUnknownResult(database, delivery, updated, now);
      }
      continue;
    }
    const scheduleDrift =
      request.operation === "schedule" &&
      result.providerId !== undefined &&
      (result.scheduledFor === undefined ||
        !sameInstant(result.scheduledFor, request.scheduledFor));
    let driftCancelled = false;
    if (scheduleDrift && result.providerId) {
      try {
        const cancellation = await provider.mutate({
          requestId: `schedule-drift:${operation.logicalId}`,
          accountId: operation.accountId,
          request: {
            operation: "cancel",
            providerPostId: result.providerId,
          },
        });
        driftCancelled = cancellation.status === "cancelled";
      } catch {
        // Persist and poll until cancellation can be verified.
      }
    }
    let updated = database.transaction(() => {
      let applied = applyResult(database, operation, request, result);
      if (scheduleDrift && driftCancelled) {
        applied = database.updateXOperation(applied.logicalId, {
          status: "partial",
          error:
            "Zernio returned a schedule outside the exact owner-authorized instant; the unauthorized schedule was cancelled",
        });
      }
      if (applied.status !== "publishing") {
        database.database
          .prepare(
            "UPDATE x_operations SET next_retry_at = ? WHERE logical_id = ?",
          )
          .run(now.toISOString(), applied.logicalId);
      }
      return applied;
    });
    if (
      (updated.status === "publishing" ||
        updated.status === "scheduled" ||
        updated.status === "partial") &&
      updated.providerId
    ) {
      trackProviderPoll(database, updated, now, updated.status === "scheduled");
      if (updated.status === "scheduled") {
        await deliverTerminalResult(database, delivery, updated, now);
      }
      continue;
    }
    if (
      (updated.status === "publishing" || updated.status === "partial") &&
      !updated.providerId
    ) {
      updated = database.scheduleXOperationRetry(
        operation.logicalId,
        result.error ??
          "Zernio still reports the operation as publishing without a provider post ID",
        now,
      );
      if (!updated.nextRetryAt) {
        await queueAndDeliverUnknownResult(database, delivery, updated, now);
      }
      continue;
    }
    await deliverTerminalResult(database, delivery, updated, now);
  }
  return rows.length;
}

async function queueAndDeliverUnknownResult(
  database: ApplicationDatabase,
  delivery: DeliveryService | undefined,
  operation: XOperation,
  now: Date,
): Promise<void> {
  database.database
    .prepare("UPDATE x_operations SET next_retry_at = ? WHERE logical_id = ?")
    .run(now.toISOString(), operation.logicalId);
  await deliverUnknownResult(database, delivery, operation, now);
}

async function deliverUnknownResult(
  database: ApplicationDatabase,
  delivery: DeliveryService | undefined,
  operation: XOperation,
  now: Date,
): Promise<void> {
  const message = operation.error?.includes("deduplication window expired")
    ? `I did not retry the uncertain X ${operation.operation} because Zernio's create-deduplication window had expired. Its outcome is still unknown; check Zernio/X before trying it again.`
    : `I could not verify the ${operation.operation} request after bounded retries. Its outcome is still unknown; check Zernio/X before trying it again.`;
  await queueAndDeliverResult(database, delivery, operation, message, now);
}

async function deliverTerminalResult(
  database: ApplicationDatabase,
  delivery: DeliveryService | undefined,
  operation: XOperation,
  now: Date,
): Promise<void> {
  await queueAndDeliverResult(
    database,
    delivery,
    operation,
    renderResult(operation),
    now,
  );
}

async function queueAndDeliverResult(
  database: ApplicationDatabase,
  delivery: DeliveryService | undefined,
  operation: XOperation,
  message: string,
  now: Date,
): Promise<void> {
  database.database
    .prepare(
      `UPDATE x_operations SET notification_message = ?, notification_attempts = 0,
       next_retry_at = ?, updated_at = ? WHERE logical_id = ?`,
    )
    .run(message, now.toISOString(), now.toISOString(), operation.logicalId);
  await deliverQueuedResult(
    database,
    delivery,
    { ...operation, notificationMessage: message, notificationAttempts: 0 },
    now,
  );
}

async function deliverQueuedResult(
  database: ApplicationDatabase,
  delivery: DeliveryService | undefined,
  operation: XOperation,
  now: Date,
): Promise<void> {
  if (!delivery) return;
  try {
    await delivery.sendOwner(
      operation.notificationMessage!,
      `x-operation:${operation.logicalId}:${operation.status === "publishing" ? "unknown" : operation.status}`,
    );
    database.database
      .prepare(
        `UPDATE x_operations SET next_retry_at = NULL, notification_message = NULL,
         notification_attempts = 0 WHERE logical_id = ?`,
      )
      .run(operation.logicalId);
  } catch {
    const attempts = operation.notificationAttempts + 1;
    database.database
      .prepare(
        `UPDATE x_operations SET notification_attempts = ?, next_retry_at = ?, updated_at = ?
         WHERE logical_id = ?`,
      )
      .run(
        attempts,
        attempts >= 3
          ? null
          : new Date(
              now.getTime() + 60_000 * 2 ** (attempts - 1),
            ).toISOString(),
        now.toISOString(),
        operation.logicalId,
      );
  }
}

function applyResult(
  database: ApplicationDatabase,
  operation: XOperation,
  request: ZernioMutationRequest,
  result: ProviderMutationResult,
): XOperation {
  const scheduleDrift =
    request.operation === "schedule" &&
    result.providerId !== undefined &&
    (result.scheduledFor === undefined ||
      !sameInstant(result.scheduledFor, request.scheduledFor));
  return database.updateXOperation(operation.logicalId, {
    status: scheduleDrift
      ? "partial"
      : verifiedStatus(request.operation, result),
    ...(result.providerId ? { providerId: result.providerId } : {}),
    ...(result.publicId ? { publicId: result.publicId } : {}),
    ...(result.publicUrl ? { publicUrl: result.publicUrl } : {}),
    ...(result.scheduledFor ? { scheduledFor: result.scheduledFor } : {}),
    error: scheduleDrift
      ? "Zernio returned a schedule outside the exact owner-authorized instant"
      : (result.error ?? null),
  });
}

function sameInstant(value: string, expected: string): boolean {
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

function parseRequest(value: string): ZernioMutationRequest {
  const parsed = JSON.parse(value) as ZernioMutationRequest;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof parsed.operation !== "string"
  ) {
    throw new Error("Stored Zernio request is invalid");
  }
  return parsed;
}

function renderResult(operation: XOperation): string {
  if (operation.status === "published") {
    return `The previously uncertain X ${operation.operation} is now verified as published${operation.publicUrl ? `: ${operation.publicUrl}` : "."}`;
  }
  if (operation.status === "scheduled") {
    return `The previously uncertain X request is now verified as scheduled for ${operation.scheduledFor}.`;
  }
  if (operation.status === "cancelled") {
    return `The previously uncertain X ${operation.operation} is now verified as cancelled/deleted.`;
  }
  return `The previously uncertain X ${operation.operation} resolved with status ${operation.status}${operation.error ? `: ${operation.error}` : "."}`;
}

function safeError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message.slice(0, 500)
      : "Unknown Zernio error";
  return String(redactForLogging(message));
}
