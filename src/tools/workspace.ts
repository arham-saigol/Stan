import { defineTool, type ToolDefinition } from "@flue/runtime";
import * as v from "valibot";
import type { WorkspaceStore } from "../workspace/store.ts";
import type { ApplicationDatabase } from "../storage/application-db.ts";
import { workspaceMutationPayload } from "../gateway/owner-authorization.ts";
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
  database: ApplicationDatabase,
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
        "Atomically replace exact text or append bounded text after the owner sends `edit workspace: {exact JSON matching these fields}`. Creates a repairable backup.",
      input: v.object({
        file: fileSchema,
        operation: v.picklist(["replace", "append"]),
        oldText: v.optional(v.string()),
        text: v.string(),
      }),
      async run({ data }) {
        if (trusted.kind !== "owner" || !trusted.sourceMessageId)
          throw new Error(
            "Workspace edits require a current authenticated owner message",
          );
        const source = trusted.sourceMessageId;
        if (data.operation === "replace" && data.oldText === undefined)
          throw new Error("A replace edit requires oldText");
        database.consumeWorkspaceAuthorization(
          trusted.sourceMessageId,
          workspaceMutationPayload(data),
        );
        const edit =
          data.operation === "replace"
            ? {
                operation: "replace" as const,
                oldText: data.oldText!,
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
