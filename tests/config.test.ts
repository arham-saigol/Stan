import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore, createDefaultConfig } from "../src/config/store.ts";
import { normalizeOwnerPhone } from "../src/config/schema.ts";
import { initializeStateRoot } from "../src/state.ts";

describe("configuration", () => {
  it("normalizes Pakistani owner input and persists only valid configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "stan-config-"));
    await initializeStateRoot(root);
    const store = new ConfigStore(root);
    const config = createDefaultConfig({
      ownerPhone: normalizeOwnerPhone("3001234567"),
    });

    await store.write(config);

    expect(store.read()).toEqual(config);
    expect(config.ownerPhone).toBe("+923001234567");
    expect(config.timezone).toBe("Asia/Karachi");
    expect(config.heartbeat.startTime).toBe("09:00");
    expect(config.heartbeat.endTime).toBe("00:00");
    expect(
      JSON.parse(await readFile(join(root, "config.json"), "utf8")),
    ).toEqual(config);
    if (process.platform !== "win32") {
      expect((await stat(join(root, "config.json"))).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects invalid schedule settings instead of retaining them", async () => {
    const root = await mkdtemp(join(tmpdir(), "stan-config-"));
    const store = new ConfigStore(root);
    const config = createDefaultConfig({ ownerPhone: "+923001234567" });

    await expect(
      store.write({
        ...config,
        heartbeat: { ...config.heartbeat, intervalMinutes: 10 },
      }),
    ).rejects.toThrow(/interval/i);
    await expect(
      readFile(join(root, "config.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes concurrent read-modify-write updates", async () => {
    const root = await mkdtemp(join(tmpdir(), "stan-config-"));
    const store = new ConfigStore(root);
    await store.write(createDefaultConfig({ ownerPhone: "+923001234567" }));

    await Promise.all([
      store.update((current) => ({
        ...current,
        heartbeat: { ...current.heartbeat, intervalMinutes: 60 },
      })),
      store.update((current) => ({
        ...current,
        heartbeat: { ...current.heartbeat, morningCatchupMinutes: 30 },
      })),
    ]);

    expect(store.read().heartbeat).toMatchObject({
      intervalMinutes: 60,
      morningCatchupMinutes: 30,
    });
  });
});
