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
  delivery: DeliveryService,
  now = new Date(),
): Promise<number> {
  const rows = database.database
    .prepare(
      `SELECT logical_id FROM x_operations
       WHERE status = 'publishing' AND next_retry_at IS NOT NULL AND next_retry_at <= ?
       ORDER BY next_retry_at LIMIT 5`,
    )
    .all(now.toISOString()) as { logical_id: string }[];
  for (const row of rows) {
    const operation = database.getXOperation(row.logical_id);
    if (!operation) continue;
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
        await delivery.sendOwner(
          `I could not verify the ${updated.operation} request after bounded retries. Its outcome is still unknown; check Zernio/X before trying it again.`,
          `x-operation:${updated.logicalId}:unknown`,
        );
      }
      continue;
    }
    let updated = applyResult(database, operation, request, result);
    if (
      (updated.status === "publishing" || updated.status === "scheduled") &&
      updated.providerId
    ) {
      trackProviderPoll(database, updated, now);
      if (updated.status === "scheduled") {
        await delivery.sendOwner(
          renderResult(updated),
          `x-operation:${updated.logicalId}:scheduled`,
        );
      }
      continue;
    }
    if (updated.status === "publishing") {
      updated = database.scheduleXOperationRetry(
        operation.logicalId,
        result.error ??
          "Zernio still reports the operation as publishing without a provider post ID",
        now,
      );
      if (!updated.nextRetryAt) {
        await delivery.sendOwner(
          `I could not verify the ${updated.operation} request after bounded retries. Its outcome is still unknown; check Zernio/X before trying it again.`,
          `x-operation:${updated.logicalId}:unknown`,
        );
      }
      continue;
    }
    await delivery.sendOwner(
      renderResult(updated),
      `x-operation:${updated.logicalId}:${updated.status}`,
    );
  }
  return rows.length;
}

function applyResult(
  database: ApplicationDatabase,
  operation: XOperation,
  request: ZernioMutationRequest,
  result: ProviderMutationResult,
): XOperation {
  return database.updateXOperation(operation.logicalId, {
    status: verifiedStatus(request.operation, result),
    ...(result.providerId ? { providerId: result.providerId } : {}),
    ...(result.publicId ? { publicId: result.publicId } : {}),
    ...(result.publicUrl ? { publicUrl: result.publicUrl } : {}),
    ...(result.scheduledFor ? { scheduledFor: result.scheduledFor } : {}),
    error: result.error ?? null,
  });
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
