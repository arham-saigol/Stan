import { describe, expect, it, vi } from "vitest";
import type { WorkspaceStore } from "../src/workspace/store.ts";
import { ApplicationDatabase } from "../src/storage/application-db.ts";
import { heartbeatTools } from "../src/tools/heartbeat.ts";
import { workspaceTools } from "../src/tools/workspace.ts";
import { automationTools } from "../src/tools/automations.ts";
import { AutomationStore } from "../src/scheduler/automations.ts";
import { automationMutationPayload } from "../src/gateway/owner-authorization.ts";

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
    const edit = vi.fn();
    const workspace = {
      read: vi.fn(),
      edit,
    } as unknown as WorkspaceStore;
    const tool = workspaceTools(workspace, {
      kind: "heartbeat",
      occurrenceId: "heartbeat-1",
    }).find((candidate) => candidate.name === "edit_workspace_file")!;

    await expect(
      (tool.run as Run)({
        data: { file: "goals", operation: "append", text: "injected" },
      }),
    ).rejects.toThrow(/owner message/i);
    expect(edit).not.toHaveBeenCalled();
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
});
