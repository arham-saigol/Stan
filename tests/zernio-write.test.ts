import { describe, expect, it, vi } from "vitest";
import { ApplicationDatabase } from "../src/storage/application-db.ts";
import {
  ZernioWriteService,
  type ZernioMutationProvider,
} from "../src/providers/zernio-write-service.ts";

function authorized(database: ApplicationDatabase, text = "post it") {
  database.bindOwnerIdentity("923001234567@s.whatsapp.net", "pn");
  database.claimInbound({
    id: "owner-1",
    senderIdentity: "923001234567@s.whatsapp.net",
    body: text,
    receivedAt: new Date().toISOString(),
  });
  return database.createAuthorization({
    sourceMessageId: "owner-1",
    operation: "publish",
  });
}

describe("Zernio public-write boundary", () => {
  it("rejects a mutation without current trusted owner authorization", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    const mutate = vi.fn();
    const service = new ZernioWriteService(database, {
      mutate,
    } as unknown as ZernioMutationProvider);

    await expect(
      service.execute(
        { sourceMessageId: "owner-1", selectedAccountId: "account-1" },
        { operation: "publish", content: "hello" },
      ),
    ).rejects.toThrow(/authorization/i);
    expect(mutate).not.toHaveBeenCalled();
    database.close();
  });

  it("reuses one request id across an ambiguous timeout and retry", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    authorized(database);
    const posts = new Map<string, string>();
    let first = true;
    const mutate = vi.fn(async (input: { requestId: string }) => {
      posts.set(input.requestId, "x-123");
      if (first) {
        first = false;
        throw new Error("request timed out");
      }
      return {
        status: "published" as const,
        providerId: "z-1",
        publicId: "x-123",
        publicUrl: "https://x.com/a/status/x-123",
      };
    });
    const service = new ZernioWriteService(database, { mutate });
    const context = {
      sourceMessageId: "owner-1",
      selectedAccountId: "account-1",
    };
    const request = { operation: "publish" as const, content: "hello" };

    const firstResult = await service.execute(context, request);
    const retryResult = await service.execute(context, request);

    expect(firstResult.status).toBe("publishing");
    expect(retryResult).toMatchObject({
      status: "published",
      publicId: "x-123",
    });
    expect(posts).toHaveLength(1);
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(mutate.mock.calls[0]![0].requestId).toBe(
      mutate.mock.calls[1]![0].requestId,
    );
    database.close();
  });

  it("rejects edits and deletions for a post outside the configured X account", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    database.claimInbound({
      id: "owner-edit",
      senderIdentity: "923001234567@s.whatsapp.net",
      body: "edit it",
      receivedAt: new Date().toISOString(),
    });
    const envelope = database.createAuthorization({
      sourceMessageId: "owner-edit",
      operation: "edit",
    });
    const mutate = vi.fn();
    const service = new ZernioWriteService(database, {
      mutate,
      verifyPostAccount: vi.fn(async () => false),
    });

    await expect(
      service.execute(
        {
          sourceMessageId: "owner-edit",
          selectedAccountId: "account-1",
        },
        {
          operation: "edit",
          providerPostId: "other-account-post",
          content: "changed",
        },
      ),
    ).rejects.toThrow(/configured X account/i);
    expect(mutate).not.toHaveBeenCalled();
    expect(database.getAuthorization(envelope.id)?.consumedAt).toBeNull();
    database.close();
  });

  it("does not repeat a non-idempotent edit after an ambiguous provider outcome", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    database.claimInbound({
      id: "owner-edit",
      senderIdentity: "923001234567@s.whatsapp.net",
      body: "edit X post z-1",
      receivedAt: new Date().toISOString(),
    });
    database.createAuthorization({
      sourceMessageId: "owner-edit",
      operation: "edit",
    });
    const mutate = vi.fn(async () => {
      throw new Error("connection reset after edit");
    });
    const service = new ZernioWriteService(database, {
      mutate,
      verifyPostAccount: vi.fn(async () => true),
    });
    const context = {
      sourceMessageId: "owner-edit",
      selectedAccountId: "account-1",
    };
    const request = {
      operation: "edit" as const,
      providerPostId: "z-1",
      content: "changed",
    };

    const first = await service.execute(context, request);
    const repeated = await service.execute(context, request);

    expect(first.status).toBe("publishing");
    expect(first.nextRetryAt).toBeNull();
    expect(repeated.logicalId).toBe(first.logicalId);
    expect(mutate).toHaveBeenCalledOnce();
    database.close();
  });

  it("polls provider state when an immediate create is accepted but still publishing", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    authorized(database);
    const service = new ZernioWriteService(database, {
      mutate: vi.fn(async () => ({
        status: "publishing" as const,
        providerId: "z-pending",
      })),
    });

    const result = await service.execute(
      {
        sourceMessageId: "owner-1",
        selectedAccountId: "account-1",
      },
      { operation: "publish", content: "hello" },
    );
    const poll = database.database
      .prepare(
        "SELECT provider_id FROM scheduled_publications WHERE logical_operation_id = ?",
      )
      .get(result.logicalId) as { provider_id: string };

    expect(result.status).toBe("publishing");
    expect(poll.provider_id).toBe("z-pending");
    database.close();
  });

  it("never reports published without a verified public id and URL", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    authorized(database);
    const service = new ZernioWriteService(database, {
      mutate: vi.fn(async () => ({
        status: "published" as const,
        providerId: "z-1",
      })),
    });

    const result = await service.execute(
      {
        sourceMessageId: "owner-1",
        selectedAccountId: "account-1",
      },
      { operation: "publish", content: "hello" },
    );

    expect(result.status).toBe("partial");
    database.close();
  });
});
