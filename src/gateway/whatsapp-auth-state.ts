import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
} from "@whiskeysockets/baileys";
import type { ApplicationDatabase } from "../storage/application-db.ts";

export function createSqliteAuthState(application: ApplicationDatabase): {
  state: AuthenticationState;
  saveCreds(update?: Partial<AuthenticationCreds>): void;
  clear(): void;
} {
  const stored = readValue<AuthenticationCreds>(application, "creds", "state");
  const creds = stored ?? initAuthCreds();
  const state: AuthenticationState = {
    creds,
    keys: {
      get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
        const result: { [id: string]: SignalDataTypeMap[T] } = {};
        for (const id of ids) {
          const value = readValue<SignalDataTypeMap[T]>(application, type, id);
          if (value !== undefined)
            result[id] =
              type === "app-state-sync-key"
                ? (proto.Message.AppStateSyncKeyData.fromObject(
                    value as Record<string, unknown>,
                  ) as unknown as SignalDataTypeMap[T])
                : value;
        }
        return result;
      },
      set(data: SignalDataSet) {
        application.transaction(() => {
          for (const [category, values] of Object.entries(data)) {
            for (const [key, value] of Object.entries(values ?? {})) {
              if (value === null) {
                application.database
                  .prepare(
                    "DELETE FROM whatsapp_auth WHERE category = ? AND item_key = ?",
                  )
                  .run(category, key);
              } else {
                writeValue(application, category, key, value);
              }
            }
          }
        });
      },
      clear() {
        application.database.exec(
          "DELETE FROM whatsapp_auth WHERE category <> 'creds'",
        );
      },
    },
  };
  return {
    state,
    saveCreds(update = {}) {
      Object.assign(creds, update);
      writeValue(application, "creds", "state", creds);
    },
    clear() {
      application.database.exec("DELETE FROM whatsapp_auth");
      Object.assign(creds, initAuthCreds());
    },
  };
}

function readValue<T>(
  application: ApplicationDatabase,
  category: string,
  key: string,
): T | undefined {
  const row = application.database
    .prepare(
      "SELECT value_json FROM whatsapp_auth WHERE category = ? AND item_key = ?",
    )
    .get(category, key) as { value_json: string } | undefined;
  return row
    ? (JSON.parse(row.value_json, BufferJSON.reviver) as T)
    : undefined;
}

function writeValue(
  application: ApplicationDatabase,
  category: string,
  key: string,
  value: unknown,
): void {
  application.database
    .prepare(
      `INSERT INTO whatsapp_auth(category, item_key, value_json) VALUES (?, ?, ?)
       ON CONFLICT(category, item_key) DO UPDATE SET value_json = excluded.value_json`,
    )
    .run(category, key, JSON.stringify(value, BufferJSON.replacer));
}
