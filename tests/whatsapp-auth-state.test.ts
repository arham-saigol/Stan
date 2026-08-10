import { proto } from "@whiskeysockets/baileys";
import { describe, expect, it } from "vitest";
import { createSqliteAuthState } from "../src/gateway/whatsapp-auth-state.ts";
import { ApplicationDatabase } from "../src/storage/application-db.ts";

describe("SQLite WhatsApp authentication state", () => {
  it("clears signal keys without deleting credentials and restores protobuf keys", async () => {
    const database = new ApplicationDatabase(":memory:");
    database.migrate();
    const auth = createSqliteAuthState(database);
    auth.saveCreds({ registered: true });
    await auth.state.keys.set({
      "app-state-sync-key": {
        "key-1": proto.Message.AppStateSyncKeyData.create({
          keyData: new Uint8Array([1, 2, 3]),
        }),
      },
    });

    const restored = await auth.state.keys.get("app-state-sync-key", ["key-1"]);
    expect(restored["key-1"]).toBeInstanceOf(proto.Message.AppStateSyncKeyData);

    await auth.state.keys.clear?.();
    const reopened = createSqliteAuthState(database);
    expect(reopened.state.creds.registered).toBe(true);
    expect(
      await reopened.state.keys.get("app-state-sync-key", ["key-1"]),
    ).toEqual({});
    database.close();
  });
});
