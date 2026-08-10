import { execFile } from "node:child_process";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function resolveStateRoot(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (environment.STAN_STATE_ROOT) return resolve(environment.STAN_STATE_ROOT);
  if (process.platform === "win32") {
    const localAppData = environment.LOCALAPPDATA;
    if (!localAppData) throw new Error("LOCALAPPDATA is required on Windows");
    return join(localAppData, "Stan");
  }
  return join(
    environment.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "stan",
  );
}

export async function initializeStateRoot(
  root = resolveStateRoot(),
): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync("whoami");
    const owner = stdout.trim();
    await execFileAsync("icacls", [
      root,
      "/inheritance:r",
      "/grant:r",
      `${owner}:(OI)(CI)F`,
    ]);
  } else {
    await chmod(root, 0o700);
  }
  for (const directory of [
    "auth",
    "logs",
    "workspace",
    "workspace/voice",
    "workspace/.history",
  ]) {
    const path = join(root, directory);
    await mkdir(path, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(path, 0o700);
  }
  return root;
}

export async function atomicWritePrivate(
  path: string,
  content: string | Uint8Array,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
  if (process.platform !== "win32") await chmod(temporary, 0o600);
  await rename(temporary, path);
  if (process.platform !== "win32") await chmod(path, 0o600);
}

export interface StatePaths {
  root: string;
  config: string;
  credentials: string;
  applicationDb: string;
  flueDb: string;
  codexAuth: string;
  codexModels: string;
  workspace: string;
  logs: string;
  service: string;
}

export function statePaths(root = resolveStateRoot()): StatePaths {
  return {
    root,
    config: join(root, "config.json"),
    credentials: join(root, "auth", "apis.json"),
    applicationDb: join(root, "stan.db"),
    flueDb: join(root, "flue.db"),
    codexAuth: join(root, "auth", "codex.json"),
    codexModels: join(root, "auth", "models.json"),
    workspace: join(root, "workspace"),
    logs: join(root, "logs"),
    service: join(root, "service.json"),
  };
}
