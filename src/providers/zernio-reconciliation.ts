import type { Post } from "@zernio/node";
import type { DeliveryService } from "../gateway/delivery.ts";
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
      `SELECT s.logical_operation_id, s.provider_id, s.last_status, s.notified_status, x.operation
       FROM scheduled_publications s JOIN x_operations x ON x.logical_id = s.logical_operation_id
       WHERE s.next_poll_at <= ? ORDER BY s.next_poll_at LIMIT 10`,
    )
    .all(now.toISOString()) as {
    logical_operation_id: string;
    provider_id: string;
    last_status: string;
    notified_status: string | null;
    operation: string;
  }[];
  for (const row of rows) {
    try {
      const post = await provider.getPost(row.provider_id);
      const target = post.platforms?.find(
        (platform) => platform.platform === "twitter",
      );
      const status = normalize(
        post.status,
        target?.status,
        target?.platformPostId,
        target?.platformPostUrl,
      );
      const updated = database.updateXOperation(row.logical_operation_id, {
        status,
        providerId: row.provider_id,
        ...(target?.platformPostId ? { publicId: target.platformPostId } : {}),
        ...(target?.platformPostUrl
          ? { publicUrl: target.platformPostUrl }
          : {}),
        ...(post.scheduledFor ? { scheduledFor: post.scheduledFor } : {}),
        error: target?.errorMessage ?? null,
      });
      const material =
        status !== row.last_status && isTerminal(row.operation, status);
      if (material && row.notified_status !== status) {
        await delivery.sendOwner(
          renderStatus(
            row.operation,
            updated.status,
            updated.publicUrl,
            updated.error,
          ),
          `x-operation:${updated.logicalId}:${updated.status}`,
        );
      }
      if (isTerminal(row.operation, status)) {
        database.database
          .prepare(
            "DELETE FROM scheduled_publications WHERE logical_operation_id = ?",
          )
          .run(row.logical_operation_id);
      } else {
        database.database
          .prepare(
            "UPDATE scheduled_publications SET last_status = ?, notified_status = ?, next_poll_at = ? WHERE logical_operation_id = ?",
          )
          .run(
            status,
            material ? status : row.notified_status,
            new Date(now.getTime() + 5 * 60_000).toISOString(),
            row.logical_operation_id,
          );
      }
    } catch {
      database.database
        .prepare(
          "UPDATE scheduled_publications SET next_poll_at = ? WHERE logical_operation_id = ?",
        )
        .run(
          new Date(now.getTime() + 15 * 60_000).toISOString(),
          row.logical_operation_id,
        );
    }
  }
  return rows.length;
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
    postStatus === "failed"
  ) {
    return postStatus;
  }
  return "publishing";
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
