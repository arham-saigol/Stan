import { describe, expect, it } from "vitest";
import { AutomationStore } from "../src/scheduler/automations.ts";
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
});
