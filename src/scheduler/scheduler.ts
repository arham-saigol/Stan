import { Temporal } from "@js-temporal/polyfill";
import type { Logger } from "pino";
import type { StanAgentRuntime } from "../agents/runtime.ts";
import type { StanConfig } from "../config/schema.ts";
import type { ConfigStore } from "../config/store.ts";
import type { DeliveryService } from "../gateway/delivery.ts";
import type { ApplicationDatabase } from "../storage/application-db.ts";
import type { AutomationStore } from "./automations.ts";
import { dueHeartbeat } from "./heartbeat.ts";
import { dailySessionId, pakistanRoutingDate } from "./rollover.ts";
import { proactiveDecision, recordProactiveSuggestion } from "./proactive.ts";

export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  private activeTick: Promise<void> | undefined;

  constructor(
    private readonly database: ApplicationDatabase,
    private readonly config: ConfigStore,
    private readonly agent: StanAgentRuntime,
    private readonly delivery: DeliveryService,
    private readonly automations: AutomationStore,
    private readonly logger: Logger,
    private readonly maintenance?: (now: Temporal.Instant) => Promise<void>,
    private readonly prepareHeartbeat?: () => Promise<void>,
    private readonly canDeliver: () => boolean = () => true,
  ) {}

  start(): void {
    if (this.timer) return;
    this.trigger();
    this.timer = setInterval(() => this.trigger(), 30_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.activeTick;
  }

  private trigger(): void {
    if (this.activeTick) return;
    this.activeTick = this.tick()
      .catch((error: unknown) => {
        this.logger.error({ error: safeError(error) }, "Scheduler tick failed");
      })
      .finally(() => {
        this.activeTick = undefined;
      });
  }

  async tick(now = Temporal.Now.instant()): Promise<void> {
    if (this.maintenance) {
      try {
        await this.maintenance(now);
      } catch (error) {
        this.logger.error(
          { error: safeError(error) },
          "Scheduler maintenance failed",
        );
      }
    }
    if (!this.agent.isBusy()) {
      this.database.database
        .prepare(
          `UPDATE heartbeat_occurrences SET status = 'failed', lease_until = NULL, next_retry_at = ?,
           reason = 'Lease expired before completion could be verified', updated_at = ?
           WHERE status IN ('leased', 'running') AND lease_until < ?`,
        )
        .run(now.toString(), now.toString(), now.toString());
    }
    const config = this.config.read();
    await this.runHeartbeat(config, now);
    await this.runAutomations(now);
    this.automations.pruneCompleted(
      new Date(now.epochMilliseconds - 30 * 24 * 60 * 60_000),
    );
  }

  private async runHeartbeat(
    config: StanConfig,
    now: Temporal.Instant,
  ): Promise<void> {
    if (!config.heartbeat.enabled) {
      this.database.database
        .prepare(
          `UPDATE heartbeat_occurrences SET status = 'silent', notify = 0,
           reason = 'Heartbeat disabled before recovery', lease_until = NULL,
           next_retry_at = NULL, updated_at = ?
           WHERE status IN ('failed', 'ready', 'leased', 'running')`,
        )
        .run(now.toString());
      return;
    }
    await this.retryHeartbeatNotifications(now);
    const completed = new Set(
      (
        this.database.database
          .prepare(
            "SELECT occurrence_id FROM heartbeat_occurrences WHERE status IN ('notified', 'silent')",
          )
          .all() as { occurrence_id: string }[]
      ).map((row) => row.occurrence_id),
    );
    const failedOccurrence = this.database.database
      .prepare(
        `SELECT occurrence_id, local_date, scheduled_for, kind, flue_submission_id
         FROM heartbeat_occurrences
         WHERE status = 'failed' AND notify IS NOT 1 AND attempts < 3
           AND next_retry_at IS NOT NULL AND next_retry_at <= ?
         ORDER BY next_retry_at LIMIT 1`,
      )
      .get(now.toString()) as
      | {
          occurrence_id: string;
          local_date: string;
          scheduled_for: string;
          kind: "morning" | "regular";
          flue_submission_id: string | null;
        }
      | undefined;
    const occurrence = failedOccurrence
      ? {
          id: failedOccurrence.occurrence_id,
          anchorDate: failedOccurrence.local_date,
          localDate: failedOccurrence.local_date,
          scheduledFor: failedOccurrence.scheduled_for,
          kind: failedOccurrence.kind,
          submissionId: failedOccurrence.flue_submission_id,
        }
      : dueHeartbeat(now, config.heartbeat, {
          completedOccurrenceIds: completed,
        });
    if (!occurrence) return;
    const timestamp = now.toString();
    const lastOwner = this.database.database
      .prepare(
        "SELECT received_at FROM inbound_messages ORDER BY received_at DESC LIMIT 1",
      )
      .get() as { received_at: string } | undefined;
    const activityAge = lastOwner
      ? now.epochMilliseconds - Date.parse(lastOwner.received_at)
      : undefined;
    const recentlyActive =
      occurrence.kind === "regular" &&
      activityAge !== undefined &&
      activityAge >= 0 &&
      activityAge < 30 * 60_000;
    if (occurrence.kind === "morning" && this.agent.isBusy()) return;
    const status = this.agent.isBusy()
      ? "busy"
      : recentlyActive
        ? "suppressed"
        : "leased";
    const inserted = this.database.database
      .prepare(
        `INSERT OR IGNORE INTO heartbeat_occurrences(occurrence_id, local_date, scheduled_for, kind, status, lease_until, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        occurrence.id,
        pakistanRoutingDate(occurrence.scheduledFor),
        occurrence.scheduledFor,
        occurrence.kind,
        status,
        status === "leased"
          ? new Date(now.epochMilliseconds + 10 * 60_000).toISOString()
          : null,
        timestamp,
        timestamp,
      );
    if (status !== "leased") return;
    if (inserted.changes === 0) {
      const reclaimed = this.database.database
        .prepare(
          `UPDATE heartbeat_occurrences SET status = 'leased', lease_until = ?, updated_at = ?
           WHERE occurrence_id = ? AND status IN ('busy', 'failed') AND notify IS NOT 1
             AND attempts < 3 AND (next_retry_at IS NULL OR next_retry_at <= ?)`,
        )
        .run(
          new Date(now.epochMilliseconds + 10 * 60_000).toISOString(),
          timestamp,
          occurrence.id,
          timestamp,
        );
      if (reclaimed.changes === 0) return;
    }
    this.database.database
      .prepare(
        "UPDATE heartbeat_occurrences SET status = 'running', updated_at = ? WHERE occurrence_id = ?",
      )
      .run(timestamp, occurrence.id);
    try {
      let submissionId =
        "submissionId" in occurrence ? occurrence.submissionId : null;
      if (!submissionId) {
        if (this.prepareHeartbeat) {
          try {
            await this.prepareHeartbeat();
          } catch (error) {
            this.logger.warn(
              { occurrenceId: occurrence.id, error: safeError(error) },
              "Optional heartbeat research preparation failed",
            );
          }
        }
        submissionId = await this.agent.dispatch(
          dailySessionId(occurrence.scheduledFor),
          {
            kind: "signal",
            type: "heartbeat",
            body:
              occurrence.kind === "morning"
                ? "Run the morning heartbeat. Always finish with heartbeat_respond and one conversational message."
                : "Run the regular heartbeat. Finish with heartbeat_respond; stay silent unless one interruption is worthwhile.",
            attributes: {
              occurrenceId: occurrence.id,
              kind: occurrence.kind,
              scheduledFor: occurrence.scheduledFor,
            },
          },
          `heartbeat:${occurrence.id}`,
        );
        this.database.database
          .prepare(
            "UPDATE heartbeat_occurrences SET flue_submission_id = ?, updated_at = ? WHERE occurrence_id = ?",
          )
          .run(submissionId, now.toString(), occurrence.id);
      }
      const reply = await this.agent.read(
        dailySessionId(occurrence.scheduledFor),
        submissionId,
      );
      const row = this.database.database
        .prepare(
          "SELECT status, notify, message FROM heartbeat_occurrences WHERE occurrence_id = ?",
        )
        .get(occurrence.id) as {
        status: string;
        notify: number | null;
        message: string | null;
      };
      const message =
        row.status === "ready"
          ? row.message
          : occurrence.kind === "morning"
            ? reply.trim()
            : null;
      if (message) {
        if (occurrence.kind === "regular") {
          const suppression = proactiveDecision(
            this.database,
            message,
            pakistanRoutingDate(occurrence.scheduledFor),
          );
          if (suppression) {
            this.database.database
              .prepare(
                "UPDATE heartbeat_occurrences SET status = 'silent', notify = 0, reason = ?, lease_until = NULL, next_retry_at = NULL, updated_at = ? WHERE occurrence_id = ?",
              )
              .run(suppression, new Date().toISOString(), occurrence.id);
            return;
          }
        }
        this.database.database
          .prepare(
            `UPDATE heartbeat_occurrences SET status = 'ready', notify = 1, message = ?,
             attempts = 0, next_retry_at = NULL, updated_at = ? WHERE occurrence_id = ?`,
          )
          .run(message, new Date().toISOString(), occurrence.id);
        if (!this.canDeliver()) return;
        await this.delivery.sendOwner(message, `heartbeat:${occurrence.id}`);
        this.database.database
          .prepare(
            "UPDATE heartbeat_occurrences SET status = 'notified', notify = 1, message = ?, lease_until = NULL, updated_at = ? WHERE occurrence_id = ?",
          )
          .run(message, new Date().toISOString(), occurrence.id);
        if (occurrence.kind === "regular") {
          recordProactiveSuggestion(
            this.database,
            message,
            new Date(now.epochMilliseconds),
          );
        }
      } else if (row.status !== "silent") {
        throw new Error("Heartbeat did not produce a structured response");
      } else {
        this.database.database
          .prepare(
            "UPDATE heartbeat_occurrences SET lease_until = NULL, next_retry_at = NULL, updated_at = ? WHERE occurrence_id = ?",
          )
          .run(now.toString(), occurrence.id);
      }
    } catch (error) {
      const failed = this.database.database
        .prepare(
          "SELECT attempts FROM heartbeat_occurrences WHERE occurrence_id = ?",
        )
        .get(occurrence.id) as { attempts: number };
      const attempts = failed.attempts + 1;
      this.database.database
        .prepare(
          `UPDATE heartbeat_occurrences SET status = 'failed', attempts = ?, reason = ?, lease_until = NULL,
           next_retry_at = ?, updated_at = ? WHERE occurrence_id = ?`,
        )
        .run(
          attempts,
          safeError(error),
          attempts >= 3
            ? null
            : new Date(
                now.epochMilliseconds + 60_000 * 2 ** (attempts - 1),
              ).toISOString(),
          now.toString(),
          occurrence.id,
        );
      this.logger.error(
        { occurrenceId: occurrence.id, error: safeError(error) },
        "Heartbeat failed",
      );
    }
  }

  private async retryHeartbeatNotifications(
    now: Temporal.Instant,
  ): Promise<void> {
    if (!this.canDeliver()) return;
    const pending = this.database.database
      .prepare(
        `SELECT occurrence_id, local_date, kind, message, attempts FROM heartbeat_occurrences
         WHERE status IN ('failed', 'ready') AND notify = 1 AND message IS NOT NULL
           AND attempts < 3 AND (next_retry_at IS NULL OR next_retry_at <= ?)
         ORDER BY updated_at LIMIT 5`,
      )
      .all(now.toString()) as {
      occurrence_id: string;
      local_date: string;
      kind: "morning" | "regular";
      message: string;
      attempts: number;
    }[];
    for (const occurrence of pending) {
      try {
        await this.delivery.sendOwner(
          occurrence.message,
          `heartbeat:${occurrence.occurrence_id}`,
        );
        this.database.database
          .prepare(
            "UPDATE heartbeat_occurrences SET status = 'notified', lease_until = NULL, updated_at = ? WHERE occurrence_id = ?",
          )
          .run(now.toString(), occurrence.occurrence_id);
        if (occurrence.kind === "regular") {
          recordProactiveSuggestion(
            this.database,
            occurrence.message,
            new Date(now.epochMilliseconds),
          );
        }
      } catch (error) {
        const attempts = occurrence.attempts + 1;
        this.database.database
          .prepare(
            `UPDATE heartbeat_occurrences SET status = 'failed', attempts = ?, reason = ?,
             next_retry_at = ?, updated_at = ? WHERE occurrence_id = ?`,
          )
          .run(
            attempts,
            safeError(error),
            attempts >= 3
              ? null
              : new Date(
                  now.epochMilliseconds + 60_000 * 2 ** (attempts - 1),
                ).toISOString(),
            now.toString(),
            occurrence.occurrence_id,
          );
      }
    }
  }

  private async runAutomations(now: Temporal.Instant): Promise<void> {
    const currentDate = new Date(now.epochMilliseconds);
    if (this.canDeliver()) {
      for (const pending of this.automations.pendingNotifications(
        currentDate,
      )) {
        try {
          await this.delivery.sendOwner(
            pending.output,
            `automation:${pending.occurrenceId}`,
          );
          this.automations.finishRun(pending.occurrenceId, {
            status: "completed",
            output: pending.output,
          });
        } catch (error) {
          this.automations.recordNotificationFailure(
            pending.occurrenceId,
            pending.output,
            safeError(error),
            currentDate,
          );
        }
      }
    }
    const claimed = this.automations.claimDue(new Date(now.epochMilliseconds));
    const runs = [...this.automations.recoverableRuns(currentDate), ...claimed];
    for (const run of runs) {
      let reply: string;
      try {
        const sessionId = dailySessionId(run.scheduledFor);
        const sessionDate = pakistanRoutingDate(run.scheduledFor);
        this.database.database
          .prepare(
            `INSERT INTO daily_sessions(local_date, conversation_id, state, created_at)
             VALUES (?, ?, 'active', ?) ON CONFLICT(local_date) DO UPDATE SET
             state = 'active', closed_at = NULL, transcript_complete = 0`,
          )
          .run(sessionDate, sessionId, currentDate.toISOString());
        const submissionId =
          run.submissionId ??
          (await this.agent.dispatch(
            sessionId,
            {
              kind: "signal",
              type: "automation",
              body: run.automation.instruction,
              attributes: {
                occurrenceId: run.occurrenceId,
                automationId: run.automation.id,
                scheduledFor: run.scheduledFor,
              },
            },
            run.occurrenceId,
          ));
        this.automations.setSubmission(
          run.occurrenceId,
          submissionId,
          currentDate,
        );
        reply = await this.agent.read(sessionId, submissionId);
      } catch (error) {
        this.automations.retryRun(
          run.occurrenceId,
          safeError(error),
          currentDate,
        );
        continue;
      }
      if (!this.automations.isRunActive(run.occurrenceId)) continue;
      const output = reply.slice(0, 12_000);
      if (
        run.automation.deliveryMode === "owner_whatsapp" &&
        this.automations.get(run.automation.id)
      ) {
        if (!this.canDeliver()) {
          this.automations.finishRun(run.occurrenceId, {
            status: "notification_pending",
            output,
          });
          continue;
        }
        try {
          await this.delivery.sendOwner(
            output,
            `automation:${run.occurrenceId}`,
          );
        } catch (error) {
          this.automations.recordNotificationFailure(
            run.occurrenceId,
            output,
            safeError(error),
            currentDate,
            true,
          );
          continue;
        }
      }
      this.automations.finishRun(run.occurrenceId, {
        status: "completed",
        output,
      });
    }
  }
}

function safeError(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 500)
    : "Unknown scheduler failure";
}
