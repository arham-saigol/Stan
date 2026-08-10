import { defineTool, type ToolDefinition } from "@flue/runtime";
import * as v from "valibot";
import type { AutomationStore } from "../scheduler/automations.ts";
import type { TrustedDeliveryContext } from "./types.ts";
import { automationMutationPayload } from "../gateway/owner-authorization.ts";

export function automationTools(
  store: AutomationStore,
  trusted: TrustedDeliveryContext,
): ToolDefinition[] {
  const requireOwner = (
    operation: "create" | "set_enabled" | "delete",
    input: Record<string, unknown>,
  ) => {
    if (trusted.kind !== "owner" || !trusted.sourceMessageId)
      throw new Error("Automation changes require a current owner message");
    store.consumeAuthorization(
      trusted.sourceMessageId,
      operation,
      automationMutationPayload(operation, input),
    );
    return trusted.sourceMessageId;
  };
  return [
    defineTool({
      name: "list_automations",
      description:
        "List authoritative one-shot and cron automations with next-run state.",
      async run() {
        return { output: store.list() };
      },
    }),
    defineTool({
      name: "create_automation",
      description:
        "Create a bounded declarative automation after the owner sends `create automation: {exact JSON matching these fields}`. It cannot execute shell or grant X writes.",
      input: v.object({
        name: v.string(),
        scheduleType: v.picklist(["once", "cron"]),
        at: v.optional(v.string()),
        expression: v.optional(v.string()),
        instruction: v.string(),
        deliveryMode: v.picklist(["silent", "owner_whatsapp"]),
      }),
      async run({ data }) {
        if (data.scheduleType === "once" && !data.at)
          throw new Error("A one-shot automation requires an exact time");
        if (data.scheduleType === "cron" && !data.expression)
          throw new Error("A cron automation requires an expression");
        const creatorMessageId = requireOwner("create", data);
        const schedule =
          data.scheduleType === "once"
            ? { type: "once" as const, at: data.at! }
            : { type: "cron" as const, expression: data.expression! };
        return {
          output: store.create({
            name: data.name,
            schedule,
            instruction: data.instruction,
            deliveryMode: data.deliveryMode,
            creatorMessageId,
          }),
        };
      },
    }),
    defineTool({
      name: "set_automation_enabled",
      description:
        "Pause or enable only after an exact `pause automation <id>` or `enable automation <id>` owner command.",
      input: v.object({ id: v.string(), enabled: v.boolean() }),
      async run({ data }) {
        requireOwner("set_enabled", data);
        return { output: store.setEnabled(data.id, data.enabled) };
      },
    }),
    defineTool({
      name: "delete_automation",
      description:
        "Delete only after an exact `delete automation <id>` owner command.",
      input: v.object({ id: v.string() }),
      async run({ data }) {
        requireOwner("delete", data);
        return { output: { deleted: store.delete(data.id) } };
      },
    }),
  ];
}
