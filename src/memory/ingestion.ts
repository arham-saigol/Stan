import type { ApplicationDatabase } from "../storage/application-db.ts";
import { redactForLogging } from "../logging.ts";
import type { SupermemoryProvider } from "./supermemory.ts";

export async function ingestPendingMemory(
  database: ApplicationDatabase,
  memory: SupermemoryProvider | undefined,
  input: {
    localDate: string;
    conversationId: string;
    transcript: string;
    complete: boolean;
  },
): Promise<void> {
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
  if (!memory) return;
  try {
    const result = await memory.ingestSession(input);
    database.database
      .prepare(
        "UPDATE memory_documents SET provider_id = ?, status = ?, attempts = attempts + 1, last_error = NULL, updated_at = ? WHERE custom_id = ?",
      )
      .run(result.id, result.status, new Date().toISOString(), customId);
  } catch (error) {
    const message =
      error instanceof Error
        ? String(redactForLogging(error.message)).slice(0, 500)
        : "Memory provider failed";
    database.database
      .prepare(
        `UPDATE memory_documents SET status = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE 'pending' END,
         attempts = attempts + 1, next_attempt_at = CASE WHEN attempts + 1 >= 3 THEN NULL ELSE ? END,
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
      `SELECT custom_id, provider_id, status, attempts, local_date, conversation_id, content, complete FROM memory_documents
       WHERE status NOT IN ('done', 'failed') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY updated_at LIMIT 5`,
    )
    .all(new Date().toISOString()) as {
    custom_id: string;
    provider_id: string | null;
    status: string;
    attempts: number;
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
        database.database
          .prepare(
            "UPDATE memory_documents SET status = ?, next_attempt_at = ?, updated_at = ? WHERE custom_id = ?",
          )
          .run(
            status,
            status === "done"
              ? null
              : new Date(Date.now() + 2 * 60_000).toISOString(),
            new Date().toISOString(),
            row.custom_id,
          );
        if (status !== "failed") continue;
        if (row.attempts >= 3) {
          database.database
            .prepare(
              "UPDATE memory_documents SET status = 'failed', next_attempt_at = NULL, updated_at = ? WHERE custom_id = ?",
            )
            .run(new Date().toISOString(), row.custom_id);
          continue;
        }
      } catch (error) {
        const attempts = row.attempts + 1;
        const exhausted = attempts >= 3;
        const message =
          error instanceof Error
            ? String(redactForLogging(error.message)).slice(0, 500)
            : "Memory status lookup failed";
        database.database
          .prepare(
            `UPDATE memory_documents SET status = ?, attempts = ?, next_attempt_at = ?,
             last_error = ?, updated_at = ? WHERE custom_id = ?`,
          )
          .run(
            exhausted ? "failed" : row.status,
            attempts,
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
