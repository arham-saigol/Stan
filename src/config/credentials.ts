import { readFileSync } from "node:fs";
import * as v from "valibot";
import { atomicWritePrivate, statePaths } from "../state.ts";

const CredentialsSchema = v.strictObject({
  version: v.literal(1),
  xquikApiKey: v.optional(v.pipe(v.string(), v.minLength(1))),
  zernioApiKey: v.optional(v.pipe(v.string(), v.minLength(1))),
  firecrawlApiKey: v.optional(v.pipe(v.string(), v.minLength(1))),
  supermemoryApiKey: v.optional(v.pipe(v.string(), v.minLength(1))),
  controlToken: v.pipe(v.string(), v.minLength(32)),
});

export type ApiCredentials = v.InferOutput<typeof CredentialsSchema>;
export type ApiCredentialName = Exclude<
  keyof ApiCredentials,
  "version" | "controlToken"
>;

export class CredentialStore {
  readonly path: string;

  constructor(root: string) {
    this.path = statePaths(root).credentials;
  }

  read(): ApiCredentials {
    try {
      return v.parse(
        CredentialsSchema,
        JSON.parse(readFileSync(this.path, "utf8")),
      );
    } catch (error) {
      throw new Error("Stan API credentials are missing or invalid", {
        cause: error,
      });
    }
  }

  tryRead(): ApiCredentials | undefined {
    try {
      return this.read();
    } catch {
      return undefined;
    }
  }

  async update(
    values: Partial<Record<ApiCredentialName, string | undefined>>,
  ): Promise<ApiCredentials> {
    const current = this.tryRead();
    const next = v.parse(CredentialsSchema, {
      version: 1,
      controlToken:
        current?.controlToken ??
        crypto.randomUUID().replaceAll("-", "") +
          crypto.randomUUID().replaceAll("-", ""),
      ...current,
      ...Object.fromEntries(
        Object.entries(values).filter(
          ([, value]) => value !== undefined && value !== "",
        ),
      ),
    });
    await atomicWritePrivate(this.path, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }

  masked(): Record<string, string> {
    const current = this.tryRead();
    if (!current) return {};
    return Object.fromEntries(
      Object.entries(current)
        .filter(([name]) => name !== "version" && name !== "controlToken")
        .map(([name, value]) => [
          name,
          typeof value === "string" ? "configured" : "not set",
        ]),
    );
  }
}
