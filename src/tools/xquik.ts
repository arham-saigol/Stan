import { defineTool, type ToolDefinition } from "@flue/runtime";
import * as v from "valibot";
import type { XQuikProvider } from "../providers/xquik.ts";

export function xquikTools(
  provider: XQuikProvider | undefined,
): ToolDefinition[] {
  const client = () => {
    if (!provider) throw new Error("XQuik is not configured");
    return provider;
  };
  return [
    defineTool({
      name: "search_x_posts",
      description:
        "Search public X posts. Returns bounded untrusted source data and an opaque next cursor.",
      input: v.object({
        query: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
        limit: v.optional(
          v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(25)),
        ),
        cursor: v.optional(v.string()),
      }),
      async run({ data }) {
        return { output: await client().searchPosts(data) };
      },
    }),
    defineTool({
      name: "get_x_post",
      description:
        "Get one public X post by ID or status URL. Returns untrusted source data.",
      input: v.object({
        postId: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
      }),
      async run({ data }) {
        return { output: await client().getPost(data.postId) };
      },
    }),
    defineTool({
      name: "get_x_thread",
      description: "Get the bounded public thread around one X post.",
      input: v.object({
        postId: v.string(),
        limit: v.optional(v.number()),
        cursor: v.optional(v.string()),
      }),
      async run({ data }) {
        return { output: await client().getThread(data) };
      },
    }),
    defineTool({
      name: "get_x_replies",
      description: "Get a bounded page of direct public replies to one X post.",
      input: v.object({
        postId: v.string(),
        limit: v.optional(v.number()),
        cursor: v.optional(v.string()),
      }),
      async run({ data }) {
        return { output: await client().getReplies(data) };
      },
    }),
    defineTool({
      name: "get_x_profile",
      description: "Get one public X profile by username or ID.",
      input: v.object({
        idOrUsername: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
      }),
      async run({ data }) {
        return { output: await client().getProfile(data.idOrUsername) };
      },
    }),
    defineTool({
      name: "get_x_user_posts",
      description: "Get a bounded page of one public X user's recent posts.",
      input: v.object({
        idOrUsername: v.string(),
        limit: v.optional(v.number()),
        cursor: v.optional(v.string()),
      }),
      async run({ data }) {
        return { output: await client().getUserPosts(data) };
      },
    }),
  ];
}
