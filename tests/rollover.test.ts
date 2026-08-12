import pino from "pino";
import { Temporal } from "@js-temporal/polyfill";
import { describe, expect, it } from "vitest";
import { ApplicationDatabase } from "../src/storage/application-db.ts";
import { AutomationStore } from "../src/scheduler/automations.ts";
import { pakistanRoutingDate } from "../src/scheduler/rollover.ts";
import { repairDailyRollover } from "../src/scheduler/rollover-job.ts";

describe("daily session rollover", () => {
  it("keeps the 00:00 heartbeat on the ending day and switches at 00:01 Pakistan time", () => {
    expect(pakistanRoutingDate("2026-08-13T19:00:00Z")).toBe("2026-08-13");
    expect(pakistanRoutingDate("2026-08-13T19:01:00Z")).toBe("2026-08-14");
  });

  it("repairs a missed rollover once without a model call or duplicate session", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    const logger = pino({ level: "silent" });

    await repairDailyRollover(
      database,
      undefined,
      logger,
      Temporal.Instant.from("2026-08-13T18:59:00Z"),
    );
    await repairDailyRollover(
      database,
      undefined,
      logger,
      Temporal.Instant.from("2026-08-13T19:02:00Z"),
    );
    await repairDailyRollover(
      database,
      undefined,
      logger,
      Temporal.Instant.from("2026-08-13T19:02:00Z"),
    );

    const rows = database.database
      .prepare(
        "SELECT local_date, state FROM daily_sessions ORDER BY local_date",
      )
      .all();
    expect(rows).toEqual([
      { local_date: "2026-08-13", state: "closed" },
      { local_date: "2026-08-14", state: "active" },
    ]);
    database.close();
  });

  it("waits for the final owner turn and queues its complete transcript in degraded mode", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    const logger = pino({ level: "silent" });
    await repairDailyRollover(
      database,
      undefined,
      logger,
      Temporal.Instant.from("2026-08-13T18:59:00Z"),
    );
    database.claimInbound({
      id: "last-turn",
      senderIdentity: "923001234567@s.whatsapp.net",
      body: "publish this",
      quotedText: "The exact post",
      receivedAt: "2026-08-13T19:00:30Z",
    });
    database.setInboundState("last-turn", "dispatched", {
      sessionId: "stan-owner-2026-08-13",
    });

    await repairDailyRollover(
      database,
      undefined,
      logger,
      Temporal.Instant.from("2026-08-13T19:02:00Z"),
    );
    expect(
      database.database
        .prepare(
          "SELECT state, transcript_complete FROM daily_sessions WHERE local_date = '2026-08-13'",
        )
        .get(),
    ).toEqual({ state: "active", transcript_complete: 0 });

    database.setInboundState("last-turn", "delivered", {
      responseText: "done",
      outboundMessageId: "out-1",
    });
    await repairDailyRollover(
      database,
      undefined,
      logger,
      Temporal.Instant.from("2026-08-13T19:02:30Z"),
    );

    expect(
      database.database
        .prepare(
          "SELECT state, transcript_complete FROM daily_sessions WHERE local_date = '2026-08-13'",
        )
        .get(),
    ).toEqual({ state: "closed", transcript_complete: 1 });
    expect(
      database.database
        .prepare(
          "SELECT status, content FROM memory_documents WHERE custom_id = 'stan-session-2026-08-13'",
        )
        .get(),
    ).toEqual({
      status: "pending",
      content: "owner: publish this\nowner quoted: The exact post\nstan: done",
    });
    database.close();
  });

  it("waits for an overdue automation to be claimed before closing", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    const logger = pino({ level: "silent" });
    await repairDailyRollover(
      database,
      undefined,
      logger,
      Temporal.Instant.from("2026-08-13T17:00:00Z"),
    );
    new AutomationStore(database).create({
      name: "late report",
      schedule: { type: "once", at: "2026-08-13T18:00:00Z" },
      instruction: "Prepare the report",
      deliveryMode: "silent",
      creatorMessageId: "owner-1",
      now: new Date("2026-08-13T17:00:00Z"),
    });

    await repairDailyRollover(
      database,
      undefined,
      logger,
      Temporal.Instant.from("2026-08-13T19:02:00Z"),
    );

    expect(
      database.database
        .prepare(
          "SELECT state FROM daily_sessions WHERE local_date = '2026-08-13'",
        )
        .get(),
    ).toEqual({ state: "active" });
    database.close();
  });

  it("waits for an interrupted proactive turn before closing", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    const logger = pino({ level: "silent" });
    await repairDailyRollover(
      database,
      undefined,
      logger,
      Temporal.Instant.from("2026-08-13T18:59:00Z"),
    );
    database.database
      .prepare(
        `INSERT INTO heartbeat_occurrences(occurrence_id, local_date, scheduled_for, kind, status, lease_until, created_at, updated_at)
         VALUES (?, '2026-08-13', ?, 'regular', 'running', ?, ?, ?)`,
      )
      .run(
        "heartbeat:2026-08-13:12:00",
        "2026-08-13T07:00:00Z",
        "2026-08-13T19:05:00Z",
        "2026-08-13T07:00:00Z",
        "2026-08-13T07:00:00Z",
      );

    await repairDailyRollover(
      database,
      undefined,
      logger,
      Temporal.Instant.from("2026-08-13T19:02:00Z"),
    );
    expect(
      database.database
        .prepare(
          "SELECT state FROM daily_sessions WHERE local_date = '2026-08-13'",
        )
        .get(),
    ).toEqual({ state: "active" });

    database.database
      .prepare(
        "UPDATE heartbeat_occurrences SET status = 'silent', lease_until = NULL, reason = 'nothing useful'",
      )
      .run();
    await repairDailyRollover(
      database,
      undefined,
      logger,
      Temporal.Instant.from("2026-08-13T19:02:30Z"),
    );
    expect(
      database.database
        .prepare(
          "SELECT content FROM memory_documents WHERE custom_id = 'stan-session-2026-08-13'",
        )
        .get(),
    ).toEqual({ content: "stan heartbeat (regular): nothing useful" });
    database.close();
  });

  it("includes proactive turns when a day has no owner messages", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    const logger = pino({ level: "silent" });
    await repairDailyRollover(
      database,
      undefined,
      logger,
      Temporal.Instant.from("2026-08-13T18:59:00Z"),
    );
    database.database
      .prepare(
        `INSERT INTO heartbeat_occurrences(occurrence_id, local_date, scheduled_for, kind, status, notify, message, created_at, updated_at)
         VALUES (?, '2026-08-13', ?, 'regular', 'notified', 1, ?, ?, ?)`,
      )
      .run(
        "heartbeat:2026-08-13:12:00",
        "2026-08-13T07:00:00Z",
        "A useful proactive update",
        "2026-08-13T07:00:00Z",
        "2026-08-13T07:00:00Z",
      );

    await repairDailyRollover(
      database,
      undefined,
      logger,
      Temporal.Instant.from("2026-08-13T19:02:00Z"),
    );

    expect(
      database.database
        .prepare(
          "SELECT content FROM memory_documents WHERE custom_id = 'stan-session-2026-08-13'",
        )
        .get(),
    ).toEqual({
      content: "stan heartbeat (regular): A useful proactive update",
    });
    database.close();
  });

  it("closes a session once an owner turn exhausts recovery", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    const logger = pino({ level: "silent" });
    await repairDailyRollover(
      database,
      undefined,
      logger,
      Temporal.Instant.from("2026-08-13T18:59:00Z"),
    );
    database.claimInbound({
      id: "exhausted-turn",
      senderIdentity: "923001234567@s.whatsapp.net",
      body: "lost turn",
      receivedAt: "2026-08-13T18:59:30Z",
    });
    database.setInboundState("exhausted-turn", "dispatched", {
      sessionId: "stan-owner-2026-08-13",
    });
    database.database
      .prepare(
        "UPDATE inbound_messages SET state = 'unknown', recovery_attempts = 3 WHERE provider_message_id = 'exhausted-turn'",
      )
      .run();

    await repairDailyRollover(
      database,
      undefined,
      logger,
      Temporal.Instant.from("2026-08-13T19:02:00Z"),
    );

    expect(
      database.database
        .prepare(
          "SELECT state, transcript_complete FROM daily_sessions WHERE local_date = '2026-08-13'",
        )
        .get(),
    ).toEqual({ state: "closed", transcript_complete: 1 });
    database.close();
  });
});
