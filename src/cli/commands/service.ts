import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CredentialStore } from "../../config/credentials.ts";
import { atomicWritePrivate, statePaths } from "../../state.ts";

const execFileAsync = promisify(execFile);
const CONTROL_PORT = 43127;

export interface DaemonStatus {
  status: string;
  pid: number;
  uptimeSeconds: number;
  whatsapp: string;
  agentBusy: boolean;
}

export async function getDaemonStatus(
  root: string,
): Promise<DaemonStatus | undefined> {
  const token = new CredentialStore(root).tryRead()?.controlToken;
  if (!token) return undefined;
  try {
    const response = await fetch(`http://127.0.0.1:${CONTROL_PORT}/status`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1500),
    });
    return response.ok ? ((await response.json()) as DaemonStatus) : undefined;
  } catch {
    return undefined;
  }
}

export async function startService(root: string): Promise<DaemonStatus> {
  const existing = await getDaemonStatus(root);
  if (existing) return existing;
  const daemon = daemonEntrypoint();
  const child = spawn(process.execPath, [daemon], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, STAN_STATE_ROOT: root },
  });
  child.unref();
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    const status = await getDaemonStatus(root);
    if (status) return status;
  }
  throw new Error(`Stan did not start. Inspect ${statePaths(root).logs}`);
}

export async function stopService(root: string): Promise<boolean> {
  const credentials = new CredentialStore(root).tryRead();
  if (!credentials || !(await getDaemonStatus(root))) return false;
  await fetch(`http://127.0.0.1:${CONTROL_PORT}/stop`, {
    method: "POST",
    headers: { authorization: `Bearer ${credentials.controlToken}` },
    signal: AbortSignal.timeout(3000),
  });
  for (let attempt = 0; attempt < 280; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    if (!(await getDaemonStatus(root))) return true;
  }
  throw new Error("Stan did not stop at a safe boundary within 70 seconds");
}

export async function installAutostart(root: string): Promise<void> {
  if (process.platform === "win32") return installWindowsTask(root);
  if (process.platform === "linux") return installSystemdUserService(root);
  throw new Error("Autostart installation supports Windows and systemd Linux");
}

async function installSystemdUserService(root: string): Promise<void> {
  const unitDirectory = join(homedir(), ".config", "systemd", "user");
  await mkdir(unitDirectory, { recursive: true, mode: 0o700 });
  const unit = `[Unit]\nDescription=Stan private WhatsApp X agent\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nEnvironment=STAN_STATE_ROOT=${systemdEscape(root)}\nExecStart=${systemdEscape(process.execPath)} ${systemdEscape(daemonEntrypoint())}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=3600\n\n[Install]\nWantedBy=default.target\n`;
  const path = join(unitDirectory, "stan.service");
  await writeFile(path, unit, { mode: 0o600 });
  await chmod(path, 0o600);
  await execFileAsync("systemctl", ["--user", "daemon-reload"]);
  await execFileAsync("systemctl", [
    "--user",
    "enable",
    "--now",
    "stan.service",
  ]);
  console.log(
    'Installed systemd user service. For boot without login, run: loginctl enable-linger "$USER"',
  );
}

async function installWindowsTask(root: string): Promise<void> {
  const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><StartWhenAvailable>true</StartWhenAvailable><RestartOnFailure><Interval>PT1M</Interval><Count>10</Count></RestartOnFailure><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings>
  <Actions Context="Author"><Exec><Command>${xmlEscape(process.execPath)}</Command><Arguments>${xmlEscape(`"${daemonEntrypoint()}" --state-root "${root}"`)}</Arguments><WorkingDirectory>${xmlEscape(dirname(daemonEntrypoint()))}</WorkingDirectory></Exec></Actions>
</Task>`;
  const path = join(root, "stan-task.xml");
  await atomicWritePrivate(path, Buffer.from(`\uFEFF${xml}`, "utf16le"));
  await execFileAsync(
    "schtasks",
    ["/Create", "/TN", "Stan", "/XML", path, "/F"],
    {
      env: { ...process.env, STAN_STATE_ROOT: root },
    },
  );
  console.log('Installed Windows Task Scheduler task "Stan".');
}

export async function readServiceMetadata(root: string): Promise<unknown> {
  try {
    return JSON.parse(
      await readFile(statePaths(root).service, "utf8"),
    ) as unknown;
  } catch {
    return undefined;
  }
}

function daemonEntrypoint(): string {
  const current = fileURLToPath(import.meta.url);
  if (current.includes(`${join("src", "cli", "commands")}`))
    return resolve(dirname(current), "..", "..", "gateway", "daemon.ts");
  return resolve(dirname(current), "..", "gateway", "daemon.js");
}

function systemdEscape(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll(" ", "\\x20");
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
