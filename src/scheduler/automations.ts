import { Cron } from "croner";
import { TIMEZONE } from "../config/schema.ts";
import type {
  ApplicationDatabase,
  AutomationAuthorizationOperation,
} from "../storage/application-db.ts";

export type AutomationSchedule =
  | { type: "once"; at: string }
  | { type: "cron"; expression: string };

export interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  schedule: AutomationSchedule;
  instruction: string;
  deliveryMode: "silent" | "owner_whatsapp";
  creatorMessageId: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

export interface ClaimedAutomationRun {
  occurrenceId: string;
  automation: Automation;
  scheduledFor: string;
  submissionId?: string;
}

export interface PendingAutomationNotification {
  occurrenceId: string;
  output: string;
}

export class AutomationStore {
  constructor(private readonly application: ApplicationDatabase) {}

  consumeAuthorization(
    sourceMessageId: string,
    operation: AutomationAuthorizationOperation,
    payloadJson: string,
  ): void {
    this.application.consumeAutomationAuthorization(
      sourceMessageId,
      operation,
      payloadJson,
    );
  }

  create(input: {
    name: string;
    schedule: AutomationSchedule;
    instruction: string;
    deliveryMode: "silent" | "owner_whatsapp";
    creatorMessageId: string;
    now?: Date;
  }): Automation {
    const now = input.now ?? new Date();
    const count = (
      this.application.database
        .prepare(
          "SELECT COUNT(*) AS count FROM automations WHERE deleted_at IS NULL",
        )
        .get() as { count: number }
    ).count;
    if (count >= 50)
      throw new Error("Automation limit of 50 jobs has been reached");
    if (!/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,63}$/u.test(input.name))
      throw new Error("Automation name is invalid");
    if (!input.instruction.trim() || input.instruction.length > 4000)
      throw new Error("Automation instruction is invalid");
    const nextRun = nextRunFor(input.schedule, now);
    if (!nextRun)
      throw new Error("Automation schedule has no future occurrence");
    const id = crypto.randomUUID();
    const timestamp = now.toISOString();
    this.application.database
      .prepare(
        `INSERT INTO automations(id, name, enabled, schedule_type, schedule_value, timezone, instruction, delivery_mode,
         creator_message_id, next_run_at, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.schedule.type,
        input.schedule.type === "once"
          ? normalizeInstant(input.schedule.at)
          : input.schedule.expression,
        TIMEZONE,
        input.instruction.trim(),
        input.deliveryMode,
        input.creatorMessageId,
        nextRun.toISOString(),
        timestamp,
        timestamp,
      );
    return this.get(id)!;
  }

  get(id: string): Automation | undefined {
    const row = this.application.database
      .prepare("SELECT * FROM automations WHERE id = ? AND deleted_at IS NULL")
      .get(id) as Record<string, string | number | null> | undefined;
    return row ? mapAutomation(row) : undefined;
  }

  list(): Automation[] {
    return (
      this.application.database
        .prepare(
          "SELECT * FROM automations WHERE deleted_at IS NULL ORDER BY created_at",
        )
        .all() as Record<string, string | number | null>[]
    ).map(mapAutomation);
  }

  setEnabled(id: string, enabled: boolean): Automation {
    const current = this.get(id);
    if (!current) throw new Error("Automation not found");
    const now = new Date();
    const existingNext = current.nextRunAt ? new Date(current.nextRunAt) : null;
    const next =
      enabled && (!existingNext || existingNext.getTime() < now.getTime())
        ? nextRunFor(current.schedule, now)
        : existingNext;
    if (enabled && !next)
      throw new Error("Automation has no future occurrence");
    const timestamp = new Date().toISOString();
    this.application.transaction(() => {
      this.application.database
        .prepare(
          "UPDATE automations SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(
          enabled ? 1 : 0,
          enabled ? next!.toISOString() : current.nextRunAt,
          timestamp,
          id,
        );
      if (!enabled) {
        this.application.database
          .prepare(
            `UPDATE automation_runs SET status = 'failed', lease_until = NULL,
             error = 'Automation disabled before recovery', updated_at = ?
             WHERE automation_id = ? AND status IN ('unknown', 'leased', 'running')`,
          )
          .run(timestamp, id);
      }
    });
    return this.get(id)!;
  }

  delete(id: string): boolean {
    return this.application.transaction(() => {
      const timestamp = new Date().toISOString();
      this.application.database
        .prepare(
          `UPDATE automation_runs SET status = 'failed', lease_until = NULL,
           error = 'Automation deleted before completion', updated_at = ?
           WHERE automation_id = ? AND status <> 'completed'`,
        )
        .run(timestamp, id);
      return (
        this.application.database
          .prepare(
            `UPDATE automations SET enabled = 0, next_run_at = NULL, deleted_at = ?,
             name = name || ' [deleted ' || id || ']', updated_at = ?
             WHERE id = ? AND deleted_at IS NULL`,
          )
          .run(timestamp, timestamp, id).changes > 0
      );
    });
  }

  claimDue(now = new Date()): ClaimedAutomationRun[] {
    this.application.database
      .prepare(
        `UPDATE automation_runs SET status = 'unknown', lease_until = NULL,
         error = 'Lease expired before completion could be verified', updated_at = ?
         WHERE status IN ('leased', 'running') AND lease_until < ?`,
      )
      .run(now.toISOString(), now.toISOString());
    const due = this.application.database
      .prepare(
        "SELECT * FROM automations WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at LIMIT 10",
      )
      .all(now.toISOString()) as Record<string, string | number | null>[];
    const claimed: ClaimedAutomationRun[] = [];
    for (const row of due) {
      const automation = mapAutomation(row);
      if (!automation.nextRunAt) continue;
      const scheduledFor = automation.nextRunAt;
      const occurrenceId = `automation:${automation.id}:${scheduledFor}`;
      const accepted = this.application.transaction(() => {
        const timestamp = now.toISOString();
        const result = this.application.database
          .prepare(
            `INSERT OR IGNORE INTO automation_runs(occurrence_id, automation_id, scheduled_for, status, lease_until, created_at, updated_at)
             VALUES (?, ?, ?, 'leased', ?, ?, ?)`,
          )
          .run(
            occurrenceId,
            automation.id,
            scheduledFor,
            new Date(now.getTime() + 10 * 60_000).toISOString(),
            timestamp,
            timestamp,
          );
        if (result.changes === 0) return false;
        const next =
          automation.schedule.type === "cron"
            ? nextRunFor(automation.schedule, now)
            : null;
        this.application.database
          .prepare(
            "UPDATE automations SET enabled = ?, next_run_at = ?, last_run_at = ?, updated_at = ? WHERE id = ?",
          )
          .run(
            next ? 1 : 0,
            next?.toISOString() ?? null,
            scheduledFor,
            timestamp,
            automation.id,
          );
        return true;
      });
      if (accepted) claimed.push({ occurrenceId, automation, scheduledFor });
    }
    return claimed;
  }

  recoverableRuns(now = new Date(), limit = 10): ClaimedAutomationRun[] {
    return (
      this.application.database
        .prepare(
          `SELECT r.occurrence_id, r.scheduled_for, r.flue_submission_id, a.*
           FROM automation_runs r JOIN automations a ON a.id = r.automation_id
           WHERE r.status = 'unknown' AND (a.enabled = 1 OR a.schedule_type = 'once')
             AND (r.lease_until IS NULL OR r.lease_until <= ?)
           ORDER BY r.updated_at LIMIT ?`,
        )
        .all(now.toISOString(), limit) as Record<
        string,
        string | number | null
      >[]
    ).map((row) => ({
      occurrenceId: String(row.occurrence_id),
      automation: mapAutomation(row),
      scheduledFor: String(row.scheduled_for),
      ...(row.flue_submission_id
        ? { submissionId: String(row.flue_submission_id) }
        : {}),
    }));
  }

  setSubmission(
    occurrenceId: string,
    submissionId: string,
    now = new Date(),
  ): void {
    this.application.database
      .prepare(
        `UPDATE automation_runs SET status = 'running', flue_submission_id = ?,
         lease_until = ?, updated_at = ? WHERE occurrence_id = ?`,
      )
      .run(
        submissionId,
        new Date(now.getTime() + 10 * 60_000).toISOString(),
        now.toISOString(),
        occurrenceId,
      );
  }

  retryRun(occurrenceId: string, error: string, now = new Date()): void {
    const row = this.application.database
      .prepare(
        `SELECT r.attempts, r.status, a.enabled, a.schedule_type FROM automation_runs r
         JOIN automations a ON a.id = r.automation_id WHERE r.occurrence_id = ?`,
      )
      .get(occurrenceId) as
      | {
          attempts: number;
          status: string;
          enabled: number;
          schedule_type: "once" | "cron";
        }
      | undefined;
    if (!row) return;
    const attempts = row.attempts + 1;
    const exhausted =
      attempts >= 3 ||
      row.status === "failed" ||
      (row.enabled !== 1 && row.schedule_type === "cron");
    this.application.database
      .prepare(
        `UPDATE automation_runs SET status = ?, attempts = ?, error = ?,
         lease_until = ?, updated_at = ? WHERE occurrence_id = ?`,
      )
      .run(
        exhausted ? "failed" : "unknown",
        attempts,
        error,
        exhausted
          ? null
          : new Date(
              now.getTime() + 60_000 * 2 ** (attempts - 1),
            ).toISOString(),
        now.toISOString(),
        occurrenceId,
      );
  }

  pruneCompleted(before: Date): number {
    return this.application.transaction(() => {
      const changes = Number(
        this.application.database
          .prepare(
            "DELETE FROM automation_runs WHERE status = 'completed' AND updated_at < ?",
          )
          .run(before.toISOString()).changes,
      );
      this.application.database
        .prepare(
          `DELETE FROM automations WHERE deleted_at IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM automation_runs WHERE automation_id = automations.id)`,
        )
        .run();
      return changes;
    });
  }

  finishRun(
    occurrenceId: string,
    result: {
      status: "completed" | "failed" | "notification_pending";
      output?: string;
      error?: string;
    },
  ): void {
    this.application.database
      .prepare(
        "UPDATE automation_runs SET status = ?, result = ?, error = ?, lease_until = NULL, updated_at = ? WHERE occurrence_id = ?",
      )
      .run(
        result.status,
        result.output ?? null,
        result.error ?? null,
        new Date().toISOString(),
        occurrenceId,
      );
  }

  recordNotificationFailure(
    occurrenceId: string,
    output: string,
    error: string,
    now = new Date(),
    firstAttempt = false,
  ): void {
    const row = this.application.database
      .prepare("SELECT attempts FROM automation_runs WHERE occurrence_id = ?")
      .get(occurrenceId) as { attempts: number } | undefined;
    if (!row) return;
    const attempts = firstAttempt ? 1 : row.attempts + 1;
    const exhausted = attempts >= 3;
    this.application.database
      .prepare(
        `UPDATE automation_runs SET status = ?, attempts = ?, result = ?, error = ?,
         lease_until = ?, updated_at = ? WHERE occurrence_id = ?`,
      )
      .run(
        exhausted ? "failed" : "notification_pending",
        attempts,
        output,
        error,
        exhausted
          ? null
          : new Date(
              now.getTime() + 60_000 * 2 ** (attempts - 1),
            ).toISOString(),
        now.toISOString(),
        occurrenceId,
      );
  }

  pendingNotifications(
    now = new Date(),
    limit = 5,
  ): PendingAutomationNotification[] {
    return this.application.database
      .prepare(
        `SELECT occurrence_id, result FROM automation_runs
         WHERE status = 'notification_pending' AND result IS NOT NULL AND attempts < 3
           AND (lease_until IS NULL OR lease_until <= ?)
         ORDER BY updated_at LIMIT ?`,
      )
      .all(now.toISOString(), limit)
      .map((row) => {
        const value = row as { occurrence_id: string; result: string };
        return { occurrenceId: value.occurrence_id, output: value.result };
      });
  }
}

function nextRunFor(schedule: AutomationSchedule, now: Date): Date | null {
  if (schedule.type === "once") {
    const value = new Date(normalizeInstant(schedule.at));
    return value.getTime() >= now.getTime() ? value : null;
  }
  let cron: Cron;
  try {
    cron = new Cron(schedule.expression, { timezone: TIMEZONE, paused: true });
  } catch (error) {
    throw new Error("Invalid cron expression", { cause: error });
  }
  const next = cron.nextRuns(2, now);
  if (
    next.length < 2 ||
    next[1]!.getTime() - next[0]!.getTime() < 30 * 60_000
  ) {
    throw new Error("Cron automations must run at least 30 minutes apart");
  }
  return next[0] ?? null;
}

function normalizeInstant(value: string): string {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new Error("One-shot automation time must include a UTC offset");
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds))
    throw new Error("One-shot automation time is invalid");
  return new Date(milliseconds).toISOString();
}

function mapAutomation(
  row: Record<string, string | number | null>,
): Automation {
  const schedule =
    row.schedule_type === "once"
      ? { type: "once" as const, at: String(row.schedule_value) }
      : { type: "cron" as const, expression: String(row.schedule_value) };
  return {
    id: String(row.id),
    name: String(row.name),
    enabled: row.enabled === 1,
    schedule,
    instruction: String(row.instruction),
    deliveryMode: row.delivery_mode as "silent" | "owner_whatsapp",
    creatorMessageId: String(row.creator_message_id),
    nextRunAt: row.next_run_at === null ? null : String(row.next_run_at),
    lastRunAt: row.last_run_at === null ? null : String(row.last_run_at),
  };
}
