import { Temporal } from "@js-temporal/polyfill";
import type { Logger } from "pino";
import { TIMEZONE } from "../config/schema.ts";
import type { SupermemoryProvider } from "../memory/supermemory.ts";
import { ingestPendingMemory } from "../memory/ingestion.ts";
import type { ApplicationDatabase } from "../storage/application-db.ts";
import { pakistanRoutingDate } from "./rollover.ts";

export async function repairDailyRollover(
  database: ApplicationDatabase,
  memory: SupermemoryProvider | undefined,
  logger: Logger,
  now = Temporal.Now.instant(),
): Promise<string> {
  const localDate = pakistanRoutingDate(now);
  const conversationId = `stan-owner-${localDate}`;
  const timestamp = now.toString();
  const open = database.database
    .prepare(
      "SELECT local_date, conversation_id FROM daily_sessions WHERE state = 'active' AND local_date <> ?",
    )
    .all(localDate) as { local_date: string; conversation_id: string }[];
  for (const previous of open) {
    const unsettled = database.database
      .prepare(
        `SELECT 1 FROM inbound_messages WHERE session_id = ? AND response_text IS NULL
         AND state IN ('claimed', 'dispatched', 'failed', 'unknown') LIMIT 1`,
      )
      .get(previous.conversation_id);
    if (unsettled) continue;
    database.database
      .prepare(
        "UPDATE daily_sessions SET state = 'closed', closed_at = ? WHERE local_date = ?",
      )
      .run(timestamp, previous.local_date);
    const transcript = localTranscript(database, previous.conversation_id);
    database.database
      .prepare(
        "UPDATE daily_sessions SET transcript_complete = 1 WHERE local_date = ?",
      )
      .run(previous.local_date);
    if (transcript.trim()) {
      await ingestPendingMemory(database, memory, {
        localDate: previous.local_date,
        conversationId: previous.conversation_id,
        transcript,
        complete: true,
      });
    }
  }
  database.database
    .prepare(
      `INSERT INTO daily_sessions(local_date, conversation_id, state, created_at) VALUES (?, ?, 'active', ?)
       ON CONFLICT(local_date) DO UPDATE SET state = 'active'`,
    )
    .run(localDate, conversationId, timestamp);
  logger.debug(
    { localDate, conversationId, timezone: TIMEZONE },
    "Daily session routing is current",
  );
  return conversationId;
}

function localTranscript(
  database: ApplicationDatabase,
  conversationId: string,
): string {
  const rows = database.database
    .prepare(
      "SELECT body, response_text FROM inbound_messages WHERE session_id = ? ORDER BY received_at",
    )
    .all(conversationId) as { body: string; response_text: string | null }[];
  return rows
    .flatMap((row) => [
      `owner: ${row.body}`,
      ...(row.response_text ? [`stan: ${row.response_text}`] : []),
    ])
    .join("\n");
}
