import type {
  AuthorizationOperation,
  AutomationAuthorizationOperation,
  MemoryAuthorizationOperation,
} from "../storage/application-db.ts";
import { Temporal } from "@js-temporal/polyfill";

export interface DerivedAuthorization {
  operation: AuthorizationOperation;
  targetPostId?: string;
  authorizedContent?: string;
  authorizedScheduledFor?: string;
}

export interface DerivedAutomationAuthorization {
  operation: AutomationAuthorizationOperation;
  payloadJson: string;
}

export interface DerivedMemoryAuthorization {
  operation: MemoryAuthorizationOperation;
  payloadJson: string;
}

export interface DerivedHeartbeatSettingsAuthorization {
  payloadJson: string;
}

const prefixes =
  /^(?:(?:(?:yes|okay|ok|please|stan)[,.!]?|(?:can|could|would)\s+you|go\s+ahead(?:\s+and)?)\s+)*/i;
const command =
  /^(post|publish|tweet|schedule|queue|reply|respond|edit|cancel|unschedule|delete|unpublish)\b/i;
const futureTime =
  /\b(?:tomorrow|tonight|later|next\s+\w+|after\s+\w+|at\s+(?:the\s+)?(?:best|optimal)\s+time|at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?|on\s+(?:mon|tues|wednes|thurs|fri|satur|sun)day|on\s+\d{4}-\d{2}-\d{2})\b/i;
const selection =
  /\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|next|last)\b|#\s*\d{1,2}\b|\b(?:the\s+|number\s+|item\s+|option\s+)(?:one|two|three|four|five|six|seven|eight|nine|ten|\d{1,2}(?:st|nd|rd|th)?)\b|(?<![\d:+-])\d{1,2}(?:st|nd|rd|th)?\b(?![\d:])/i;

export function deriveAuthorizationOperation(
  text: string,
): AuthorizationOperation | undefined {
  const normalized = text.trim().replace(prefixes, "");
  if (
    /^(?:(?:create|add|schedule)\s+automation|set\s+up\s+automation|(?:pause|disable|enable|resume|delete|remove)\s+automation\b|cancel\s+(?:this|that|the)?\s*automation\b|(?:cancel|delete)\s+(?:this|that|the)?\s*(?:memory|reminder|note|file)\b|schedule\s+(?:this|that|the)?\s*reminder\b|edit\s+workspace\b|update\s+heartbeat\b|forget\s+memory\b|remember\s*:)/i.test(
      normalized,
    )
  )
    return undefined;
  const match = command.exec(normalized);
  if (!match) {
    return /^save\s+(?:this|that|it)?\s*(?:as\s+)?(?:an?\s+)?(?:x\s+)?draft\b/i.test(
      normalized,
    )
      ? "draft"
      : undefined;
  }
  const operation = match[1]!.toLowerCase();
  if (
    operation === "post" ||
    operation === "publish" ||
    operation === "tweet"
  ) {
    return futureTime.test(normalized) ? "schedule" : "publish";
  }
  if (operation === "schedule" || operation === "queue") {
    return /\b(?:x|post|tweet|this|that|it|one|them)\b/i.test(normalized) ||
      selection.test(normalized)
      ? "schedule"
      : undefined;
  }
  if (operation === "reply" || operation === "respond") {
    return /\b(?:x|post|tweet|this|that|it|them|him|her|thread)\b|@\w+|https?:\/\//i.test(
      normalized,
    ) || selection.test(normalized)
      ? "reply"
      : undefined;
  }
  if (operation === "edit") {
    return /\b(?:x|post|tweet|published|live|zernio|status\/\d+|it|that|them|him|her)\b/i.test(
      normalized,
    ) || selection.test(normalized)
      ? "edit"
      : undefined;
  }
  if (operation === "cancel" || operation === "unschedule") {
    return operation === "unschedule" ||
      /\b(?:x|post|tweet|publication|zernio|scheduled|it|that|them|him|her)\b/i.test(
        normalized,
      ) ||
      selection.test(normalized)
      ? "cancel"
      : undefined;
  }
  if (operation === "delete" || operation === "unpublish") {
    return operation === "unpublish" ||
      /\b(?:x|post|tweet|publication|zernio|it|that|them|him|her)\b/i.test(
        normalized,
      ) ||
      selection.test(normalized)
      ? "delete"
      : undefined;
  }
  return operation as AuthorizationOperation;
}

export function deriveAuthorization(
  text: string,
  quotedText?: string,
): DerivedAuthorization | undefined {
  const operation = deriveAuthorizationOperation(text);
  if (!operation) return undefined;
  const quoted = quotedText?.trim();
  const referenced = selection.test(text);
  // The owner's quoted text binds the content verbatim for draft/publish/schedule
  // unless the command points at a numbered item instead ("post the second one").
  // Reply/edit content is never bound: the quoted text there is usually the target.
  const authorizedContent =
    (operation === "draft" ||
      operation === "publish" ||
      operation === "schedule") &&
    quoted &&
    !referenced &&
    quoted.length <= 25_000
      ? quoted
      : undefined;
  const authorizedScheduledFor =
    operation === "schedule" ? extractScheduledInstant(text) : undefined;
  // A verbatim but invalid ISO instant must not be silently reinterpreted.
  if (
    operation === "schedule" &&
    /\b\d{4}-\d{2}-\d{2}T/.test(text) &&
    !authorizedScheduledFor
  )
    return undefined;
  if (!isTargetedMutation(operation)) {
    return {
      operation,
      ...(authorizedContent ? { authorizedContent } : {}),
      ...(authorizedScheduledFor ? { authorizedScheduledFor } : {}),
    };
  }
  const targetPostId =
    extractTargetPostId(text) ?? extractTargetPostId(quotedText ?? "");
  return {
    operation,
    ...(targetPostId ? { targetPostId } : {}),
  };
}

export function deriveAutomationAuthorization(
  text: string,
): DerivedAutomationAuthorization | undefined {
  const normalized = text.trim().replace(prefixes, "");
  const create =
    /^(?:create|add|schedule|set\s+up)\s+automation\s*:\s*(\{.*\})$/is.exec(
      normalized,
    );
  if (create) {
    try {
      return {
        operation: "create",
        payloadJson: automationMutationPayload(
          "create",
          JSON.parse(create[1]!) as Record<string, unknown>,
        ),
      };
    } catch {
      return undefined;
    }
  }
  const enabled =
    /^(pause|disable|enable|resume)\s+automation\s+([A-Za-z0-9_-]{1,200})$/i.exec(
      normalized,
    );
  if (enabled) {
    return {
      operation: "set_enabled",
      payloadJson: automationMutationPayload("set_enabled", {
        id: enabled[2]!,
        enabled: /^(?:enable|resume)$/i.test(enabled[1]!),
      }),
    };
  }
  const deletion =
    /^(?:delete|remove)\s+automation\s+([A-Za-z0-9_-]{1,200})$/i.exec(
      normalized,
    );
  if (deletion) {
    return {
      operation: "delete",
      payloadJson: automationMutationPayload("delete", { id: deletion[1]! }),
    };
  }
  return undefined;
}

export function automationMutationPayload(
  operation: AutomationAuthorizationOperation,
  input: Record<string, unknown>,
): string {
  if (operation === "create") {
    const scheduleType = input.scheduleType;
    const allowed = new Set([
      "name",
      "scheduleType",
      scheduleType === "once" ? "at" : "expression",
      "instruction",
      "deliveryMode",
    ]);
    if (Object.keys(input).some((key) => !allowed.has(key)))
      throw new Error("Automation confirmation contains unsupported fields");
    if (
      typeof input.name !== "string" ||
      (scheduleType !== "once" && scheduleType !== "cron") ||
      typeof input.instruction !== "string" ||
      (input.deliveryMode !== "silent" &&
        input.deliveryMode !== "owner_whatsapp")
    )
      throw new Error("Automation confirmation payload is invalid");
    const scheduleValue = scheduleType === "once" ? input.at : input.expression;
    if (typeof scheduleValue !== "string")
      throw new Error("Automation schedule confirmation is incomplete");
    return JSON.stringify({
      name: input.name,
      scheduleType,
      ...(scheduleType === "once"
        ? { at: scheduleValue }
        : { expression: scheduleValue }),
      instruction: input.instruction,
      deliveryMode: input.deliveryMode,
    });
  }
  if (typeof input.id !== "string")
    throw new Error("Automation target confirmation is invalid");
  if (operation === "set_enabled") {
    if (typeof input.enabled !== "boolean")
      throw new Error("Automation state confirmation is invalid");
    return JSON.stringify({ id: input.id, enabled: input.enabled });
  }
  return JSON.stringify({ id: input.id });
}

export function deriveMemoryAuthorization(
  text: string,
): DerivedMemoryAuthorization | undefined {
  const normalized = text.trim().replace(prefixes, "");
  const remember = /^remember\s*:\s*(.+)$/is.exec(normalized);
  if (remember) {
    try {
      return {
        operation: "remember",
        payloadJson: memoryMutationPayload("remember", {
          content: remember[1]!.trim(),
        }),
      };
    } catch {
      return undefined;
    }
  }
  const forget = /^forget\s+memory\s+([^\s]{1,200})$/i.exec(normalized);
  return forget
    ? {
        operation: "forget",
        payloadJson: memoryMutationPayload("forget", {
          documentId: forget[1]!,
        }),
      }
    : undefined;
}

export function memoryMutationPayload(
  operation: MemoryAuthorizationOperation,
  input: Record<string, unknown>,
): string {
  if (operation === "remember") {
    if (
      typeof input.content !== "string" ||
      input.content.length < 1 ||
      input.content.length > 20_000
    )
      throw new Error("Memory confirmation content is invalid");
    return JSON.stringify({ content: input.content });
  }
  if (
    typeof input.documentId !== "string" ||
    input.documentId.length < 1 ||
    input.documentId.length > 200
  )
    throw new Error("Memory confirmation target is invalid");
  return JSON.stringify({ documentId: input.documentId });
}

export function deriveHeartbeatSettingsAuthorization(
  text: string,
): DerivedHeartbeatSettingsAuthorization | undefined {
  const normalized = text.trim().replace(prefixes, "");
  const match = /^update\s+heartbeat\s*:\s*(\{.*\})$/is.exec(normalized);
  if (!match) return undefined;
  try {
    return {
      payloadJson: heartbeatSettingsMutationPayload(
        JSON.parse(match[1]!) as Record<string, unknown>,
      ),
    };
  } catch {
    return undefined;
  }
}

export function heartbeatSettingsMutationPayload(
  input: Record<string, unknown>,
): string {
  const keys = [
    "enabled",
    "startTime",
    "endTime",
    "intervalMinutes",
    "morningCatchupMinutes",
  ] as const;
  if (!keys.some((key) => input[key] !== undefined))
    throw new Error("Heartbeat settings confirmation is empty");
  if (
    Object.keys(input).some(
      (key) => !keys.includes(key as (typeof keys)[number]),
    ) ||
    (input.enabled !== undefined && typeof input.enabled !== "boolean") ||
    !validOptionalTime(input.startTime) ||
    !validOptionalTime(input.endTime) ||
    !validOptionalInteger(input.intervalMinutes, 30, 1440) ||
    !validOptionalInteger(input.morningCatchupMinutes, 0, 720)
  )
    throw new Error("Heartbeat settings confirmation is invalid");
  return JSON.stringify(
    Object.fromEntries(
      keys.flatMap((key) =>
        input[key] === undefined ? [] : [[key, input[key]]],
      ),
    ),
  );
}

function validOptionalTime(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))
  );
}

function validOptionalInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): boolean {
  return (
    value === undefined ||
    (typeof value === "number" &&
      Number.isInteger(value) &&
      value >= minimum &&
      value <= maximum)
  );
}

function extractScheduledInstant(text: string): string | undefined {
  const match =
    /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))\b/i.exec(
      text,
    );
  if (!match || !Number.isFinite(Date.parse(match[1]!))) return undefined;
  try {
    Temporal.PlainDate.from(match[1]!.slice(0, 10));
  } catch {
    return undefined;
  }
  return new Date(match[1]!).toISOString();
}

function isTargetedMutation(operation: AuthorizationOperation): boolean {
  return (
    operation === "reply" ||
    operation === "edit" ||
    operation === "cancel" ||
    operation === "delete"
  );
}

function extractTargetPostId(text: string): string | undefined {
  const statusUrl =
    /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[^\s/]+\/status\/([A-Za-z0-9_-]{1,200})/i.exec(
      text,
    );
  if (statusUrl) return statusUrl[1];
  const labelled =
    /\b(?:provider(?:\s+post)?|zernio(?:\s+post)?|(?:x\s+)?(?:post|tweet))(?:\s+id)?\s*[:#]?\s+([A-Za-z_-]*\d[A-Za-z0-9_-]{0,199})\b/i.exec(
      text,
    );
  return labelled?.[1];
}
