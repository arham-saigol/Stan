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

interface MutationEntry {
  operationKey: string;
  operation: "edit" | "create" | "delete";
  file: WorkspaceFile;
  result: string | null;
  backup?: string;
  status: "pending" | "complete";
  createdAt: string;
}

const customFileName = /^[a-z][a-z0-9_]{0,63}$/;
const operationsFile = "operations.json";
const maxMutationRecords = 100;

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
    for (const file of ["index.json", operationsFile]) {
      const path = join(this.root, ".history", file);
      if (!(await this.exists(path))) await atomicWritePrivate(path, "[]\n");
    }
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

  edit(
    file: WorkspaceFile,
    edit: WorkspaceEdit,
    operationKey: string,
  ): Promise<string> {
    return this.mutate(async () => {
      const previous = await this.findMutation(operationKey, "edit");
      if (previous) {
        const result = await this.replayMutation(previous);
        if (result === null)
          throw new Error("Workspace mutation outcome is invalid");
        return result;
      }
      const current = await this.read(file);
      const next = this.editedContent(current, edit);
      const entry: MutationEntry = {
        operationKey: this.assertOperationKey(operationKey),
        operation: "edit",
        file,
        result: next,
        backup: await this.backup(file, current),
        status: "pending",
        createdAt: new Date().toISOString(),
      };
      await this.recordMutation(entry);
      await atomicWritePrivate(await this.assertSafe(file), next);
      await this.completeMutation(entry);
      return next;
    });
  }

  create(
    file: WorkspaceFile,
    content: string,
    operationKey: string,
  ): Promise<string> {
    return this.mutate(async () => {
      const previous = await this.findMutation(operationKey, "create");
      if (previous) {
        const result = await this.replayMutation(previous);
        if (result === null)
          throw new Error("Workspace mutation outcome is invalid");
        return result;
      }
      this.assertSize(
        content,
        "Workspace file exceeds the configured size limit",
      );
      const path = await this.pathFor(file);
      if (await this.exists(path))
        throw new Error("Workspace file already exists");
      const entry: MutationEntry = {
        operationKey: this.assertOperationKey(operationKey),
        operation: "create",
        file,
        result: content,
        status: "pending",
        createdAt: new Date().toISOString(),
      };
      await this.recordMutation(entry);
      await atomicWritePrivate(path, content);
      await this.completeMutation(entry);
      return content;
    });
  }

  delete(file: WorkspaceFile, operationKey: string): Promise<void> {
    return this.mutate(async () => {
      const previous = await this.findMutation(operationKey, "delete");
      if (previous) {
        await this.replayMutation(previous);
        return;
      }
      const path = await this.assertSafe(file);
      const entry: MutationEntry = {
        operationKey: this.assertOperationKey(operationKey),
        operation: "delete",
        file,
        result: null,
        backup: await this.backup(file, await this.readContent(path)),
        status: "pending",
        createdAt: new Date().toISOString(),
      };
      await this.recordMutation(entry);
      await unlink(path);
      await this.completeMutation(entry);
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

  private async replayMutation(entry: MutationEntry): Promise<string | null> {
    if (entry.status === "pending") {
      const path = await this.pathFor(entry.file);
      if (entry.operation === "edit") {
        const before = await this.backupContent(entry.backup);
        if (before !== null) {
          const current = await this.readContent(
            await this.assertSafe(entry.file),
          );
          if (current !== entry.result && current === before)
            await atomicWritePrivate(path, entry.result!);
        }
      } else if (entry.operation === "create") {
        if (!(await this.exists(path)))
          await atomicWritePrivate(path, entry.result!);
      } else {
        const before = await this.backupContent(entry.backup);
        if (before !== null && (await this.exists(path))) {
          const current = await this.readContent(
            await this.assertSafe(entry.file),
          );
          if (current === before) await unlink(path);
        }
      }
      await this.completeMutation(entry);
    }
    return entry.result;
  }

  private async findMutation(
    operationKey: string,
    operation: MutationEntry["operation"],
  ): Promise<MutationEntry | undefined> {
    this.assertOperationKey(operationKey);
    const entry = (await this.mutations()).find(
      (candidate) => candidate.operationKey === operationKey,
    );
    if (entry && entry.operation !== operation)
      throw new Error("Workspace operation key is already in use");
    return entry;
  }

  private async recordMutation(entry: MutationEntry): Promise<void> {
    const entries = await this.mutations();
    entries.push(entry);
    let excess = entries.length - maxMutationRecords;
    if (excess > 0) {
      for (let index = 0; index < entries.length && excess > 0; index++) {
        const candidate = entries[index];
        if (!candidate || candidate.status !== "complete") continue;
        entries.splice(index, 1);
        index--;
        excess--;
      }
    }
    await this.writeMutations(entries);
  }

  private async completeMutation(entry: MutationEntry): Promise<void> {
    const entries = await this.mutations();
    const stored = entries.find(
      (candidate) => candidate.operationKey === entry.operationKey,
    );
    if (!stored) throw new Error("Workspace mutation outcome is missing");
    stored.status = "complete";
    await this.writeMutations(entries);
  }

  private async mutations(): Promise<MutationEntry[]> {
    return JSON.parse(
      await readFile(join(this.root, ".history", operationsFile), "utf8"),
    ) as MutationEntry[];
  }

  private writeMutations(entries: MutationEntry[]): Promise<void> {
    return atomicWritePrivate(
      join(this.root, ".history", operationsFile),
      `${JSON.stringify(entries, null, 2)}\n`,
    );
  }

  private assertOperationKey(operationKey: string): string {
    if (
      typeof operationKey !== "string" ||
      !operationKey ||
      operationKey.length > 512
    )
      throw new Error("Workspace operation key is invalid");
    return operationKey;
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

  private async backupContent(
    backup: string | undefined,
  ): Promise<string | null> {
    if (!backup) return null;
    try {
      return await this.readContent(join(this.root, ".history", backup));
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  private async backup(file: WorkspaceFile, content: string): Promise<string> {
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
    return backup;
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
