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

  it("does not bypass persisted retry backoff on a repeated owner turn", async () => {
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
    const replayedResult = await service.execute(context, request);

    expect(firstResult.status).toBe("publishing");
    expect(replayedResult.logicalId).toBe(firstResult.logicalId);
    expect(posts.size).toBe(1);
    expect(mutate).toHaveBeenCalledOnce();
    database.close();
  });

  it("requeues a create persisted before the provider call", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    authorized(database);
    const mutate = vi.fn(async () => {
      throw new Error("connection reset");
    });
    const service = new ZernioWriteService(database, { mutate });
    const context = {
      sourceMessageId: "owner-1",
      selectedAccountId: "account-1",
    };
    const request = { operation: "publish" as const, content: "hello" };
    const operation = await service.execute(context, request);
    database.database
      .prepare(
        "UPDATE x_operations SET next_retry_at = NULL WHERE logical_id = ?",
      )
      .run(operation.logicalId);

    const recovered = await service.execute(context, request);

    expect(recovered.nextRetryAt).not.toBeNull();
    expect(mutate).toHaveBeenCalledOnce();
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
      targetPostId: "other-account-post",
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

  it("rejects an empty target before the account boundary can be bypassed", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    database.claimInbound({
      id: "owner-edit",
      senderIdentity: "923001234567@s.whatsapp.net",
      body: "edit X post",
      receivedAt: new Date().toISOString(),
    });
    database.createAuthorization({
      sourceMessageId: "owner-edit",
      operation: "edit",
      targetPostId: "z-1",
    });
    const mutate = vi.fn();
    const verifyPostAccount = vi.fn();
    const service = new ZernioWriteService(database, {
      mutate,
      verifyPostAccount,
    });

    await expect(
      service.execute(
        { sourceMessageId: "owner-edit", selectedAccountId: "account-1" },
        { operation: "edit", providerPostId: "", content: "changed" },
      ),
    ).rejects.toThrow(/target X post ID/i);
    expect(verifyPostAccount).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
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
      targetPostId: "z-1",
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
    expect(
      database.database
        .prepare(
          "SELECT provider_id FROM scheduled_publications WHERE logical_operation_id = ?",
        )
        .get(first.logicalId),
    ).toEqual({ provider_id: "z-1" });
    database.close();
  });

  it("rejects a destructive target other than the one the owner authorized", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    database.claimInbound({
      id: "owner-delete",
      senderIdentity: "923001234567@s.whatsapp.net",
      body: "delete X post z-1",
      receivedAt: new Date().toISOString(),
    });
    database.createAuthorization({
      sourceMessageId: "owner-delete",
      operation: "delete",
      targetPostId: "z-1",
    });
    const mutate = vi.fn();
    const service = new ZernioWriteService(database, {
      mutate,
      verifyPostAccount: vi.fn(async () => true),
    });

    await expect(
      service.execute(
        { sourceMessageId: "owner-delete", selectedAccountId: "account-1" },
        { operation: "delete", providerPostId: "z-2" },
      ),
    ).rejects.toThrow(/target authorized by the owner/i);
    expect(mutate).not.toHaveBeenCalled();
    database.close();
  });

  it("rejects a reply target other than the one the owner authorized", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    database.claimInbound({
      id: "owner-reply",
      senderIdentity: "923001234567@s.whatsapp.net",
      body: "reply to X post 111",
      receivedAt: new Date().toISOString(),
    });
    database.createAuthorization({
      sourceMessageId: "owner-reply",
      operation: "reply",
      targetPostId: "111",
    });
    const mutate = vi.fn();
    const service = new ZernioWriteService(database, { mutate });

    await expect(
      service.execute(
        { sourceMessageId: "owner-reply", selectedAccountId: "account-1" },
        { operation: "reply", replyToPostId: "222", content: "hello" },
      ),
    ).rejects.toThrow(/target authorized by the owner/i);
    expect(mutate).not.toHaveBeenCalled();
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
