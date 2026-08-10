import { lstat, mkdir, readFile, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { atomicWritePrivate } from "../state.ts";

export const WORKSPACE_FILES = {
  goals: "GOALS.md",
  strategy: "STRATEGY.md",
  playbook: "PLAYBOOK.md",
  heartbeats: "HEARTBEATS.md",
  watchlist: "WATCHLIST.md",
  voice_profile: "voice/PROFILE.md",
  voice_examples: "voice/EXAMPLES.md",
} as const;

export type WorkspaceFile = keyof typeof WORKSPACE_FILES;
export type WorkspaceEdit =
  | { operation: "replace"; oldText: string; text: string }
  | { operation: "append"; text: string };

interface HistoryEntry {
  id: string;
  file: WorkspaceFile;
  backup: string;
  sourceMessageId: string;
  createdAt: string;
}

export class WorkspaceStore {
  private readonly maxBytes: number;
  private editQueue = Promise.resolve();

  constructor(
    private readonly root: string,
    options: { maxBytes?: number } = {},
  ) {
    this.maxBytes = options.maxBytes ?? 64 * 1024;
  }

  async initialize(): Promise<void> {
    await mkdir(join(this.root, "voice"), { recursive: true, mode: 0o700 });
    await mkdir(join(this.root, ".history"), { recursive: true, mode: 0o700 });
    for (const [logicalName, relative] of Object.entries(WORKSPACE_FILES) as [
      WorkspaceFile,
      string,
    ][]) {
      const target = join(this.root, relative);
      try {
        await lstat(target);
      } catch (error) {
        if (!isMissing(error)) throw error;
        const template = await readFile(
          join(import.meta.dirname, "templates", relative),
          "utf8",
        );
        await atomicWritePrivate(target, template);
      }
      await this.assertSafe(logicalName);
    }
    try {
      await lstat(join(this.root, ".history", "index.json"));
    } catch (error) {
      if (!isMissing(error)) throw error;
      await atomicWritePrivate(
        join(this.root, ".history", "index.json"),
        "[]\n",
      );
    }
  }

  async read(file: WorkspaceFile): Promise<string> {
    const path = await this.assertSafe(file);
    const content = await readFile(path, "utf8");
    if (Buffer.byteLength(content) > this.maxBytes)
      throw new Error("Workspace file exceeds the configured size limit");
    return content;
  }

  edit(
    file: WorkspaceFile,
    edit: WorkspaceEdit,
    sourceMessageId: string,
  ): Promise<string> {
    const result = this.editQueue.then(() =>
      this.applyEdit(file, edit, sourceMessageId),
    );
    this.editQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async applyEdit(
    file: WorkspaceFile,
    edit: WorkspaceEdit,
    sourceMessageId: string,
  ): Promise<string> {
    const current = await this.read(file);
    let next: string;
    if (edit.operation === "replace") {
      const first = current.indexOf(edit.oldText);
      const last = current.lastIndexOf(edit.oldText);
      if (!edit.oldText || first < 0 || first !== last) {
        throw new Error("Replacement oldText must occur exactly once");
      }
      next = `${current.slice(0, first)}${edit.text}${current.slice(first + edit.oldText.length)}`;
    } else {
      next = `${current}${edit.text}`;
    }
    if (Buffer.byteLength(next) > this.maxBytes)
      throw new Error("Workspace edit exceeds the configured size limit");
    await this.backup(file, current, sourceMessageId);
    await atomicWritePrivate(await this.assertSafe(file), next);
    return next;
  }

  private async assertSafe(file: WorkspaceFile): Promise<string> {
    if (!Object.hasOwn(WORKSPACE_FILES, file))
      throw new Error("Workspace file is not on the allowlist");
    const relative = WORKSPACE_FILES[file];
    if (
      relative.includes("..") ||
      relative.startsWith("/") ||
      relative.startsWith("\\")
    ) {
      throw new Error("Workspace allowlist entry is invalid");
    }
    const path = join(this.root, relative);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink())
      throw new Error("Workspace symlinks are not allowed");
    if (!metadata.isFile())
      throw new Error("Workspace entry must be a regular file");
    const resolvedRoot = await realpath(this.root);
    const resolvedParent = await realpath(dirname(path));
    if (
      resolvedParent !== resolvedRoot &&
      !resolvedParent.startsWith(
        `${resolvedRoot}${process.platform === "win32" ? "\\" : "/"}`,
      )
    ) {
      throw new Error("Workspace path escapes its root");
    }
    return path;
  }

  private async backup(
    file: WorkspaceFile,
    content: string,
    sourceMessageId: string,
  ): Promise<void> {
    const indexPath = join(this.root, ".history", "index.json");
    const entries = JSON.parse(
      await readFile(indexPath, "utf8"),
    ) as HistoryEntry[];
    const id = crypto.randomUUID();
    const backup = `${Date.now()}-${id}-${basename(WORKSPACE_FILES[file])}`;
    await atomicWritePrivate(join(this.root, ".history", backup), content);
    entries.unshift({
      id,
      file,
      backup,
      sourceMessageId,
      createdAt: new Date().toISOString(),
    });
    const removed = entries.splice(20);
    await atomicWritePrivate(
      indexPath,
      `${JSON.stringify(entries, null, 2)}\n`,
    );
    await Promise.all(
      removed.map((entry) =>
        unlink(join(this.root, ".history", entry.backup)).catch(
          () => undefined,
        ),
      ),
    );
  }
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
