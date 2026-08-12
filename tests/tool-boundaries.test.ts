import { describe, expect, it, vi } from "vitest";
import type { WorkspaceStore } from "../src/workspace/store.ts";
import { ApplicationDatabase } from "../src/storage/application-db.ts";
import type { ConfigStore } from "../src/config/store.ts";
import { heartbeatTools } from "../src/tools/heartbeat.ts";
import { settingsTools } from "../src/tools/settings.ts";
import { workspaceTools } from "../src/tools/workspace.ts";
import { automationTools } from "../src/tools/automations.ts";
import { memoryTools } from "../src/tools/memory.ts";
import type { SupermemoryProvider } from "../src/memory/supermemory.ts";
import { AutomationStore } from "../src/scheduler/automations.ts";
import {
  automationMutationPayload,
  memoryMutationPayload,
  workspaceMutationPayload,
} from "../src/gateway/owner-authorization.ts";

type Run = (context: { data: Record<string, unknown> }) => Promise<unknown>;

describe("trusted tool boundaries", () => {
  it("allows only the owned running heartbeat to settle once", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    database.database
      .prepare(
        `INSERT INTO heartbeat_occurrences(occurrence_id, local_date, scheduled_for, kind, status, created_at, updated_at)
         VALUES ('heartbeat-1', '2026-08-13', '2026-08-13T04:00:00Z', 'morning', 'running',
                 '2026-08-13T04:00:00Z', '2026-08-13T04:00:00Z')`,
      )
      .run();
    const tool = heartbeatTools(database, {
      kind: "heartbeat",
      occurrenceId: "heartbeat-1",
      isMorning: true,
    })[0]!;
    const run = tool.run as Run;
    const input = {
      data: {
        notify: true,
        message: "Good morning",
        reason: "useful_check_in",
      },
    };

    await expect(run(input)).resolves.toMatchObject({ terminate: true });
    await expect(run(input)).rejects.toThrow(/not owned or running/i);
    database.close();
  });

  it("rejects workspace persistence outside a current owner turn", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    const edit = vi.fn();
    const workspace = {
      read: vi.fn(),
      edit,
    } as unknown as WorkspaceStore;
    const tool = workspaceTools(workspace, database, {
      kind: "heartbeat",
      occurrenceId: "heartbeat-1",
    }).find((candidate) => candidate.name === "edit_workspace_file")!;

    await expect(
      (tool.run as Run)({
        data: { file: "goals", operation: "append", text: "injected" },
      }),
    ).rejects.toThrow(/owner message/i);
    expect(edit).not.toHaveBeenCalled();
    database.close();
  });

  it("binds a workspace edit to the exact owner-confirmed payload", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    database.claimInbound({
      id: "owner-workspace",
      senderIdentity: "923001234567@s.whatsapp.net",
      body: "edit workspace",
      receivedAt: new Date().toISOString(),
    });
    const edit = vi.fn(async () => "updated");
    const workspace = {
      read: vi.fn(),
      edit,
    } as unknown as WorkspaceStore;
    const tool = workspaceTools(workspace, database, {
      kind: "owner",
      sourceMessageId: "owner-workspace",
    }).find((candidate) => candidate.name === "edit_workspace_file")!;
    const data = { file: "goals", operation: "append", text: "Ship Stan" };

    database.createWorkspaceAuthorization(
      "owner-workspace",
      workspaceMutationPayload(data),
    );
    await expect((tool.run as Run)({ data })).resolves.toMatchObject({
      output: { file: "goals", content: "updated" },
    });
    await expect((tool.run as Run)({ data })).resolves.toMatchObject({
      output: { file: "goals", content: "updated" },
    });
    expect(edit).toHaveBeenCalledOnce();
    database.close();
  });

  it("returns the prior heartbeat settings result on an exact retry", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    database.claimInbound({
      id: "owner-settings",
      senderIdentity: "923001234567@s.whatsapp.net",
      body: "update heartbeat",
      receivedAt: new Date().toISOString(),
    });
    const data = { enabled: false };
    database.createHeartbeatSettingsAuthorization(
      "owner-settings",
      JSON.stringify(data),
    );
    const update = vi.fn(async () => ({ heartbeat: data }));
    const store = { read: vi.fn(), update } as unknown as ConfigStore;
    const tool = settingsTools(store, database, {
      kind: "owner",
      sourceMessageId: "owner-settings",
    }).find((candidate) => candidate.name === "update_heartbeat_settings")!;

    await expect((tool.run as Run)({ data })).resolves.toMatchObject({
      output: data,
    });
    await expect((tool.run as Run)({ data })).resolves.toMatchObject({
      output: data,
    });
    expect(update).toHaveBeenCalledOnce();
    database.close();
  });

  it("consumes explicit operation-specific automation intent", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    database.claimInbound({
      id: "owner-automation",
      senderIdentity: "923001234567@s.whatsapp.net",
      body: "create a reminder automation",
      receivedAt: new Date().toISOString(),
    });
    const store = new AutomationStore(database);
    const tool = automationTools(store, {
      kind: "owner",
      sourceMessageId: "owner-automation",
    }).find((candidate) => candidate.name === "create_automation")!;
    const input = {
      data: {
        name: "explicit reminder",
        scheduleType: "once",
        at: "2099-08-13T09:00:00+05:00",
        instruction: "Prepare the report",
        deliveryMode: "owner_whatsapp",
      },
    };

    await expect((tool.run as Run)(input)).rejects.toThrow(/authorization/i);
    database.createAutomationAuthorization(
      "owner-automation",
      "create",
      automationMutationPayload("create", input.data),
    );
    await expect((tool.run as Run)(input)).resolves.toMatchObject({
      output: { name: "explicit reminder" },
    });
    await expect((tool.run as Run)(input)).rejects.toThrow(/authorization/i);
    database.close();
  });

  it("does not consume memory intent when Supermemory is unavailable", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    database.claimInbound({
      id: "owner-memory",
      senderIdentity: "923001234567@s.whatsapp.net",
      body: "remember: simple systems",
      receivedAt: new Date().toISOString(),
    });
    const data = { content: "simple systems" };
    database.createMemoryAuthorization(
      "owner-memory",
      "remember",
      memoryMutationPayload("remember", data),
    );
    const trusted = { kind: "owner" as const, sourceMessageId: "owner-memory" };
    const unavailable = memoryTools(undefined, database, trusted).find(
      (candidate) => candidate.name === "remember",
    )!;

    await expect((unavailable.run as Run)({ data })).rejects.toThrow(
      /Supermemory is unavailable/i,
    );

    const remember = vi.fn(async () => ({ id: "memory-1", status: "done" }));
    const available = memoryTools(
      { remember } as unknown as SupermemoryProvider,
      database,
      trusted,
    ).find((candidate) => candidate.name === "remember")!;
    await expect((available.run as Run)({ data })).resolves.toMatchObject({
      output: { id: "memory-1" },
    });
    database.close();
  });

  it("retries the exact idempotent memory mutation after provider failure", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    database.claimInbound({
      id: "owner-memory",
      senderIdentity: "923001234567@s.whatsapp.net",
      body: "remember: simple systems",
      receivedAt: new Date().toISOString(),
    });
    const remember = vi
      .fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce({ id: "memory-1", status: "done" });
    const tool = memoryTools(
      { remember } as unknown as SupermemoryProvider,
      database,
      { kind: "owner", sourceMessageId: "owner-memory" },
    ).find((candidate) => candidate.name === "remember")!;
    const data = { content: "simple systems" };

    database.createMemoryAuthorization(
      "owner-memory",
      "remember",
      memoryMutationPayload("remember", data),
    );
    await expect((tool.run as Run)({ data })).rejects.toThrow(/response lost/i);
    await expect((tool.run as Run)({ data })).resolves.toMatchObject({
      output: { id: "memory-1" },
    });
    await expect(
      (tool.run as Run)({ data: { content: "different content" } }),
    ).rejects.toThrow(/authorization/i);
    expect(remember).toHaveBeenCalledTimes(2);
    expect(remember.mock.calls[0]![1]).toBe(remember.mock.calls[1]![1]);
    database.close();
  });
});
