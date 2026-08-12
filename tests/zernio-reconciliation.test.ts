import type { Post } from "@zernio/node";
import { describe, expect, it, vi } from "vitest";
import type { DeliveryService } from "../src/gateway/delivery.ts";
import { reconcilePendingXOperations } from "../src/providers/zernio-operation-reconciliation.ts";
import { reconcileScheduledPublications } from "../src/providers/zernio-reconciliation.ts";
import {
  ZernioWriteService,
  type ZernioMutationProvider,
  type ZernioMutationRequest,
} from "../src/providers/zernio-write-service.ts";
import { ApplicationDatabase } from "../src/storage/application-db.ts";

function setOperationCreatedAt(
  database: ApplicationDatabase,
  logicalId: string,
  createdAt = "2026-08-13T00:00:00Z",
): void {
  database.database
    .prepare(
      `UPDATE x_operations SET created_at = ?,
       next_retry_at = CASE WHEN next_retry_at IS NULL THEN NULL ELSE ? END
       WHERE logical_id = ?`,
    )
    .run(createdAt, createdAt, logicalId);
  database.database
    .prepare(
      "UPDATE scheduled_publications SET next_poll_at = ? WHERE logical_operation_id = ?",
    )
    .run(createdAt, logicalId);
}

describe("ambiguous Zernio operation reconciliation", () => {
  it("persists the request and retries it with the same provider request id", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    database.claimInbound({
      id: "owner-1",
      senderIdentity: "923001234567@s.whatsapp.net",
      body: "post it",
      receivedAt: "2026-08-13T00:00:00Z",
    });
    database.createAuthorization({
      sourceMessageId: "owner-1",
      operation: "publish",
      authorizedContent: "hello",
      now: new Date("2026-08-13T00:00:00Z"),
    });
    const requestIds: string[] = [];
    let attempt = 0;
    const provider: ZernioMutationProvider = {
      mutate: vi.fn(
        async ({
          requestId,
        }: {
          requestId: string;
          accountId: string;
          request: ZernioMutationRequest;
        }) => {
          requestIds.push(requestId);
          attempt += 1;
          if (attempt === 1) throw new Error("connection reset");
          return {
            status: "published" as const,
            providerId: "z-1",
            publicId: "x-1",
            publicUrl: "https://x.com/stan/status/x-1",
          };
        },
      ),
    };
    const service = new ZernioWriteService(database, provider);
    const initial = await service.execute(
      {
        sourceMessageId: "owner-1",
        selectedAccountId: "account-1",
      },
      { operation: "publish", content: "hello" },
    );
    setOperationCreatedAt(database, initial.logicalId);
    const sendOwner = vi.fn(async () => ({ messageId: "out-1" }));

    await reconcilePendingXOperations(
      database,
      provider,
      { sendOwner } as unknown as DeliveryService,
      new Date("2026-08-13T00:02:00Z"),
    );

    expect(requestIds).toEqual([initial.requestId, initial.requestId]);
    expect(database.getXOperation(initial.logicalId)).toMatchObject({
      status: "published",
      publicId: "x-1",
    });
    expect(sendOwner).toHaveBeenCalledOnce();
    database.close();
  });

  it("rejects schedule drift returned by a recovered create", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    database.claimInbound({
      id: "owner-schedule",
      senderIdentity: "923001234567@s.whatsapp.net",
      body: "schedule it",
      receivedAt: "2026-08-13T00:00:00Z",
    });
    database.createAuthorization({
      sourceMessageId: "owner-schedule",
      operation: "schedule",
      authorizedContent: "hello",
      authorizedScheduledFor: "2026-08-14T00:00:00.000Z",
      now: new Date("2026-08-13T00:00:00Z"),
    });
    let attempt = 0;
    const provider: ZernioMutationProvider = {
      mutate: vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("connection reset");
        return {
          status: "scheduled" as const,
          providerId: "z-1",
          scheduledFor: "2026-08-14T01:00:00Z",
        };
      }),
    };
    const initial = await new ZernioWriteService(database, provider).execute(
      {
        sourceMessageId: "owner-schedule",
        selectedAccountId: "account-1",
      },
      {
        operation: "schedule",
        content: "hello",
        scheduledFor: "2026-08-14T00:00:00Z",
      },
    );
    setOperationCreatedAt(database, initial.logicalId);
    const sendOwner = vi.fn(async () => ({ messageId: "out-1" }));

    await reconcilePendingXOperations(
      database,
      provider,
      { sendOwner } as unknown as DeliveryService,
      new Date("2026-08-13T00:02:00Z"),
    );

    const resolved = database.getXOperation(initial.logicalId)!;
    expect(resolved.status).toBe("partial");
    expect(resolved.error).toMatch(/owner-authorized instant/i);
    expect(sendOwner).not.toHaveBeenCalled();
    database.close();
  });

  it("retries an ID-less partial result returned during reconciliation", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    database.claimInbound({
      id: "owner-idless-schedule",
      senderIdentity: "923001234567@s.whatsapp.net",
      body: "schedule it",
      receivedAt: "2026-08-13T00:00:00Z",
    });
    database.createAuthorization({
      sourceMessageId: "owner-idless-schedule",
      operation: "schedule",
      authorizedContent: "hello",
      authorizedScheduledFor: "2026-08-14T00:00:00.000Z",
      now: new Date("2026-08-13T00:00:00Z"),
    });
    let attempt = 0;
    const provider: ZernioMutationProvider = {
      mutate: vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("connection reset");
        return {
          status: "scheduled" as const,
          scheduledFor: "2026-08-14T00:00:00Z",
        };
      }),
    };
    const operation = await new ZernioWriteService(database, provider).execute(
      {
        sourceMessageId: "owner-idless-schedule",
        selectedAccountId: "account-1",
      },
      {
        operation: "schedule",
        content: "hello",
        scheduledFor: "2026-08-14T00:00:00Z",
      },
    );
    setOperationCreatedAt(database, operation.logicalId);

    await reconcilePendingXOperations(
      database,
      provider,
      { sendOwner: vi.fn() } as unknown as DeliveryService,
      new Date("2026-08-13T00:02:00Z"),
    );

    expect(database.getXOperation(operation.logicalId)).toMatchObject({
      status: "publishing",
      retryCount: 2,
      providerId: null,
    });
    database.close();
  });

  it("retries a terminal owner notification without repeating the provider mutation", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    database.claimInbound({
      id: "owner-1",
      senderIdentity: "923001234567@s.whatsapp.net",
      body: "post it",
      receivedAt: "2026-08-13T00:00:00Z",
    });
    database.createAuthorization({
      sourceMessageId: "owner-1",
      operation: "publish",
      authorizedContent: "hello",
      now: new Date("2026-08-13T00:00:00Z"),
    });
    let attempt = 0;
    const provider: ZernioMutationProvider = {
      mutate: vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("connection reset");
        return {
          status: "published" as const,
          providerId: "z-1",
          publicId: "x-1",
          publicUrl: "https://x.com/stan/status/x-1",
        };
      }),
    };
    const service = new ZernioWriteService(database, provider);
    const initial = await service.execute(
      { sourceMessageId: "owner-1", selectedAccountId: "account-1" },
      { operation: "publish", content: "hello" },
    );
    setOperationCreatedAt(database, initial.logicalId);
    const sendOwner = vi
      .fn()
      .mockRejectedValueOnce(new Error("WhatsApp disconnected"))
      .mockResolvedValueOnce({ messageId: "out-1" });
    const delivery = { sendOwner } as unknown as DeliveryService;

    await reconcilePendingXOperations(
      database,
      provider,
      delivery,
      new Date("2026-08-13T00:02:00Z"),
    );
    expect(database.getXOperation(initial.logicalId)).toMatchObject({
      status: "published",
      nextRetryAt: "2026-08-13T00:03:00.000Z",
    });

    await reconcilePendingXOperations(
      database,
      provider,
      delivery,
      new Date("2026-08-13T00:03:00Z"),
    );

    expect(provider.mutate).toHaveBeenCalledTimes(2);
    expect(sendOwner).toHaveBeenCalledTimes(2);
    expect(database.getXOperation(initial.logicalId)!.nextRetryAt).toBeNull();
    database.close();
  });

  it("retries an exhausted-outcome notification without another provider mutation", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    database.claimInbound({
      id: "owner-1",
      senderIdentity: "923001234567@s.whatsapp.net",
      body: "post it",
      receivedAt: "2026-08-13T00:00:00Z",
    });
    database.createAuthorization({
      sourceMessageId: "owner-1",
      operation: "publish",
      authorizedContent: "hello",
      now: new Date("2026-08-13T00:00:00Z"),
    });
    const provider: ZernioMutationProvider = {
      mutate: vi.fn(async () => {
        throw new Error("connection reset");
      }),
    };
    const operation = await new ZernioWriteService(database, provider).execute(
      { sourceMessageId: "owner-1", selectedAccountId: "account-1" },
      { operation: "publish", content: "hello" },
    );
    setOperationCreatedAt(
      database,
      operation.logicalId,
      "2026-08-13T00:01:00Z",
    );
    const sendOwner = vi
      .fn()
      .mockRejectedValueOnce(new Error("WhatsApp disconnected"))
      .mockResolvedValueOnce({ messageId: "out-1" });
    const delivery = { sendOwner } as unknown as DeliveryService;

    await reconcilePendingXOperations(
      database,
      provider,
      delivery,
      new Date("2026-08-13T00:02:00Z"),
    );
    await reconcilePendingXOperations(
      database,
      provider,
      delivery,
      new Date("2026-08-13T00:05:00Z"),
    );
    expect(database.getXOperation(operation.logicalId)!.nextRetryAt).toBe(
      "2026-08-13T00:05:00.000Z",
    );

    await reconcilePendingXOperations(
      database,
      provider,
      delivery,
      new Date("2026-08-13T00:06:00Z"),
    );
    await reconcilePendingXOperations(
      database,
      provider,
      delivery,
      new Date("2026-08-13T00:07:00Z"),
    );

    expect(provider.mutate).toHaveBeenCalledTimes(3);
    expect(sendOwner).toHaveBeenCalledTimes(2);
    expect(database.getXOperation(operation.logicalId)!.nextRetryAt).toBeNull();
    database.close();
  });

  it("keeps an exhausted provider retry due until its warning is queued", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    database.claimInbound({
      id: "owner-exhausted",
      senderIdentity: "923001234567@s.whatsapp.net",
      body: "post it",
      receivedAt: "2026-08-13T00:00:00Z",
    });
    database.createAuthorization({
      sourceMessageId: "owner-exhausted",
      operation: "publish",
      authorizedContent: "hello",
      now: new Date("2026-08-13T00:00:00Z"),
    });
    const operation = database.beginXOperation({
      envelopeId: database.getAuthorizationForSource("owner-exhausted")!.id,
      sourceMessageId: "owner-exhausted",
      operation: "publish",
      payloadHash: "hash",
      accountId: "account-1",
      requestJson: JSON.stringify({ operation: "publish", content: "hello" }),
      content: "hello",
    });
    database.database
      .prepare("UPDATE x_operations SET retry_count = 2 WHERE logical_id = ?")
      .run(operation.logicalId);

    const exhausted = database.scheduleXOperationRetry(
      operation.logicalId,
      "still unknown",
      new Date("2026-08-13T00:03:00Z"),
    );

    expect(exhausted.retryCount).toBe(3);
    expect(exhausted.nextRetryAt).toBe("2026-08-13T00:03:00.000Z");
    database.close();
  });

  it("does not retry an ambiguous create after the provider deduplication window", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    database.claimInbound({
      id: "owner-1",
      senderIdentity: "923001234567@s.whatsapp.net",
      body: "post it",
      receivedAt: "2026-08-13T00:00:00Z",
    });
    database.createAuthorization({
      sourceMessageId: "owner-1",
      operation: "publish",
      authorizedContent: "hello",
      now: new Date("2026-08-13T00:00:00Z"),
    });
    const provider: ZernioMutationProvider = {
      mutate: vi.fn(async () => {
        throw new Error("connection reset");
      }),
    };
    const operation = await new ZernioWriteService(database, provider).execute(
      { sourceMessageId: "owner-1", selectedAccountId: "account-1" },
      { operation: "publish", content: "hello" },
    );
    setOperationCreatedAt(database, operation.logicalId);
    database.database
      .prepare(
        "UPDATE x_operations SET created_at = ?, next_retry_at = ? WHERE logical_id = ?",
      )
      .run("2026-08-13T00:00:00Z", "2026-08-13T00:01:00Z", operation.logicalId);
    const sendOwner = vi.fn(async () => ({ messageId: "out-1" }));

    await reconcilePendingXOperations(
      database,
      provider,
      { sendOwner } as unknown as DeliveryService,
      new Date("2026-08-13T00:06:00Z"),
    );

    expect(provider.mutate).toHaveBeenCalledOnce();
    expect(sendOwner).toHaveBeenCalledOnce();
    expect(database.getXOperation(operation.logicalId)).toMatchObject({
      retryCount: 3,
      nextRetryAt: null,
    });
    database.close();
  });

  it("polls an incomplete recovered create for its public identity", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    database.claimInbound({
      id: "owner-1",
      senderIdentity: "923001234567@s.whatsapp.net",
      body: "post it",
      receivedAt: "2026-08-13T00:00:00Z",
    });
    database.createAuthorization({
      sourceMessageId: "owner-1",
      operation: "publish",
      authorizedContent: "hello",
      now: new Date("2026-08-13T00:00:00Z"),
    });
    let attempt = 0;
    const provider = {
      mutate: vi.fn(async () => {
        if (++attempt === 1) throw new Error("connection reset");
        return { status: "published" as const, providerId: "z-1" };
      }),
      getPost: vi.fn(async () => ({
        status: "published" as const,
        platforms: [
          {
            platform: "twitter" as const,
            status: "published" as const,
            platformPostId: "x-1",
            platformPostUrl: "https://x.com/stan/status/x-1",
          },
        ],
      })),
    };
    const operation = await new ZernioWriteService(database, provider).execute(
      { sourceMessageId: "owner-1", selectedAccountId: "account-1" },
      { operation: "publish", content: "hello" },
    );
    setOperationCreatedAt(database, operation.logicalId);
    const sendOwner = vi.fn(async () => ({ messageId: "out-1" }));
    const delivery = { sendOwner } as unknown as DeliveryService;

    await reconcilePendingXOperations(
      database,
      provider,
      delivery,
      new Date("2026-08-13T00:02:00Z"),
    );
    expect(sendOwner).not.toHaveBeenCalled();
    expect(
      database.database
        .prepare(
          "SELECT 1 FROM scheduled_publications WHERE logical_operation_id = ?",
        )
        .get(operation.logicalId),
    ).toBeDefined();

    await reconcileScheduledPublications(
      database,
      provider,
      delivery,
      new Date("2026-08-13T00:03:00Z"),
    );
    expect(database.getXOperation(operation.logicalId)).toMatchObject({
      status: "published",
      publicId: "x-1",
    });
    expect(sendOwner).toHaveBeenCalledOnce();
    database.close();
  });

  it("retries a verified schedule notification without repeating the provider mutation", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    database.claimInbound({
      id: "owner-1",
      senderIdentity: "923001234567@s.whatsapp.net",
      body: "schedule this X post",
      receivedAt: "2026-08-13T00:00:00Z",
    });
    database.createAuthorization({
      sourceMessageId: "owner-1",
      operation: "schedule",
      authorizedContent: "hello",
      authorizedScheduledFor: "2026-08-14T00:00:00.000Z",
      now: new Date("2026-08-13T00:00:00Z"),
    });
    let attempt = 0;
    const provider: ZernioMutationProvider = {
      mutate: vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("connection reset");
        return {
          status: "scheduled" as const,
          providerId: "z-1",
          scheduledFor: "2026-08-14T00:00:00Z",
        };
      }),
    };
    const initial = await new ZernioWriteService(database, provider).execute(
      { sourceMessageId: "owner-1", selectedAccountId: "account-1" },
      {
        operation: "schedule",
        content: "hello",
        scheduledFor: "2026-08-14T00:00:00Z",
      },
    );
    setOperationCreatedAt(database, initial.logicalId);
    const sendOwner = vi
      .fn()
      .mockRejectedValueOnce(new Error("WhatsApp disconnected"))
      .mockResolvedValueOnce({ messageId: "out-1" });
    const delivery = { sendOwner } as unknown as DeliveryService;

    await reconcilePendingXOperations(
      database,
      provider,
      delivery,
      new Date("2026-08-13T00:02:00Z"),
    );
    expect(database.getXOperation(initial.logicalId)).toMatchObject({
      status: "scheduled",
      nextRetryAt: "2026-08-13T00:03:00.000Z",
    });

    await reconcilePendingXOperations(
      database,
      provider,
      delivery,
      new Date("2026-08-13T00:03:00Z"),
    );
    expect(provider.mutate).toHaveBeenCalledTimes(2);
    expect(sendOwner).toHaveBeenCalledTimes(2);
    expect(database.getXOperation(initial.logicalId)!.nextRetryAt).toBeNull();
    database.close();
  });

  it("gives an asynchronously published post a bounded identity grace period", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    database.claimInbound({
      id: "owner-1",
      senderIdentity: "923001234567@s.whatsapp.net",
      body: "post it",
      receivedAt: "2026-08-13T00:00:00Z",
    });
    database.createAuthorization({
      sourceMessageId: "owner-1",
      operation: "publish",
      authorizedContent: "hello",
      now: new Date("2026-08-13T00:00:00Z"),
    });
    let poll = 0;
    const provider = {
      mutate: vi.fn(async () => ({
        status: "publishing" as const,
        providerId: "z-1",
      })),
      getPost: vi.fn(async () => {
        poll += 1;
        return {
          status: "published" as const,
          platforms: [
            {
              platform: "twitter" as const,
              status: "published" as const,
              ...(poll >= 3
                ? {
                    platformPostId: "x-1",
                    platformPostUrl: "https://x.com/stan/status/x-1",
                  }
                : {}),
            },
          ],
        };
      }),
    };
    const operation = await new ZernioWriteService(database, provider).execute(
      { sourceMessageId: "owner-1", selectedAccountId: "account-1" },
      { operation: "publish", content: "hello" },
    );
    const sendOwner = vi.fn(async () => ({ messageId: "out-1" }));
    const delivery = { sendOwner } as unknown as DeliveryService;

    for (const time of [
      "2026-08-13T00:02:00Z",
      "2026-08-13T00:07:00Z",
      "2026-08-13T00:12:00Z",
    ]) {
      await reconcileScheduledPublications(
        database,
        provider,
        delivery,
        new Date(time),
      );
    }

    expect(database.getXOperation(operation.logicalId)).toMatchObject({
      status: "published",
      publicId: "x-1",
      publicUrl: "https://x.com/stan/status/x-1",
    });
    expect(provider.getPost).toHaveBeenCalledTimes(3);
    expect(sendOwner).toHaveBeenCalledOnce();
    database.close();
  });

  it("reconciles an incomplete edit result before reporting success", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    database.claimInbound({
      id: "owner-edit",
      senderIdentity: "923001234567@s.whatsapp.net",
      body: "edit post",
      receivedAt: "2026-08-13T00:00:00Z",
    });
    database.createAuthorization({
      sourceMessageId: "owner-edit",
      operation: "edit",
      targetPostId: "z-1",
      authorizedContent: "new content",
      now: new Date("2026-08-13T00:00:00Z"),
    });
    let poll = 0;
    const provider = {
      verifyPostAccount: vi.fn(async () => true),
      mutate: vi.fn(async () => ({
        status: "published" as const,
        providerId: "z-1",
      })),
      getPost: vi.fn(async () => ({
        status: "published" as const,
        content: ++poll === 1 ? "old content" : "new content",
        platforms: [
          {
            platform: "twitter" as const,
            status: "published" as const,
            platformPostId: "x-1",
            platformPostUrl: "https://x.com/stan/status/x-1",
          },
        ],
      })),
    };
    const operation = await new ZernioWriteService(database, provider).execute(
      { sourceMessageId: "owner-edit", selectedAccountId: "account-1" },
      { operation: "edit", providerPostId: "z-1", content: "new content" },
    );
    setOperationCreatedAt(database, operation.logicalId);
    const sendOwner = vi.fn(async () => ({ messageId: "out-1" }));
    const delivery = { sendOwner } as unknown as DeliveryService;

    await reconcileScheduledPublications(
      database,
      provider,
      delivery,
      new Date("2026-08-13T00:02:00Z"),
    );
    expect(database.getXOperation(operation.logicalId)!.status).toBe(
      "publishing",
    );
    expect(sendOwner).not.toHaveBeenCalled();

    await reconcileScheduledPublications(
      database,
      provider,
      delivery,
      new Date("2026-08-13T00:07:00Z"),
    );
    expect(database.getXOperation(operation.logicalId)!.status).toBe(
      "published",
    );
    expect(sendOwner).toHaveBeenCalledOnce();
    database.close();
  });

  it.each(["publishing", "draft"] as const)(
    "bounds provider state %s when it never settles",
    async (providerStatus) => {
      const database = new ApplicationDatabase(":memory:");
      database.migrate();
      database.claimInbound({
        id: "owner-1",
        senderIdentity: "923001234567@s.whatsapp.net",
        body: "post it",
        receivedAt: "2026-08-13T00:00:00Z",
      });
      database.createAuthorization({
        sourceMessageId: "owner-1",
        operation: "publish",
        authorizedContent: "hello",
        now: new Date("2026-08-13T00:00:00Z"),
      });
      const provider = {
        mutate: vi.fn(async () => ({
          status: "publishing" as const,
          providerId: "z-1",
        })),
        getPost: vi.fn(async () => ({
          status: providerStatus,
          platforms: [{ platform: "twitter" as const, status: providerStatus }],
        })),
      };
      const operation = await new ZernioWriteService(
        database,
        provider,
      ).execute(
        { sourceMessageId: "owner-1", selectedAccountId: "account-1" },
        { operation: "publish", content: "hello" },
      );
      setOperationCreatedAt(database, operation.logicalId);
      const sendOwner = vi.fn(async () => ({ messageId: "out-1" }));

      for (const time of [
        "2026-08-13T00:02:00Z",
        "2026-08-13T00:07:00Z",
        "2026-08-13T00:12:00Z",
      ])
        await reconcileScheduledPublications(
          database,
          provider,
          { sendOwner } as unknown as DeliveryService,
          new Date(time),
        );

      expect(provider.getPost).toHaveBeenCalledTimes(3);
      const resolved = database.getXOperation(operation.logicalId)!;
      expect(resolved.status).toBe("partial");
      expect(resolved.error).toContain("bounded polling");
      expect(sendOwner).toHaveBeenCalledOnce();
      database.close();
    },
  );

  it.each(["draft", "cancel"] as const)(
    "surfaces an unexpectedly published %s as partial",
    async (requestedOperation) => {
      const database = new ApplicationDatabase(":memory:");
      database.migrate();
      database.claimInbound({
        id: "owner-write",
        senderIdentity: "923001234567@s.whatsapp.net",
        body: `${requestedOperation} X post`,
        receivedAt: "2026-08-13T00:00:00Z",
      });
      database.createAuthorization({
        sourceMessageId: "owner-write",
        operation: requestedOperation,
        ...(requestedOperation === "cancel"
          ? { targetPostId: "z-1" }
          : { authorizedContent: "private draft" }),
        now: new Date("2026-08-13T00:00:00Z"),
      });
      const provider = {
        verifyPostAccount: vi.fn(async () => true),
        mutate: vi.fn(async () => ({
          status: "publishing" as const,
          providerId: "z-1",
        })),
        getPost: vi.fn(async () => ({
          status: "published" as const,
          platforms: [
            {
              platform: "twitter" as const,
              status: "published" as const,
              platformPostId: "x-1",
              platformPostUrl: "https://x.com/stan/status/x-1",
            },
          ],
        })),
      };
      const request: ZernioMutationRequest =
        requestedOperation === "draft"
          ? { operation: "draft", content: "private draft" }
          : { operation: "cancel", providerPostId: "z-1" };
      const operation = await new ZernioWriteService(
        database,
        provider,
      ).execute(
        { sourceMessageId: "owner-write", selectedAccountId: "account-1" },
        request,
      );
      setOperationCreatedAt(database, operation.logicalId);
      const sendOwner = vi.fn(async () => ({ messageId: "out-1" }));

      await reconcileScheduledPublications(
        database,
        provider,
        { sendOwner } as unknown as DeliveryService,
        new Date("2026-08-13T00:02:00Z"),
      );

      const resolved = database.getXOperation(operation.logicalId)!;
      expect(resolved.status).toBe("partial");
      expect(resolved.error).toContain("reported");
      expect(sendOwner).toHaveBeenCalledOnce();
      database.close();
    },
  );

  it("defers a newly resolved schedule until after its due time", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    database.claimInbound({
      id: "owner-schedule",
      senderIdentity: "923001234567@s.whatsapp.net",
      body: "schedule X post",
      receivedAt: "2026-08-13T00:00:00Z",
    });
    database.createAuthorization({
      sourceMessageId: "owner-schedule",
      operation: "schedule",
      authorizedContent: "hello",
      authorizedScheduledFor: "2026-08-14T00:00:00.000Z",
      now: new Date("2026-08-13T00:00:00Z"),
    });
    const provider = {
      mutate: vi.fn(async () => ({
        status: "scheduled" as const,
        providerId: "z-1",
      })),
      getPost: vi.fn(async () => ({
        status: "scheduled" as const,
        scheduledFor: "2026-08-14T00:00:00Z",
        platforms: [
          { platform: "twitter" as const, status: "scheduled" as const },
        ],
      })),
    };
    const operation = await new ZernioWriteService(database, provider).execute(
      { sourceMessageId: "owner-schedule", selectedAccountId: "account-1" },
      {
        operation: "schedule",
        content: "hello",
        scheduledFor: "2026-08-14T00:00:00Z",
      },
    );
    setOperationCreatedAt(database, operation.logicalId);

    await reconcileScheduledPublications(
      database,
      provider,
      { sendOwner: vi.fn() } as unknown as DeliveryService,
      new Date("2026-08-13T00:02:00Z"),
    );

    expect(database.getXOperation(operation.logicalId)!.status).toBe(
      "scheduled",
    );
    expect(
      database.database
        .prepare(
          "SELECT poll_count, next_poll_at FROM scheduled_publications WHERE logical_operation_id = ?",
        )
        .get(operation.logicalId),
    ).toEqual({
      poll_count: 0,
      next_poll_at: "2026-08-14T00:01:00.000Z",
    });
    database.close();
  });

  it("surfaces provider drift from the owner-authorized schedule", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    database.claimInbound({
      id: "owner-schedule",
      senderIdentity: "923001234567@s.whatsapp.net",
      body: "schedule X post",
      receivedAt: "2026-08-13T00:00:00Z",
    });
    database.createAuthorization({
      sourceMessageId: "owner-schedule",
      operation: "schedule",
      authorizedContent: "hello",
      authorizedScheduledFor: "2026-08-14T00:00:00.000Z",
      now: new Date("2026-08-13T00:00:00Z"),
    });
    const provider = {
      mutate: vi.fn(async (input: { request: { operation: string } }) =>
        input.request.operation === "cancel"
          ? { status: "cancelled" as const }
          : {
              status: "scheduled" as const,
              providerId: "z-1",
              scheduledFor: "2026-08-14T00:00:00Z",
            },
      ),
      getPost: vi.fn(async () => ({
        status: "scheduled" as const,
        scheduledFor: "2026-08-14T01:00:00Z",
        platforms: [
          { platform: "twitter" as const, status: "scheduled" as const },
        ],
      })),
    };
    const operation = await new ZernioWriteService(database, provider).execute(
      { sourceMessageId: "owner-schedule", selectedAccountId: "account-1" },
      {
        operation: "schedule",
        content: "hello",
        scheduledFor: "2026-08-14T00:00:00Z",
      },
    );
    database.database
      .prepare(
        "UPDATE scheduled_publications SET next_poll_at = ? WHERE logical_operation_id = ?",
      )
      .run("2026-08-13T00:02:00.000Z", operation.logicalId);
    const sendOwner = vi.fn(async () => ({ messageId: "out-1" }));

    await reconcileScheduledPublications(
      database,
      provider,
      { sendOwner } as unknown as DeliveryService,
      new Date("2026-08-13T00:02:00Z"),
    );

    const resolved = database.getXOperation(operation.logicalId)!;
    expect(resolved.status).toBe("partial");
    expect(resolved.error).toMatch(/owner-authorized instant/i);
    expect(provider.mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        request: { operation: "cancel", providerPostId: "z-1" },
      }),
    );
    expect(sendOwner).toHaveBeenCalledOnce();
    database.close();
  });

  it("settles drift reconciliation when polling observes cancellation", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    database.claimInbound({
      id: "owner-drift-cancelled",
      senderIdentity: "923001234567@s.whatsapp.net",
      body: "schedule it",
      receivedAt: "2026-08-13T00:00:00Z",
    });
    database.createAuthorization({
      sourceMessageId: "owner-drift-cancelled",
      operation: "schedule",
      authorizedContent: "hello",
      authorizedScheduledFor: "2026-08-14T00:00:00.000Z",
      now: new Date("2026-08-13T00:00:00Z"),
    });
    const posts = [
      {
        status: "scheduled" as const,
        scheduledFor: "2026-08-14T01:00:00Z",
        platforms: [
          { platform: "twitter" as const, status: "scheduled" as const },
        ],
      },
      {
        status: "cancelled" as const,
        platforms: [
          { platform: "twitter" as const, status: "cancelled" as const },
        ],
      },
    ];
    const provider = {
      mutate: vi.fn(async (input: { request: { operation: string } }) => {
        if (input.request.operation === "cancel")
          throw new Error("ambiguous cancellation");
        return {
          status: "scheduled" as const,
          providerId: "z-1",
          scheduledFor: "2026-08-14T00:00:00Z",
        };
      }),
      getPost: vi.fn(async () => posts.shift()! as unknown as Post),
    };
    const operation = await new ZernioWriteService(database, provider).execute(
      {
        sourceMessageId: "owner-drift-cancelled",
        selectedAccountId: "account-1",
      },
      {
        operation: "schedule",
        content: "hello",
        scheduledFor: "2026-08-14T00:00:00Z",
      },
    );
    setOperationCreatedAt(database, operation.logicalId);
    const sendOwner = vi.fn(async () => ({ messageId: "out-1" }));
    const delivery = { sendOwner } as unknown as DeliveryService;

    await reconcileScheduledPublications(
      database,
      provider,
      delivery,
      new Date("2026-08-13T00:02:00Z"),
    );
    await reconcileScheduledPublications(
      database,
      provider,
      delivery,
      new Date("2026-08-13T00:07:00Z"),
    );

    const resolved = database.getXOperation(operation.logicalId)!;
    expect(resolved.status).toBe("partial");
    expect(resolved.error).toMatch(/unauthorized schedule was cancelled/i);
    expect(provider.mutate).toHaveBeenCalledTimes(2);
    expect(sendOwner).toHaveBeenCalledOnce();
    database.close();
  });

  it("keeps schedule drift visible if cancellation fails and it publishes", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    database.claimInbound({
      id: "owner-drift-publish",
      senderIdentity: "923001234567@s.whatsapp.net",
      body: "schedule it",
      receivedAt: "2026-08-13T00:00:00Z",
    });
    database.createAuthorization({
      sourceMessageId: "owner-drift-publish",
      operation: "schedule",
      authorizedContent: "hello",
      authorizedScheduledFor: "2026-08-14T00:00:00.000Z",
      now: new Date("2026-08-13T00:00:00Z"),
    });
    const posts = [
      {
        status: "scheduled" as const,
        scheduledFor: "2026-08-14T01:00:00Z",
        platforms: [
          { platform: "twitter" as const, status: "scheduled" as const },
        ],
      },
      {
        status: "published" as const,
        platforms: [
          {
            platform: "twitter" as const,
            status: "published" as const,
            platformPostId: "x-1",
            platformPostUrl: "https://x.com/a/status/x-1",
          },
        ],
      },
    ];
    const provider = {
      mutate: vi.fn(async (input: { request: { operation: string } }) => {
        if (input.request.operation === "cancel")
          throw new Error("cancel unavailable");
        return {
          status: "scheduled" as const,
          providerId: "z-1",
          scheduledFor: "2026-08-14T00:00:00Z",
        };
      }),
      getPost: vi.fn(async () => posts.shift()!),
    };
    const operation = await new ZernioWriteService(database, provider).execute(
      {
        sourceMessageId: "owner-drift-publish",
        selectedAccountId: "account-1",
      },
      {
        operation: "schedule",
        content: "hello",
        scheduledFor: "2026-08-14T00:00:00Z",
      },
    );
    setOperationCreatedAt(database, operation.logicalId);
    const sendOwner = vi.fn(async () => ({ messageId: "out-1" }));
    const delivery = { sendOwner } as unknown as DeliveryService;

    await reconcileScheduledPublications(
      database,
      provider,
      delivery,
      new Date("2026-08-13T00:02:00Z"),
    );
    await reconcileScheduledPublications(
      database,
      provider,
      delivery,
      new Date("2026-08-13T00:07:00Z"),
    );

    const resolved = database.getXOperation(operation.logicalId)!;
    expect(resolved.status).toBe("partial");
    expect(resolved.error).toMatch(/published.*drifting/i);
    expect(sendOwner).toHaveBeenCalledOnce();
    database.close();
  });

  it("keeps an unchanged delete unresolved until bounded polling exhausts", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    database.claimInbound({
      id: "owner-delete",
      senderIdentity: "923001234567@s.whatsapp.net",
      body: "delete X post z-1",
      receivedAt: "2026-08-13T00:00:00Z",
    });
    database.createAuthorization({
      sourceMessageId: "owner-delete",
      operation: "delete",
      targetPostId: "z-1",
      now: new Date("2026-08-13T00:00:00Z"),
    });
    const provider = {
      verifyPostAccount: vi.fn(async () => true),
      mutate: vi.fn(async () => {
        throw new Error("ambiguous delete outcome");
      }),
      getPost: vi.fn(async () => ({
        status: "published" as const,
        platforms: [
          {
            platform: "twitter" as const,
            status: "published" as const,
            platformPostId: "x-1",
            platformPostUrl: "https://x.com/stan/status/x-1",
          },
        ],
      })),
    };
    const operation = await new ZernioWriteService(database, provider).execute(
      { sourceMessageId: "owner-delete", selectedAccountId: "account-1" },
      { operation: "delete", providerPostId: "z-1" },
    );
    setOperationCreatedAt(database, operation.logicalId);
    const notifications: string[] = [];
    const sendOwner = vi.fn(async (message: string) => {
      notifications.push(message);
      return { messageId: "out-1" };
    });

    for (const time of [
      "2026-08-13T00:02:00Z",
      "2026-08-13T00:07:00Z",
      "2026-08-13T00:12:00Z",
    ])
      await reconcileScheduledPublications(
        database,
        provider,
        { sendOwner } as unknown as DeliveryService,
        new Date(time),
      );

    expect(database.getXOperation(operation.logicalId)!.status).toBe("partial");
    expect(provider.getPost).toHaveBeenCalledTimes(3);
    expect(sendOwner).toHaveBeenCalledOnce();
    expect(notifications[0]).not.toContain("verified as published");
    database.close();
  });

  it("settles a missing prevalidated delete target as cancelled", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    database.claimInbound({
      id: "owner-delete",
      senderIdentity: "923001234567@s.whatsapp.net",
      body: "delete X post z-1",
      receivedAt: "2026-08-13T00:00:00Z",
    });
    database.createAuthorization({
      sourceMessageId: "owner-delete",
      operation: "delete",
      targetPostId: "z-1",
      now: new Date("2026-08-13T00:00:00Z"),
    });
    const provider = {
      verifyPostAccount: vi.fn(async () => true),
      mutate: vi.fn(async () => {
        throw new Error("ambiguous delete outcome");
      }),
      getPost: vi.fn(async () => {
        throw Object.assign(new Error("post not found"), { status: 404 });
      }),
    };
    const operation = await new ZernioWriteService(database, provider).execute(
      { sourceMessageId: "owner-delete", selectedAccountId: "account-1" },
      { operation: "delete", providerPostId: "z-1" },
    );
    setOperationCreatedAt(database, operation.logicalId);
    const sendOwner = vi.fn(async () => ({ messageId: "out-1" }));

    await reconcileScheduledPublications(
      database,
      provider,
      { sendOwner } as unknown as DeliveryService,
      new Date("2026-08-13T00:02:00Z"),
    );

    expect(database.getXOperation(operation.logicalId)!.status).toBe(
      "cancelled",
    );
    expect(sendOwner).toHaveBeenCalledOnce();
    expect(
      database.database
        .prepare(
          "SELECT 1 FROM scheduled_publications WHERE logical_operation_id = ?",
        )
        .get(operation.logicalId),
    ).toBeUndefined();
    database.close();
  });

  it("does not treat a scheduled-publication notification outage as provider failure", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    database.claimInbound({
      id: "owner-1",
      senderIdentity: "923001234567@s.whatsapp.net",
      body: "post it",
      receivedAt: "2026-08-13T00:00:00Z",
    });
    database.createAuthorization({
      sourceMessageId: "owner-1",
      operation: "publish",
      authorizedContent: "hello",
      now: new Date("2026-08-13T00:00:00Z"),
    });
    const provider = {
      mutate: vi.fn(async () => ({
        status: "publishing" as const,
        providerId: "z-1",
      })),
      getPost: vi.fn(async () => ({
        status: "published" as const,
        platforms: [
          {
            platform: "twitter" as const,
            status: "published" as const,
            platformPostId: "x-1",
            platformPostUrl: "https://x.com/stan/status/x-1",
          },
        ],
      })),
    };
    const operation = await new ZernioWriteService(database, provider).execute(
      { sourceMessageId: "owner-1", selectedAccountId: "account-1" },
      { operation: "publish", content: "hello" },
    );
    const sendOwner = vi
      .fn()
      .mockRejectedValueOnce(new Error("WhatsApp offline"))
      .mockResolvedValueOnce({ messageId: "out-1" });
    const delivery = { sendOwner } as unknown as DeliveryService;

    await reconcileScheduledPublications(
      database,
      provider,
      delivery,
      new Date("2026-08-13T00:02:00Z"),
    );
    expect(database.getXOperation(operation.logicalId)!.status).toBe(
      "published",
    );

    await reconcileScheduledPublications(
      database,
      provider,
      delivery,
      new Date("2026-08-13T00:03:00Z"),
    );
    expect(database.getXOperation(operation.logicalId)!.status).toBe(
      "published",
    );
    expect(sendOwner).toHaveBeenCalledTimes(2);
    expect(provider.getPost).toHaveBeenCalledOnce();
    expect(
      database.database
        .prepare(
          "SELECT 1 FROM scheduled_publications WHERE logical_operation_id = ?",
        )
        .get(operation.logicalId),
    ).toBeUndefined();
    database.close();
  });

  it("bounds terminal scheduled-publication notification retries", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    database.claimInbound({
      id: "owner-1",
      senderIdentity: "923001234567@s.whatsapp.net",
      body: "post it",
      receivedAt: "2026-08-13T00:00:00Z",
    });
    database.createAuthorization({
      sourceMessageId: "owner-1",
      operation: "publish",
      authorizedContent: "hello",
      now: new Date("2026-08-13T00:00:00Z"),
    });
    const provider = {
      mutate: vi.fn(async () => ({
        status: "publishing" as const,
        providerId: "z-1",
      })),
      getPost: vi.fn(async () => ({
        status: "published" as const,
        platforms: [
          {
            platform: "twitter" as const,
            status: "published" as const,
            platformPostId: "x-1",
            platformPostUrl: "https://x.com/stan/status/x-1",
          },
        ],
      })),
    };
    const operation = await new ZernioWriteService(database, provider).execute(
      { sourceMessageId: "owner-1", selectedAccountId: "account-1" },
      { operation: "publish", content: "hello" },
    );
    setOperationCreatedAt(database, operation.logicalId);
    const sendOwner = vi.fn(async () => {
      throw new Error("WhatsApp offline");
    });
    const delivery = { sendOwner } as unknown as DeliveryService;

    for (const time of [
      "2026-08-13T00:02:00Z",
      "2026-08-13T00:03:00Z",
      "2026-08-13T00:05:00Z",
      "2026-08-13T00:10:00Z",
    ])
      await reconcileScheduledPublications(
        database,
        provider,
        delivery,
        new Date(time),
      );

    expect(provider.getPost).toHaveBeenCalledOnce();
    expect(sendOwner).toHaveBeenCalledTimes(3);
    expect(
      database.database
        .prepare(
          "SELECT 1 FROM scheduled_publications WHERE logical_operation_id = ?",
        )
        .get(operation.logicalId),
    ).toBeUndefined();
    const notification = database.getXOperation(operation.logicalId)!;
    expect(notification.notificationAttempts).toBe(3);
    expect(notification.notificationMessage).toContain("verified as published");
    database.close();
  });
});
