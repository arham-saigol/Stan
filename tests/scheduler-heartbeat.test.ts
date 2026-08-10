import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Temporal } from "@js-temporal/polyfill";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { StanAgentRuntime } from "../src/agents/runtime.ts";
import { ConfigStore, createDefaultConfig } from "../src/config/store.ts";
import type { DeliveryService } from "../src/gateway/delivery.ts";
import { AutomationStore } from "../src/scheduler/automations.ts";
import { Scheduler } from "../src/scheduler/scheduler.ts";
import { ApplicationDatabase } from "../src/storage/application-db.ts";

describe("heartbeat execution", () => {
  it("sends the model-written morning response once and lets a regular run stay silent", async () => {
    const root = await mkdtemp(join(tmpdir(), "stan-heartbeat-run-"));
    const config = new ConfigStore(root);
    await config.write(createDefaultConfig({ ownerPhone: "+923001234567" }));
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    const sendOwner = vi.fn(async () => ({ messageId: "out-1" }));
    let busy = true;
    const agent = {
      isBusy: () => busy,
      deliver: vi.fn(
        async (
          _id: string,
          message: { attributes?: Record<string, string> },
        ) => {
          const occurrenceId = message.attributes!.occurrenceId!;
          const morning = message.attributes!.kind === "morning";
          database.database
            .prepare(
              "UPDATE heartbeat_occurrences SET status = ?, notify = ?, message = ?, reason = 'nothing_useful' WHERE occurrence_id = ?",
            )
            .run(
              morning ? "ready" : "silent",
              morning ? 1 : 0,
              morning ? "Morning — what should we work on?" : null,
              occurrenceId,
            );
          return morning ? "Morning — what should we work on?" : "";
        },
      ),
    } as unknown as StanAgentRuntime;
    const scheduler = new Scheduler(
      database,
      config,
      agent,
      { sendOwner } as unknown as DeliveryService,
      new AutomationStore(database),
      pino({ level: "silent" }),
      undefined,
      async () => {
        throw new Error("XQuik unavailable");
      },
    );

    await scheduler.tick(Temporal.Instant.from("2026-08-13T04:00:00Z")); // busy at 09:00
    busy = false;
    await scheduler.tick(Temporal.Instant.from("2026-08-13T04:00:30Z"));
    await scheduler.tick(Temporal.Instant.from("2026-08-13T07:00:00Z")); // 12:00

    expect(sendOwner).toHaveBeenCalledTimes(1);
    expect(sendOwner).toHaveBeenCalledWith(
      "Morning — what should we work on?",
      "heartbeat:heartbeat:2026-08-13:09:00",
    );
    expect(agent.deliver).toHaveBeenCalledTimes(2);
    database.close();
  });

  it("retries a regular heartbeat notification without rerunning the agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "stan-heartbeat-retry-"));
    const config = new ConfigStore(root);
    await config.write(createDefaultConfig({ ownerPhone: "+923001234567" }));
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    const sendOwner = vi
      .fn()
      .mockRejectedValueOnce(new Error("WhatsApp offline"))
      .mockResolvedValueOnce({ messageId: "out-1" });
    const deliver = vi.fn(
      async (_id: string, message: { attributes?: Record<string, string> }) => {
        database.database
          .prepare(
            "UPDATE heartbeat_occurrences SET status = 'ready', notify = 1, message = ? WHERE occurrence_id = ?",
          )
          .run("One useful interruption", message.attributes!.occurrenceId!);
        return "One useful interruption";
      },
    );
    const scheduler = new Scheduler(
      database,
      config,
      { isBusy: () => false, deliver } as unknown as StanAgentRuntime,
      { sendOwner } as unknown as DeliveryService,
      new AutomationStore(database),
      pino({ level: "silent" }),
    );

    await scheduler.tick(Temporal.Instant.from("2026-08-13T07:00:00Z"));
    await scheduler.tick(Temporal.Instant.from("2026-08-13T07:01:00Z"));

    expect(deliver).toHaveBeenCalledOnce();
    expect(sendOwner).toHaveBeenCalledTimes(2);
    expect(
      database.database
        .prepare("SELECT status FROM heartbeat_occurrences")
        .get(),
    ).toEqual({ status: "notified" });

    database.database
      .prepare(
        `INSERT INTO heartbeat_occurrences(occurrence_id, local_date, scheduled_for, kind, status, notify, message, created_at, updated_at)
         VALUES (?, ?, ?, 'regular', 'ready', 1, ?, ?, ?)`,
      )
      .run(
        "heartbeat:2026-08-13:crash",
        "2026-08-13",
        "2026-08-13T07:01:30Z",
        "Persisted before a daemon exit",
        "2026-08-13T07:01:30Z",
        "2026-08-13T07:01:30Z",
      );
    await scheduler.tick(Temporal.Instant.from("2026-08-13T07:02:00Z"));

    expect(deliver).toHaveBeenCalledOnce();
    expect(sendOwner).toHaveBeenCalledTimes(3);
    expect(
      database.database
        .prepare(
          "SELECT status FROM heartbeat_occurrences WHERE occurrence_id = 'heartbeat:2026-08-13:crash'",
        )
        .get(),
    ).toEqual({ status: "notified" });
    database.close();
  });
});
