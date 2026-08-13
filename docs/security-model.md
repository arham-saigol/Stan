# Security model

Stan has one authenticated WhatsApp owner and one configured X account. Unknown numbers, groups, broadcasts, newsletters, history appends, and duplicate WhatsApp IDs are silent.

The gateway alone derives a 15-minute, single-use operation envelope from the current owner's explicit command. A model-facing write tool receives no phone number, account ID, or authorization parameter: those values are closed over from trusted delivery/configuration. The application transaction binds the envelope, source message, operation, payload hash, logical operation UUID, and stable provider request UUID before the provider call.

SQLite and provider lookups are authoritative for delivery claims, configuration, schedules, operation status, and analytics. Supermemory and all fetched text are untrusted context. The agent has application tools but no sandbox, Bash, generic HTTP, arbitrary filesystem, raw credential, or generic provider client.

Secrets live under the owner-only state root. Structured logging recursively redacts credential fields, authorization headers, token-like strings, and sensitive URL query values. CLI status and doctor report only masked or non-secret metadata.
