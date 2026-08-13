import makeWASocket, {
  DisconnectReason,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  normalizeMessageContent,
  type WASocket,
  type WAMessage,
} from "@whiskeysockets/baileys";
import pino, { type Logger } from "pino";
import type { ApplicationDatabase } from "../storage/application-db.ts";
import type { OwnerIngress } from "./owner-ingress.ts";
import { createSqliteAuthState } from "./whatsapp-auth-state.ts";

export class WhatsAppGateway {
  private socket: WASocket | undefined;
  private stopping = false;
  private reconnectAttempt = 0;
  private inbound = Promise.resolve();
  private connection: "closed" | "connecting" | "open" = "closed";

  constructor(
    private readonly application: ApplicationDatabase,
    private readonly ingress: OwnerIngress,
    private readonly ownerPhone: string,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.stopping = false;
    this.connect();
  }

  quiesce(): void {
    this.stopping = true;
  }

  async drain(): Promise<void> {
    await this.inbound;
  }

  async stop(): Promise<void> {
    this.quiesce();
    this.connection = "closed";
    const socket = this.socket;
    this.socket = undefined;
    if (socket) await socket.end(undefined);
  }

  status(): string {
    return this.connection;
  }

  async send(text: string, messageId?: string): Promise<{ messageId: string }> {
    if (!this.socket || this.connection !== "open")
      throw new Error("WhatsApp is not connected");
    const result = await this.socket.sendMessage(
      `${this.ownerPhone.slice(1)}@s.whatsapp.net`,
      { text },
      messageId ? { messageId } : undefined,
    );
    if (!result?.key.id)
      throw new Error("WhatsApp did not return an outbound message ID");
    return { messageId: result.key.id };
  }

  private connect(): void {
    if (this.stopping) return;
    this.connection = "connecting";
    const auth = createSqliteAuthState(this.application);
    const socket = makeWASocket({
      auth: auth.state,
      logger: pino({ level: "silent" }),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      shouldIgnoreJid: (jid) =>
        isJidGroup(jid) || isJidBroadcast(jid) || isJidNewsletter(jid),
      generateHighQualityLinkPreview: false,
    });
    this.socket = socket;
    socket.ev.on("creds.update", (update) => {
      void auth.saveCreds(update);
    });
    socket.ev.on("lid-mapping.update", ({ lid, pn }) => {
      if (
        this.application.isOwnerIdentity(pn) ||
        this.application.isOwnerIdentity(lid)
      ) {
        this.application.bindOwnerIdentity(pn, "pn");
        this.application.bindOwnerIdentity(lid, "lid");
      }
    });
    socket.ev.on("messages.upsert", ({ messages, type }) => {
      if (this.stopping || type !== "notify") return;
      this.inbound = this.inbound
        .then(async () => {
          for (const message of messages) {
            const inbound = toInbound(message, type);
            if (inbound) await this.ingress.handle(inbound);
          }
        })
        .catch((error: unknown) => {
          this.logger.error({ error }, "WhatsApp ingress failed");
        });
    });
    socket.ev.on("connection.update", (update) => {
      if (update.connection === "open") {
        this.connection = "open";
        this.reconnectAttempt = 0;
        this.logger.info({ component: "whatsapp" }, "WhatsApp connected");
        return;
      }
      if (update.connection !== "close") return;
      this.connection = "closed";
      const statusCode = disconnectStatus(update.lastDisconnect?.error);
      if (statusCode === DisconnectReason.loggedOut || this.stopping) {
        this.logger.warn(
          { component: "whatsapp", statusCode },
          "WhatsApp disconnected and requires re-authentication",
        );
        return;
      }
      this.socket = undefined;
      const delay =
        statusCode === DisconnectReason.restartRequired
          ? 0
          : Math.min(30_000, 1000 * 2 ** this.reconnectAttempt++);
      this.logger.warn(
        { component: "whatsapp", statusCode, delay },
        "WhatsApp disconnected; reconnecting",
      );
      setTimeout(() => this.connect(), delay).unref();
    });
  }
}

function toInbound(message: WAMessage, type: "notify") {
  const remoteJid = message.key.remoteJid;
  const id = message.key.id;
  if (!remoteJid || !id || message.key.fromMe) return undefined;
  const content = normalizeMessageContent(message.message);
  const text = content?.conversation ?? content?.extendedTextMessage?.text;
  if (!text) return undefined;
  const quoted = normalizeMessageContent(
    content?.extendedTextMessage?.contextInfo?.quotedMessage,
  );
  const quotedText = quoted?.conversation ?? quoted?.extendedTextMessage?.text;
  const seconds =
    typeof message.messageTimestamp === "number"
      ? message.messageTimestamp
      : Number(message.messageTimestamp ?? Math.floor(Date.now() / 1000));
  return {
    id,
    type,
    remoteJid,
    ...(message.key.remoteJidAlt
      ? { remoteJidAlt: message.key.remoteJidAlt }
      : {}),
    ...(message.key.participant
      ? { participant: message.key.participant }
      : {}),
    fromMe: false,
    text,
    ...(quotedText ? { quotedText } : {}),
    receivedAt: new Date(seconds * 1000).toISOString(),
  };
}

function disconnectStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const output = "output" in error ? error.output : undefined;
  if (!output || typeof output !== "object") return undefined;
  const statusCode = "statusCode" in output ? output.statusCode : undefined;
  return typeof statusCode === "number" ? statusCode : undefined;
}
