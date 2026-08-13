import { parsePhoneNumberFromString } from "libphonenumber-js";
import * as v from "valibot";

export const TIMEZONE = "Asia/Karachi" as const;
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

const TimeSchema = v.pipe(
  v.string(),
  v.regex(timePattern, "Time must use HH:mm"),
);

export const ConfigSchema = v.strictObject({
  version: v.literal(1),
  timezone: v.literal(TIMEZONE),
  ownerPhone: v.pipe(
    v.string(),
    v.regex(/^\+92\d{10}$/, "Owner phone must be Pakistani E.164"),
  ),
  model: v.strictObject({
    provider: v.literal("openai-codex"),
    id: v.pipe(v.string(), v.minLength(1)),
    thinkingLevel: v.picklist([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]),
  }),
  heartbeat: v.strictObject({
    enabled: v.boolean(),
    startTime: TimeSchema,
    endTime: TimeSchema,
    intervalMinutes: v.pipe(
      v.number(),
      v.integer(),
      v.minValue(30, "Heartbeat interval must be at least 30 minutes"),
      v.maxValue(1440),
    ),
    morningCatchupMinutes: v.pipe(
      v.number(),
      v.integer(),
      v.minValue(0),
      v.maxValue(720),
    ),
  }),
  sessionRolloverTime: v.literal("00:01"),
  selectedXAccountId: v.optional(v.pipe(v.string(), v.minLength(1))),
  memoryContainerTag: v.pipe(v.string(), v.regex(/^stan_[a-z0-9]{24}$/)),
});

export type StanConfig = v.InferOutput<typeof ConfigSchema>;

export function parseConfig(input: unknown): StanConfig {
  return v.parse(ConfigSchema, input);
}

export function normalizeOwnerPhone(input: string): string {
  const trimmed = input.trim();
  const candidate = trimmed.startsWith("+")
    ? trimmed
    : `+92${trimmed.replace(/^0/, "")}`;
  const parsed = parsePhoneNumberFromString(candidate);
  if (!parsed?.isValid() || parsed.country !== "PK") {
    throw new Error("Owner phone must be a valid Pakistani number");
  }
  return parsed.number;
}
