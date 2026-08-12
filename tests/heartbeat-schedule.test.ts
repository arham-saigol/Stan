import { describe, expect, it } from "vitest";
import type { StanConfig } from "../src/config/schema.ts";
import { createDefaultConfig } from "../src/config/store.ts";
import {
  dueHeartbeat,
  heartbeatScheduleForDate,
} from "../src/scheduler/heartbeat.ts";

const config: StanConfig = createDefaultConfig({ ownerPhone: "+923001234567" });

describe("Pakistan-time heartbeat cadence", () => {
  it("anchors the overnight schedule at 09:00 without a second morning run", () => {
    const schedule = heartbeatScheduleForDate("2026-08-13", config.heartbeat);

    expect(schedule.map((occurrence) => occurrence.localTime)).toEqual([
      "09:00",
      "12:00",
      "15:00",
      "18:00",
      "21:00",
      "00:00",
    ]);
    expect(schedule.map((occurrence) => occurrence.kind)).toEqual([
      "morning",
      "regular",
      "regular",
      "regular",
      "regular",
      "regular",
    ]);
    expect(schedule.at(-1)?.localDate).toBe("2026-08-14");
  });

  it("keeps both endpoints unique for an all-day schedule", () => {
    const schedule = heartbeatScheduleForDate("2026-08-13", {
      ...config.heartbeat,
      startTime: "09:00",
      endTime: "09:00",
      intervalMinutes: 1440,
    });

    expect(schedule).toHaveLength(2);
    expect(new Set(schedule.map((occurrence) => occurrence.id)).size).toBe(2);
  });

  it("runs no heartbeat from 02:00 until 09:00", () => {
    expect(
      dueHeartbeat("2026-08-13T21:30:00Z", config.heartbeat),
    ).toBeUndefined(); // 02:30 PKT
    expect(
      dueHeartbeat("2026-08-14T03:30:00Z", config.heartbeat),
    ).toBeUndefined(); // 08:30 PKT
  });

  it("allows one morning startup catch-up but never burst-replays regular ticks", () => {
    const morning = dueHeartbeat("2026-08-13T05:00:00Z", config.heartbeat); // 10:00 PKT
    const late = dueHeartbeat("2026-08-13T10:10:00Z", config.heartbeat); // 15:10 PKT

    expect(morning).toMatchObject({ kind: "morning", localTime: "09:00" });
    expect(late).toBeUndefined();
    expect(
      dueHeartbeat("2026-08-13T05:00:00Z", config.heartbeat, {
        completedOccurrenceIds: new Set([morning!.id]),
      }),
    ).toBeUndefined();
  });
});
