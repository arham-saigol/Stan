import { defineTool, type ToolDefinition } from "@flue/runtime";
import * as v from "valibot";
import type { ConfigStore } from "../config/store.ts";
import type { ApplicationDatabase } from "../storage/application-db.ts";
import { heartbeatSettingsMutationPayload } from "../gateway/owner-authorization.ts";
import type { TrustedDeliveryContext } from "./types.ts";

export function settingsTools(
  store: ConfigStore,
  database: ApplicationDatabase,
  trusted: TrustedDeliveryContext,
): ToolDefinition[] {
  const requireOwner = () => {
    if (trusted.kind !== "owner" || !trusted.sourceMessageId)
      throw new Error("Heartbeat settings require a current owner message");
    return trusted.sourceMessageId;
  };
  return [
    defineTool({
      name: "get_heartbeat_settings",
      description:
        "Read current authoritative heartbeat settings and next-cadence inputs.",
      async run() {
        return { output: store.read().heartbeat };
      },
    }),
    defineTool({
      name: "update_heartbeat_settings",
      description:
        "Update heartbeat enabled state, active hours, cadence, or catch-up grace after an exact `update heartbeat: {JSON matching these fields}` owner command.",
      input: v.object({
        enabled: v.optional(v.boolean()),
        startTime: v.optional(
          v.pipe(v.string(), v.regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)),
        ),
        endTime: v.optional(
          v.pipe(v.string(), v.regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)),
        ),
        intervalMinutes: v.optional(
          v.pipe(v.number(), v.integer(), v.minValue(30), v.maxValue(1440)),
        ),
        morningCatchupMinutes: v.optional(
          v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(720)),
        ),
      }),
      async run({ data }) {
        database.consumeHeartbeatSettingsAuthorization(
          requireOwner(),
          heartbeatSettingsMutationPayload(data),
        );
        const updated = await store.update((current) => ({
          ...current,
          heartbeat: { ...current.heartbeat, ...data },
        }));
        return { output: updated.heartbeat };
      },
    }),
  ];
}
