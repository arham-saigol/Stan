import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceStore } from "../src/workspace/store.ts";

describe("bounded workspace", () => {
  it("initializes operating documents with Voice Evidence and supports atomic exact edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "stan-workspace-"));
    const store = new WorkspaceStore(root, { maxBytes: 1024 });
    await store.initialize();
    const before = await store.read("goals");

    expect(await store.list()).toEqual([
      "goals",
      "strategy",
      "playbook",
      "heartbeats",
      "watchlist",
      "voice_profile",
      "voice_evidence",
    ]);
    expect(
      await readFile(join(root, "voice", "EVIDENCE.md"), "utf8"),
    ).toContain("# Voice Evidence");

    await store.edit(
      "goals",
      {
        operation: "replace",
        oldText: "# Goals",
        text: "# Current Goals",
      },
      "owner:edit-goals",
    );

    expect(await store.read("goals")).toBe(
      before.replace("# Goals", "# Current Goals"),
    );
    const history = JSON.parse(
      await readFile(join(root, ".history", "index.json"), "utf8"),
    ) as unknown[];
    expect(history).toHaveLength(1);
  });

  it("creates, lists, and deletes workspace files", async () => {
    const root = await mkdtemp(join(tmpdir(), "stan-workspace-"));
    const store = new WorkspaceStore(root, { maxBytes: 1024 });
    await store.initialize();

    await store.create("ideas", "# Ideas\n", "owner:create-ideas");

    expect(await store.list()).toContain("ideas");
    expect(await store.read("ideas")).toBe("# Ideas\n");

    await store.delete("ideas", "owner:delete-ideas");

    expect(await store.list()).not.toContain("ideas");
    const history = JSON.parse(
      await readFile(join(root, ".history", "index.json"), "utf8"),
    ) as unknown[];
    expect(history).toHaveLength(1);
  });

  it("replays completed workspace mutations across restarts", async () => {
    const root = await mkdtemp(join(tmpdir(), "stan-workspace-"));
    const store = new WorkspaceStore(root, { maxBytes: 1024 });
    await store.initialize();

    await store.edit(
      "goals",
      { operation: "append", text: "\nonce" },
      "heartbeat:once:edit",
    );
    const restarted = new WorkspaceStore(root, { maxBytes: 1024 });
    await restarted.initialize();
    await restarted.edit(
      "goals",
      { operation: "append", text: "\nonce" },
      "heartbeat:once:edit",
    );
    expect((await restarted.read("goals")).match(/once/g) ?? []).toHaveLength(
      1,
    );

    await restarted.create("ideas", "# Ideas\n", "automation:once:create");
    const afterCreate = new WorkspaceStore(root, { maxBytes: 1024 });
    await afterCreate.initialize();
    await expect(
      afterCreate.create("ideas", "# Ideas\n", "automation:once:create"),
    ).resolves.toBe("# Ideas\n");

    await afterCreate.delete("ideas", "automation:once:delete");
    const afterDelete = new WorkspaceStore(root, { maxBytes: 1024 });
    await afterDelete.initialize();
    await expect(
      afterDelete.delete("ideas", "automation:once:delete"),
    ).resolves.toBeUndefined();
  });

  it("recreates missing fixed documents without overwriting edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "stan-workspace-"));
    const store = new WorkspaceStore(root, { maxBytes: 1024 });
    await store.initialize();
    await store.edit(
      "goals",
      { operation: "append", text: "\nkeep this" },
      "owner:keep-goals",
    );
    await rm(join(root, "HEARTBEATS.md"));

    const restarted = new WorkspaceStore(root, { maxBytes: 1024 });
    await restarted.initialize();

    await expect(restarted.read("goals")).resolves.toMatch(/keep this$/);
    await expect(restarted.read("heartbeats")).resolves.toContain(
      "# Heartbeats",
    );
  });

  it("serializes concurrent edits so one accepted change cannot overwrite another", async () => {
    const root = await mkdtemp(join(tmpdir(), "stan-workspace-"));
    const store = new WorkspaceStore(root, { maxBytes: 1024 });
    await store.initialize();

    await Promise.all([
      store.edit(
        "goals",
        { operation: "append", text: "\nfirst" },
        "owner:first",
      ),
      store.edit(
        "goals",
        { operation: "append", text: "\nsecond" },
        "owner:second",
      ),
    ]);

    expect(await store.read("goals")).toMatch(/first\nsecond$/);
  });

  it("rejects unsafe names, oversized writes and stale replacements", async () => {
    const root = await mkdtemp(join(tmpdir(), "stan-workspace-"));
    const store = new WorkspaceStore(root, { maxBytes: 128 });
    await store.initialize();

    await expect(store.read("../config.json")).rejects.toThrow(/name/i);
    await expect(
      store.create("../notes", "x", "owner:unsafe-create"),
    ).rejects.toThrow(/name/i);
    await expect(
      store.create("ideas", "x".repeat(129), "owner:oversized-create"),
    ).rejects.toThrow(/limit/i);
    await expect(
      store.edit(
        "strategy",
        { operation: "append", text: "x".repeat(129) },
        "owner:oversized-edit",
      ),
    ).rejects.toThrow(/limit/i);
    await expect(
      store.edit(
        "strategy",
        {
          operation: "replace",
          oldText: "not present",
          text: "replacement",
        },
        "owner:stale-edit",
      ),
    ).rejects.toThrow(/exactly once/i);
  });

  it.skipIf(process.platform === "win32")(
    "rejects workspace files replaced by symlinks",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "stan-workspace-"));
      const outside = join(root, "..", `outside-${crypto.randomUUID()}.md`);
      const store = new WorkspaceStore(root, { maxBytes: 128 });
      await store.initialize();
      await writeFile(outside, "secret");
      await rm(join(root, "GOALS.md"));
      await symlink(outside, join(root, "GOALS.md"));

      await expect(store.read("goals")).rejects.toThrow(/symlink/i);
    },
  );
});
