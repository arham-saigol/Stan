import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { password, select } from "@inquirer/prompts";
import { ConfigStore } from "../../config/store.ts";
import {
  CredentialStore,
  type ApiCredentialName,
} from "../../config/credentials.ts";
import { SupermemoryProvider } from "../../memory/supermemory.ts";
import { ZernioProvider } from "../../providers/zernio.ts";
import { XQuikProvider } from "../../providers/xquik.ts";
import { statePaths } from "../../state.ts";
import { getDaemonStatus, startService, stopService } from "./service.ts";

const prompts: [ApiCredentialName, string][] = [
  ["xquikApiKey", "XQuik API key"],
  ["zernioApiKey", "Zernio API key"],
  ["firecrawlApiKey", "Firecrawl API key"],
  ["supermemoryApiKey", "Supermemory API key"],
];

export async function apisAuthCommand(root: string): Promise<void> {
  const daemonWasRunning = Boolean(await getDaemonStatus(root));
  const store = new CredentialStore(root);
  const existingCredentials = store.tryRead();
  const configStore = new ConfigStore(root);
  console.log("Existing credentials:", store.masked());
  const updates: Partial<Record<ApiCredentialName, string | undefined>> = {};
  for (const [name, message] of prompts) {
    const value = await password({
      message: `${message} (blank keeps existing)`,
      mask: "*",
    });
    if (value.trim()) updates[name] = value.trim();
  }
  if (updates.xquikApiKey)
    await new XQuikProvider(updates.xquikApiKey).health();
  let selectedXAccountId: string | undefined;
  if (updates.zernioApiKey) {
    const accounts = await new ZernioProvider(
      updates.zernioApiKey,
    ).listAccounts();
    const choices = accounts
      .filter((account) => account.id && account.connected)
      .map((account) => ({
        value: account.id!,
        name: account.username ?? account.id!,
      }));
    if (!choices.length) throw new Error("Zernio has no connected X account");
    const current = configStore.read().selectedXAccountId;
    selectedXAccountId = choices.some((choice) => choice.value === current)
      ? current
      : await select({ message: "Bound X account", choices });
  }
  if (updates.supermemoryApiKey) {
    const config = configStore.read();
    await new SupermemoryProvider(
      updates.supermemoryApiKey,
      config.memoryContainerTag,
    ).profile();
  }
  const credentialsChanged = Object.keys(updates).length > 0;
  const daemonIsRunning = credentialsChanged
    ? Boolean(await getDaemonStatus(root))
    : false;
  const shouldRestart = daemonWasRunning || daemonIsRunning;
  try {
    if (credentialsChanged && shouldRestart) await stopService(root);
    if (
      updates.zernioApiKey &&
      updates.zernioApiKey !== existingCredentials?.zernioApiKey &&
      hasUnsettledDestructiveWrites(root)
    ) {
      throw new Error(
        "Cannot rotate Zernio credentials while an X cancel or delete is still being verified",
      );
    }
    if (selectedXAccountId) {
      await configStore.update((config) => ({
        ...config,
        selectedXAccountId,
      }));
    }
    await store.update(updates);
    console.log("API credentials validated where possible and saved.");
    if (credentialsChanged && shouldRestart) {
      await startService(root);
      console.log("Stan restarted with the updated provider credentials.");
    }
  } catch (error) {
    if (credentialsChanged && shouldRestart)
      await startService(root).catch(() => undefined);
    throw error;
  }
}

export function hasUnsettledDestructiveWrites(root: string): boolean {
  const path = statePaths(root).applicationDb;
  if (!existsSync(path)) return false;
  const database = new DatabaseSync(path, {
    readOnly: true,
  });
  try {
    return Boolean(
      database
        .prepare(
          `SELECT 1 FROM scheduled_publications s
           JOIN x_operations x ON x.logical_id = s.logical_operation_id
           WHERE x.operation IN ('cancel', 'delete') LIMIT 1`,
        )
        .get(),
    );
  } finally {
    database.close();
  }
}
