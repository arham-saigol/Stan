import { createHash } from "node:crypto";
import type { ApplicationDatabase } from "../storage/application-db.ts";

export type ProactiveSuppression = "duplicate" | "notification_budget";

export function proactiveDecision(
  database: ApplicationDatabase,
  message: string,
  localDate: string,
): ProactiveSuppression | undefined {
  const hash = suggestionHash(message);
  if (
    database.database
      .prepare("SELECT 1 FROM proactive_suggestions WHERE topic_hash = ?")
      .get(hash)
  ) {
    return "duplicate";
  }
  const count = (
    database.database
      .prepare(
        `SELECT COUNT(*) AS count FROM heartbeat_occurrences
         WHERE local_date = ? AND kind = 'regular' AND status = 'notified'`,
      )
      .get(localDate) as { count: number }
  ).count;
  return count >= 2 ? "notification_budget" : undefined;
}

export function recordProactiveSuggestion(
  database: ApplicationDatabase,
  message: string,
  now = new Date(),
): void {
  database.database
    .prepare(
      `INSERT INTO proactive_suggestions(topic_hash, message, sent_at) VALUES (?, ?, ?)
       ON CONFLICT(topic_hash) DO UPDATE SET message = excluded.message, sent_at = excluded.sent_at`,
    )
    .run(suggestionHash(message), message.slice(0, 4000), now.toISOString());
}

function suggestionHash(message: string): string {
  const normalized = message
    .trim()
    .toLocaleLowerCase("en")
    .replace(/\s+/g, " ");
  return createHash("sha256").update(normalized).digest("hex");
}
