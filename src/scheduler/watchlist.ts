import { Temporal } from "@js-temporal/polyfill";
import { TIMEZONE } from "../config/schema.ts";
import type { XQuikProvider } from "../providers/xquik.ts";
import type { ApplicationDatabase } from "../storage/application-db.ts";
import type { WorkspaceStore } from "../workspace/store.ts";

export interface WatchlistEntry {
  key: string;
  line: string;
}

export function selectWatchlistEntries(
  markdown: string,
  lastChecks: ReadonlyMap<string, string>,
  limit: number,
): WatchlistEntry[] {
  const entries = markdown.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*-\s+(.+?)(?:\s+[—|]\s+|$)/.exec(line);
    if (!match) return [];
    const key = match[1]!.trim().replace(/^`|`$/g, "");
    return key ? [{ key, line: line.trim() }] : [];
  });
  return entries
    .map((entry, index) => ({
      entry,
      index,
      checked: lastChecks.get(entry.key),
    }))
    .sort((left, right) => {
      if (!left.checked && right.checked) return -1;
      if (left.checked && !right.checked) return 1;
      return (
        (left.checked ?? "").localeCompare(right.checked ?? "") ||
        left.index - right.index
      );
    })
    .slice(0, Math.max(0, Math.min(5, limit)))
    .map(({ entry }) => entry);
}

export class WatchlistRotator {
  constructor(
    private readonly database: ApplicationDatabase,
    private readonly workspace: WorkspaceStore,
    private readonly xquik: XQuikProvider | undefined,
  ) {}

  async check(limit = 3): Promise<number> {
    if (!this.xquik) return 0;
    const content = await this.workspace.read("watchlist");
    const stateRows = this.database.database
      .prepare("SELECT watch_key, last_checked_at FROM watchlist_state")
      .all() as {
      watch_key: string;
      last_checked_at: string | null;
    }[];
    const state = new Map(
      stateRows.map((row) => [row.watch_key, row.last_checked_at ?? ""]),
    );
    const entries = selectWatchlistEntries(content, state, limit);
    for (const entry of entries) {
      try {
        const result = entry.key.startsWith("@")
          ? await this.xquik.getUserPosts({
              idOrUsername: entry.key.slice(1),
              limit: 5,
            })
          : await this.xquik.searchPosts({
              query: entry.key.replace(/^query:\s*/i, ""),
              limit: 5,
            });
        this.database.database
          .prepare(
            "INSERT INTO activity_facts(local_date, kind, subject_id, detail_json, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(
            Temporal.Now.zonedDateTimeISO(TIMEZONE).toPlainDate().toString(),
            "watchlist-check",
            entry.key,
            JSON.stringify(result).slice(0, 8000),
            new Date().toISOString(),
          );
      } finally {
        this.database.database
          .prepare(
            `INSERT INTO watchlist_state(watch_key, last_checked_at) VALUES (?, ?)
             ON CONFLICT(watch_key) DO UPDATE SET last_checked_at = excluded.last_checked_at`,
          )
          .run(entry.key, new Date().toISOString());
      }
    }
    this.database.database
      .prepare(
        `DELETE FROM activity_facts WHERE kind = 'watchlist-check' AND id NOT IN (
           SELECT id FROM activity_facts WHERE kind = 'watchlist-check'
           ORDER BY created_at DESC LIMIT 500)`,
      )
      .run();
    return entries.length;
  }
}
