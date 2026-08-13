import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stopService } from "../src/cli/commands/service.ts";

const roots: string[] = [];

async function stateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "stan-service-"));
  roots.push(root);
  await mkdir(join(root, "auth"));
  await writeFile(
    join(root, "auth", "apis.json"),
    JSON.stringify({ version: 1, controlToken: "x".repeat(32) }),
  );
  return root;
}

function statusResponse(): Response {
  return Response.json({
    status: "running",
    pid: 1234,
    uptimeSeconds: 1,
    whatsapp: "connected",
    agentBusy: false,
  });
}

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("service shutdown", () => {
  it("rejects a failed stop response", async () => {
    const root = await stateRoot();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(statusResponse())
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetch);

    await expect(stopService(root)).rejects.toThrow(/refused.*503/i);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("confirms the daemon process exited after status becomes unavailable", async () => {
    vi.useFakeTimers();
    const root = await stateRoot();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(statusResponse())
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockRejectedValue(new Error("connection refused"));
    vi.stubGlobal("fetch", fetch);
    const kill = vi
      .spyOn(process, "kill")
      .mockReturnValueOnce(true)
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      });

    const stopping = stopService(root);
    await vi.advanceTimersByTimeAsync(500);

    await expect(stopping).resolves.toBe(true);
    expect(kill).toHaveBeenCalledTimes(2);
  });
});
