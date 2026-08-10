import type { AuthorizationOperation } from "../storage/application-db.ts";

export interface DerivedAuthorization {
  operation: AuthorizationOperation;
  targetPostId?: string;
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
  if (!isTargetedMutation(operation)) return { operation };
  const targetPostId = extractTargetPostId(`${text}\n${quotedText ?? ""}`);
  return targetPostId ? { operation, targetPostId } : undefined;
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
