import { Temporal } from "@js-temporal/polyfill";
import { TIMEZONE, type StanConfig } from "../config/schema.ts";

export interface HeartbeatOccurrence {
  id: string;
  anchorDate: string;
  localDate: string;
  localTime: string;
  scheduledFor: string;
  kind: "morning" | "regular";
}

type HeartbeatConfig = StanConfig["heartbeat"];

export function heartbeatScheduleForDate(
  anchorDate: string,
  config: HeartbeatConfig,
): HeartbeatOccurrence[] {
  if (!config.enabled) return [];
  const startDate = Temporal.PlainDate.from(anchorDate);
  const [startHour, startMinute] = parseTime(config.startTime);
  const [endHour, endMinute] = parseTime(config.endTime);
  const start = startDate.toZonedDateTime({
    timeZone: TIMEZONE,
    plainTime: { hour: startHour, minute: startMinute },
  });
  let endDate = startDate;
  const startMinutes = startHour * 60 + startMinute;
  const endMinutes = endHour * 60 + endMinute;
  if (endMinutes <= startMinutes) endDate = endDate.add({ days: 1 });
  const end = endDate.toZonedDateTime({
    timeZone: TIMEZONE,
    plainTime: { hour: endHour, minute: endMinute },
  });
  const occurrences: HeartbeatOccurrence[] = [];
  for (
    let at = start;
    startMinutes === endMinutes
      ? Temporal.ZonedDateTime.compare(at, end) < 0
      : Temporal.ZonedDateTime.compare(at, end) <= 0;
    at = at.add({ minutes: config.intervalMinutes })
  ) {
    const localTime = `${pad(at.hour)}:${pad(at.minute)}`;
    const kind = occurrences.length === 0 ? "morning" : "regular";
    occurrences.push({
      id: `heartbeat:${anchorDate}:${at.toPlainDate().toString()}:${localTime}`,
      anchorDate,
      localDate: at.toPlainDate().toString(),
      localTime,
      scheduledFor: at.toInstant().toString(),
      kind,
    });
  }
  return occurrences;
}

export function dueHeartbeat(
  now: string | Temporal.Instant,
  config: HeartbeatConfig,
  options: {
    completedOccurrenceIds?: ReadonlySet<string>;
  } = {},
): HeartbeatOccurrence | undefined {
  if (!config.enabled) return undefined;
  const instant = typeof now === "string" ? Temporal.Instant.from(now) : now;
  const local = instant.toZonedDateTimeISO(TIMEZONE);
  const today = local.toPlainDate();
  const candidates = [
    ...heartbeatScheduleForDate(today.subtract({ days: 1 }).toString(), config),
    ...heartbeatScheduleForDate(today.toString(), config),
  ];
  const completed = options.completedOccurrenceIds ?? new Set<string>();
  const exact = candidates.find((occurrence) => {
    const scheduled = Temporal.Instant.from(occurrence.scheduledFor);
    return (
      Math.floor(scheduled.epochMilliseconds / 60_000) ===
      Math.floor(instant.epochMilliseconds / 60_000)
    );
  });
  if (exact && !completed.has(exact.id)) return exact;
  const morning = candidates.find(
    (occurrence) =>
      occurrence.kind === "morning" &&
      occurrence.localDate === today.toString(),
  );
  if (!morning || completed.has(morning.id)) return undefined;
  const elapsed = instant
    .since(Temporal.Instant.from(morning.scheduledFor))
    .total({ unit: "minutes" });
  return elapsed >= 0 && elapsed <= config.morningCatchupMinutes
    ? morning
    : undefined;
}

function parseTime(value: string): [number, number] {
  const [hour, minute] = value.split(":").map(Number);
  return [hour!, minute!];
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
