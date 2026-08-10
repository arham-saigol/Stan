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
    const sendOwner = vi
      .fn()
      .mockRejectedValueOnce(new Error("WhatsApp disconnected"))
      .mockResolvedValueOnce({ messageId: "out-1" });
    const delivery = { sendOwner } as unknown as DeliveryService;

    await expect(
      reconcilePendingXOperations(
        database,
        provider,
        delivery,
        new Date("2026-08-13T00:02:00Z"),
      ),
    ).rejects.toThrow("WhatsApp disconnected");
    expect(database.getXOperation(initial.logicalId)).toMatchObject({
      status: "published",
      nextRetryAt: "2026-08-13T00:02:00.000Z",
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
    await expect(
      reconcilePendingXOperations(
        database,
        provider,
        delivery,
        new Date("2026-08-13T00:05:00Z"),
      ),
    ).rejects.toThrow("WhatsApp disconnected");
    expect(database.getXOperation(operation.logicalId)!.nextRetryAt).toBe(
      "2026-08-13T00:05:00.000Z",
    );

    await reconcilePendingXOperations(
      database,
      provider,
      delivery,
      new Date("2026-08-13T00:06:00Z"),
    );

    expect(provider.mutate).toHaveBeenCalledTimes(3);
    expect(sendOwner).toHaveBeenCalledTimes(2);
    expect(database.getXOperation(operation.logicalId)!.nextRetryAt).toBeNull();
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
    const sendOwner = vi
      .fn()
      .mockRejectedValueOnce(new Error("WhatsApp disconnected"))
      .mockResolvedValueOnce({ messageId: "out-1" });
    const delivery = { sendOwner } as unknown as DeliveryService;

    await expect(
      reconcilePendingXOperations(
        database,
        provider,
        delivery,
        new Date("2026-08-13T00:02:00Z"),
      ),
    ).rejects.toThrow("WhatsApp disconnected");
    expect(database.getXOperation(initial.logicalId)).toMatchObject({
      status: "scheduled",
      nextRetryAt: "2026-08-13T00:02:00.000Z",
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

    await expect(
      reconcileScheduledPublications(
        database,
        provider,
        delivery,
        new Date("2026-08-13T00:02:00Z"),
      ),
    ).rejects.toThrow("WhatsApp offline");
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
    expect(
      database.database
        .prepare(
          "SELECT 1 FROM scheduled_publications WHERE logical_operation_id = ?",
        )
        .get(operation.logicalId),
    ).toBeUndefined();
    database.close();
  });
});
