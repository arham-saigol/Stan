import type { ApplicationDatabase } from "../storage/application-db.ts";
import { redactForLogging } from "../logging.ts";
import type { SupermemoryProvider } from "./supermemory.ts";

interface PendingMemoryInput {
  localDate: string;
  conversationId: string;
  transcript: string;
  complete: boolean;
}

export function queuePendingMemory(
  database: ApplicationDatabase,
  input: PendingMemoryInput,
): void {
  const customId = `stan-session-${input.localDate}`;
  const now = new Date().toISOString();
  database.database
    .prepare(
      `INSERT INTO memory_documents(custom_id, local_date, conversation_id, content, complete, status, attempts, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, ?) ON CONFLICT(custom_id) DO UPDATE SET
       provider_id = CASE WHEN memory_documents.content <> excluded.content THEN NULL ELSE memory_documents.provider_id END,
       conversation_id = excluded.conversation_id, content = excluded.content, complete = excluded.complete,
       status = 'pending',
       attempts = CASE WHEN memory_documents.content <> excluded.content THEN 0 ELSE memory_documents.attempts END,
       failure_attempts = CASE WHEN memory_documents.content <> excluded.content THEN 0 ELSE memory_documents.failure_attempts END,
       next_attempt_at = CASE WHEN memory_documents.content <> excluded.content THEN NULL ELSE memory_documents.next_attempt_at END,
       last_error = CASE WHEN memory_documents.content <> excluded.content THEN NULL ELSE memory_documents.last_error END,
       updated_at = excluded.updated_at`,
    )
    .run(
      customId,
      input.localDate,
      input.conversationId,
      input.transcript,
      input.complete ? 1 : 0,
      now,
    );
}

export async function ingestPendingMemory(
  database: ApplicationDatabase,
  memory: SupermemoryProvider | undefined,
  input: PendingMemoryInput,
): Promise<void> {
  queuePendingMemory(database, input);
  if (!memory) return;
  const customId = `stan-session-${input.localDate}`;
  try {
    const result = await memory.ingestSession(input);
    database.database
      .prepare(
        `UPDATE memory_documents SET provider_id = ?, status = ?, attempts = attempts + 1,
         content = CASE WHEN ? = 'done' THEN '' ELSE content END,
         failure_attempts = CASE WHEN ? = 'done' THEN 0 ELSE failure_attempts END,
         last_error = NULL, updated_at = ? WHERE custom_id = ?`,
      )
      .run(
        result.id,
        result.status,
        result.status,
        result.status,
        new Date().toISOString(),
        customId,
      );
  } catch (error) {
    const message =
      error instanceof Error
        ? String(redactForLogging(error.message)).slice(0, 500)
        : "Memory provider failed";
    database.database
      .prepare(
        `UPDATE memory_documents SET status = CASE WHEN failure_attempts + 1 >= 3 THEN 'failed' ELSE 'pending' END,
         attempts = attempts + 1, failure_attempts = failure_attempts + 1,
         next_attempt_at = CASE WHEN failure_attempts + 1 >= 3 THEN NULL ELSE ? END,
         last_error = ?, updated_at = ? WHERE custom_id = ?`,
      )
      .run(
        new Date(Date.now() + 15 * 60_000).toISOString(),
        message,
        new Date().toISOString(),
        customId,
      );
  }
}

export async function reconcilePendingMemory(
  database: ApplicationDatabase,
  memory: SupermemoryProvider,
): Promise<number> {
  const rows = database.database
    .prepare(
      `SELECT custom_id, provider_id, status, attempts, failure_attempts, local_date, conversation_id, content, complete FROM memory_documents
       WHERE status NOT IN ('done', 'failed') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY updated_at LIMIT 5`,
    )
    .all(new Date().toISOString()) as {
    custom_id: string;
    provider_id: string | null;
    status: string;
    attempts: number;
    failure_attempts: number;
    local_date: string;
    conversation_id: string;
    content: string;
    complete: number;
  }[];
  for (const row of rows) {
    if (row.provider_id) {
      try {
        const document = (await memory.status(row.provider_id)) as {
          status?: string;
        };
        const status = document.status ?? row.status;
        if (status === "done") {
          database.database
            .prepare(
              "UPDATE memory_documents SET status = 'done', content = '', failure_attempts = 0, next_attempt_at = NULL, last_error = NULL, updated_at = ? WHERE custom_id = ?",
            )
            .run(new Date().toISOString(), row.custom_id);
          continue;
        }
        if (status !== "failed") {
          const attempts = row.attempts + 1;
          const exhausted = attempts >= 720;
          database.database
            .prepare(
              `UPDATE memory_documents SET status = ?, attempts = ?, failure_attempts = 0, next_attempt_at = ?,
               last_error = ?, updated_at = ? WHERE custom_id = ?`,
            )
            .run(
              exhausted ? "failed" : status,
              attempts,
              exhausted
                ? null
                : new Date(Date.now() + 2 * 60_000).toISOString(),
              exhausted
                ? "Memory provider did not finish within the 24-hour polling limit"
                : null,
              new Date().toISOString(),
              row.custom_id,
            );
          continue;
        }
        if (row.failure_attempts >= 2) {
          database.database
            .prepare(
              "UPDATE memory_documents SET status = 'failed', next_attempt_at = NULL, updated_at = ? WHERE custom_id = ?",
            )
            .run(new Date().toISOString(), row.custom_id);
          continue;
        }
        database.database
          .prepare(
            `UPDATE memory_documents SET provider_id = NULL, status = 'pending',
             failure_attempts = failure_attempts + 1, next_attempt_at = ?,
             last_error = 'Memory provider reported ingestion failure', updated_at = ?
             WHERE custom_id = ?`,
          )
          .run(
            new Date(Date.now() + 15 * 60_000).toISOString(),
            new Date().toISOString(),
            row.custom_id,
          );
        continue;
      } catch (error) {
        const failureAttempts = row.failure_attempts + 1;
        const exhausted = failureAttempts >= 3;
        const message =
          error instanceof Error
            ? String(redactForLogging(error.message)).slice(0, 500)
            : "Memory status lookup failed";
        database.database
          .prepare(
            `UPDATE memory_documents SET status = ?, failure_attempts = ?, next_attempt_at = ?,
             last_error = ?, updated_at = ? WHERE custom_id = ?`,
          )
          .run(
            exhausted ? "failed" : row.status,
            failureAttempts,
            exhausted ? null : new Date(Date.now() + 15 * 60_000).toISOString(),
            message,
            new Date().toISOString(),
            row.custom_id,
          );
        continue;
      }
    }
    await ingestPendingMemory(database, memory, {
      localDate: row.local_date,
      conversationId: row.conversation_id,
      transcript: row.content,
      complete: row.complete === 1,
    });
  }
  return rows.length;
}
