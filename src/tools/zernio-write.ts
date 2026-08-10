import { defineTool, type ToolDefinition } from "@flue/runtime";
import * as v from "valibot";
import type {
  ZernioWriteService,
  ZernioMutationRequest,
} from "../providers/zernio-write-service.ts";
import type { TrustedDeliveryContext } from "./types.ts";

const content = v.pipe(v.string(), v.minLength(1), v.maxLength(25_000));

export function zernioWriteTools(
  service: ZernioWriteService | undefined,
  trusted: TrustedDeliveryContext,
  selectedAccountId: string | undefined,
): ToolDefinition[] {
  const execute = async (request: ZernioMutationRequest) => {
    if (!service || !selectedAccountId)
      throw new Error("Zernio and a bound X account must be configured");
    if (!trusted.sourceMessageId)
      throw new Error("A current authenticated owner message is required");
    return service.execute(
      {
        sourceMessageId: trusted.sourceMessageId,
        ...(trusted.authorizationEnvelopeId
          ? { authorizationEnvelopeId: trusted.authorizationEnvelopeId }
          : {}),
        selectedAccountId,
      },
      request,
    );
  };
  return [
    defineTool({
      name: "save_x_draft",
      description:
        "Save a Zernio draft only when the current owner command explicitly authorized a draft. This does not publish.",
      input: v.object({ content }),
      async run({ data }) {
        return {
          output: await execute({ operation: "draft", content: data.content }),
        };
      },
    }),
    defineTool({
      name: "publish_x_post",
      description:
        "Publish one X post now. Requires and consumes the current owner command’s matching publish authorization.",
      input: v.object({ content }),
      durable: true,
      async run({ data, step }) {
        return {
          output: await step.do("zernio-create", () =>
            execute({ operation: "publish", content: data.content }),
          ),
        };
      },
    }),
    defineTool({
      name: "schedule_x_post",
      description:
        "Submit one future X post to Zernio. Requires current matching schedule authorization; a successful result is scheduled, not posted.",
      input: v.object({
        content,
        scheduledFor: v.pipe(v.string(), v.isoTimestamp()),
      }),
      durable: true,
      async run({ data, step }) {
        return {
          output: await step.do("zernio-schedule", () =>
            execute({
              operation: "schedule",
              content: data.content,
              scheduledFor: data.scheduledFor,
            }),
          ),
        };
      },
    }),
    defineTool({
      name: "reply_on_x",
      description:
        "Publish an X reply. Requires and consumes current matching reply authorization.",
      input: v.object({
        content,
        replyToPostId: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
      }),
      durable: true,
      async run({ data, step }) {
        return {
          output: await step.do("zernio-reply", () =>
            execute({
              operation: "reply",
              content: data.content,
              replyToPostId: data.replyToPostId,
            }),
          ),
        };
      },
    }),
    defineTool({
      name: "edit_x_post",
      description:
        "Edit one Zernio/X post where the provider supports it. Requires current matching edit authorization.",
      input: v.object({ providerPostId: v.string(), content }),
      async run({ data }) {
        return {
          output: await execute({
            operation: "edit",
            providerPostId: data.providerPostId,
            content: data.content,
          }),
        };
      },
    }),
    defineTool({
      name: "cancel_scheduled_x_post",
      description:
        "Cancel one scheduled Zernio post. Requires current matching cancel authorization.",
      input: v.object({ providerPostId: v.string() }),
      async run({ data }) {
        return {
          output: await execute({
            operation: "cancel",
            providerPostId: data.providerPostId,
          }),
        };
      },
    }),
    defineTool({
      name: "delete_x_post",
      description:
        "Delete or unpublish one X/Zernio post. Requires current matching delete authorization.",
      input: v.object({ providerPostId: v.string() }),
      async run({ data }) {
        return {
          output: await execute({
            operation: "delete",
            providerPostId: data.providerPostId,
          }),
        };
      },
    }),
  ];
}
