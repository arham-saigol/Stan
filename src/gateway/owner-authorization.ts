import type {
  AuthorizationOperation,
  AutomationAuthorizationOperation,
} from "../storage/application-db.ts";

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

export interface DerivedWorkspaceAuthorization {
  payloadJson: string;
}

const prefixes =
  /^(?:(?:(?:yes|okay|ok|please|stan)[,.!]?|(?:can|could|would)\s+you|go\s+ahead(?:\s+and)?)\s+)*/i;
const command =
  /^(post|publish|tweet|schedule|queue|reply|respond|edit|cancel|unschedule|delete|unpublish)\b/i;
const futureTime =
  /\b(?:tomorrow|tonight|later|next\s+\w+|after\s+\w+|at\s+(?:the\s+)?(?:best|optimal)\s+time|at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?|on\s+(?:mon|tues|wednes|thurs|fri|satur|sun)day|on\s+\d{4}-\d{2}-\d{2})\b/i;

export function deriveAuthorizationOperation(
  text: string,
): AuthorizationOperation | undefined {
  const normalized = text.trim().replace(prefixes, "");
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
    return /\b(?:x|post|tweet)\b/i.test(normalized) ? "schedule" : undefined;
  }
  if (operation === "reply" || operation === "respond") {
    return /\b(?:x|post|tweet|this|that|it|thread)\b|@\w+|https?:\/\//i.test(
      normalized,
    )
      ? "reply"
      : undefined;
  }
  if (operation === "edit") {
    return /\b(?:x|post|tweet|published|live|zernio|status\/\d+)\b/i.test(
      normalized,
    )
      ? "edit"
      : undefined;
  }
  if (operation === "cancel" || operation === "unschedule") {
    return operation === "unschedule" ||
      /\b(?:x|post|tweet|publication|zernio)\b/i.test(normalized)
      ? "cancel"
      : undefined;
  }
  if (operation === "delete" || operation === "unpublish") {
    return operation === "unpublish" ||
      /\b(?:x|post|tweet|publication|zernio)\b/i.test(normalized)
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
  const authorizedContent = contentOperation(operation)
    ? quotedText?.trim()
    : undefined;
  if (contentOperation(operation) && !authorizedContent) return undefined;
  const authorizedScheduledFor =
    operation === "schedule" ? extractScheduledInstant(text) : undefined;
  if (operation === "schedule" && !authorizedScheduledFor) return undefined;
  if (!isTargetedMutation(operation)) {
    return {
      operation,
      ...(authorizedContent ? { authorizedContent } : {}),
      ...(authorizedScheduledFor ? { authorizedScheduledFor } : {}),
    };
  }
  const targetPostId = extractTargetPostId(`${text}\n${quotedText ?? ""}`);
  return targetPostId
    ? {
        operation,
        targetPostId,
        ...(authorizedContent ? { authorizedContent } : {}),
      }
    : undefined;
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

export function deriveWorkspaceAuthorization(
  text: string,
): DerivedWorkspaceAuthorization | undefined {
  const normalized = text.trim().replace(prefixes, "");
  const match = /^edit\s+workspace\s*:\s*(\{.*\})$/is.exec(normalized);
  if (!match) return undefined;
  try {
    return {
      payloadJson: workspaceMutationPayload(
        JSON.parse(match[1]!) as Record<string, unknown>,
      ),
    };
  } catch {
    return undefined;
  }
}

export function workspaceMutationPayload(
  input: Record<string, unknown>,
): string {
  const files = new Set([
    "goals",
    "strategy",
    "playbook",
    "heartbeats",
    "watchlist",
    "voice_profile",
    "voice_examples",
  ]);
  if (
    typeof input.file !== "string" ||
    !files.has(input.file) ||
    (input.operation !== "replace" && input.operation !== "append") ||
    typeof input.text !== "string" ||
    (input.operation === "replace" && typeof input.oldText !== "string")
  ) {
    throw new Error("Workspace confirmation payload is invalid");
  }
  return JSON.stringify({
    file: input.file,
    operation: input.operation,
    ...(input.operation === "replace" ? { oldText: input.oldText } : {}),
    text: input.text,
  });
}

function contentOperation(operation: AuthorizationOperation): boolean {
  return (
    operation === "publish" ||
    operation === "schedule" ||
    operation === "reply" ||
    operation === "edit"
  );
}

function extractScheduledInstant(text: string): string | undefined {
  const match =
    /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))\b/i.exec(
      text,
    );
  if (!match || !Number.isFinite(Date.parse(match[1]!))) return undefined;
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
