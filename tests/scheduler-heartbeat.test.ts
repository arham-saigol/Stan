import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Temporal } from "@js-temporal/polyfill";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { StanAgentRuntime } from "../src/agents/runtime.ts";
import { ConfigStore, createDefaultConfig } from "../src/config/store.ts";
import type { DeliveryService } from "../src/gateway/delivery.ts";
import { AutomationStore } from "../src/scheduler/automations.ts";
import { Scheduler } from "../src/scheduler/scheduler.ts";
import { ApplicationDatabase } from "../src/storage/application-db.ts";

type HeartbeatMessage = { attributes?: Record<string, string> };

function heartbeatRuntime(
  deliver: (id: string, message: HeartbeatMessage) => Promise<string>,
  isBusy: () => boolean = () => false,
): StanAgentRuntime {
  const submissions = new Map<
    string,
    { conversationId: string; message: HeartbeatMessage }
  >();
  let sequence = 0;
  return {
    isBusy,
    dispatch: vi.fn(async (conversationId: string, message: unknown) => {
      const submissionId = `submission-${++sequence}`;
      submissions.set(submissionId, {
        conversationId,
        message: message as HeartbeatMessage,
      });
      return submissionId;
    }),
    read: vi.fn(async (_conversationId: string, submissionId: string) => {
      const submission = submissions.get(submissionId)!;
      return deliver(submission.conversationId, submission.message);
    }),
  } as unknown as StanAgentRuntime;
}

describe("heartbeat execution", () => {
  it("sends the model-written morning response once and lets a regular run stay silent", async () => {
    const root = await mkdtemp(join(tmpdir(), "stan-heartbeat-run-"));
    const config = new ConfigStore(root);
    await config.write(createDefaultConfig({ ownerPhone: "+923001234567" }));
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    const sendOwner = vi.fn(async () => ({ messageId: "out-1" }));
    let busy = true;
    const deliver = vi.fn(async (_id: string, message: HeartbeatMessage) => {
      const occurrenceId = message.attributes!.occurrenceId!;
      const morning = message.attributes!.kind === "morning";
      database.database
        .prepare(
          "UPDATE heartbeat_occurrences SET status = ?, notify = ?, message = ?, reason = 'nothing_useful' WHERE occurrence_id = ?",
        )
        .run(
          morning ? "ready" : "silent",
          morning ? 1 : 0,
          morning ? "Morning — what should we work on?" : null,
          occurrenceId,
        );
      return morning ? "Morning — what should we work on?" : "";
    });
    const agent = heartbeatRuntime(deliver, () => busy);
    const scheduler = new Scheduler(
      database,
      config,
      agent,
      { sendOwner } as unknown as DeliveryService,
      new AutomationStore(database),
      pino({ level: "silent" }),
      undefined,
      async () => {
        throw new Error("XQuik unavailable");
      },
    );

    await scheduler.tick(Temporal.Instant.from("2026-08-13T04:00:00Z")); // busy at 09:00
    busy = false;
    await scheduler.tick(Temporal.Instant.from("2026-08-13T04:00:30Z"));
    database.claimInbound({
      id: "future-skewed",
      senderIdentity: "923001234567@s.whatsapp.net",
      body: "future message",
      receivedAt: "2099-08-13T07:00:00Z",
    });
    await scheduler.tick(Temporal.Instant.from("2026-08-13T07:00:00Z")); // 12:00

    expect(sendOwner).toHaveBeenCalledTimes(1);
    expect(sendOwner).toHaveBeenCalledWith(
      "Morning — what should we work on?",
      "heartbeat:heartbeat:2026-08-13:09:00",
    );
    expect(deliver).toHaveBeenCalledTimes(2);
    database.close();
  });

  it("retries a regular heartbeat notification without rerunning the agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "stan-heartbeat-retry-"));
    const config = new ConfigStore(root);
    await config.write(createDefaultConfig({ ownerPhone: "+923001234567" }));
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    const sendOwner = vi
      .fn()
      .mockRejectedValueOnce(new Error("WhatsApp offline"))
      .mockResolvedValueOnce({ messageId: "out-1" });
    const deliver = vi.fn(
      async (_id: string, message: { attributes?: Record<string, string> }) => {
        database.database
          .prepare(
            "UPDATE heartbeat_occurrences SET status = 'ready', notify = 1, message = ? WHERE occurrence_id = ?",
          )
          .run("One useful interruption", message.attributes!.occurrenceId!);
        return "One useful interruption";
      },
    );
    const scheduler = new Scheduler(
      database,
      config,
      heartbeatRuntime(deliver),
      { sendOwner } as unknown as DeliveryService,
      new AutomationStore(database),
      pino({ level: "silent" }),
    );

    await scheduler.tick(Temporal.Instant.from("2026-08-13T07:00:00Z"));
    await scheduler.tick(Temporal.Instant.from("2026-08-13T07:01:00Z"));

    expect(deliver).toHaveBeenCalledOnce();
    expect(sendOwner).toHaveBeenCalledTimes(2);
    expect(
      database.database
        .prepare("SELECT status FROM heartbeat_occurrences")
        .get(),
    ).toEqual({ status: "notified" });

    database.database
      .prepare(
        `INSERT INTO heartbeat_occurrences(occurrence_id, local_date, scheduled_for, kind, status, notify, message, created_at, updated_at)
         VALUES (?, ?, ?, 'regular', 'ready', 1, ?, ?, ?)`,
      )
      .run(
        "heartbeat:2026-08-13:crash",
        "2026-08-13",
        "2026-08-13T07:01:30Z",
        "Persisted before a daemon exit",
        "2026-08-13T07:01:30Z",
        "2026-08-13T07:01:30Z",
      );
    await scheduler.tick(Temporal.Instant.from("2026-08-13T07:02:00Z"));

    expect(deliver).toHaveBeenCalledOnce();
    expect(sendOwner).toHaveBeenCalledTimes(3);
    expect(
      database.database
        .prepare(
          "SELECT status FROM heartbeat_occurrences WHERE occurrence_id = 'heartbeat:2026-08-13:crash'",
        )
        .get(),
    ).toEqual({ status: "notified" });
    database.close();
  });

  it("bounds permanently failing morning heartbeat generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "stan-heartbeat-failure-"));
    const config = new ConfigStore(root);
    await config.write(createDefaultConfig({ ownerPhone: "+923001234567" }));
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    const deliver = vi.fn(async () => {
      throw new Error("model unavailable");
    });
    const scheduler = new Scheduler(
      database,
      config,
      heartbeatRuntime(deliver),
      { sendOwner: vi.fn() } as unknown as DeliveryService,
      new AutomationStore(database),
      pino({ level: "silent" }),
    );

    for (const instant of [
      "2026-08-13T04:00:00Z",
      "2026-08-13T04:00:30Z",
      "2026-08-13T04:01:00Z",
      "2026-08-13T04:03:00Z",
      "2026-08-13T04:04:00Z",
    ]) {
      await scheduler.tick(Temporal.Instant.from(instant));
    }

    expect(deliver).toHaveBeenCalledTimes(3);
    expect(
      database.database
        .prepare(
          "SELECT status, attempts, next_retry_at FROM heartbeat_occurrences",
        )
        .get(),
    ).toEqual({ status: "failed", attempts: 3, next_retry_at: null });
    database.close();
  });

  it("reclaims an interrupted regular heartbeat after its lease expires", async () => {
    const root = await mkdtemp(join(tmpdir(), "stan-regular-lease-"));
    const config = new ConfigStore(root);
    await config.write(createDefaultConfig({ ownerPhone: "+923001234567" }));
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    database.database
      .prepare(
        `INSERT INTO heartbeat_occurrences(occurrence_id, local_date, scheduled_for, kind, status, lease_until, flue_submission_id, created_at, updated_at)
         VALUES (?, ?, ?, 'regular', 'running', ?, 'submission-existing', ?, ?)`,
      )
      .run(
        "heartbeat:2026-08-13:11:59",
        "2026-08-13",
        "2026-08-13T06:59:00Z",
        "2026-08-13T06:59:30Z",
        "2026-08-13T06:59:00Z",
        "2026-08-13T06:59:00Z",
      );
    const dispatch = vi.fn();
    const read = vi.fn(async () => {
      database.database
        .prepare(
          "UPDATE heartbeat_occurrences SET status = 'silent', notify = 0 WHERE occurrence_id = ?",
        )
        .run("heartbeat:2026-08-13:11:59");
      return "";
    });
    const scheduler = new Scheduler(
      database,
      config,
      { isBusy: () => false, dispatch, read } as unknown as StanAgentRuntime,
      { sendOwner: vi.fn() } as unknown as DeliveryService,
      new AutomationStore(database),
      pino({ level: "silent" }),
    );

    await scheduler.tick(Temporal.Instant.from("2026-08-13T07:00:00Z"));

    expect(dispatch).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledWith(
      "stan-owner-2026-08-13",
      "submission-existing",
    );
    expect(
      database.database
        .prepare("SELECT status, next_retry_at FROM heartbeat_occurrences")
        .get(),
    ).toEqual({ status: "silent", next_retry_at: null });
    database.close();
  });

  it("reclaims a failed regular heartbeat after its scheduled minute", async () => {
    const root = await mkdtemp(join(tmpdir(), "stan-regular-recovery-"));
    const config = new ConfigStore(root);
    await config.write(createDefaultConfig({ ownerPhone: "+923001234567" }));
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    const deliver = vi
      .fn()
      .mockRejectedValueOnce(new Error("model unavailable"))
      .mockImplementationOnce(
        async (
          _id: string,
          message: { attributes?: Record<string, string> },
        ) => {
          database.database
            .prepare(
              "UPDATE heartbeat_occurrences SET status = 'silent', notify = 0 WHERE occurrence_id = ?",
            )
            .run(message.attributes!.occurrenceId!);
          return "";
        },
      );
    const scheduler = new Scheduler(
      database,
      config,
      heartbeatRuntime(deliver),
      { sendOwner: vi.fn() } as unknown as DeliveryService,
      new AutomationStore(database),
      pino({ level: "silent" }),
    );

    await scheduler.tick(Temporal.Instant.from("2026-08-13T07:00:00Z"));
    await scheduler.tick(Temporal.Instant.from("2026-08-13T07:01:00Z"));

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(
      database.database
        .prepare("SELECT status, attempts FROM heartbeat_occurrences")
        .get(),
    ).toEqual({ status: "silent", attempts: 1 });
    database.close();
  });
});
