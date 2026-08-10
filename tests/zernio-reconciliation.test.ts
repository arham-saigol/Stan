import { describe, expect, it, vi } from "vitest";
import type { DeliveryService } from "../src/gateway/delivery.ts";
import { reconcilePendingXOperations } from "../src/providers/zernio-operation-reconciliation.ts";
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
});
