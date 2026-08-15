import { access, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { verifyCodexRefresh } from "../../auth/codex.ts";
import { CredentialStore } from "../../config/credentials.ts";
import { ConfigStore } from "../../config/store.ts";
import { SupermemoryProvider } from "../../memory/supermemory.ts";
import { redactForLogging } from "../../logging.ts";
import { ZernioProvider } from "../../providers/zernio.ts";
import { XQuikProvider } from "../../providers/xquik.ts";
import { statePaths } from "../../state.ts";
import { WORKSPACE_FILES, WorkspaceStore } from "../../workspace/store.ts";
import { getDaemonStatus } from "./service.ts";

interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

export async function doctorCommand(root: string): Promise<void> {
  const checks: Check[] = [];
  const paths = statePaths(root);
  const run = async (name: string, check: () => Promise<string>) => {
    try {
      checks.push({ name, status: "ok", detail: await check() });
    } catch (error) {
      checks.push({ name, status: "fail", detail: safe(error) });
    }
  };
  await run("state permissions", async () => {
    await access(root, constants.R_OK | constants.W_OK);
    const mode = (await lstat(root)).mode & 0o777;
    if (process.platform !== "win32" && mode !== 0o700)
      throw new Error(`expected 0700, found ${mode.toString(8)}`);
    return "owner state root is accessible";
  });
  let config: ReturnType<ConfigStore["read"]> | undefined;
  await run("configuration", async () => {
    config = new ConfigStore(root).read();
    return "valid";
  });
  const credentials = new CredentialStore(root).tryRead();
  await run("database", async () => {
    await access(paths.applicationDb, constants.R_OK);
    const database = new DatabaseSync(paths.applicationDb, { readOnly: true });
    try {
      const row = database.prepare("PRAGMA integrity_check").get() as {
        integrity_check: string;
      };
      if (row.integrity_check !== "ok") throw new Error(row.integrity_check);
      const leases = (
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM heartbeat_occurrences WHERE lease_until < ? AND status IN ('leased', 'running')",
          )
          .get(new Date().toISOString()) as { count: number }
      ).count;
      return `integrity ok; ${leases} expired scheduler leases`;
    } finally {
      database.close();
    }
  });
  await run("workspace", async () => {
    const workspace = new WorkspaceStore(paths.workspace);
    for (const file of Object.keys(WORKSPACE_FILES)) await workspace.read(file);
    const files = await workspace.list();
    await Promise.all(files.map((file) => workspace.read(file)));
    return `${files.length} workspace files valid`;
  });
  await run("Codex", async () =>
    (await verifyCodexRefresh(root))
      ? "subscription credential refreshable"
      : Promise.reject(new Error("not authenticated")),
  );
  const daemon = await getDaemonStatus(root);
  checks.push({
    name: "service",
    status: daemon ? "ok" : "warn",
    detail: daemon ? "running" : "stopped",
  });
  await run("WhatsApp auth", async () => {
    const database = new DatabaseSync(paths.applicationDb, { readOnly: true });
    try {
      const count = (
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM whatsapp_auth WHERE category = 'creds'",
          )
          .get() as { count: number }
      ).count;
      if (!count) throw new Error("not authenticated");
      return daemon
        ? `credentials present; ${daemon.whatsapp}`
        : "credentials present; daemon stopped";
    } finally {
      database.close();
    }
  });
  if (credentials?.zernioApiKey)
    await run(
      "Zernio",
      async () =>
        `${((await new ZernioProvider(credentials.zernioApiKey!).listAccounts()) as unknown[]).length} connected X account records`,
    );
  else
    checks.push({ name: "Zernio", status: "warn", detail: "not configured" });
  if (credentials?.xquikApiKey)
    await run("XQuik", async () => {
      await new XQuikProvider(credentials.xquikApiKey!).health();
      return "account and credits reachable";
    });
  else checks.push({ name: "XQuik", status: "warn", detail: "not configured" });
  checks.push({
    name: "Firecrawl",
    status: credentials?.firecrawlApiKey ? "ok" : "warn",
    detail: credentials?.firecrawlApiKey ? "configured" : "keyless/degraded",
  });
  if (credentials?.supermemoryApiKey && config)
    await run("Supermemory", async () => {
      await new SupermemoryProvider(
        credentials.supermemoryApiKey!,
        config!.memoryContainerTag,
      ).profile();
      return "profile reachable";
    });
  else
    checks.push({
      name: "Supermemory",
      status: "warn",
      detail: "not configured; owner chat continues without semantic memory",
    });
  console.table(checks);
  if (checks.some((check) => check.status === "fail")) process.exitCode = 1;
}

function safe(error: unknown): string {
  const message =
    error instanceof Error ? error.message.slice(0, 300) : "check failed";
  return String(redactForLogging(message));
}
