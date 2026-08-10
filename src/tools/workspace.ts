import { defineTool, type ToolDefinition } from "@flue/runtime";
import * as v from "valibot";
import type { WorkspaceStore } from "../workspace/store.ts";
import type { TrustedDeliveryContext } from "./types.ts";

const fileSchema = v.picklist([
  "goals",
  "strategy",
  "playbook",
  "heartbeats",
  "watchlist",
  "voice_profile",
  "voice_examples",
]);

export function workspaceTools(
  workspace: WorkspaceStore,
  trusted: TrustedDeliveryContext,
): ToolDefinition[] {
  return [
    defineTool({
      name: "read_workspace_file",
      description:
        "Read one allowlisted Stan operating document by logical name.",
      input: v.object({ file: fileSchema }),
      async run({ data }) {
        return {
          output: { file: data.file, content: await workspace.read(data.file) },
        };
      },
    }),
    defineTool({
      name: "edit_workspace_file",
      description:
        "Atomically replace exact text or append bounded text in one allowlisted operating document. Creates a repairable backup.",
      input: v.variant("operation", [
        v.object({
          file: fileSchema,
          operation: v.literal("replace"),
          oldText: v.string(),
          text: v.string(),
        }),
        v.object({
          file: fileSchema,
          operation: v.literal("append"),
          text: v.string(),
        }),
      ]),
      async run({ data }) {
        const source =
          trusted.sourceMessageId ?? trusted.occurrenceId ?? "system";
        const edit =
          data.operation === "replace"
            ? {
                operation: "replace" as const,
                oldText: data.oldText,
                text: data.text,
              }
            : { operation: "append" as const, text: data.text };
        return {
          output: {
            file: data.file,
            content: await workspace.edit(data.file, edit, source),
          },
        };
      },
    }),
  ];
}
