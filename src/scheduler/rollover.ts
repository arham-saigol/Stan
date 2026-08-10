import { Temporal } from "@js-temporal/polyfill";
import { TIMEZONE } from "../config/schema.ts";

export function pakistanRoutingDate(
  instant: string | Temporal.Instant,
): string {
  const value =
    typeof instant === "string" ? Temporal.Instant.from(instant) : instant;
  const local = value.toZonedDateTimeISO(TIMEZONE);
  const date =
    local.hour === 0 && local.minute < 1
      ? local.toPlainDate().subtract({ days: 1 })
      : local.toPlainDate();
  return date.toString();
}

export function dailySessionId(instant: string | Temporal.Instant): string {
  return `stan-owner-${pakistanRoutingDate(instant)}`;
}
