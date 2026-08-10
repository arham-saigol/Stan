import { describe, expect, it } from "vitest";
import {
  proactiveDecision,
  recordProactiveSuggestion,
} from "../src/scheduler/proactive.ts";
import { ApplicationDatabase } from "../src/storage/application-db.ts";

describe("proactive notification policy", () => {
  it("suppresses exact repeat suggestions and enforces the daily regular-notification cap", () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    recordProactiveSuggestion(
      database,
      "A useful opportunity",
      new Date("2026-08-13T04:00:00Z"),
    );

    expect(
      proactiveDecision(database, "  a useful   opportunity ", "2026-08-13"),
    ).toBe("duplicate");

    for (const id of ["one", "two"]) {
      database.database
        .prepare(
          `INSERT INTO heartbeat_occurrences(occurrence_id, local_date, scheduled_for, kind, status, created_at, updated_at)
           VALUES (?, '2026-08-13', '2026-08-13T07:00:00Z', 'regular', 'notified', '2026-08-13T07:00:00Z', '2026-08-13T07:00:00Z')`,
        )
        .run(id);
    }
    expect(proactiveDecision(database, "Something new", "2026-08-13")).toBe(
      "notification_budget",
    );
    database.close();
  });
});
