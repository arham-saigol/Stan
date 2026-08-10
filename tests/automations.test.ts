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

  it("claims each due occurrence exactly once", () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    const store = new AutomationStore(database);
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

  it("retries a completed automation reply without rerunning the agent", async () => {
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
    const sendOwner = vi
      .fn()
      .mockRejectedValueOnce(new Error("WhatsApp offline"))
      .mockResolvedValueOnce({ messageId: "out-1" });
    const scheduler = new Scheduler(
      database,
      config,
      { isBusy: () => false, dispatch, read } as unknown as StanAgentRuntime,
      { sendOwner } as unknown as DeliveryService,
      automations,
      pino({ level: "silent" }),
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

    await scheduler.tick(Temporal.Instant.from("2026-08-13T04:01:00Z"));
    expect(
      database.database
        .prepare("SELECT status, result FROM automation_runs")
        .get(),
    ).toEqual({ status: "completed", result: "the finished report" });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledOnce();
    expect(sendOwner).toHaveBeenCalledTimes(2);
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
