import { describe, expect, it, vi } from "vitest";
import {
  ingestPendingMemory,
  reconcilePendingMemory,
} from "../src/memory/ingestion.ts";
import type { SupermemoryProvider } from "../src/memory/supermemory.ts";
import { ApplicationDatabase } from "../src/storage/application-db.ts";

const input = {
  localDate: "2026-08-13",
  conversationId: "stan-owner-2026-08-13",
  transcript: "owner: hello\nstan: hi",
  complete: true,
};

describe("durable memory ingestion", () => {
  it("bounds permanent failures and redacts the persisted provider error", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    const memory = {
      ingestSession: vi.fn(async () => {
        throw new Error(
          "POST https://memory.example/add?api_key=secret-value failed",
        );
      }),
    } as unknown as SupermemoryProvider;

    await ingestPendingMemory(database, memory, input);
    await ingestPendingMemory(database, memory, input);
    await ingestPendingMemory(database, memory, input);

    const row = database.database
      .prepare(
        "SELECT status, attempts, next_attempt_at, last_error FROM memory_documents",
      )
      .get() as {
      status: string;
      attempts: number;
      next_attempt_at: string | null;
      last_error: string;
    };
    expect(row).toMatchObject({
      status: "failed",
      attempts: 3,
      next_attempt_at: null,
    });
    expect(row.last_error).not.toContain("secret-value");
    database.close();
  });

  it("polls a pending provider document instead of re-ingesting it", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    const memory = {
      ingestSession: vi.fn(async () => ({ id: "memory-1", status: "pending" })),
      status: vi.fn(async () => ({ status: "pending" })),
    } as unknown as SupermemoryProvider;

    await ingestPendingMemory(database, memory, input);
    await reconcilePendingMemory(database, memory);

    expect(memory.ingestSession).toHaveBeenCalledOnce();
    expect(memory.status).toHaveBeenCalledWith("memory-1");
    database.close();
  });
});
