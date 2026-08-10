# Feasibility gates and package decisions

The owner explicitly overrode the plan's stop-before-product rule on 2026-08-10 so implementation could proceed without live Zernio, Supermemory, or WhatsApp credentials. The checks below remain release gates; an unchecked gate is not evidence of provider success.

## Pinned API decisions

| Boundary    |                                     Pinned package | Implemented contract                                                                                                      |
| ----------- | -------------------------------------------------: | ------------------------------------------------------------------------------------------------------------------------- |
| Flue        |               `@flue/runtime` / `@flue/vite` 2.0.3 | Node target, file SQLite, standalone `start`/`init`, signal deliveries, durable tools                                     |
| Pi          | `@earendil-works/pi-coding-agent` / `pi-ai` 0.84.1 | Stan-owned `ModelRuntime` auth path, OpenAI Codex device flow, provider catalog, metadata-derived thinking levels         |
| WhatsApp    |               `@whiskeysockets/baileys` 7.0.0-rc14 | ESM, SQLite `AuthenticationState`, PN/LID mappings, notify-only ingress, restart reconnect                                |
| Zernio      |                             `@zernio/node` 0.2.540 | `createPost` with `x-request-id`, Twitter `replyToTweetId`, schedules, `editPost`, delete/unpublish, status and analytics |
| XQuik       |                          `x-twitter-scraper` 0.8.0 | Public tweet/profile/thread/reply/timeline reads only                                                                     |
| Firecrawl   |                                 `firecrawl` 4.32.0 | Search and one-page Markdown scrape only                                                                                  |
| Supermemory |                               `supermemory` 4.25.4 | Stable `customId`, container-scoped add/profile/hybrid search/list/get/delete                                             |

Flue 2.0.3 resolves pi-ai 0.83 internally while the installed Pi SDK is 0.84.1. Stan wraps Pi's provider auth and passes the structurally compatible provider into Flue. A local boot check successfully registered `openai-codex` and started/stopped file-backed Flue; the live tool call and refresh checks below still decide whether this is acceptable.

Zernio's installed types document a roughly five-minute `x-request-id` create-idempotency window plus 24-hour content deduplication. X replies are represented through `TwitterPlatformData.replyToTweetId`; the provider warns that X may reject replies outside the connected account's permitted conversation. Published X edits use `editPost` and remain subject to X Premium, time, count, and text-only limits.

## Live gate record

- [ ] **Codex:** run `stan auth`, complete device login, select only a returned model/thinking level, make a Stan tool call, restart the process, and verify refresh with `stan doctor`.
- [ ] **Flue recovery:** force-kill during a model/tool run, restart, and inspect durable settlement plus the single logical provider operation/request ID.
- [ ] **Baileys Windows:** complete QR and pairing-code auth, reconnect, observe PN/LID binding, and test ordinary plus `restartRequired` reconnects.
- [ ] **Baileys Ubuntu:** repeat the Windows checks on the target VPS.
- [ ] **Zernio test account:** verify draft, immediate post, reply, schedule while Stan is offline, cancellation, status, analytics, edit/delete support, and same-request retry behavior.
- [ ] **Supermemory:** add and update one stable `customId`, wait for processing, retrieve profile and hybrid results, then delete the document/container test data.

Record dates, account constraints, provider IDs (never credentials), terminal statuses, and relevant SDK response shapes beneath each item when run. Do not mark an external action successful from a model statement; use the provider response/status lookup.
