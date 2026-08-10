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
    const agent = {
      isBusy: () => false,
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

    await scheduler.tick(false, Temporal.Instant.from("2026-08-13T04:00:00Z")); // 09:00
    await scheduler.tick(false, Temporal.Instant.from("2026-08-13T04:00:30Z"));
    await scheduler.tick(false, Temporal.Instant.from("2026-08-13T07:00:00Z")); // 12:00

    expect(sendOwner).toHaveBeenCalledTimes(1);
    expect(sendOwner).toHaveBeenCalledWith(
      "Morning — what should we work on?",
      "heartbeat:heartbeat:2026-08-13:09:00",
    );
    expect(agent.deliver).toHaveBeenCalledTimes(2);
    database.close();
  });
});
