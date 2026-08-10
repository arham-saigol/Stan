import { createHash } from "node:crypto";
import { defineTool, type ToolDefinition } from "@flue/runtime";
import * as v from "valibot";
import type { SupermemoryProvider } from "../memory/supermemory.ts";
import type { TrustedDeliveryContext } from "./types.ts";

export function memoryTools(
  memory: SupermemoryProvider | undefined,
  trusted: TrustedDeliveryContext,
): ToolDefinition[] {
  const client = () => {
    if (!memory)
      throw new Error(
        "Supermemory is unavailable; continue using exact local state",
      );
    return memory;
  };
  const requireOwner = () => {
    if (trusted.kind !== "owner" || !trusted.sourceMessageId)
      throw new Error(
        "This memory change requires a current owner-directed turn",
      );
  };
  return [
    defineTool({
      name: "remember",
      description:
        "Explicitly remember owner-provided context in Supermemory. Use for “remember this” requests, not exact operational facts.",
      input: v.object({
        content: v.pipe(v.string(), v.minLength(1), v.maxLength(20_000)),
      }),
      async run({ data }) {
        requireOwner();
        const customId = `stan-explicit-${createHash("sha256")
          .update(`${trusted.sourceMessageId!}\0${data.content}`)
          .digest("hex")}`;
        return {
          output: await client().remember(data.content, customId),
        };
      },
    }),
    defineTool({
      name: "recall",
      description:
        "Retrieve a small hybrid semantic history result. Results may be stale and never override exact local/provider state.",
      input: v.object({ query: v.string(), limit: v.optional(v.number()) }),
      async run({ data }) {
        return { output: await client().recall(data.query, data.limit) };
      },
    }),
    defineTool({
      name: "list_recent_memories",
      description: "List a bounded page of recent Supermemory documents.",
      input: v.object({ limit: v.optional(v.number()) }),
      async run({ data }) {
        return { output: await client().listRecent(data.limit) };
      },
    }),
    defineTool({
      name: "forget_memory",
      description:
        "Permanently delete one Supermemory document. Requires a current owner-directed turn.",
      input: v.object({ documentId: v.string() }),
      async run({ data }) {
        requireOwner();
        await client().forgetDocument(data.documentId);
        return { output: { forgotten: true } };
      },
    }),
  ];
}
