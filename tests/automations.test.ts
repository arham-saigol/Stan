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

describe("declarative automations", () => {
  it("validates cron expressions and rejects unreasonably frequent jobs", () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    const store = new AutomationStore(database);

    expect(() =>
      store.create({
        name: "bad",
        schedule: { type: "cron", expression: "not cron" },
        instruction: "Research one topic",
        deliveryMode: "silent",
        creatorMessageId: "owner-1",
        now: new Date("2026-08-13T00:00:00Z"),
      }),
    ).toThrow(/cron/i);
    expect(() =>
      store.create({
        name: "noisy",
        schedule: { type: "cron", expression: "* * * * *" },
        instruction: "Research one topic",
        deliveryMode: "silent",
        creatorMessageId: "owner-1",
        now: new Date("2026-08-13T00:00:00Z"),
      }),
    ).toThrow(/30 minutes/i);
    database.close();
  });

  it("runs one catch-up occurrence and skips older cron slots after downtime", () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    const store = new AutomationStore(database);
    const automation = store.create({
      name: "hourly-check",
      schedule: { type: "cron", expression: "0 * * * *" },
      instruction: "Check once",
      deliveryMode: "silent",
      creatorMessageId: "owner-1",
      now: new Date("2026-08-13T00:00:00Z"),
    });

    expect(store.claimDue(new Date("2026-08-13T05:30:00Z"))).toHaveLength(1);
    expect(
      new Date(store.get(automation.id)!.nextRunAt!).getTime(),
    ).toBeGreaterThan(new Date("2026-08-13T05:30:00Z").getTime());
    database.close();
  });

  it("marks an expired in-flight run unknown instead of silently duplicating it", () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    const store = new AutomationStore(database);
    store.create({
      name: "leased-check",
      schedule: { type: "once", at: "2026-08-13T04:00:00Z" },
      instruction: "Check once",
      deliveryMode: "silent",
      creatorMessageId: "owner-1",
      now: new Date("2026-08-13T00:00:00Z"),
    });
    const [run] = store.claimDue(new Date("2026-08-13T04:00:00Z"));

    expect(store.claimDue(new Date("2026-08-13T04:11:00Z"))).toHaveLength(0);
    const row = database.database
      .prepare("SELECT status FROM automation_runs WHERE occurrence_id = ?")
      .get(run!.occurrenceId) as { status: string };
    expect(row.status).toBe("unknown");
    database.close();
  });

  it("does not recover an unknown run after its automation is disabled", () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    const store = new AutomationStore(database);
    const automation = store.create({
      name: "paused recovery",
      schedule: { type: "once", at: "2026-08-13T04:00:00Z" },
      instruction: "Check once",
      deliveryMode: "silent",
      creatorMessageId: "owner-1",
      now: new Date("2026-08-13T00:00:00Z"),
    });
    store.claimDue(new Date("2026-08-13T04:00:00Z"));
    store.claimDue(new Date("2026-08-13T04:11:00Z"));
    store.setEnabled(automation.id, false);

    expect(store.recoverableRuns(new Date("2026-08-13T04:12:00Z"))).toEqual([]);
    database.close();
  });

  it("settles a running recurring occurrence when its automation is paused", () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    const store = new AutomationStore(database);
    const automation = store.create({
      name: "paused while running",
      schedule: { type: "cron", expression: "0 * * * *" },
      instruction: "Check hourly",
      deliveryMode: "silent",
      creatorMessageId: "owner-1",
      now: new Date("2026-08-13T00:00:00Z"),
    });
    const [run] = store.claimDue(new Date("2026-08-13T01:00:00Z"));
    store.setSubmission(run!.occurrenceId, "submission-1");

    store.setEnabled(automation.id, false);
    store.retryRun(run!.occurrenceId, "read failed");

    expect(
      database.database
        .prepare(
          "SELECT status, lease_until FROM automation_runs WHERE occurrence_id = ?",
        )
        .get(run!.occurrenceId),
    ).toEqual({ status: "failed", lease_until: null });
    expect(store.recoverableRuns(new Date("2026-08-13T02:00:00Z"))).toEqual([]);
    database.close();
  });

  it("claims each due occurrence exactly once", () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    const store = new AutomationStore(database);
    expect(() =>
      store.create({
        name: "host-dependent",
        schedule: { type: "once", at: "2026-08-13T09:00:00" },
        instruction: "Prepare a private report",
        deliveryMode: "silent",
        creatorMessageId: "owner-1",
        now: new Date("2026-08-13T00:00:00Z"),
      }),
    ).toThrow(/UTC offset/i);
    store.create({
      name: "once",
      schedule: { type: "once", at: "2026-08-13T09:00:00+05:00" },
      instruction: "Prepare a private report",
      deliveryMode: "owner_whatsapp",
      creatorMessageId: "owner-1",
      now: new Date("2026-08-13T00:00:00Z"),
    });

    expect(store.claimDue(new Date("2026-08-13T04:00:00Z"))).toHaveLength(1);
    expect(store.claimDue(new Date("2026-08-13T04:00:00Z"))).toHaveLength(0);
    database.close();
  });

  it("settles pending heartbeat generation when heartbeats are disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "stan-heartbeat-disabled-"));
    const config = new ConfigStore(root);
    const initial = createDefaultConfig({ ownerPhone: "+923001234567" });
    await config.write({
      ...initial,
      heartbeat: { ...initial.heartbeat, enabled: false },
    });
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    database.database
      .prepare(
        `INSERT INTO heartbeat_occurrences(
           occurrence_id, local_date, scheduled_for, kind, status, attempts,
           next_retry_at, created_at, updated_at
         ) VALUES (?, ?, ?, 'regular', 'failed', 1, ?, ?, ?)`,
      )
      .run(
        "heartbeat:2026-08-13:regular:09:00",
        "2026-08-13",
        "2026-08-13T04:00:00Z",
        "2026-08-13T04:01:00Z",
        "2026-08-13T04:00:00Z",
        "2026-08-13T04:00:00Z",
      );
    const scheduler = new Scheduler(
      database,
      config,
      { isBusy: () => false } as unknown as StanAgentRuntime,
      { sendOwner: vi.fn() } as unknown as DeliveryService,
      new AutomationStore(database),
      pino({ level: "silent" }),
    );

    await scheduler.tick(Temporal.Instant.from("2026-08-13T04:02:00Z"));

    expect(
      database.database
        .prepare(
          "SELECT status, notify, next_retry_at FROM heartbeat_occurrences WHERE occurrence_id = ?",
        )
        .get("heartbeat:2026-08-13:regular:09:00"),
    ).toEqual({ status: "silent", notify: 0, next_retry_at: null });
    database.close();
  });

  it("defers a completed automation reply until delivery is ready", async () => {
    const root = await mkdtemp(join(tmpdir(), "stan-automation-"));
    const config = new ConfigStore(root);
    const initial = createDefaultConfig({ ownerPhone: "+923001234567" });
    await config.write({
      ...initial,
      heartbeat: { ...initial.heartbeat, enabled: false },
    });
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    const automations = new AutomationStore(database);
    automations.create({
      name: "daily report",
      schedule: { type: "once", at: "2026-08-13T04:00:00Z" },
      instruction: "Prepare the report",
      deliveryMode: "owner_whatsapp",
      creatorMessageId: "owner-1",
      now: new Date("2026-08-13T00:00:00Z"),
    });
    const dispatch = vi.fn(async () => "submission-1");
    const read = vi.fn(async () => "the finished report");
    const sendOwner = vi.fn(async () => ({ messageId: "out-1" }));
    let canDeliver = false;
    const scheduler = new Scheduler(
      database,
      config,
      { isBusy: () => false, dispatch, read } as unknown as StanAgentRuntime,
      { sendOwner } as unknown as DeliveryService,
      automations,
      pino({ level: "silent" }),
      undefined,
      undefined,
      () => canDeliver,
    );

    await scheduler.tick(Temporal.Instant.from("2026-08-13T04:00:00Z"));
    expect(
      database.database
        .prepare("SELECT status, result FROM automation_runs")
        .get(),
    ).toEqual({
      status: "notification_pending",
      result: "the finished report",
    });
    expect(sendOwner).not.toHaveBeenCalled();

    canDeliver = true;
    await scheduler.tick(Temporal.Instant.from("2026-08-13T04:01:00Z"));
    expect(
      database.database
        .prepare("SELECT status, result FROM automation_runs")
        .get(),
    ).toEqual({ status: "completed", result: "the finished report" });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledOnce();
    expect(sendOwner).toHaveBeenCalledOnce();
    database.close();
  });

  it("bounds persistent automation notification failures", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "stan-automation-notify-failure-"),
    );
    const config = new ConfigStore(root);
    const initial = createDefaultConfig({ ownerPhone: "+923001234567" });
    await config.write({
      ...initial,
      heartbeat: { ...initial.heartbeat, enabled: false },
    });
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    const automations = new AutomationStore(database);
    automations.create({
      name: "failing delivery",
      schedule: { type: "once", at: "2026-08-13T04:00:00Z" },
      instruction: "Prepare the report",
      deliveryMode: "owner_whatsapp",
      creatorMessageId: "owner-1",
      now: new Date("2026-08-13T00:00:00Z"),
    });
    const sendOwner = vi.fn(async () => {
      throw new Error("WhatsApp unavailable");
    });
    const scheduler = new Scheduler(
      database,
      config,
      {
        isBusy: () => false,
        dispatch: vi.fn(async () => "submission-1"),
        read: vi.fn(async () => "finished report"),
      } as unknown as StanAgentRuntime,
      { sendOwner } as unknown as DeliveryService,
      automations,
      pino({ level: "silent" }),
    );

    for (const instant of [
      "2026-08-13T04:00:00Z",
      "2026-08-13T04:01:00Z",
      "2026-08-13T04:03:00Z",
      "2026-08-13T04:10:00Z",
    ])
      await scheduler.tick(Temporal.Instant.from(instant));

    expect(sendOwner).toHaveBeenCalledTimes(3);
    expect(
      database.database
        .prepare(
          "SELECT status, attempts, lease_until, result FROM automation_runs",
        )
        .get(),
    ).toEqual({
      status: "failed",
      attempts: 3,
      lease_until: null,
      result: "finished report",
    });
    database.close();
  });

  it("retains an active deleted run and suppresses its owner delivery", async () => {
    const root = await mkdtemp(join(tmpdir(), "stan-automation-delete-"));
    const config = new ConfigStore(root);
    const initial = createDefaultConfig({ ownerPhone: "+923001234567" });
    await config.write({
      ...initial,
      heartbeat: { ...initial.heartbeat, enabled: false },
    });
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    const automations = new AutomationStore(database);
    const automation = automations.create({
      name: "delete while running",
      schedule: { type: "once", at: "2026-08-13T04:00:00Z" },
      instruction: "Prepare the report",
      deliveryMode: "owner_whatsapp",
      creatorMessageId: "owner-1",
      now: new Date("2026-08-13T00:00:00Z"),
    });
    let releaseRead!: (value: string) => void;
    const read = vi.fn(
      () =>
        new Promise<string>((resolvePromise) => {
          releaseRead = resolvePromise;
        }),
    );
    const sendOwner = vi.fn();
    const scheduler = new Scheduler(
      database,
      config,
      {
        isBusy: () => false,
        dispatch: vi.fn(async () => "submission-1"),
        read,
      } as unknown as StanAgentRuntime,
      { sendOwner } as unknown as DeliveryService,
      automations,
      pino({ level: "silent" }),
    );

    const ticking = scheduler.tick(
      Temporal.Instant.from("2026-08-13T04:00:00Z"),
    );
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    expect(automations.delete(automation.id)).toBe(true);
    releaseRead("finished report");
    await ticking;

    expect(sendOwner).not.toHaveBeenCalled();
    expect(
      database.database
        .prepare(
          "SELECT status, result FROM automation_runs WHERE automation_id = ?",
        )
        .get(automation.id),
    ).toEqual({ status: "completed", result: "finished report" });
    database.close();
  });

  it("retains completed run history when an automation is deleted", () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    const store = new AutomationStore(database);
    const automation = store.create({
      name: "daily report",
      schedule: { type: "cron", expression: "0 * * * *" },
      instruction: "Prepare the report",
      deliveryMode: "silent",
      creatorMessageId: "owner-1",
      now: new Date("2026-08-13T00:00:00Z"),
    });
    database.database
      .prepare(
        `INSERT INTO automation_runs(occurrence_id, automation_id, scheduled_for, status, result, created_at, updated_at)
         VALUES ('completed-run', ?, '2026-08-13T04:00:00Z', 'completed', 'report', ?, ?)`,
      )
      .run(automation.id, "2026-08-13T04:00:00Z", "2026-08-13T04:00:00Z");

    expect(store.delete(automation.id)).toBe(true);
    expect(store.get(automation.id)).toBeUndefined();
    expect(
      database.database
        .prepare(
          "SELECT status, result FROM automation_runs WHERE occurrence_id = 'completed-run'",
        )
        .get(),
    ).toEqual({ status: "completed", result: "report" });
    expect(() =>
      store.create({
        name: "daily report",
        schedule: { type: "cron", expression: "0 * * * *" },
        instruction: "Prepare another report",
        deliveryMode: "silent",
        creatorMessageId: "owner-2",
        now: new Date("2026-08-13T01:00:00Z"),
      }),
    ).not.toThrow();
    database.close();
  });

  it("prunes completed and failed automation runs beyond retention", () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    const store = new AutomationStore(database);
    const automation = store.create({
      name: "retained-check",
      schedule: { type: "cron", expression: "0 * * * *" },
      instruction: "Check once",
      deliveryMode: "silent",
      creatorMessageId: "owner-1",
      now: new Date("2026-08-13T00:00:00Z"),
    });
    const insert = database.database.prepare(
      `INSERT INTO automation_runs(occurrence_id, automation_id, scheduled_for, status, result, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'large result', ?, ?)`,
    );
    insert.run(
      "old-completed",
      automation.id,
      "2026-06-01T00:00:00Z",
      "completed",
      "2026-06-01T00:00:00Z",
      "2026-06-01T00:00:00Z",
    );
    insert.run(
      "old-failed",
      automation.id,
      "2026-06-01T00:00:00Z",
      "failed",
      "2026-06-01T00:00:00Z",
      "2026-06-01T00:00:00Z",
    );
    insert.run(
      "recent-completed",
      automation.id,
      "2026-08-12T00:00:00Z",
      "completed",
      "2026-08-12T00:00:00Z",
      "2026-08-12T00:00:00Z",
    );

    expect(store.pruneCompleted(new Date("2026-07-01T00:00:00Z"))).toBe(2);
    expect(
      database.database
        .prepare(
          "SELECT occurrence_id FROM automation_runs ORDER BY occurrence_id",
        )
        .all(),
    ).toEqual([{ occurrence_id: "recent-completed" }]);
    database.close();
  });

  it("recovers an expired run through its idempotent Flue submission", async () => {
    const root = await mkdtemp(join(tmpdir(), "stan-automation-recovery-"));
    const config = new ConfigStore(root);
    const initial = createDefaultConfig({ ownerPhone: "+923001234567" });
    await config.write({
      ...initial,
      heartbeat: { ...initial.heartbeat, enabled: false },
    });
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    const automations = new AutomationStore(database);
    automations.create({
      name: "recoverable report",
      schedule: { type: "once", at: "2026-08-13T04:00:00Z" },
      instruction: "Prepare the report",
      deliveryMode: "silent",
      creatorMessageId: "owner-1",
      now: new Date("2026-08-13T00:00:00Z"),
    });
    const [run] = automations.claimDue(new Date("2026-08-13T04:00:00Z"));
    automations.claimDue(new Date("2026-08-13T04:11:00Z"));
    const dispatch = vi.fn(async () => "submission-recovered");
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient model outage"))
      .mockResolvedValueOnce("recovered report");
    const scheduler = new Scheduler(
      database,
      config,
      { isBusy: () => false, dispatch, read } as unknown as StanAgentRuntime,
      { sendOwner: vi.fn() } as unknown as DeliveryService,
      automations,
      pino({ level: "silent" }),
    );

    await scheduler.tick(Temporal.Instant.from("2026-08-13T04:12:00Z"));

    expect(
      database.database
        .prepare(
          "SELECT status, attempts, flue_submission_id FROM automation_runs WHERE occurrence_id = ?",
        )
        .get(run!.occurrenceId),
    ).toEqual({
      status: "unknown",
      attempts: 1,
      flue_submission_id: "submission-recovered",
    });

    await scheduler.tick(Temporal.Instant.from("2026-08-13T04:13:00Z"));

    expect(dispatch).toHaveBeenCalledWith(
      "stan-owner-2026-08-13",
      expect.any(Object),
      run!.occurrenceId,
    );
    expect(read).toHaveBeenCalledWith(
      "stan-owner-2026-08-13",
      "submission-recovered",
    );
    expect(dispatch).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledTimes(2);
    expect(
      database.database
        .prepare(
          "SELECT status, attempts, flue_submission_id, result FROM automation_runs WHERE occurrence_id = ?",
        )
        .get(run!.occurrenceId),
    ).toEqual({
      status: "completed",
      attempts: 1,
      flue_submission_id: "submission-recovered",
      result: "recovered report",
    });
    database.close();
  });
});
