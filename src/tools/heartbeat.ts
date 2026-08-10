import { defineTool, type ToolDefinition } from "@flue/runtime";
import * as v from "valibot";
import type { ApplicationDatabase } from "../storage/application-db.ts";
import type { TrustedDeliveryContext } from "./types.ts";

const reasons = [
  "opportunity",
  "performance_change",
  "scheduled_post_update",
  "unfinished_work",
  "useful_check_in",
  "nothing_useful",
] as const;

export function heartbeatTools(
  database: ApplicationDatabase,
  trusted: TrustedDeliveryContext,
): ToolDefinition[] {
  return [
    defineTool({
      name: "heartbeat_respond",
      description:
        "Finish a heartbeat with one structured notify-or-silent decision. Morning runs must notify with a model-written message.",
      input: v.object({
        notify: v.boolean(),
        message: v.optional(v.string()),
        reason: v.picklist(reasons),
      }),
      async run({ data }) {
        if (trusted.kind !== "heartbeat" || !trusted.occurrenceId)
          throw new Error(
            "heartbeat_respond is only valid during a heartbeat run",
          );
        if (data.notify && !data.message?.trim())
          throw new Error("A notifying heartbeat needs a message");
        if (trusted.isMorning && (!data.notify || !data.message?.trim()))
          throw new Error(
            "The morning heartbeat must send one model-written message",
          );
        database.database
          .prepare(
            `UPDATE heartbeat_occurrences SET status = ?, notify = ?, message = ?, reason = ?, lease_until = NULL, updated_at = ? WHERE occurrence_id = ?`,
          )
          .run(
            data.notify ? "ready" : "silent",
            data.notify ? 1 : 0,
            data.message ?? null,
            data.reason,
            new Date().toISOString(),
            trusted.occurrenceId,
          );
        return { output: { accepted: true }, terminate: true };
      },
    }),
  ];
}
