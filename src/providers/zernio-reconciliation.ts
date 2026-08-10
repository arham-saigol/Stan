import type { Post } from "@zernio/node";
import type { DeliveryService } from "../gateway/delivery.ts";
import { redactForLogging } from "../logging.ts";
import type {
  ApplicationDatabase,
  XOperationStatus,
} from "../storage/application-db.ts";

interface ZernioStatusProvider {
  getPost(postId: string): Promise<Post>;
}

export async function reconcileScheduledPublications(
  database: ApplicationDatabase,
  provider: ZernioStatusProvider,
  delivery: DeliveryService,
  now = new Date(),
): Promise<number> {
  const rows = database.database
    .prepare(
      `SELECT s.logical_operation_id, s.provider_id, s.last_status, s.notified_status, s.poll_count,
              s.notification_message, s.notification_attempts, x.operation
       FROM scheduled_publications s JOIN x_operations x ON x.logical_id = s.logical_operation_id
       WHERE s.next_poll_at <= ? AND s.notification_attempts < 3
       ORDER BY s.next_poll_at LIMIT 10`,
    )
    .all(now.toISOString()) as {
    logical_operation_id: string;
    provider_id: string;
    last_status: string;
    notified_status: string | null;
    poll_count: number;
    notification_message: string | null;
    notification_attempts: number;
    operation: string;
  }[];
  for (const row of rows) {
    if (row.notification_message) {
      await deliverTerminalNotification(
        database,
        delivery,
        { ...row, notification_message: row.notification_message },
        now,
      );
      continue;
    }
    let post: Post;
    try {
      post = await provider.getPost(row.provider_id);
    } catch (error) {
      const pollCount = row.poll_count + 1;
      if (pollCount < 3) {
        database.database
          .prepare(
            "UPDATE scheduled_publications SET poll_count = ?, next_poll_at = ? WHERE logical_operation_id = ?",
          )
          .run(
            pollCount,
            new Date(now.getTime() + 15 * 60_000).toISOString(),
            row.logical_operation_id,
          );
        continue;
      }
      const updated = database.updateXOperation(row.logical_operation_id, {
        status: "partial",
        error: `Provider verification failed after bounded polling: ${safeError(error)}`,
      });
      const message = renderStatus(
        row.operation,
        updated.status,
        updated.publicUrl,
        updated.error,
      );
      queueTerminalNotification(
        database,
        row.logical_operation_id,
        updated.status,
        message,
        now,
      );
      await deliverTerminalNotification(
        database,
        delivery,
        {
          ...row,
          last_status: updated.status,
          notification_message: message,
          notification_attempts: 0,
        },
        now,
      );
      continue;
    }
    const target = post.platforms?.find(
      (platform) => platform.platform === "twitter",
    );
    const observed = normalize(
      post.status,
      target?.status,
      target?.platformPostId,
      target?.platformPostUrl,
    );
    const incompletePublished =
      observed === "partial" && post.status === "published";
    const pollCount = incompletePublished ? row.poll_count + 1 : 0;
    const waitingForPublicIdentity = incompletePublished && pollCount < 3;
    const status = waitingForPublicIdentity ? "publishing" : observed;
    const updated = database.updateXOperation(row.logical_operation_id, {
      status,
      providerId: row.provider_id,
      ...(target?.platformPostId ? { publicId: target.platformPostId } : {}),
      ...(target?.platformPostUrl ? { publicUrl: target.platformPostUrl } : {}),
      ...(post.scheduledFor ? { scheduledFor: post.scheduledFor } : {}),
      error: target?.errorMessage ?? null,
    });
    const material =
      status !== row.last_status && isTerminal(row.operation, status);
    if (isTerminal(row.operation, status)) {
      const message = renderStatus(
        row.operation,
        updated.status,
        updated.publicUrl,
        updated.error,
      );
      queueTerminalNotification(
        database,
        row.logical_operation_id,
        status,
        message,
        now,
      );
      await deliverTerminalNotification(
        database,
        delivery,
        {
          ...row,
          last_status: status,
          notification_message: message,
          notification_attempts: 0,
        },
        now,
      );
    } else {
      database.database
        .prepare(
          `UPDATE scheduled_publications SET last_status = ?, notified_status = ?, poll_count = ?, next_poll_at = ?
           WHERE logical_operation_id = ?`,
        )
        .run(
          status,
          material ? status : row.notified_status,
          pollCount,
          new Date(now.getTime() + 5 * 60_000).toISOString(),
          row.logical_operation_id,
        );
    }
  }
  return rows.length;
}

function queueTerminalNotification(
  database: ApplicationDatabase,
  logicalId: string,
  status: XOperationStatus,
  message: string,
  now: Date,
): void {
  database.database
    .prepare(
      `UPDATE scheduled_publications SET last_status = ?, notified_status = ?,
       notification_message = ?, notification_attempts = 0, next_poll_at = ?
       WHERE logical_operation_id = ?`,
    )
    .run(status, status, message, now.toISOString(), logicalId);
}

async function deliverTerminalNotification(
  database: ApplicationDatabase,
  delivery: DeliveryService,
  row: {
    logical_operation_id: string;
    last_status: string;
    notification_message: string;
    notification_attempts: number;
  },
  now: Date,
): Promise<void> {
  try {
    await delivery.sendOwner(
      row.notification_message,
      `x-operation:${row.logical_operation_id}:${row.last_status}`,
    );
    database.database
      .prepare(
        "DELETE FROM scheduled_publications WHERE logical_operation_id = ?",
      )
      .run(row.logical_operation_id);
  } catch {
    const attempts = row.notification_attempts + 1;
    database.database
      .prepare(
        `UPDATE scheduled_publications SET notification_attempts = ?, next_poll_at = ?
         WHERE logical_operation_id = ?`,
      )
      .run(
        attempts,
        attempts >= 3
          ? now.toISOString()
          : new Date(
              now.getTime() + 60_000 * 2 ** (attempts - 1),
            ).toISOString(),
        row.logical_operation_id,
      );
  }
}

function normalize(
  postStatus: string | undefined,
  platformStatus: string | undefined,
  publicId: string | undefined,
  publicUrl: string | undefined,
): XOperationStatus {
  if (
    postStatus === "published" &&
    (platformStatus === "failed" || !publicId || !publicUrl)
  ) {
    return "partial";
  }
  if (
    postStatus === "draft" ||
    postStatus === "scheduled" ||
    postStatus === "publishing" ||
    postStatus === "published" ||
    postStatus === "partial" ||
    postStatus === "failed" ||
    postStatus === "cancelled"
  ) {
    return postStatus;
  }
  return "publishing";
}

function safeError(error: unknown): string {
  return error instanceof Error
    ? String(redactForLogging(error.message)).slice(0, 500)
    : "Unknown Zernio polling failure";
}

function isTerminal(operation: string, status: XOperationStatus): boolean {
  if (status === "partial" || status === "failed" || status === "cancelled") {
    return true;
  }
  if (operation === "draft") return status === "draft";
  return status === "published";
}

function renderStatus(
  operation: string,
  status: XOperationStatus,
  url: string | null,
  error: string | null,
): string {
  if (status === "draft")
    return "The previously pending X draft is now verified as saved.";
  if (status === "published")
    return `Your X ${operation} is now verified as published${url ? `: ${url}` : "."}`;
  if (status === "partial")
    return `Your X ${operation} completed only partially${error ? `: ${error}` : "."}`;
  if (status === "cancelled") return `Your X ${operation} was cancelled.`;
  return `Your X ${operation} failed${error ? `: ${error}` : "."}`;
}
