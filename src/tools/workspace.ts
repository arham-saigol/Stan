import { defineTool, type ToolDefinition } from "@flue/runtime";
import * as v from "valibot";
import type { WorkspaceStore } from "../workspace/store.ts";

const fileSchema = v.string();

export function workspaceTools(workspace: WorkspaceStore): ToolDefinition[] {
  return [
    defineTool({
      name: "list_workspace_files",
      description: "List available workspace documents by logical name.",
      async run() {
        return { output: { files: await workspace.list() } };
      },
    }),
    defineTool({
      name: "read_workspace_file",
      description: "Read one workspace document by logical name.",
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
        "Atomically replace exact text or append bounded text to a workspace document. Creates a repairable backup.",
      input: v.object({
        file: fileSchema,
        operation: v.picklist(["replace", "append"]),
        oldText: v.optional(v.string()),
        text: v.string(),
      }),
      async run({ data, toolCallId }) {
        if (data.operation === "replace" && data.oldText === undefined)
          throw new Error("A replace edit requires oldText");
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
            content: await workspace.edit(data.file, edit, toolCallId),
          },
        };
      },
    }),
    defineTool({
      name: "create_workspace_file",
      description:
        "Create a bounded workspace document under a new logical name.",
      input: v.object({ file: fileSchema, content: v.string() }),
      async run({ data, toolCallId }) {
        return {
          output: {
            file: data.file,
            content: await workspace.create(
              data.file,
              data.content,
              toolCallId,
            ),
          },
        };
      },
    }),
    defineTool({
      name: "delete_workspace_file",
      description: "Delete one workspace document by logical name.",
      input: v.object({ file: fileSchema }),
      async run({ data, toolCallId }) {
        await workspace.delete(data.file, toolCallId);
        return { output: { file: data.file, deleted: true } };
      },
    }),
  ];
}
