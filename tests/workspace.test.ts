import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceStore } from "../src/workspace/store.ts";

describe("bounded workspace", () => {
  it("initializes the allowlisted operating documents and supports atomic exact edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "stan-workspace-"));
    const store = new WorkspaceStore(root, { maxBytes: 1024 });
    await store.initialize();
    const before = await store.read("goals");

    await store.edit(
      "goals",
      { operation: "replace", oldText: "# Goals", text: "# Current Goals" },
      "owner-1",
    );

    expect(await store.read("goals")).toBe(
      before.replace("# Goals", "# Current Goals"),
    );
    const history = JSON.parse(
      await readFile(join(root, ".history", "index.json"), "utf8"),
    ) as unknown[];
    expect(history).toHaveLength(1);
  });

  it("serializes concurrent edits so one accepted change cannot overwrite another", async () => {
    const root = await mkdtemp(join(tmpdir(), "stan-workspace-"));
    const store = new WorkspaceStore(root, { maxBytes: 1024 });
    await store.initialize();

    await Promise.all([
      store.edit("goals", { operation: "append", text: "\nfirst" }, "one"),
      store.edit("goals", { operation: "append", text: "\nsecond" }, "two"),
    ]);

    expect(await store.read("goals")).toMatch(/first\nsecond$/);
  });

  it("rejects traversal, symlinks, oversized writes and stale replacements", async () => {
    const root = await mkdtemp(join(tmpdir(), "stan-workspace-"));
    const outside = join(root, "..", `outside-${crypto.randomUUID()}.md`);
    const store = new WorkspaceStore(root, { maxBytes: 128 });
    await store.initialize();
    await writeFile(outside, "secret");
    await symlink(outside, join(root, "GOALS.md")).catch(() => undefined);

    await expect(store.read("../config.json" as "goals")).rejects.toThrow(
      /allowlist/i,
    );
    await expect(
      store.edit(
        "strategy",
        { operation: "append", text: "x".repeat(129) },
        "owner-1",
      ),
    ).rejects.toThrow(/limit/i);
    await expect(
      store.edit(
        "strategy",
        { operation: "replace", oldText: "not present", text: "replacement" },
        "owner-1",
      ),
    ).rejects.toThrow(/exactly once/i);
    if (
      (await readFile(join(root, "GOALS.md"), "utf8").catch(
        () => "symlink",
      )) === "secret"
    ) {
      await expect(store.read("goals")).rejects.toThrow(/symlink/i);
    }
  });
});
