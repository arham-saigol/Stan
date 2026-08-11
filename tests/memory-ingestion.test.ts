import { describe, expect, it, vi } from "vitest";
import {
  ingestPendingMemory,
  reconcilePendingMemory,
} from "../src/memory/ingestion.ts";
import { SupermemoryProvider } from "../src/memory/supermemory.ts";
import { ApplicationDatabase } from "../src/storage/application-db.ts";

const input = {
  localDate: "2026-08-13",
  conversationId: "stan-owner-2026-08-13",
  transcript: "owner: hello\nstan: hi",
  complete: true,
};

describe("durable memory ingestion", () => {
  it("marks a truncated provider upload incomplete", async () => {
    const memory = new SupermemoryProvider("test-key", "stan-test");
    const requests: { content: string; metadata: { complete: boolean } }[] = [];
    const add = vi.fn(
      async (request: { content: string; metadata: { complete: boolean } }) => {
        requests.push(request);
        return { id: "memory-1", status: "done" };
      },
    );
    Object.assign(memory as unknown as { client: unknown }, {
      client: { add },
    });

    await memory.ingestSession({
      ...input,
      transcript: `dropped-prefix${"x".repeat(200_000)}`,
    });

    expect(requests[0]).toMatchObject({
      content: "x".repeat(200_000),
      metadata: { complete: false },
    });
  });

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

  it("bounds provider documents that remain pending", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    const memory = {
      ingestSession: vi.fn(async () => ({ id: "memory-1", status: "pending" })),
      status: vi.fn(async () => ({ status: "pending" })),
    } as unknown as SupermemoryProvider;

    await ingestPendingMemory(database, memory, input);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      database.database.exec(
        "UPDATE memory_documents SET next_attempt_at = '2000-01-01T00:00:00Z' WHERE status != 'failed'",
      );
      await reconcilePendingMemory(database, memory);
    }

    expect(memory.status).toHaveBeenCalledTimes(2);
    expect(
      database.database
        .prepare(
          "SELECT status, attempts, next_attempt_at FROM memory_documents",
        )
        .get(),
    ).toEqual({ status: "failed", attempts: 3, next_attempt_at: null });
    database.close();
  });

  it("clears stale provider state when a transcript is refreshed", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    const memory = {
      ingestSession: vi
        .fn()
        .mockResolvedValueOnce({ id: "memory-old", status: "done" })
        .mockRejectedValueOnce(new Error("provider unavailable")),
    } as unknown as SupermemoryProvider;

    await ingestPendingMemory(database, memory, input);
    await ingestPendingMemory(database, memory, {
      ...input,
      transcript: `${input.transcript}\nowner: delayed turn`,
    });

    expect(
      database.database
        .prepare("SELECT provider_id, status, attempts FROM memory_documents")
        .get(),
    ).toEqual({ provider_id: null, status: "pending", attempts: 1 });
    database.close();
  });

  it("bounds retries when accepted provider documents later fail", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    let id = 0;
    const memory = {
      ingestSession: vi.fn(async () => ({
        id: `memory-${++id}`,
        status: "pending",
      })),
      status: vi.fn(async () => ({ status: "failed" })),
    } as unknown as SupermemoryProvider;

    await ingestPendingMemory(database, memory, input);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      database.database.exec(
        "UPDATE memory_documents SET next_attempt_at = '2000-01-01T00:00:00Z' WHERE status != 'failed'",
      );
      await reconcilePendingMemory(database, memory);
    }

    expect(memory.ingestSession).toHaveBeenCalledTimes(3);
    expect(
      database.database
        .prepare(
          "SELECT status, attempts, next_attempt_at FROM memory_documents",
        )
        .get(),
    ).toEqual({ status: "failed", attempts: 3, next_attempt_at: null });
    database.close();
  });

  it("bounds permanent provider status lookup failures", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    const memory = {
      ingestSession: vi.fn(async () => ({ id: "memory-1", status: "pending" })),
      status: vi.fn(async () => {
        throw new Error(
          "GET https://memory.example/status?api_key=secret failed",
        );
      }),
    } as unknown as SupermemoryProvider;

    await ingestPendingMemory(database, memory, input);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      database.database.exec(
        "UPDATE memory_documents SET next_attempt_at = '2000-01-01T00:00:00Z' WHERE status != 'failed'",
      );
      await reconcilePendingMemory(database, memory);
    }

    expect(memory.status).toHaveBeenCalledTimes(2);
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
    expect(row.last_error).not.toContain("secret");
    database.close();
  });
});
