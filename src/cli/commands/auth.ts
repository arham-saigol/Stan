import { select } from "@inquirer/prompts";
import { loginCodex, listCodexModels } from "../../auth/codex.ts";
import { ConfigStore } from "../../config/store.ts";

export async function authenticateCodexAndSelect(
  root: string,
): Promise<{ modelId: string; thinkingLevel: string }> {
  await loginCodex(root, { method: "device_code" });
  const models = await listCodexModels(root);
  if (!models.length)
    throw new Error("No authenticated OpenAI Codex models are available");
  const modelId = await select({
    message: "OpenAI Codex model",
    choices: models.map((model) => ({
      value: model.id,
      name: model.id,
      description: `${model.name} · ${model.contextWindow.toLocaleString()} context`,
    })),
  });
  const model = models.find((candidate) => candidate.id === modelId)!;
  const thinkingLevel = await select({
    message: "Thinking level",
    choices: model.thinkingLevels.map((level) => ({
      value: level,
      name: level,
    })),
  });
  return { modelId, thinkingLevel };
}

export async function authCommand(root: string): Promise<void> {
  const selected = await authenticateCodexAndSelect(root);
  const store = new ConfigStore(root);
  const current = store.read();
  await store.write({
    ...current,
    model: {
      provider: "openai-codex",
      id: selected.modelId,
      thinkingLevel: selected.thinkingLevel,
    },
  });
  console.log(
    `Using openai-codex/${selected.modelId} with ${selected.thinkingLevel} thinking.`,
  );
}
