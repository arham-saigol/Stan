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
    now: () => new Date("2026-08-13T10:00:00.000Z"),
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

    expect(
      await ingress.reconcilePending(
        5,
        new Date(Date.parse("2026-08-13T10:00:00.000Z") + 61_000),
      ),
    ).toBe(1);

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

  it("bounds permanently failing owner-turn recovery", async () => {
    const { database, ingress, dispatch, read } = await harness();
    read.mockRejectedValue(new Error("Flue unavailable"));

    expect(await ingress.handle(message({ id: "never-recovers" }))).toEqual({
      status: "failed",
    });
    const started = Date.parse("2026-08-13T10:00:00.000Z");
    expect(await ingress.reconcilePending(5, new Date(started + 61_000))).toBe(
      1,
    );
    expect(
      await ingress.reconcilePending(5, new Date(started + 4 * 60_000)),
    ).toBe(1);
    expect(
      await ingress.reconcilePending(5, new Date(started + 10 * 60_000)),
    ).toBe(0);

    expect(dispatch).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledTimes(3);
    expect(
      database.database
        .prepare(
          "SELECT state, recovery_attempts, next_retry_at FROM inbound_messages WHERE provider_message_id = 'never-recovers'",
        )
        .get(),
    ).toEqual({ state: "unknown", recovery_attempts: 3, next_retry_at: null });
  });

  it("retries an admitted submission that failed before producing a response", async () => {
    const { database, ingress, dispatch, read, send } = await harness();
    read.mockRejectedValueOnce(new Error("Flue temporarily unavailable"));

    expect(await ingress.handle(message({ id: "retry-me" }))).toEqual({
      status: "failed",
    });
    expect(
      await ingress.reconcilePending(
        5,
        new Date(Date.parse("2026-08-13T10:00:00.000Z") + 61_000),
      ),
    ).toBe(1);

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

  it("terminally rejects queued turns from a former configured owner", async () => {
    const { database, ingress, dispatch } = await harness();
    database.claimInbound({
      id: "former-owner-turn",
      senderIdentity: ownerJid,
      body: "post it",
      receivedAt: new Date().toISOString(),
    });
    const authorization = database.createAuthorization({
      sourceMessageId: "former-owner-turn",
      operation: "publish",
      authorizedContent: "exact post",
    });
    database.configureOwnerIdentity("923111234567@s.whatsapp.net");

    expect(await ingress.reconcilePending()).toBe(1);

    expect(dispatch).not.toHaveBeenCalled();
    expect(
      database.database
        .prepare(
          "SELECT state, recovery_attempts, next_retry_at FROM inbound_messages WHERE provider_message_id = 'former-owner-turn'",
        )
        .get(),
    ).toEqual({ state: "unknown", recovery_attempts: 3, next_retry_at: null });
    expect(
      database.getAuthorization(authorization.id)?.consumedAt,
    ).not.toBeNull();
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

  it("serializes recovered turns before newly admitted owner messages", async () => {
    const { ingress, database, deliveries, dispatch, read } = await harness();
    database.claimInbound({
      id: "recovered-turn",
      senderIdentity: ownerJid,
      body: "older message",
      receivedAt: "2026-08-13T09:00:00.000Z",
    });
    let release!: (value: string) => void;
    read.mockImplementationOnce(
      () => new Promise<string>((resolve) => (release = resolve)),
    );

    const recovery = ingress.reconcilePending();
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    const live = ingress.handle(
      message({ id: "live-turn", text: "newer message" }),
    );
    await Promise.resolve();

    expect(dispatch).toHaveBeenCalledOnce();
    release("recovered reply");
    await expect(recovery).resolves.toBe(1);
    await expect(live).resolves.toEqual({ status: "delivered" });
    expect(deliveries.map((delivery) => delivery.body)).toEqual([
      "older message",
      "newer message",
    ]);
  });

  it("anchors an expiring publish envelope to trusted admission time", async () => {
    const { ingress, database, deliveries } = await harness();

    await ingress.handle(
      message({
        text: "Please post the quoted draft",
        quotedText: "Option 2",
        receivedAt: "2099-08-13T10:00:00.000Z",
      }),
    );

    expect(database.getAuthorizationForSource("wamid-1")).toMatchObject({
      operation: "publish",
      sourceMessageId: "wamid-1",
      quotedText: "Option 2",
      authorizedContent: "Option 2",
      createdAt: "2026-08-13T10:00:00.000Z",
      expiresAt: "2026-08-13T10:15:00.000Z",
      consumedAt: null,
    });
    expect(deliveries[0]!.metadata).toEqual({
      sourceMessageId: "wamid-1",
      quotedText: "Option 2",
    });
  });

  it("preserves the original authorization window when recovering a claimed message", async () => {
    const { ingress, database } = await harness();
    database.claimInbound({
      id: "recovered-approval",
      senderIdentity: ownerJid,
      body: "Please post the quoted draft",
      quotedText: "Option 2",
      receivedAt: "2026-08-13T09:00:00.000Z",
      admittedAt: "2026-08-13T09:00:00.000Z",
    });

    await ingress.reconcilePending(5, new Date("2026-08-13T10:00:00.000Z"));

    expect(
      database.getAuthorizationForSource("recovered-approval"),
    ).toMatchObject({
      createdAt: "2026-08-13T09:00:00.000Z",
      expiresAt: "2026-08-13T09:15:00.000Z",
    });
  });

  it("backs off recovered failures from the current attempt time", async () => {
    const { ingress, database, read } = await harness();
    read.mockRejectedValue(new Error("Flue unavailable"));
    database.claimInbound({
      id: "recovered-failure",
      senderIdentity: ownerJid,
      body: "Please post the quoted draft",
      quotedText: "Option 2",
      receivedAt: "2026-08-13T09:00:00.000Z",
      admittedAt: "2026-08-13T09:00:00.000Z",
    });

    await ingress.reconcilePending(5, new Date("2026-08-13T10:00:00.000Z"));

    expect(
      database.database
        .prepare(
          "SELECT next_retry_at FROM inbound_messages WHERE provider_message_id = 'recovered-failure'",
        )
        .get(),
    ).toEqual({ next_retry_at: "2026-08-13T10:01:00.000Z" });
    expect(
      database.getAuthorizationForSource("recovered-failure"),
    ).toMatchObject({ createdAt: "2026-08-13T09:00:00.000Z" });
  });

  it("creates a transcript session for a delayed missed-day message", async () => {
    const { ingress, database } = await harness();

    await ingress.handle(
      message({
        id: "missed-day-owner-message",
        receivedAt: "2026-08-12T10:00:00.000Z",
      }),
    );

    expect(
      database.database
        .prepare(
          "SELECT local_date, conversation_id, state FROM daily_sessions WHERE local_date = '2026-08-12'",
        )
        .get(),
    ).toEqual({
      local_date: "2026-08-12",
      conversation_id: "stan-owner-2026-08-12",
      state: "active",
    });
  });

  it("reopens a closed transcript when a delayed provider message is admitted", async () => {
    const { ingress, database } = await harness();
    database.database
      .prepare(
        `INSERT INTO daily_sessions(local_date, conversation_id, state, created_at, closed_at, transcript_complete)
         VALUES ('2026-08-12', 'stan-owner-2026-08-12', 'closed', ?, ?, 1)`,
      )
      .run("2026-08-12T00:00:00.000Z", "2026-08-13T00:01:00.000Z");

    await ingress.handle(
      message({
        id: "delayed-owner-message",
        receivedAt: "2026-08-12T10:00:00.000Z",
      }),
    );

    expect(
      database.database
        .prepare(
          "SELECT state, closed_at, transcript_complete FROM daily_sessions WHERE local_date = '2026-08-12'",
        )
        .get(),
    ).toEqual({ state: "active", closed_at: null, transcript_complete: 0 });
  });
});
