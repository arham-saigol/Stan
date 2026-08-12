import { select } from "@inquirer/prompts";
import { readFile, unlink } from "node:fs/promises";
import { loginCodex, listCodexModels } from "../../auth/codex.ts";
import { ConfigStore } from "../../config/store.ts";
import { atomicWritePrivate, statePaths } from "../../state.ts";

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
  const thinkingLevels = model.thinkingLevels.filter(
    (level) => level !== "max",
  );
  if (!thinkingLevels.length)
    throw new Error("This model has no Flue-compatible thinking levels");
  const thinkingLevel = await select({
    message: "Thinking level",
    choices: thinkingLevels.map((level) => ({
      value: level,
      name: level,
    })),
  });
  return { modelId, thinkingLevel };
}

export async function authCommand(root: string): Promise<void> {
  const restore = await snapshotCodexState(root);
  try {
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
  } catch (error) {
    await restore();
    throw error;
  }
}

async function snapshotCodexState(root: string): Promise<() => Promise<void>> {
  const paths = statePaths(root);
  const files = [
    paths.codexAuth,
    paths.codexModels,
    `${paths.codexModels}.cache`,
  ];
  const snapshots = await Promise.all(
    files.map(async (path) => ({
      path,
      content: await readFile(path).catch((error: unknown) => {
        if (isMissing(error)) return undefined;
        throw error;
      }),
    })),
  );
  return async () => {
    await Promise.all(
      snapshots.map(({ path, content }) =>
        content ? atomicWritePrivate(path, content) : removeIfPresent(path),
      ),
    );
  };
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
