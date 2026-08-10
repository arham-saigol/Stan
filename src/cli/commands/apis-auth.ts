import { password } from "@inquirer/prompts";
import { ConfigStore } from "../../config/store.ts";
import {
  CredentialStore,
  type ApiCredentialName,
} from "../../config/credentials.ts";
import { SupermemoryProvider } from "../../memory/supermemory.ts";
import { ZernioProvider } from "../../providers/zernio.ts";
import { XQuikProvider } from "../../providers/xquik.ts";

const prompts: [ApiCredentialName, string][] = [
  ["xquikApiKey", "XQuik API key"],
  ["zernioApiKey", "Zernio API key"],
  ["firecrawlApiKey", "Firecrawl API key"],
  ["supermemoryApiKey", "Supermemory API key"],
];

export async function apisAuthCommand(root: string): Promise<void> {
  const store = new CredentialStore(root);
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
  if (updates.zernioApiKey)
    await new ZernioProvider(updates.zernioApiKey).listAccounts();
  if (updates.supermemoryApiKey) {
    const config = new ConfigStore(root).read();
    await new SupermemoryProvider(
      updates.supermemoryApiKey,
      config.memoryContainerTag,
    ).profile();
  }
  await store.update(updates);
  console.log("API credentials validated where possible and saved.");
}
