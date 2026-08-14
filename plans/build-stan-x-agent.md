# Build Stan: private WhatsApp X agent

## Goal

Build `stan`, a private, always-on, single-user X/Twitter agent operated through WhatsApp and a local CLI. Stan should research public X conversations and the wider web, draft posts and replies in Arham's voice, schedule or publish only when Arham explicitly requests it, monitor outcomes, remember useful context across daily sessions, and proactively check in without becoming noisy.

Stan must run on a Windows PC or Ubuntu VPS, survive process restarts, preserve accepted work, keep secrets out of model context and logs, and report external actions according to verified provider state rather than model assumptions.

## Fixed product decisions

- Use TypeScript on Node.js 24.
- Use Flue 2.0's Node target for the durable agent runtime.
- Use Pi's OpenAI Codex provider and ChatGPT subscription authentication, with device-code login.
- Use Baileys directly for WhatsApp rather than Chat SDK.
- Accept messages only from one configured owner number and send proactive messages only to that owner.
- Default Pakistani phone input to the fixed `+92` prefix.
- Use the IANA timezone `Asia/Karachi` everywhere. Do not depend on the host timezone or represent this as a raw UTC offset.
- Use XQuik only for public X reads and research.
- Use Zernio for account-bound operations: connected-account discovery, drafts, publishing, replies, scheduling, cancellation/editing where supported, publication status, and analytics.
- Use Firecrawl for wider web search and page fetches.
- Use Supermemory for semantic long-term memory.
- Use file-backed SQLite for exact local state, Flue durability, scheduling, deduplication, and provider operation records.
- Use a small local Markdown workspace for deliberate operating knowledge.
- Start with one main agent and no subagents. Add a predefined read-only research delegate only if measured context or quality problems justify it. Never allow runtime creation of arbitrary agents or capabilities.
- Do not give the model Bash, arbitrary filesystem access, raw credentials, arbitrary HTTP, or generic provider clients.
- Do not build a general permissions system or approval UI. Enforce narrow owner authorization at the write-tool boundary.
- Let Zernio own delayed X publication. Do not implement a second tweet publishing queue.

## Non-negotiable invariants

### Owner boundary

Normalize the configured phone number to E.164 and bind it to the WhatsApp identities Baileys observes, including JID/LID mappings. Ignore unknown senders, groups, broadcasts, newsletters, history replays, and status events without responding. Claim each inbound WhatsApp message ID in SQLite before dispatching it so provider retries and reconnects cannot duplicate work.

### Public-write boundary

The system prompt is guidance, not authorization. The gateway must derive a short-lived authorization envelope only from the current authenticated owner's explicit command, such as `post`, `schedule`, `reply`, `edit`, `cancel`, or `delete`. Natural references such as “post the second one” or “schedule that for tomorrow at nine” are allowed. The envelope authorizes only the named operation and records the source WhatsApp message and quoted-message context. When the owner includes a verbatim status URL, labelled post ID, or ISO instant, that detail binds exactly, and when the owner quotes the exact final text of a post or schedule without a numbered reference, that text binds exactly; otherwise the model resolves the target, content, or instant. Numbered references (“the second one”, “#2”) resolve against the numbered items Stan showed earlier in the conversation, and natural times resolve to an explicit ISO instant on the trusted `Asia/Karachi` clock. Edit, cancel, and delete still require the resolved target to belong to the configured X account. The model cannot create, persist, or reuse an authorization envelope; each envelope is single-use and bound to one owner message.

Proactive runs, heartbeats, cron jobs, Supermemory results, workspace files, X posts, and fetched web pages cannot grant public-write authority. Scheduled publication remains authorized because Stan submits it to Zernio during the authorized owner turn. Any new edit, cancellation, deletion, or replacement requires a new owner command.

### External-action truth

Use a stable UUID as Zernio's `x-request-id` for one logical create operation and reuse it only when retrying that operation. Persist the operation before the provider call. Distinguish `draft`, `scheduled`, `publishing`, `published`, `partial`, `failed`, and `cancelled`. Report immediate publication as successful only from a terminal provider response with its public ID/URL. Report a future item as scheduled, not posted. Poll or process signed webhooks to learn its eventual outcome.

### Exact versus semantic memory

Supermemory is useful but approximate and asynchronous. It is never authoritative for authorization, schedules, exact post status, analytics, credentials, deduplication, or current configuration. SQLite and provider lookups own those facts.

## First milestone: feasibility gates

Before building the product surface, create disposable spikes and record their outcomes. Do not proceed past a failed gate without revisiting the architecture.

1. **Codex authentication:** use the installed Pi APIs to run OpenAI Codex device-code login, persist a refreshable credential in a Stan-owned auth path, discover the authenticated models and each model's supported thinking levels, register/use that provider from Flue, and complete one tool-capable model call. Prove refresh after process restart. Flue documents environment API keys more directly than OAuth credential stores, so this integration is the framework-selection gate.
2. **Flue recovery:** use file-backed SQLite, force-kill a model/tool run, restart, and show that accepted conversation work settles without duplicate external effects.
3. **Baileys:** complete QR and phone pairing-code authentication on Windows and Ubuntu, reconnect from persisted auth, observe JID/LID identity, reject history replay, and cleanly recover from `restartRequired` and ordinary disconnects.
4. **Zernio:** against a test X account, verify draft, immediate post, reply, future schedule, cancellation, get-status, analytics, and retry/idempotency behavior. Record the actual SDK types and thread/reply shapes.
5. **Supermemory:** ingest an idempotently named sample conversation, wait for asynchronous processing, retrieve profile and hybrid search results, update the same `customId`, and delete the test container/document.
6. Pin compatible package versions only after these spikes, using the installed packages' documentation and types. Flue, Pi, Baileys, and Supermemory are fast-moving; do not implement from remembered APIs.

## Proposed repository layout

Preserve implementation freedom where framework conventions differ in the installed version, but aim for this separation:

```text
package.json
vite.config.ts
src/
  app.ts                         # Flue/Hono app and internal health/control routes
  db.ts                          # file-backed Flue SQLite adapter
  agents/
    stan.ts                      # main Flue agent
  auth/
    codex.ts                     # Pi device auth, refresh, credential adapter
  cli/
    index.ts
    commands/
      setup.ts
      auth.ts
      service.ts
      status.ts
      logs.ts
      doctor.ts
      whatsapp-auth.ts
      apis-auth.ts
  config/
    schema.ts
    store.ts
  gateway/
    daemon.ts
    owner-authorization.ts
    whatsapp.ts
    delivery.ts
  scheduler/
    scheduler.ts
    heartbeat.ts
    rollover.ts
    automations.ts
  memory/
    supermemory.ts
    context.ts
    ingestion.ts
  workspace/
    store.ts
    templates/
      GOALS.md
      STRATEGY.md
      PLAYBOOK.md
      HEARTBEATS.md
      WATCHLIST.md
      voice/PROFILE.md
      voice/EVIDENCE.md
  providers/
    xquik.ts
    zernio.ts
    firecrawl.ts
  tools/
    xquik.ts
    zernio-read.ts
    zernio-write.ts
    firecrawl.ts
    heartbeat.ts
    settings.ts
    automations.ts
    memory.ts
    workspace.ts
    whatsapp.ts
  skills/
    voice/SKILL.md
    stan/SKILL.md
  storage/
    application-db.ts
    migrations/
tests/
  integration/
  fixtures/
```

Use platform state directories rather than repository paths at runtime:

- Windows: `%LOCALAPPDATA%\Stan`
- Ubuntu: `$XDG_STATE_HOME/stan` or `~/.local/state/stan`

Keep configuration, credential state, Baileys auth, SQLite, mutable workspace files, logs, and service metadata beneath that root. Apply owner-only filesystem permissions (`0600`/`0700` on Ubuntu and an owner-only ACL on Windows). Never print secrets or full credential-bearing provider errors.

## Configuration model

Validate config on every read and write. Store non-secret config separately from credentials. Use one authoritative schedule representation approximately like:

```json
{
  "timezone": "Asia/Karachi",
  "ownerPhone": "+92…",
  "model": {
    "provider": "openai-codex",
    "id": "…",
    "thinkingLevel": "…"
  },
  "heartbeat": {
    "enabled": true,
    "startTime": "09:00",
    "endTime": "02:00",
    "intervalMinutes": 180,
    "morningCatchupMinutes": 120
  },
  "sessionRolloverTime": "00:01"
}
```

`heartbeat.startTime` is also the morning-message time. Do not introduce a separate morning time that can diverge. Treat the active period as an overnight interval from 09:00 through the following 02:00. The default three-hour cadence anchored at 09:00 produces 09:00, 12:00, 15:00, 18:00, 21:00, and 00:00; 09:00 is the morning run, not a second heartbeat.

`HEARTBEATS.md` is the single editable heartbeat prompt/checklist. Keep a small immutable application wrapper that identifies the run as a heartbeat, supplies trusted context, requires a structured response, and repeats the write boundary. Do not duplicate editable heartbeat prose in JSON config.

## SQLite responsibilities

Use the Flue persistence tables plus application-owned tables/migrations for at least:

- inbound WhatsApp message claims and delivery state;
- owner authorization envelopes and consumed status;
- daily session routing and rollover state;
- X/Zernio logical operations, request IDs, provider IDs, payload hashes, statuses, URLs, and errors;
- scheduled publication monitoring;
- heartbeat and automation definitions, leases, runs, skip reasons, notifications, and next-run times;
- owner interaction timestamps and daily activity facts;
- analytics snapshots and comparison baselines;
- Supermemory documents/custom IDs, ingestion status, retries, and last profile refresh;
- workspace document versions or backups when edited by the agent.

Use transactions and unique indexes at the real idempotency boundaries. Do not rely on in-memory locks for correctness across restarts.

## WhatsApp gateway

Implement one long-lived Baileys socket with persisted auth and explicit reconnect handling. Register all handlers before connecting. Initially support text and quoted-message context; add media/audio only after the text path is reliable.

For each accepted owner message:

1. Normalize and verify sender identity.
2. Reject non-notify/history/group/broadcast traffic.
3. Claim the provider message ID transactionally.
4. Derive any narrow authorization envelope from the raw owner command and quoted context.
5. Resolve the active Pakistan-date daily session.
6. Dispatch a typed owner delivery into Flue with trusted metadata kept separate from model-selected arguments.
7. Stream or await the settled reply and send it only to the bound owner destination.
8. Persist send outcome and allow safe reconciliation after a crash.

A reply tool must be permanently bound to the owner destination; the model never supplies a phone number.

Document during setup that Baileys is unofficial, can break when WhatsApp changes its protocol, and can result in suspension of the dedicated number.

## Daily session lifecycle

Use one Flue conversation per Pakistan calendar day, for example `stan-owner-2026-08-13`.

At 00:01 `Asia/Karachi`, run an idempotent rollover job:

1. Close the previous session for new ordinary routing.
2. Finalize its local activity record.
3. Upsert its transcript to Supermemory with `customId: stan-session-YYYY-MM-DD` and metadata identifying source, date, Flue conversation ID, and completeness.
4. Set the new daily conversation ID active.
5. Do not send WhatsApp output and do not spend a model call merely to create the Flue conversation; create it on its first owner or scheduled delivery.

The 00:00 heartbeat belongs to the ending day. Traffic at or after 00:01 routes to the new day. If rollover was missed while offline, perform it once at startup before accepting messages.

## Heartbeat system

### Trusted context packet

Before every heartbeat model call, construct a bounded, deterministic context packet from authoritative sources:

- local date and time;
- whether this is the morning run;
- last owner interaction and days since meaningful work;
- messages and actions completed today;
- yesterday's closing activity;
- recent posts, schedules, failures, replies, and material analytics changes;
- suggestions already sent recently, so they are not repeated;
- active goals and strategy;
- `HEARTBEATS.md`;
- active entries from `WATCHLIST.md`, with last-check timestamps from SQLite;
- Supermemory's compact profile and a small relevant retrieval result set;
- currently running or queued work.

Do not fetch every watched profile or full analytics history every three hours. Rotate bounded watchlist checks, remember last checks in SQLite, batch XQuik requests where possible, and let the model request deeper research through read-only tools.

### Morning run

At the configured start time (default 09:00), always invoke the model and always send exactly one WhatsApp message. The model writes the message; do not use templates or phrase randomization. It may greet normally, refer to yesterday's work or performance, note a multi-day gap, surface a timely opportunity, or simply ask what to work on. Prompt for selective, conversational use of context rather than a mechanical report, forced novelty, fake urgency, or repeated enthusiasm.

If Stan starts after 09:00, permit one morning catch-up within the configured grace period (default 120 minutes). Never replay several missed heartbeats.

### Regular runs

At subsequent anchored ticks, always invoke the model when inside active hours and not already busy. Require the model to finish with a typed tool such as:

```text
heartbeat_respond({
  notify: boolean,
  message?: string,
  reason: "opportunity" | "performance_change" | "scheduled_post_update" |
          "unfinished_work" | "useful_check_in" | "nothing_useful"
})
```

Send at most one bound-owner WhatsApp message when `notify` is true. A false result remains silent but is recorded. Suppress or skip when nothing changed, the same topic was already raised, Arham interacted recently, another run is active, or an exact automation is handling the matter.

Use durable leases and stable occurrence IDs. Skip outside active hours, when the main owner session is busy, or when the same occurrence is complete. Record `quiet-hours`, `busy`, `duplicate`, `disabled`, and provider failure distinctly. Do not shift cadence after daemon restart.

Allow the owner to disable heartbeats completely or update start time, overnight end time, interval, catch-up grace, and `HEARTBEATS.md` through Stan. Configuration changes require a current authenticated owner message, but no second approval.

## Exact automations (“crons”)

Implement application-owned declarative automations, not OS cron entries or executable code. Support one-shot and cron schedules with:

- stable ID and name;
- enabled/paused state;
- schedule and always-fixed `Asia/Karachi` timezone;
- instruction payload;
- delivery mode (`silent` or owner WhatsApp);
- creator owner-message ID;
- created/updated timestamps;
- next run, last run, and bounded run history.

Expose narrow typed CRUD/run-now tools. Validate expressions, cap job count, reject unreasonably frequent schedules, prevent overlap, and claim each occurrence idempotently. Exact automations may research, analyze, update local operating knowledge, or notify the owner. They cannot publish, reply, edit, cancel, or delete X content without a contemporaneous owner authorization envelope.

Keep heartbeat for periodic awareness and automations for exact timing. Editing `HEARTBEATS.md` must not silently create recurring jobs.

## Workspace design and context policy

Initialize these mutable files:

- `GOALS.md`: current outcomes, priorities, products, topics, and temporary campaigns.
- `STRATEGY.md`: current content pillars, audience hypotheses, posting balance, and active experiments.
- `PLAYBOOK.md`: curated lessons supported by repeated outcomes rather than one noisy post.
- `HEARTBEATS.md`: editable morning/heartbeat prompt and short standing checklist.
- `WATCHLIST.md`: public X profiles/topics Stan wants to track, with handle/query, rationale, status, and desired check cadence. SQLite records actual last checks and cursors.
- `voice/PROFILE.md`: mutable voice preferences.
- `voice/EVIDENCE.md`: source record for owner-written and owner-approved voice evidence.

Do not create a generic `MEMORY.md` or daily Markdown logs; those would compete with Supermemory and exact local activity state.

Expose generic workspace lifecycle tools, not separate tools per file:

```text
list_workspace_files()
read_workspace_file({ file })
edit_workspace_file({ file, operation, oldText?, text })
create_workspace_file({ file, content })
delete_workspace_file({ file })
```

`file` is a logical name resolved inside the workspace. Reject path separators, traversal, symlinks, non-regular files, oversized content, and writes beyond a configured per-file limit. Make replacement exact and atomic; keep a small backup history for edits and deletions. The tools cannot reach source code, credentials, logs, SQLite, Baileys auth, or arbitrary files.

Do not inject every workspace file into every system prompt:

- Keep permanent system context to identity, owner/write boundaries, truthfulness, tool semantics, and short skill pointers.
- Inject bounded `GOALS.md` and `STRATEGY.md` operating context on owner and proactive turns.
- Inject `HEARTBEATS.md` and relevant `WATCHLIST.md` entries only on morning/heartbeat turns.
- Load `PLAYBOOK.md` when drafting or reviewing analytics, either through the voice skill's procedure or the generic workspace reader.
- Package/load voice profile and evidence through the voice skill only when writing or evaluating content.
- Bound all injected sections and surface truncation explicitly rather than silently consuming unbounded prompt space.

This gives reliable context where it is required while preserving progressive disclosure and prompt-cache efficiency.

## Skills

Create two model-invoked Flue skills:

1. **`voice`** — writing and evaluation procedure for human posts, replies, quote posts, and threads; it should direct the agent to the mutable voice profile, evidence, strategy, and playbook only when needed.
2. **`stan`** — operating procedure for inspecting/updating heartbeat settings, turning heartbeats off/on, editing `HEARTBEATS.md`, managing exact automations, maintaining the watchlist and workspace, choosing Supermemory versus exact state, and preserving public-write boundaries.

When creating or editing either skill, the implementation agent must use the repository's `writing-for-agents` skill at `.agents/skills/writing-for-agents/SKILL.md`, read it completely, and follow its `SKILL-MECHANICS.md` reference before writing. Apply its progressive-disclosure, context-pointer, single-source-of-truth, co-location, completion-criterion, and pruning guidance. Keep model-invoked descriptions short but explicit about their genuine trigger branches. Do not duplicate runtime configuration or tool schemas inside skill prose when the agent can inspect them through tools.

Flue skill activation supplies instructions; it does not itself grant tools or authorization. Mount the bounded application tools independently.

## Supermemory integration

Add `SUPERMEMORY_API_KEY` to setup/API credential management and use the official TypeScript SDK. Create one opaque, stable container tag for Arham and scope every write, profile request, search, forget, list, and deletion to it.

- Fetch the compact static/dynamic profile at daily-session start and cache it with a short TTL.
- For each owner or heartbeat task, issue a bounded hybrid retrieval query when the task would benefit from history.
- Treat retrieved statements as potentially stale and include source metadata where available.
- Upsert daily conversations with stable `customId`s so retries and incremental updates do not create duplicates.
- Track asynchronous ingestion status and retry safely; do not block ordinary owner interaction on indexing.
- Provide narrow `remember`, `recall`, `forget_memory`, and `list_recent_memories` tools. An explicit “remember this” should write directly rather than relying only on later transcript extraction. Forgetting requires an owner-directed turn.
- Continue in degraded mode if Supermemory is unavailable; expose degradation in status/doctor and retain pending ingestion locally.
- During setup, disclose that conversation content and selected context are sent to Supermemory's cloud service. Preserve the option to configure a self-hosted Supermemory base URL later only if there is a real deployment requirement.

## Provider tools

### XQuik read-only

Implement bounded tools for search posts, get post/thread/replies, get profile, and get a user's posts. Enforce small defaults, hard result caps, opaque cursors, timeouts, credit awareness, and `Retry-After`. Return structured source text and metadata marked as untrusted. Do not expose XQuik writes.

### Firecrawl read-only

Implement web search and single-page fetch only. Accept `http`/`https`, bound results and output size, prefer Markdown, pass cancellation, and reject local/private targets. Defer crawl, browser interaction, and arbitrary extraction until required.

### Zernio

Bind the selected X account ID in trusted application configuration so the model cannot choose another account. Separate read and write implementations even if they share a client. Reads cover account/profile, posts, status, schedules, and analytics. Writes cover draft, publish, reply/thread, schedule, update/cancel, and supported published edits/deletes. Every public mutation consumes the matching authorization envelope and uses the persisted logical operation/idempotency record.

Initially poll scheduled outcomes and send material state changes to the owner. Add signed, deduplicated Zernio webhooks only when a stable public HTTPS endpoint exists; verify HMAC over the raw body and acknowledge quickly.

## CLI and setup

Ship a global `stan` executable with these commands:

- `stan setup`: resumable interactive setup; validate Node/OS, create and secure state directories, initialize DB/workspace, run WhatsApp auth, collect the owner number with fixed `+92` prefix, configure APIs including Supermemory, select/validate the Zernio X account, run Codex auth/model/thinking selection, install default heartbeat/rollover schedules, optionally install autostart, and print a final redacted summary.
- `stan auth`: run Codex device-code auth, refresh catalogs with a timeout, show only authenticated available models, then only thinking levels supported by the selected model's metadata; atomically retain the prior working credential/config on cancellation or validation failure.
- `stan start`, `stop`, `restart`: idempotently manage the gateway service and shut down gracefully at turn boundaries.
- `stan status`: show process/uptime, active daily session, next morning/heartbeat/automation, WhatsApp connection, model/thinking level, memory health, DB health, selected X account, and last successful owner/heartbeat turn without secrets.
- `stan logs`: redacted rolling logs with follow, line-count, and level filtering.
- `stan doctor`: non-mutating checks for permissions, config, DB integrity/migrations, service state, scheduler leases, Codex refresh/model, WhatsApp auth/identity, XQuik account/credits, Zernio account connection, Firecrawl, Supermemory, pending ingestion, and workspace validity.
- `stan whatsapp auth`: stop/rebind safely, authenticate into a temporary directory by QR or pairing code, verify connection and owner identity, then atomically replace old credentials.
- `stan apis auth`: add/update XQuik, Zernio, Firecrawl, and Supermemory credentials; show masked existing state; blank input preserves the existing value; validate changes before commit.

The CLI itself requires Node, so `setup` should install/configure only dependencies it can safely manage and give exact platform instructions rather than silently modifying system package managers.

## Daemon and service management

Run one daemon and one active owner conversation at a time. Use native service management rather than adding PM2:

- Ubuntu: systemd user or system service, with restart-on-failure and explicit state-directory permissions.
- Windows: Task Scheduler with startup/logon launch and restart-on-failure.

Use a hidden internal gateway entrypoint if needed. `start`/`status` must verify the actual process/control endpoint rather than trusting a stale PID file. Graceful stop closes ingress, stops scheduling new work, waits to a safe turn boundary, flushes logs/DB, and closes Baileys.

## Logging and observability

Use structured rolling logs with correlation fields for WhatsApp message ID, Flue submission ID, daily session, heartbeat/automation occurrence, logical provider operation, and external provider ID. Redact known secret fields and headers before serialization. Store bounded run history and make failure states inspectable without exposing fetched private content by default.

Track token/model usage for owner, heartbeat, automation, and compaction runs separately so heartbeat cadence can be evaluated against ChatGPT limits. Track proactive notification rate and silence rate to tune intrusiveness from evidence.

## Implementation sequence

1. Complete all feasibility gates and document package/API decisions.
2. Establish package/build/typecheck/test setup, validated config, secure state paths, SQLite migrations, and redacted logging.
3. Build Codex auth/model selection and a minimal durable Flue agent.
4. Build owner-only Baileys ingress/outbound with deduplication and daily-session routing.
5. Add XQuik and Firecrawl read tools plus the voice skill; deliver a drafting-only vertical slice.
6. Add Zernio reads and exact local content/analytics records.
7. Implement authorization envelopes, Zernio mutations, idempotent reconciliation, and publication-status reporting.
8. Add workspace templates, generic workspace lifecycle tools, and the `stan` operations skill.
9. Add Supermemory profile, retrieval, explicit memory tools, daily transcript ingestion, and degraded-mode handling.
10. Add 00:01 rollover, anchored morning/heartbeat monitor, structured silent response, leases, catch-up, and WATCHLIST rotation.
11. Add declarative one-shot/cron automations and their management tools.
12. Finish CLI setup/auth/service/status/logs/doctor and native Windows/Ubuntu service installation.
13. Run end-to-end forced-restart and provider-failure scenarios, then enable proactive defaults.

Each feature should begin with the smallest public-seam test that demonstrates its essential outcome. Avoid mocks of application internals where a fake provider HTTP server, temporary SQLite database, fake clock, and gateway seam can assert observable behavior.

## Verification

### Automated checks

Add scripts for formatting/linting, typecheck, unit/integration tests, and production build. Use a fake clock fixed around Pakistan midnight and the overnight active window. Use temporary state roots so tests exercise real permissions/path/config behavior without touching the operator's credentials.

Prove at least:

- Unknown numbers, groups, and replayed message IDs cause no model call or reply.
- Owner messages are processed once across duplicate Baileys events and daemon restarts.
- A drafting request cannot invoke a public Zernio mutation.
- Heartbeats, automations, memory, watchlist entries, and fetched prompt injection cannot mint authorization.
- An explicitly authorized logical post creates at most one Zernio post across timeout, retry, and crash recovery.
- Stan reports scheduled/published/partial/failed/cancelled according to verified provider state.
- Zernio publishes an already scheduled item while Stan is offline.
- Daily routing changes at 00:01 Pakistan time and missed rollover repairs once on startup.
- The 09:00 occurrence always sends exactly one model-written morning message.
- Regular heartbeats can finish silently and send at most one message.
- The overnight active range is interpreted correctly; no heartbeat runs from 02:00 until 09:00.
- Daemon restart does not shift anchored cadence or burst-replay missed occurrences.
- Disabling heartbeats prevents model calls; re-enabling and editing start/end/interval updates the next occurrence durably.
- Editing `HEARTBEATS.md` changes the next heartbeat prompt without modifying immutable safety context.
- The generic workspace tools list and manage only workspace documents, rejecting traversal, symlinks, oversize writes, and stale exact replacements.
- WATCHLIST checks are bounded and rotated rather than all fetched every heartbeat.
- Cron expressions are validated; duplicate occurrences run once; automations cannot execute shell or public X writes.
- Supermemory outage does not block owner chat or authorized publishing; pending ingestion later reconciles once.
- Supermemory retrieval cannot override exact SQLite/provider facts.
- Logs and CLI output contain no API keys, OAuth tokens, WhatsApp credentials, webhook secrets, or authorization headers.

### Manual platform checks

On both a clean Windows machine and Ubuntu VPS:

1. Install and run `stan setup` from scratch.
2. Authenticate Codex by device code and select model/reasoning.
3. Authenticate WhatsApp by QR and pairing code, then reconnect after reboot.
4. Confirm unauthorized WhatsApp traffic remains silent.
5. Draft, post to a test account, schedule, restart Stan, and observe verified publication outcome.
6. Exercise a morning catch-up, a silent heartbeat, heartbeat disable/enable, and an owner-created cron.
7. Rotate each API credential without losing the others.
8. Run `stan doctor`, service restart, log following, and uninstall/disable autostart cleanly.

## Completion criteria

Stan is ready for initial real use when the feasibility gates pass; setup works on Windows and Ubuntu; one owner can converse through WhatsApp across daily sessions; drafting uses the voice skill; memory spans sessions through Supermemory and exact local state; the workspace and watchlist can be safely maintained; the morning and heartbeat behavior is durable, editable, and appropriately silent; exact automations survive restarts; public X mutations occur only from matching owner commands and are idempotent; provider outcomes are verified; and the full acceptance suite plus both platform smoke tests pass.

## Open questions

No product question currently blocks implementation. During the Zernio spike, confirm the connected test account's exact reply/thread/edit capabilities and platform constraints. During the Codex spike, confirm the current Pi/Flue credential adapter API. These findings may change boundary code but not the product architecture above.
