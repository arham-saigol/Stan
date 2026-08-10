import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplicationDatabase } from "../src/storage/application-db.ts";
import {
  OwnerIngress,
  type InboundMessage,
  type OwnerDispatch,
} from "../src/gateway/owner-ingress.ts";

const ownerPhone = "+923001234567";
const ownerJid = "923001234567@s.whatsapp.net";

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: "wamid-1",
    type: "notify",
    remoteJid: ownerJid,
    fromMe: false,
    text: "draft a post about simple systems",
    receivedAt: "2026-08-13T10:00:00.000Z",
    ...overrides,
  };
}

const databases: ApplicationDatabase[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "stan-ingress-"));
  const database = new ApplicationDatabase(join(root, "stan.db"));
  databases.push(database);
  database.migrate();
  database.bindOwnerIdentity(ownerJid, "pn");
  const deliveries: Parameters<OwnerDispatch>[0][] = [];
  const dispatch = vi.fn(async (delivery: Parameters<OwnerDispatch>[0]) => {
    deliveries.push(delivery);
    return "submission-1";
  });
  const read = vi.fn(async () => "Here is a draft.");
  const send = vi.fn(async () => ({ messageId: "out-1" }));
  const ingress = new OwnerIngress({
    database,
    ownerPhone,
    dispatch,
    read,
    send,
  });
  return { root, database, deliveries, dispatch, read, send, ingress };
}

describe("owner-only ingress", () => {
  it("silently ignores unknown senders, groups, history and status traffic", async () => {
    const { ingress, dispatch, send } = await harness();

    await ingress.handle(
      message({ id: "unknown", remoteJid: "923991234567@s.whatsapp.net" }),
    );
    await ingress.handle(
      message({
        id: "group",
        remoteJid: "120363000@g.us",
        participant: ownerJid,
      }),
    );
    await ingress.handle(message({ id: "history", type: "append" }));
    await ingress.handle(
      message({ id: "status", remoteJid: "status@broadcast" }),
    );

    expect(dispatch).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("processes an owner message once across duplicate events and database restarts", async () => {
    const { root, database, ingress, dispatch, send } = await harness();

    expect(await ingress.handle(message())).toEqual({ status: "delivered" });
    expect(await ingress.handle(message())).toEqual({ status: "duplicate" });
    database.close();
    databases.splice(databases.indexOf(database), 1);

    const reopened = new ApplicationDatabase(join(root, "stan.db"));
    databases.push(reopened);
    reopened.migrate();
    const restarted = new OwnerIngress({
      database: reopened,
      ownerPhone,
      dispatch,
      read: async () => "Here is a draft.",
      send,
    });
    expect(await restarted.handle(message())).toEqual({ status: "duplicate" });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "whatsapp:wamid-1" }),
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not turn a drafting request into public-write authorization", async () => {
    const { ingress, database } = await harness();

    await ingress.handle(message({ text: "draft me a post about YAGNI" }));

    expect(database.getAuthorizationForSource("wamid-1")).toBeUndefined();
  });

  it("removes stale owner identities when the configured owner changes", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    database.configureOwnerIdentity(ownerJid);
    const dispatch = vi.fn(async () => "ok");
    const send = vi.fn(async () => ({ messageId: "out-1" }));
    const newOwnerPhone = "+923111234567";
    const ingress = new OwnerIngress({
      database,
      ownerPhone: newOwnerPhone,
      dispatch,
      read: async () => "ok",
      send,
    });

    expect(await ingress.handle(message({ id: "old-owner" }))).toEqual({
      status: "ignored",
    });
    expect(
      await ingress.handle(
        message({
          id: "new-owner",
          remoteJid: "923111234567@s.whatsapp.net",
        }),
      ),
    ).toEqual({ status: "delivered" });
    database.close();
  });

  it("reattaches to an admitted Flue submission after a daemon restart", async () => {
    const { database, ingress, dispatch, read, send } = await harness();
    database.claimInbound({
      id: "recover-me",
      senderIdentity: ownerJid,
      body: "draft a post",
      receivedAt: "2026-08-13T10:00:00.000Z",
    });
    database.setInboundState("recover-me", "dispatched", {
      sessionId: "stan-owner-2026-08-13",
      flueSubmissionId: "submission-existing",
    });

    expect(await ingress.reconcilePending()).toBe(1);

    expect(dispatch).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledWith(
      "stan-owner-2026-08-13",
      "submission-existing",
    );
    expect(send).toHaveBeenCalledOnce();
    expect(
      database.database
        .prepare(
          "SELECT state FROM inbound_messages WHERE provider_message_id = 'recover-me'",
        )
        .get(),
    ).toEqual({ state: "delivered" });
  });

  it("retries an admitted submission that failed before producing a response", async () => {
    const { database, ingress, dispatch, read, send } = await harness();
    read.mockRejectedValueOnce(new Error("Flue temporarily unavailable"));

    expect(await ingress.handle(message({ id: "retry-me" }))).toEqual({
      status: "failed",
    });
    expect(await ingress.reconcilePending()).toBe(1);

    expect(dispatch).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledOnce();
    expect(
      database.database
        .prepare(
          "SELECT state FROM inbound_messages WHERE provider_message_id = 'retry-me'",
        )
        .get(),
    ).toEqual({ state: "delivered" });
  });

  it("does not reconcile an owner message that this process is still handling", async () => {
    const { ingress, dispatch, read } = await harness();
    let release!: (value: string) => void;
    read.mockImplementationOnce(
      () => new Promise<string>((resolve) => (release = resolve)),
    );

    const handling = ingress.handle(message({ id: "in-flight" }));
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    expect(dispatch).toHaveBeenCalledOnce();

    expect(await ingress.reconcilePending()).toBe(0);
    release("settled reply");
    await expect(handling).resolves.toEqual({ status: "delivered" });
    expect(read).toHaveBeenCalledOnce();
  });

  it("derives one expiring publish envelope from an explicit owner command", async () => {
    const { ingress, database, deliveries } = await harness();

    await ingress.handle(
      message({
        text: "Please post the second one",
        quotedText: "Option 1\nOption 2",
      }),
    );

    expect(database.getAuthorizationForSource("wamid-1")).toMatchObject({
      operation: "publish",
      sourceMessageId: "wamid-1",
      quotedText: "Option 1\nOption 2",
      createdAt: "2026-08-13T10:00:00.000Z",
      expiresAt: "2026-08-13T10:15:00.000Z",
      consumedAt: null,
    });
    expect(deliveries[0]!.metadata).toEqual({
      sourceMessageId: "wamid-1",
      quotedText: "Option 1\nOption 2",
    });
  });
});
