import { rm } from "node:fs/promises";
import { confirm, input, password, select } from "@inquirer/prompts";
import { ConfigStore, createDefaultConfig } from "../../config/store.ts";
import {
  CredentialStore,
  type ApiCredentialName,
} from "../../config/credentials.ts";
import { normalizeOwnerPhone } from "../../config/schema.ts";
import { ZernioProvider } from "../../providers/zernio.ts";
import { XQuikProvider } from "../../providers/xquik.ts";
import { SupermemoryProvider } from "../../memory/supermemory.ts";
import {
  atomicWritePrivate,
  initializeStateRoot,
  statePaths,
} from "../../state.ts";
import { ApplicationDatabase } from "../../storage/application-db.ts";
import { WorkspaceStore } from "../../workspace/store.ts";
import { authenticateCodexAndSelect, snapshotCodexState } from "./auth.ts";
import { hasTrackedZernioWrites } from "./apis-auth.ts";
import {
  getDaemonStatus,
  installAutostart,
  startService,
  stopService,
} from "./service.ts";
import { authenticateWhatsApp } from "./whatsapp-auth.ts";

export async function setupCommand(root: string): Promise<void> {
  if (Number(process.versions.node.split(".")[0]) !== 24)
    throw new Error("Stan requires Node.js 24");
  if (process.platform !== "win32" && process.platform !== "linux")
    throw new Error("Stan setup supports Windows and Linux");
  await initializeStateRoot(root);
  const paths = statePaths(root);
  const database = new ApplicationDatabase(paths.applicationDb);
  database.migrate();
  const workspace = new WorkspaceStore(paths.workspace);
  await workspace.initialize();
  const daemonWasRunning = Boolean(await getDaemonStatus(root));
  let daemonStopped = false;
  let existingConfig: ReturnType<ConfigStore["read"]> | undefined;
  let existingCredentials: ReturnType<CredentialStore["tryRead"]>;
  let configWritten = false;
  let credentialsWritten = false;
  let setupComplete = false;
  let codexChanged = false;
  const ownerIdentities = database.database
    .prepare("SELECT identity, kind, created_at FROM owner_identities")
    .all() as { identity: string; kind: string; created_at: string }[];
  const restoreCodex = await snapshotCodexState(root);
  try {
    console.log(
      "Baileys is unofficial and can break when WhatsApp changes. Use a dedicated number; automation can result in suspension.",
    );
    console.log(
      "Selected conversations and context are sent to Supermemory cloud only when its key is configured.",
    );
    const configStore = new ConfigStore(root);
    try {
      existingConfig = configStore.read();
    } catch {
      /* first setup */
    }
    const localPhone = await input({
      message: "Owner mobile number (+92 prefix is fixed)",
      default: existingConfig?.ownerPhone.slice(3) ?? "3001234567",
    });
    const ownerPhone = normalizeOwnerPhone(localPhone);
    const credentialStore = new CredentialStore(root);
    existingCredentials = credentialStore.tryRead();
    const apiValues: Partial<Record<ApiCredentialName, string | undefined>> =
      {};
    for (const [name, label] of [
      ["xquikApiKey", "XQuik API key"],
      ["zernioApiKey", "Zernio API key"],
      ["firecrawlApiKey", "Firecrawl API key"],
      ["supermemoryApiKey", "Supermemory API key"],
    ] as [ApiCredentialName, string][]) {
      const value = await password({
        message: `${label} (blank keeps existing)`,
        mask: "*",
      });
      if (value.trim()) apiValues[name] = value.trim();
    }
    const candidateXQuik =
      apiValues.xquikApiKey ?? existingCredentials?.xquikApiKey;
    const candidateZernio =
      apiValues.zernioApiKey ?? existingCredentials?.zernioApiKey;
    const candidateSupermemory =
      apiValues.supermemoryApiKey ?? existingCredentials?.supermemoryApiKey;
    if (
      apiValues.zernioApiKey &&
      apiValues.zernioApiKey !== existingCredentials?.zernioApiKey &&
      hasTrackedZernioWrites(root)
    ) {
      throw new Error(
        "Cannot rotate Zernio credentials while an X operation is still being tracked",
      );
    }
    if (candidateXQuik) await new XQuikProvider(candidateXQuik).health();
    let selectedXAccountId = existingConfig?.selectedXAccountId;
    if (candidateZernio) {
      const accounts = (await new ZernioProvider(
        candidateZernio,
      ).listAccounts()) as {
        id?: string;
        username?: string;
        connected?: boolean;
      }[];
      const choices = accounts
        .filter((account) => account.id && account.connected)
        .map((account) => ({
          value: account.id!,
          name: account.username ?? account.id!,
        }));
      if (!choices.length) throw new Error("Zernio has no connected X account");
      selectedXAccountId = await select({
        message: "Bound X account",
        choices,
      });
    }
    codexChanged = true;
    const model = await authenticateCodexAndSelect(root);
    const config =
      existingConfig ??
      createDefaultConfig({
        ownerPhone,
        modelId: model.modelId,
        thinkingLevel: model.thinkingLevel as ReturnType<
          typeof createDefaultConfig
        >["model"]["thinkingLevel"],
      });
    if (candidateSupermemory) {
      await new SupermemoryProvider(
        candidateSupermemory,
        config.memoryContainerTag,
      ).profile();
    }
    if (daemonWasRunning) {
      await stopService(root);
      daemonStopped = true;
    }
    const finalConfig = await configStore.write({
      ...config,
      ownerPhone,
      model: {
        provider: "openai-codex",
        id: model.modelId,
        thinkingLevel: model.thinkingLevel,
      },
      ...(selectedXAccountId ? { selectedXAccountId } : {}),
    });
    configWritten = true;
    await credentialStore.update(apiValues);
    credentialsWritten = true;
    database.configureOwnerIdentity(`${ownerPhone.slice(1)}@s.whatsapp.net`);
    if (
      await confirm({ message: "Authenticate WhatsApp now?", default: true })
    ) {
      await authenticateWhatsApp(database, finalConfig);
    }
    if (
      await confirm({
        message: "Install always-on autostart service?",
        default: false,
      })
    ) {
      await installAutostart(root);
    }
    setupComplete = true;
    console.log({
      stateRoot: root,
      ownerPhone: `${ownerPhone.slice(0, 5)}…${ownerPhone.slice(-3)}`,
      model: `openai-codex/${model.modelId}`,
      thinkingLevel: model.thinkingLevel,
      xAccount: selectedXAccountId ?? "not configured",
      heartbeat: finalConfig.heartbeat,
    });
  } catch (error) {
    if (!setupComplete) {
      if (configWritten) {
        if (existingConfig) await new ConfigStore(root).write(existingConfig);
        else await rm(paths.config, { force: true });
      }
      if (credentialsWritten) {
        if (existingCredentials) {
          await atomicWritePrivate(
            paths.credentials,
            `${JSON.stringify(existingCredentials, null, 2)}\n`,
          );
        } else {
          await rm(paths.credentials, { force: true });
        }
      }
      database.transaction(() => {
        database.database.exec("DELETE FROM owner_identities");
        const insert = database.database.prepare(
          "INSERT INTO owner_identities(identity, kind, created_at) VALUES (?, ?, ?)",
        );
        for (const owner of ownerIdentities)
          insert.run(owner.identity, owner.kind, owner.created_at);
      });
      if (codexChanged) await restoreCodex();
    }
    throw error;
  } finally {
    database.close();
    if (daemonStopped) await startService(root);
  }
}
