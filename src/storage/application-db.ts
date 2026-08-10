import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export type AuthorizationOperation =
  | "draft"
  | "publish"
  | "schedule"
  | "reply"
  | "edit"
  | "cancel"
  | "delete";
export type XOperationStatus =
  | "draft"
  | "scheduled"
  | "publishing"
  | "published"
  | "partial"
  | "failed"
  | "cancelled";

export interface AuthorizationEnvelope {
  id: string;
  operation: AuthorizationOperation;
  sourceMessageId: string;
  quotedText: string | null;
  targetPostId: string | null;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
}

export interface XOperation {
  logicalId: string;
  requestId: string;
  authorizationEnvelopeId: string;
  operation: AuthorizationOperation;
  payloadHash: string;
  accountId: string;
  requestJson: string;
  retryCount: number;
  nextRetryAt: string | null;
  providerId: string | null;
  status: XOperationStatus;
  publicId: string | null;
  publicUrl: string | null;
  scheduledFor: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

const migration = `
CREATE TABLE IF NOT EXISTS owner_identities (
  identity TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('pn', 'lid')),
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS inbound_messages (
  provider_message_id TEXT PRIMARY KEY,
  sender_identity TEXT NOT NULL,
  body TEXT NOT NULL,
  quoted_text TEXT,
  received_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('claimed', 'dispatched', 'reply_pending', 'delivered', 'failed', 'unknown')),
  session_id TEXT,
  flue_submission_id TEXT,
  response_text TEXT,
  outbound_message_id TEXT,
  error TEXT,
  recovery_attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS authorization_envelopes (
  id TEXT PRIMARY KEY,
  source_message_id TEXT NOT NULL UNIQUE REFERENCES inbound_messages(provider_message_id),
  operation TEXT NOT NULL CHECK (operation IN ('draft', 'publish', 'schedule', 'reply', 'edit', 'cancel', 'delete')),
  quoted_text TEXT,
  target_post_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS daily_sessions (
  local_date TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('active', 'closed')),
  created_at TEXT NOT NULL,
  closed_at TEXT,
  transcript_complete INTEGER NOT NULL DEFAULT 0 CHECK (transcript_complete IN (0, 1))
) STRICT;
CREATE TABLE IF NOT EXISTS x_operations (
  logical_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  authorization_envelope_id TEXT NOT NULL UNIQUE REFERENCES authorization_envelopes(id),
  operation TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  account_id TEXT NOT NULL,
  request_json TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  provider_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('draft', 'scheduled', 'publishing', 'published', 'partial', 'failed', 'cancelled')),
  public_id TEXT,
  public_url TEXT,
  scheduled_for TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS scheduled_publications (
  logical_operation_id TEXT PRIMARY KEY REFERENCES x_operations(logical_id),
  provider_id TEXT NOT NULL,
  next_poll_at TEXT NOT NULL,
  last_status TEXT NOT NULL,
  notified_status TEXT,
  poll_count INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE IF NOT EXISTS heartbeat_occurrences (
  occurrence_id TEXT PRIMARY KEY,
  local_date TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('morning', 'regular')),
  status TEXT NOT NULL CHECK (status IN ('leased', 'running', 'ready', 'notified', 'silent', 'quiet-hours', 'busy', 'suppressed', 'duplicate', 'disabled', 'failed')),
  lease_until TEXT,
  notify INTEGER CHECK (notify IN (0, 1)),
  message TEXT,
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  schedule_type TEXT NOT NULL CHECK (schedule_type IN ('once', 'cron')),
  schedule_value TEXT NOT NULL,
  timezone TEXT NOT NULL CHECK (timezone = 'Asia/Karachi'),
  instruction TEXT NOT NULL,
  delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('silent', 'owner_whatsapp')),
  creator_message_id TEXT NOT NULL,
  next_run_at TEXT,
  last_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS automation_runs (
  occurrence_id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id),
  scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL,
  lease_until TEXT,
  flue_submission_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS automation_runs_recent ON automation_runs(automation_id, created_at DESC);
CREATE TABLE IF NOT EXISTS activity_facts (
  id INTEGER PRIMARY KEY,
  local_date TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject_id TEXT,
  detail_json TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS analytics_snapshots (
  id INTEGER PRIMARY KEY,
  post_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  metrics_json TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS memory_documents (
  custom_id TEXT PRIMARY KEY,
  provider_id TEXT,
  local_date TEXT,
  conversation_id TEXT,
  content TEXT,
  complete INTEGER CHECK (complete IN (0, 1)),
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS workspace_history (
  id INTEGER PRIMARY KEY,
  logical_name TEXT NOT NULL,
  previous_content TEXT NOT NULL,
  source_message_id TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS watchlist_state (
  watch_key TEXT PRIMARY KEY,
  last_checked_at TEXT,
  cursor TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS whatsapp_auth (
  category TEXT NOT NULL,
  item_key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  PRIMARY KEY (category, item_key)
) STRICT;
CREATE TABLE IF NOT EXISTS proactive_suggestions (
  topic_hash TEXT PRIMARY KEY,
  message TEXT NOT NULL,
  sent_at TEXT NOT NULL
) STRICT;
`;

export class ApplicationDatabase {
  readonly database: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path, { timeout: 5000 });
    this.database.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
  }

  migrate(): void {
    this.transaction(() => {
      this.database.exec(migration);
      addColumnIfMissing(
        this.database,
        "inbound_messages",
        "flue_submission_id",
        "TEXT",
      );
      addColumnIfMissing(
        this.database,
        "inbound_messages",
        "recovery_attempts",
        "INTEGER NOT NULL DEFAULT 0",
      );
      addColumnIfMissing(
        this.database,
        "inbound_messages",
        "next_retry_at",
        "TEXT",
      );
      addColumnIfMissing(
        this.database,
        "authorization_envelopes",
        "target_post_id",
        "TEXT",
      );
      addColumnIfMissing(
        this.database,
        "scheduled_publications",
        "poll_count",
        "INTEGER NOT NULL DEFAULT 0",
      );
      addColumnIfMissing(
        this.database,
        "automation_runs",
        "flue_submission_id",
        "TEXT",
      );
      addColumnIfMissing(
        this.database,
        "automation_runs",
        "attempts",
        "INTEGER NOT NULL DEFAULT 0",
      );
    });
  }

  close(): void {
    this.database.close();
  }

  transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  configureOwnerIdentity(identity: string): void {
    const normalized = normalizeJid(identity);
    this.transaction(() => {
      const current = this.database
        .prepare("SELECT identity FROM owner_identities WHERE kind = 'pn'")
        .all() as { identity: string }[];
      if (current.some((row) => row.identity !== normalized)) {
        this.database.exec("DELETE FROM owner_identities");
      }
      this.database
        .prepare(
          "INSERT OR IGNORE INTO owner_identities(identity, kind, created_at) VALUES (?, 'pn', ?)",
        )
        .run(normalized, new Date().toISOString());
    });
  }

  bindOwnerIdentity(identity: string, kind: "pn" | "lid"): void {
    this.database
      .prepare(
        "INSERT OR IGNORE INTO owner_identities(identity, kind, created_at) VALUES (?, ?, ?)",
      )
      .run(normalizeJid(identity), kind, new Date().toISOString());
  }

  isOwnerIdentity(identity: string): boolean {
    return (
      this.database
        .prepare("SELECT 1 FROM owner_identities WHERE identity = ?")
        .get(normalizeJid(identity)) !== undefined
    );
  }

  claimInbound(input: {
    id: string;
    senderIdentity: string;
    body: string;
    quotedText?: string;
    receivedAt: string;
  }): boolean {
    return this.transaction(() => {
      if (
        this.database
          .prepare(
            "SELECT 1 FROM inbound_messages WHERE provider_message_id = ?",
          )
          .get(input.id)
      )
        return false;
      this.database
        .prepare(
          `INSERT INTO inbound_messages(provider_message_id, sender_identity, body, quoted_text, received_at, state)
           VALUES (?, ?, ?, ?, ?, 'claimed')`,
        )
        .run(
          input.id,
          normalizeJid(input.senderIdentity),
          input.body,
          input.quotedText ?? null,
          input.receivedAt,
        );
      return true;
    });
  }

  setInboundState(
    id: string,
    state: "dispatched" | "reply_pending" | "delivered" | "failed" | "unknown",
    values: {
      sessionId?: string;
      flueSubmissionId?: string;
      responseText?: string;
      outboundMessageId?: string;
      error?: string;
    } = {},
  ): void {
    this.database
      .prepare(
        `UPDATE inbound_messages SET state = ?, session_id = COALESCE(?, session_id),
         flue_submission_id = COALESCE(?, flue_submission_id), response_text = COALESCE(?, response_text),
         outbound_message_id = COALESCE(?, outbound_message_id), error = COALESCE(?, error)
         , recovery_attempts = CASE WHEN ? = 'reply_pending' THEN 0 ELSE recovery_attempts END
         , next_retry_at = CASE WHEN ? = 'reply_pending' THEN NULL ELSE next_retry_at END
         WHERE provider_message_id = ?`,
      )
      .run(
        state,
        values.sessionId ?? null,
        values.flueSubmissionId ?? null,
        values.responseText ?? null,
        values.outboundMessageId ?? null,
        values.error ?? null,
        state,
        state,
        id,
      );
  }

  recordInboundFailure(id: string, error: string, now = new Date()): void {
    const row = this.database
      .prepare(
        "SELECT recovery_attempts FROM inbound_messages WHERE provider_message_id = ?",
      )
      .get(id) as { recovery_attempts: number } | undefined;
    if (!row) return;
    const attempts = row.recovery_attempts + 1;
    const exhausted = attempts >= 3;
    this.database
      .prepare(
        `UPDATE inbound_messages SET state = ?, recovery_attempts = ?, next_retry_at = ?, error = ?
         WHERE provider_message_id = ?`,
      )
      .run(
        exhausted ? "unknown" : "failed",
        attempts,
        exhausted
          ? null
          : new Date(
              now.getTime() + 60_000 * 2 ** (attempts - 1),
            ).toISOString(),
        error,
        id,
      );
  }

  createAuthorization(input: {
    sourceMessageId: string;
    operation: AuthorizationOperation;
    quotedText?: string;
    targetPostId?: string;
    now?: Date;
  }): AuthorizationEnvelope {
    const now = input.now ?? new Date();
    const envelope: AuthorizationEnvelope = {
      id: crypto.randomUUID(),
      operation: input.operation,
      sourceMessageId: input.sourceMessageId,
      quotedText: input.quotedText ?? null,
      targetPostId: input.targetPostId ?? null,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
      consumedAt: null,
    };
    this.database
      .prepare(
        `INSERT INTO authorization_envelopes(id, source_message_id, operation, quoted_text, target_post_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        envelope.id,
        envelope.sourceMessageId,
        envelope.operation,
        envelope.quotedText,
        envelope.targetPostId,
        envelope.createdAt,
        envelope.expiresAt,
      );
    return envelope;
  }

  getAuthorizationForSource(
    sourceMessageId: string,
  ): AuthorizationEnvelope | undefined {
    const row = this.database
      .prepare(
        `SELECT id, operation, source_message_id, quoted_text, target_post_id, created_at, expires_at, consumed_at
         FROM authorization_envelopes WHERE source_message_id = ?`,
      )
      .get(sourceMessageId) as Record<string, string | null> | undefined;
    return row ? mapAuthorization(row) : undefined;
  }

  getAuthorization(id: string): AuthorizationEnvelope | undefined {
    const row = this.database
      .prepare(
        `SELECT id, operation, source_message_id, quoted_text, target_post_id, created_at, expires_at, consumed_at
         FROM authorization_envelopes WHERE id = ?`,
      )
      .get(id) as Record<string, string | null> | undefined;
    return row ? mapAuthorization(row) : undefined;
  }

  beginXOperation(input: {
    envelopeId: string;
    sourceMessageId: string;
    operation: AuthorizationOperation;
    payloadHash: string;
    accountId: string;
    requestJson: string;
    targetPostId?: string;
    now?: Date;
  }): XOperation {
    return this.transaction(() => {
      const existing = this.getXOperationByEnvelope(input.envelopeId);
      if (existing) {
        if (
          existing.payloadHash !== input.payloadHash ||
          existing.operation !== input.operation
        ) {
          throw new Error(
            "Authorization envelope is already bound to a different X operation",
          );
        }
        return existing;
      }
      const envelope = this.getAuthorization(input.envelopeId);
      const now = input.now ?? new Date();
      if (!envelope || envelope.sourceMessageId !== input.sourceMessageId) {
        throw new Error(
          "Current owner authorization is required for this X operation",
        );
      }
      if (envelope.operation !== input.operation) {
        throw new Error(
          `Owner authorization permits ${envelope.operation}, not ${input.operation}`,
        );
      }
      if (
        (input.operation === "reply" ||
          input.operation === "edit" ||
          input.operation === "cancel" ||
          input.operation === "delete") &&
        (!envelope.targetPostId || envelope.targetPostId !== input.targetPostId)
      ) {
        throw new Error(
          "The requested X post does not match the target authorized by the owner",
        );
      }
      if (
        envelope.consumedAt ||
        Date.parse(envelope.expiresAt) <= now.getTime()
      ) {
        throw new Error("Owner authorization has expired or was consumed");
      }
      const logicalId = crypto.randomUUID();
      const requestId = crypto.randomUUID();
      const timestamp = now.toISOString();
      this.database
        .prepare(
          "UPDATE authorization_envelopes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL",
        )
        .run(timestamp, envelope.id);
      this.database
        .prepare(
          `INSERT INTO x_operations(logical_id, request_id, authorization_envelope_id, operation, payload_hash, account_id, request_json, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'publishing', ?, ?)`,
        )
        .run(
          logicalId,
          requestId,
          envelope.id,
          input.operation,
          input.payloadHash,
          input.accountId,
          input.requestJson,
          timestamp,
          timestamp,
        );
      return this.getXOperation(logicalId)!;
    });
  }

  getXOperation(logicalId: string): XOperation | undefined {
    const row = this.database
      .prepare("SELECT * FROM x_operations WHERE logical_id = ?")
      .get(logicalId) as Record<string, string | null> | undefined;
    return row ? mapXOperation(row) : undefined;
  }

  getXOperationByEnvelope(envelopeId: string): XOperation | undefined {
    const row = this.database
      .prepare("SELECT * FROM x_operations WHERE authorization_envelope_id = ?")
      .get(envelopeId) as Record<string, string | null> | undefined;
    return row ? mapXOperation(row) : undefined;
  }

  updateXOperation(
    logicalId: string,
    update: {
      status: XOperationStatus;
      providerId?: string;
      publicId?: string;
      publicUrl?: string;
      scheduledFor?: string;
      error?: string | null;
    },
  ): XOperation {
    this.database
      .prepare(
        `UPDATE x_operations SET status = ?, provider_id = COALESCE(?, provider_id), public_id = COALESCE(?, public_id),
         public_url = COALESCE(?, public_url), scheduled_for = COALESCE(?, scheduled_for), error = ?,
         next_retry_at = CASE WHEN ? = 'publishing' THEN next_retry_at ELSE NULL END, updated_at = ? WHERE logical_id = ?`,
      )
      .run(
        update.status,
        update.providerId ?? null,
        update.publicId ?? null,
        update.publicUrl ?? null,
        update.scheduledFor ?? null,
        update.error ?? null,
        update.status,
        new Date().toISOString(),
        logicalId,
      );
    const result = this.getXOperation(logicalId);
    if (!result) throw new Error("X operation disappeared during update");
    return result;
  }

  scheduleXOperationRetry(
    logicalId: string,
    error: string,
    now = new Date(),
  ): XOperation {
    const current = this.getXOperation(logicalId);
    if (!current) throw new Error("X operation not found");
    const retryCount = current.retryCount + 1;
    const nextRetryAt =
      retryCount < 3
        ? new Date(now.getTime() + 60_000 * 2 ** (retryCount - 1)).toISOString()
        : null;
    this.database
      .prepare(
        "UPDATE x_operations SET status = 'publishing', retry_count = ?, next_retry_at = ?, error = ?, updated_at = ? WHERE logical_id = ?",
      )
      .run(retryCount, nextRetryAt, error, now.toISOString(), logicalId);
    return this.getXOperation(logicalId)!;
  }
}

function addColumnIfMissing(
  database: DatabaseSync,
  table: string,
  column: string,
  declaration: string,
): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (!columns.some((candidate) => candidate.name === column))
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
}

function mapAuthorization(
  row: Record<string, string | null>,
): AuthorizationEnvelope {
  return {
    id: row.id!,
    operation: row.operation as AuthorizationOperation,
    sourceMessageId: row.source_message_id!,
    quotedText: row.quoted_text ?? null,
    targetPostId: row.target_post_id ?? null,
    createdAt: row.created_at!,
    expiresAt: row.expires_at!,
    consumedAt: row.consumed_at ?? null,
  };
}

function mapXOperation(row: Record<string, string | null>): XOperation {
  return {
    logicalId: row.logical_id!,
    requestId: row.request_id!,
    authorizationEnvelopeId: row.authorization_envelope_id!,
    operation: row.operation as AuthorizationOperation,
    payloadHash: row.payload_hash!,
    accountId: row.account_id!,
    requestJson: row.request_json!,
    retryCount: Number(row.retry_count),
    nextRetryAt: row.next_retry_at ?? null,
    providerId: row.provider_id ?? null,
    status: row.status as XOperationStatus,
    publicId: row.public_id ?? null,
    publicUrl: row.public_url ?? null,
    scheduledFor: row.scheduled_for ?? null,
    error: row.error ?? null,
    createdAt: row.created_at!,
    updatedAt: row.updated_at!,
  };
}

export function normalizeJid(jid: string): string {
  const [user = "", server = ""] = jid.split("@", 2);
  return `${user.split(":", 1)[0]}@${server}`.toLowerCase();
}
