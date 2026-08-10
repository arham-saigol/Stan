import { defineTool, type ToolDefinition } from "@flue/runtime";
import * as v from "valibot";
import type { FirecrawlProvider } from "../providers/firecrawl.ts";

export function firecrawlTools(
  provider: FirecrawlProvider | undefined,
): ToolDefinition[] {
  const client = () => {
    if (!provider) throw new Error("Firecrawl is not configured");
    return provider;
  };
  return [
    defineTool({
      name: "search_web",
      description:
        "Search the wider web and return a bounded list of untrusted sources.",
      input: v.object({
        query: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
        limit: v.optional(
          v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10)),
        ),
      }),
      async run({ data, signal }) {
        return { output: await client().search(data, signal) };
      },
    }),
    defineTool({
      name: "fetch_web_page",
      description:
        "Fetch one public HTTP(S) page as bounded Markdown. Local and private network targets are rejected.",
      input: v.object({ url: v.pipe(v.string(), v.url(), v.maxLength(2000)) }),
      async run({ data, signal }) {
        return { output: await client().fetch(data.url, signal) };
      },
    }),
  ];
}
