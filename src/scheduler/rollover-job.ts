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
         AND state IN ('claimed', 'dispatched', 'failed', 'unknown')
         AND NOT (state = 'unknown' AND recovery_attempts >= 3) LIMIT 1`,
      )
      .get(previous.conversation_id);
    if (unsettled) continue;
    database.database
      .prepare(
        "UPDATE daily_sessions SET state = 'closed', closed_at = ? WHERE local_date = ?",
      )
      .run(timestamp, previous.local_date);
    const transcript = localTranscript(
      database,
      previous.local_date,
      previous.conversation_id,
    );
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
  localDate: string,
  conversationId: string,
): string {
  const turns: { at: string; lines: string[] }[] = (
    database.database
      .prepare(
        "SELECT received_at, body, response_text FROM inbound_messages WHERE session_id = ?",
      )
      .all(conversationId) as {
      received_at: string;
      body: string;
      response_text: string | null;
    }[]
  ).map((row) => ({
    at: row.received_at,
    lines: [
      `owner: ${row.body}`,
      ...(row.response_text ? [`stan: ${row.response_text}`] : []),
    ],
  }));
  const heartbeats = database.database
    .prepare(
      `SELECT scheduled_for, kind, status, message, reason FROM heartbeat_occurrences
       WHERE local_date = ?`,
    )
    .all(localDate) as {
    scheduled_for: string;
    kind: string;
    status: string;
    message: string | null;
    reason: string | null;
  }[];
  turns.push(
    ...heartbeats.map((row) => ({
      at: row.scheduled_for,
      lines: [
        `stan heartbeat (${row.kind}): ${row.message ?? row.reason ?? row.status}`,
      ],
    })),
  );
  const start = Temporal.PlainDate.from(localDate).toZonedDateTime({
    timeZone: TIMEZONE,
    plainTime: Temporal.PlainTime.from("00:01"),
  });
  const automations = database.database
    .prepare(
      `SELECT r.scheduled_for, r.status, r.result, r.error, a.name, a.instruction
       FROM automation_runs r JOIN automations a ON a.id = r.automation_id
       WHERE r.scheduled_for >= ? AND r.scheduled_for < ?`,
    )
    .all(
      start.toInstant().toString(),
      start.add({ days: 1 }).toInstant().toString(),
    ) as {
    scheduled_for: string;
    status: string;
    result: string | null;
    error: string | null;
    name: string;
    instruction: string;
  }[];
  turns.push(
    ...automations.map((row) => ({
      at: row.scheduled_for,
      lines: [
        `automation (${row.name}): ${row.instruction}`,
        `stan: ${row.result ?? row.error ?? row.status}`,
      ],
    })),
  );
  return turns
    .sort((left, right) => left.at.localeCompare(right.at))
    .flatMap((turn) => turn.lines)
    .join("\n");
}
