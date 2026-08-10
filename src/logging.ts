import { renameSync, statSync } from "node:fs";
import { chmod, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import pino, { type Logger } from "pino";

const sensitiveKey =
  /(?:api[-_]?key|authorization|access[-_]?token|refresh[-_]?token|password|secret|cookie|credential|webhook[-_]?secret|\bcode\b)/i;
const sensitiveQuery =
  /^(?:code|token|access_token|refresh_token|api_key|key|signature)$/i;

export function redactForLogging(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === "string") return sanitizeString(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value))
    return value.map((item) => redactForLogging(item, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      sensitiveKey.test(key) ? "[REDACTED]" : redactForLogging(nested, seen),
    ]),
  );
}

export async function createLogger(
  logDirectory: string,
  level = "info",
): Promise<Logger> {
  await mkdir(logDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(logDirectory, 0o700);
  const path = join(logDirectory, "stan.log");
  rotate(path);
  const file = await open(path, "a", 0o600);
  await file.close();
  if (process.platform !== "win32") await chmod(path, 0o600);
  const destination = pino.destination({
    dest: path,
    sync: false,
    mkdir: true,
  });
  return pino(
    {
      level,
      base: { service: "stan" },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        log: (object) => redactForLogging(object) as Record<string, unknown>,
      },
      hooks: {
        logMethod(arguments_, method) {
          const sanitized = arguments_.map((argument) =>
            redactForLogging(argument),
          );
          method.apply(this, sanitized as Parameters<typeof method>);
        },
      },
    },
    destination,
  );
}

function sanitizeString(value: string): string {
  let result = value
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|xq|fc)[-_][A-Za-z0-9._-]{8,}/g, "[REDACTED]")
    .replace(
      /([?&](?:code|token|access_token|refresh_token|api_key|key|signature)=)[^&\s]+/gi,
      "$1[REDACTED]",
    );
  if (/^https?:\/\//i.test(result)) {
    try {
      const url = new URL(result);
      for (const key of url.searchParams.keys()) {
        if (sensitiveQuery.test(key)) url.searchParams.set(key, "[REDACTED]");
      }
      result = url.toString();
    } catch {
      // It was not a complete URL; the string patterns above still apply.
    }
  }
  return result;
}

function rotate(path: string): void {
  try {
    if (statSync(path).size < 5 * 1024 * 1024) return;
  } catch {
    return;
  }
  for (let index = 4; index >= 1; index -= 1) {
    try {
      renameSync(`${path}.${index}`, `${path}.${index + 1}`);
    } catch {
      // Missing generations are expected.
    }
  }
  renameSync(path, `${path}.1`);
}
