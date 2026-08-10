import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplicationDatabase } from "../src/storage/application-db.ts";
import {
  OwnerIngress,
  type InboundMessage,
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
  const dispatch = vi.fn(async () => "Here is a draft.");
  const send = vi.fn(async () => ({ messageId: "out-1" }));
  const ingress = new OwnerIngress({ database, ownerPhone, dispatch, send });
  return { root, database, dispatch, send, ingress };
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
      send,
    });
    expect(await restarted.handle(message())).toEqual({ status: "duplicate" });
    expect(dispatch).toHaveBeenCalledTimes(1);
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

  it("derives one expiring publish envelope from an explicit owner command", async () => {
    const { ingress, database } = await harness();

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
      consumedAt: null,
    });
  });
});
