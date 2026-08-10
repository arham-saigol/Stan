import { defineTool, type ToolDefinition } from "@flue/runtime";
import * as v from "valibot";
import type { AutomationStore } from "../scheduler/automations.ts";
import type { TrustedDeliveryContext } from "./types.ts";

export function automationTools(
  store: AutomationStore,
  trusted: TrustedDeliveryContext,
): ToolDefinition[] {
  const requireOwner = () => {
    if (trusted.kind !== "owner" || !trusted.sourceMessageId)
      throw new Error("Automation changes require a current owner message");
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
        "Create a bounded declarative one-shot or cron automation in Asia/Karachi. It cannot execute shell or grant X writes.",
      input: v.variant("scheduleType", [
        v.object({
          name: v.string(),
          scheduleType: v.literal("once"),
          at: v.string(),
          instruction: v.string(),
          deliveryMode: v.picklist(["silent", "owner_whatsapp"]),
        }),
        v.object({
          name: v.string(),
          scheduleType: v.literal("cron"),
          expression: v.string(),
          instruction: v.string(),
          deliveryMode: v.picklist(["silent", "owner_whatsapp"]),
        }),
      ]),
      async run({ data }) {
        const creatorMessageId = requireOwner();
        const schedule =
          data.scheduleType === "once"
            ? { type: "once" as const, at: data.at }
            : { type: "cron" as const, expression: data.expression };
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
        "Pause or enable one existing automation from the current owner turn.",
      input: v.object({ id: v.string(), enabled: v.boolean() }),
      async run({ data }) {
        requireOwner();
        return { output: store.setEnabled(data.id, data.enabled) };
      },
    }),
    defineTool({
      name: "delete_automation",
      description:
        "Delete one declarative automation from the current owner turn.",
      input: v.object({ id: v.string() }),
      async run({ data }) {
        requireOwner();
        return { output: { deleted: store.delete(data.id) } };
      },
    }),
  ];
}
