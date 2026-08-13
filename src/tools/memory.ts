import { createHash } from "node:crypto";
import { defineTool, type ToolDefinition } from "@flue/runtime";
import * as v from "valibot";
import type { SupermemoryProvider } from "../memory/supermemory.ts";
import type { ApplicationDatabase } from "../storage/application-db.ts";
import { memoryMutationPayload } from "../gateway/owner-authorization.ts";
import type { TrustedDeliveryContext } from "./types.ts";

export function memoryTools(
  memory: SupermemoryProvider | undefined,
  database: ApplicationDatabase,
  trusted: TrustedDeliveryContext,
): ToolDefinition[] {
  const client = () => {
    if (!memory)
      throw new Error(
        "Supermemory is unavailable; continue using exact local state",
      );
    return memory;
  };
  const requireOwner = (
    operation: "remember" | "forget",
    input: Record<string, unknown>,
  ) => {
    if (trusted.kind !== "owner" || !trusted.sourceMessageId)
      throw new Error(
        "This memory change requires a current owner-directed turn",
      );
    return database.consumeMemoryAuthorization(
      trusted.sourceMessageId,
      operation,
      memoryMutationPayload(operation, input),
    );
  };
  return [
    defineTool({
      name: "remember",
      description:
        "Remember exact owner-provided context after an exact `remember: <content>` command. Do not use for operational facts.",
      input: v.object({
        content: v.pipe(v.string(), v.minLength(1), v.maxLength(20_000)),
      }),
      async run({ data }) {
        const provider = client();
        requireOwner("remember", data);
        const customId = `stan-explicit-${createHash("sha256")
          .update(`${trusted.sourceMessageId!}\0${data.content}`)
          .digest("hex")}`;
        return {
          output: await provider.remember(data.content, customId),
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
        "Permanently delete one Supermemory document after an exact `forget memory <documentId>` owner command.",
      input: v.object({ documentId: v.string() }),
      async run({ data }) {
        const provider = client();
        const firstAttempt = requireOwner("forget", data);
        await provider.forgetDocument(data.documentId, !firstAttempt);
        return { output: { forgotten: true } };
      },
    }),
  ];
}
