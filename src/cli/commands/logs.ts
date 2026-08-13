import { open, watch } from "node:fs/promises";
import { statePaths } from "../../state.ts";

export async function logsCommand(
  root: string,
  options: { lines: number; level?: string; follow: boolean },
): Promise<void> {
  const path = `${statePaths(root).logs}/stan.log`;
  let offset = 0;
  const print = async (tailOnly: boolean) => {
    const file = await open(path, "r");
    try {
      const size = (await file.stat()).size;
      const start = tailOnly ? Math.max(0, size - 256_000) : offset;
      const buffer = Buffer.alloc(Math.max(0, size - start));
      await file.read(buffer, 0, buffer.length, start);
      offset = size;
      let rows = buffer.toString("utf8").split(/\r?\n/).filter(Boolean);
      if (options.level)
        rows = rows.filter((row) =>
          row.includes(`"level":${levelNumber(options.level!)}`),
        );
      if (tailOnly) rows = rows.slice(-options.lines);
      for (const row of rows) console.log(row);
    } finally {
      await file.close();
    }
  };
  await print(true);
  if (!options.follow) return;
  for await (const event of watch(path)) {
    if (event) await print(false);
  }
}

function levelNumber(level: string): number {
  return (
    (
      {
        trace: 10,
        debug: 20,
        info: 30,
        warn: 40,
        error: 50,
        fatal: 60,
      } as Record<string, number>
    )[level] ?? 30
  );
}
