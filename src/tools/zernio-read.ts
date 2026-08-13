import { defineTool, type ToolDefinition } from "@flue/runtime";
import * as v from "valibot";
import type { ZernioProvider } from "../providers/zernio.ts";
import type { ApplicationDatabase } from "../storage/application-db.ts";

export function zernioReadTools(
  provider: ZernioProvider | undefined,
  selectedAccountId: string | undefined,
  database?: ApplicationDatabase,
): ToolDefinition[] {
  const client = () => {
    if (!provider) throw new Error("Zernio is not configured");
    return provider;
  };
  const account = () => {
    if (!selectedAccountId) throw new Error("No X account is selected");
    return selectedAccountId;
  };
  return [
    defineTool({
      name: "get_connected_x_account",
      description:
        "Get the application-bound connected X account. The account cannot be selected by model input.",
      async run() {
        return { output: await client().getBoundAccount(account()) };
      },
    }),
    defineTool({
      name: "list_account_x_posts",
      description:
        "List recent posts, drafts, and schedules for the bound X account.",
      input: v.object({
        limit: v.optional(
          v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(25)),
        ),
      }),
      async run({ data }) {
        return { output: await client().listPosts(account(), data.limit) };
      },
    }),
    defineTool({
      name: "get_account_x_post_status",
      description:
        "Get verified Zernio status for one account-bound post or schedule.",
      input: v.object({ providerPostId: v.string() }),
      async run({ data }) {
        return {
          output: await client().getPostForAccount(
            data.providerPostId,
            account(),
          ),
        };
      },
    }),
    defineTool({
      name: "get_x_post_analytics",
      description:
        "Get current Zernio analytics for one post. Treat provider status as authoritative.",
      input: v.object({ postId: v.string() }),
      async run({ data }) {
        const output = await client().analyticsForAccount(
          data.postId,
          account(),
        );
        if (database) {
          const serialized = JSON.stringify(output) ?? "null";
          database.database
            .prepare(
              "INSERT INTO analytics_snapshots(post_id, captured_at, metrics_json) VALUES (?, ?, ?)",
            )
            .run(
              data.postId,
              new Date().toISOString(),
              serialized.slice(0, 80_000),
            );
          database.database.exec(
            "DELETE FROM analytics_snapshots WHERE id NOT IN (SELECT id FROM analytics_snapshots ORDER BY captured_at DESC LIMIT 500)",
          );
        }
        return { output };
      },
    }),
  ];
}
