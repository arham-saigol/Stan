import makeWASocket, { DisconnectReason } from "@whiskeysockets/baileys";
import { input, select } from "@inquirer/prompts";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import qrcode from "qrcode-terminal";
import type { StanConfig } from "../../config/schema.ts";
import {
  ApplicationDatabase,
  normalizeJid,
} from "../../storage/application-db.ts";
import { createSqliteAuthState } from "../../gateway/whatsapp-auth-state.ts";

export async function authenticateWhatsApp(
  target: ApplicationDatabase,
  config: StanConfig,
  method?: "qr" | "pairing",
): Promise<void> {
  const choice =
    method ??
    (await select({
      message: "WhatsApp authentication method",
      choices: [
        { value: "qr" as const, name: "QR code" },
        { value: "pairing" as const, name: "Phone pairing code" },
      ],
    }));
  const pairingPhone =
    choice === "pairing"
      ? normalizePairingPhone(
          await input({
            message:
              "Dedicated Stan WhatsApp account number (international format)",
          }),
        )
      : undefined;
  const directory = await mkdtemp(join(tmpdir(), "stan-whatsapp-auth-"));
  const temporary = new ApplicationDatabase(join(directory, "auth.db"));
  temporary.migrate();
  let socket: ReturnType<typeof makeWASocket> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      let requestedCode = false;
      let settled = false;
      const connect = () => {
        const auth = createSqliteAuthState(temporary);
        socket = makeWASocket({
          auth: auth.state,
          logger: pino({ level: "silent" }),
          syncFullHistory: false,
          shouldSyncHistoryMessage: () => false,
          markOnlineOnConnect: false,
        });
        socket.ev.on("creds.update", (update) => {
          void auth.saveCreds(update);
        });
        socket.ev.on(
          "connection.update",
          ({ connection, qr, lastDisconnect }) => {
            void (async () => {
              if (choice === "qr" && qr) qrcode.generate(qr, { small: true });
              if (
                choice === "pairing" &&
                !auth.state.creds.registered &&
                !requestedCode &&
                (connection === "connecting" || qr)
              ) {
                requestedCode = true;
                const code = await socket!.requestPairingCode(pairingPhone!);
                console.log(`Enter this pairing code in WhatsApp: ${code}`);
              }
              if (connection === "open" && !settled) {
                const authenticated = [
                  auth.state.creds.me?.id,
                  auth.state.creds.me?.phoneNumber,
                ].filter((identity): identity is string => Boolean(identity));
                if (
                  authenticated.some(
                    (identity) =>
                      normalizeJid(identity) ===
                      `${config.ownerPhone.slice(1)}@s.whatsapp.net`,
                  )
                ) {
                  settled = true;
                  reject(
                    new Error(
                      "Stan must use a dedicated WhatsApp account separate from the owner number",
                    ),
                  );
                  return;
                }
                const owners = await socket!.onWhatsApp(
                  config.ownerPhone.slice(1),
                );
                const owner = owners?.[0];
                if (!owner?.exists) {
                  settled = true;
                  reject(
                    new Error(
                      "The configured owner number is not available on WhatsApp",
                    ),
                  );
                  return;
                }
                settled = true;
                resolve();
              }
              if (connection === "close" && !settled) {
                const code = statusCode(lastDisconnect?.error);
                if (code === DisconnectReason.loggedOut) {
                  settled = true;
                  reject(new Error("WhatsApp rejected authentication"));
                } else {
                  await socket?.end(undefined);
                  setTimeout(
                    connect,
                    code === DisconnectReason.restartRequired ? 0 : 1000,
                  ).unref();
                }
              }
            })().catch(reject);
          },
        );
      };
      connect();
    });
    await socket?.end(undefined);
    socket = undefined;
    target.configureOwnerIdentity(
      `${config.ownerPhone.slice(1)}@s.whatsapp.net`,
    );
    target.transaction(() => {
      target.database.exec("DELETE FROM whatsapp_auth");
      const rows = temporary.database
        .prepare("SELECT category, item_key, value_json FROM whatsapp_auth")
        .all() as {
        category: string;
        item_key: string;
        value_json: string;
      }[];
      const insert = target.database.prepare(
        "INSERT INTO whatsapp_auth(category, item_key, value_json) VALUES (?, ?, ?)",
      );
      for (const row of rows)
        insert.run(row.category, row.item_key, row.value_json);
    });
    console.log("WhatsApp authentication verified and installed.");
  } finally {
    try {
      await socket?.end(undefined);
    } finally {
      temporary.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
}

function normalizePairingPhone(value: string): string {
  const parsed = parsePhoneNumberFromString(value.trim());
  if (!parsed?.isValid()) {
    throw new Error("The dedicated WhatsApp pairing number is invalid");
  }
  return parsed.number.slice(1);
}

function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("output" in error))
    return undefined;
  const output = error.output;
  return output &&
    typeof output === "object" &&
    "statusCode" in output &&
    typeof output.statusCode === "number"
    ? output.statusCode
    : undefined;
}
