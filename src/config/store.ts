import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { atomicWritePrivate, statePaths } from "../state.ts";
import { parseConfig, TIMEZONE, type StanConfig } from "./schema.ts";

export class ConfigStore {
  readonly path: string;

  constructor(root: string) {
    this.path = statePaths(root).config;
  }

  read(): StanConfig {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      throw new Error(`Stan is not configured at ${this.path}`, {
        cause: error,
      });
    }
    try {
      return parseConfig(JSON.parse(raw));
    } catch (error) {
      throw new Error("Stan configuration is invalid", { cause: error });
    }
  }

  async write(input: unknown): Promise<StanConfig> {
    const config = parseConfig(input);
    await atomicWritePrivate(this.path, `${JSON.stringify(config, null, 2)}\n`);
    return config;
  }
}

export function createDefaultConfig(input: {
  ownerPhone: string;
  modelId?: string;
  thinkingLevel?: StanConfig["model"]["thinkingLevel"];
}): StanConfig {
  return parseConfig({
    version: 1,
    timezone: TIMEZONE,
    ownerPhone: input.ownerPhone,
    model: {
      provider: "openai-codex",
      id: input.modelId ?? "gpt-5.4",
      thinkingLevel: input.thinkingLevel ?? "medium",
    },
    heartbeat: {
      enabled: true,
      startTime: "09:00",
      endTime: "00:00",
      intervalMinutes: 180,
      morningCatchupMinutes: 120,
    },
    sessionRolloverTime: "00:01",
    memoryContainerTag: `stan_${randomBytes(12).toString("hex")}`,
  });
}
