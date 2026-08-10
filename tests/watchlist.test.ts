import { describe, expect, it } from "vitest";
import { selectWatchlistEntries } from "../src/scheduler/watchlist.ts";

describe("watchlist rotation", () => {
  it("selects only the bounded least-recently checked entries", () => {
    const markdown = `# Watchlist\n\n- @alpha — peer\n- query: TypeScript agents — topic\n- @gamma — peer\n- @delta — peer\n`;
    const selected = selectWatchlistEntries(
      markdown,
      new Map([
        ["@alpha", "2026-08-13T12:00:00Z"],
        ["query: TypeScript agents", "2026-08-10T12:00:00Z"],
        ["@gamma", "2026-08-12T12:00:00Z"],
      ]),
      2,
    );

    expect(selected.map((entry) => entry.key)).toEqual([
      "@delta",
      "query: TypeScript agents",
    ]);
  });
});
