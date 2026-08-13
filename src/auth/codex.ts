import {
  getSupportedThinkingLevels,
  type AuthEvent,
  type Api,
  type AuthPrompt,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { input, password, select } from "@inquirer/prompts";
import { statePaths } from "../state.ts";

export interface CodexModelChoice {
  id: string;
  name: string;
  thinkingLevels: ReturnType<typeof getSupportedThinkingLevels>;
  contextWindow: number;
}

export async function createCodexRuntime(root: string): Promise<ModelRuntime> {
  const paths = statePaths(root);
  return ModelRuntime.create({
    authPath: paths.codexAuth,
    modelsPath: paths.codexModels,
    modelsStorePath: `${paths.codexModels}.cache`,
    refreshOnCreate: true,
    allowModelNetwork: false,
  });
}

export async function loginCodex(
  root: string,
  options: {
    method?: "device_code" | "browser";
    notify?: (event: AuthEvent) => void;
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  const runtime = await createCodexRuntime(root);
  const method = options.method ?? "device_code";
  await runtime.login("openai-codex", "oauth", {
    ...(options.signal ? { signal: options.signal } : {}),
    notify(event) {
      options.notify?.(event);
      if (event.type === "device_code") {
        console.log(
          `Open ${event.verificationUri} and enter code ${event.userCode}`,
        );
      } else if (event.type === "auth_url") {
        console.log(`Open ${event.url}`);
      } else if (event.type === "progress") {
        console.log(event.message);
      }
    },
    prompt: (prompt) => answerPrompt(prompt, method),
  });
}

export async function listCodexModels(
  root: string,
  signal = AbortSignal.timeout(15_000),
): Promise<CodexModelChoice[]> {
  const runtime = await createCodexRuntime(root);
  await runtime.refresh({
    providers: ["openai-codex"],
    allowNetwork: true,
    force: true,
    signal,
  });
  const available = await runtime.getAvailable("openai-codex", { signal });
  return available.map((model) => describeModel(model));
}

export async function verifyCodexRefresh(
  root: string,
  signal = AbortSignal.timeout(15_000),
): Promise<boolean> {
  const runtime = await createCodexRuntime(root);
  const auth = await runtime.getAuth("openai-codex", {
    signal,
    minOAuthValidityMs: 10 * 60_000,
  });
  return Boolean(
    auth?.auth.apiKey && runtime.isUsingSubscription("openai-codex"),
  );
}

export async function createFlueCodexProvider(root: string): Promise<Provider> {
  const runtime = await createCodexRuntime(root);
  const provider = runtime.getProvider("openai-codex");
  if (!provider)
    throw new Error("Pi did not register the OpenAI Codex provider");
  return {
    id: provider.id,
    name: provider.name,
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    ...(provider.headers ? { headers: provider.headers } : {}),
    auth: {
      apiKey: {
        name: "Stan-owned OpenAI Codex OAuth credential",
        check: async ({ signal }) => {
          const auth = await runtime.checkAuth("openai-codex", { signal });
          return auth
            ? { source: "Stan auth store", type: "api_key" as const }
            : undefined;
        },
        resolve: async ({ signal }) => {
          const result = await runtime.getAuth("openai-codex", { signal });
          return result ? { ...result, source: "Stan auth store" } : undefined;
        },
      },
    },
    getModels: () => provider.getModels(),
    ...(provider.refreshModels
      ? { refreshModels: provider.refreshModels.bind(provider) }
      : {}),
    ...(provider.filterModels
      ? { filterModels: provider.filterModels.bind(provider) }
      : {}),
    stream: provider.stream.bind(provider),
    streamSimple: provider.streamSimple.bind(provider),
    ...(provider.fetchDeferred
      ? { fetchDeferred: provider.fetchDeferred.bind(provider) }
      : {}),
    ...(provider.cancelDeferred
      ? { cancelDeferred: provider.cancelDeferred.bind(provider) }
      : {}),
  };
}

function describeModel(model: Model<Api>): CodexModelChoice {
  return {
    id: model.id,
    name: model.name,
    thinkingLevels: getSupportedThinkingLevels(model),
    contextWindow: model.contextWindow,
  };
}

async function answerPrompt(
  prompt: AuthPrompt,
  method: "device_code" | "browser",
): Promise<string> {
  if (prompt.type === "select") {
    const preferred = prompt.options.find((option) => option.id === method);
    if (preferred) return preferred.id;
    return select({
      message: prompt.message,
      choices: prompt.options.map((option) => ({
        value: option.id,
        name: option.label,
        ...(option.description ? { description: option.description } : {}),
      })),
    });
  }
  if (prompt.type === "secret")
    return password({ message: prompt.message, mask: "*" });
  return input({
    message: prompt.message,
    default: prompt.placeholder,
    ...(prompt.signal ? { signal: prompt.signal } : {}),
  });
}
