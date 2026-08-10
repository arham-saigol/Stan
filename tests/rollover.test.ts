import pino from "pino";
import { Temporal } from "@js-temporal/polyfill";
import { describe, expect, it } from "vitest";
import { ApplicationDatabase } from "../src/storage/application-db.ts";
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
});
