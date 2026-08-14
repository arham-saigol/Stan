import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { atomicWritePrivate } from "../state.ts";

export const WORKSPACE_FILES = {
  goals: "GOALS.md",
  strategy: "STRATEGY.md",
  playbook: "PLAYBOOK.md",
  heartbeats: "HEARTBEATS.md",
  watchlist: "WATCHLIST.md",
  voice_profile: "voice/PROFILE.md",
  voice_evidence: "voice/EVIDENCE.md",
} as const;

export type WorkspaceFile = string;
export type WorkspaceEdit =
  | { operation: "replace"; oldText: string; text: string }
  | { operation: "append"; text: string };

interface HistoryEntry {
  id: string;
  file: WorkspaceFile;
  backup: string;
  createdAt: string;
}

const customFileName = /^[a-z][a-z0-9_]{0,63}$/;
const initializedMarker = ".initialized";

export class WorkspaceStore {
  private readonly maxBytes: number;
  private mutationQueue = Promise.resolve();

  constructor(
    private readonly root: string,
    options: { maxBytes?: number } = {},
  ) {
    this.maxBytes = options.maxBytes ?? 64 * 1024;
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(join(this.root, "voice"), { recursive: true, mode: 0o700 });
    await mkdir(join(this.root, ".history"), { recursive: true, mode: 0o700 });

    const initialized = await this.exists(join(this.root, initializedMarker));
    if (!initialized) {
      for (const [file, relative] of Object.entries(WORKSPACE_FILES)) {
        const target = join(this.root, relative);
        if (await this.exists(target)) {
          await this.assertSafe(file);
          continue;
        }
        const template = await readFile(
          join(import.meta.dirname, "templates", relative),
          "utf8",
        );
        await atomicWritePrivate(target, template);
        await this.assertSafe(file);
      }
      await atomicWritePrivate(join(this.root, initializedMarker), "\n");
    }
    if (!(await this.exists(join(this.root, ".history", "index.json"))))
      await atomicWritePrivate(
        join(this.root, ".history", "index.json"),
        "[]\n",
      );
  }

  async list(): Promise<WorkspaceFile[]> {
    const files: WorkspaceFile[] = [];
    for (const file of Object.keys(WORKSPACE_FILES)) {
      try {
        await this.assertSafe(file);
        files.push(file);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    const entries = await readdir(this.root, { withFileTypes: true });
    const customFiles: WorkspaceFile[] = [];
    for (const entry of entries) {
      const file = entry.name.replace(/\.md$/, "");
      if (
        !entry.isFile() ||
        !entry.name.endsWith(".md") ||
        !customFileName.test(file) ||
        Object.hasOwn(WORKSPACE_FILES, file)
      )
        continue;
      await this.assertSafe(file);
      customFiles.push(file);
    }
    return [...files, ...customFiles.sort()];
  }

  async read(file: WorkspaceFile): Promise<string> {
    return this.readContent(await this.assertSafe(file));
  }

  edit(file: WorkspaceFile, edit: WorkspaceEdit): Promise<string> {
    return this.mutate(async () => {
      const current = await this.read(file);
      const next = this.editedContent(current, edit);
      await this.backup(file, current);
      await atomicWritePrivate(await this.assertSafe(file), next);
      return next;
    });
  }

  create(file: WorkspaceFile, content: string): Promise<string> {
    return this.mutate(async () => {
      this.assertSize(
        content,
        "Workspace file exceeds the configured size limit",
      );
      const path = await this.pathFor(file);
      if (await this.exists(path))
        throw new Error("Workspace file already exists");
      await atomicWritePrivate(path, content);
      return content;
    });
  }

  delete(file: WorkspaceFile): Promise<void> {
    return this.mutate(async () => {
      const path = await this.assertSafe(file);
      await this.backup(file, await this.readContent(path));
      await unlink(path);
    });
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private editedContent(current: string, edit: WorkspaceEdit): string {
    let next: string;
    if (edit.operation === "replace") {
      const first = current.indexOf(edit.oldText);
      const last = current.lastIndexOf(edit.oldText);
      if (!edit.oldText || first < 0 || first !== last)
        throw new Error("Replacement oldText must occur exactly once");
      next = `${current.slice(0, first)}${edit.text}${current.slice(first + edit.oldText.length)}`;
    } else {
      next = `${current}${edit.text}`;
    }
    this.assertSize(next, "Workspace edit exceeds the configured size limit");
    return next;
  }

  private async assertSafe(file: WorkspaceFile): Promise<string> {
    const path = await this.pathFor(file);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink())
      throw new Error("Workspace symlinks are not allowed");
    if (!metadata.isFile())
      throw new Error("Workspace entry must be a regular file");
    return path;
  }

  private async pathFor(file: WorkspaceFile): Promise<string> {
    const relative = this.relativePath(file);
    const path = join(this.root, relative);
    const resolvedRoot = await realpath(this.root);
    const resolvedParent = await realpath(dirname(path));
    if (
      resolvedParent !== resolvedRoot &&
      !resolvedParent.startsWith(
        `${resolvedRoot}${process.platform === "win32" ? "\\" : "/"}`,
      )
    )
      throw new Error("Workspace path escapes its root");
    return path;
  }

  private relativePath(file: WorkspaceFile): string {
    if (typeof file !== "string")
      throw new Error("Workspace file name is invalid");
    if (Object.hasOwn(WORKSPACE_FILES, file))
      return WORKSPACE_FILES[file as keyof typeof WORKSPACE_FILES];
    if (!customFileName.test(file))
      throw new Error("Workspace file name is invalid");
    return `${file}.md`;
  }

  private async readContent(path: string): Promise<string> {
    const content = await readFile(path, "utf8");
    this.assertSize(
      content,
      "Workspace file exceeds the configured size limit",
    );
    return content;
  }

  private assertSize(content: string, message: string): void {
    if (Buffer.byteLength(content) > this.maxBytes) throw new Error(message);
  }

  private async backup(file: WorkspaceFile, content: string): Promise<void> {
    const indexPath = join(this.root, ".history", "index.json");
    const entries = JSON.parse(
      await readFile(indexPath, "utf8"),
    ) as HistoryEntry[];
    const id = crypto.randomUUID();
    const backup = `${Date.now()}-${id}-${basename(this.relativePath(file))}`;
    await atomicWritePrivate(join(this.root, ".history", backup), content);
    entries.unshift({
      id,
      file,
      backup,
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

  private async exists(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
