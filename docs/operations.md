# Operations

Use `stan status` for the live localhost control result and `stan doctor` for non-destructive state/provider checks. `stan stop` closes ingress and scheduling before waiting for Flue to drain at a safe boundary.

The default heartbeat is anchored at 09:00 Asia/Karachi and runs at 09:00, 12:00, 15:00, 18:00, 21:00, and 00:00. The 00:00 run belongs to the ending daily session; routing switches at 00:01. Startup may catch up only the morning occurrence within its configured grace period. Exact one-shot and cron jobs are application records, never shell commands.

Linux autostart uses a systemd user service with `Restart=on-failure`. Enable user lingering manually if it must start before login. Windows uses a Task Scheduler XML definition with logon startup and restart-on-failure. Service health comes from the control endpoint, not a PID file.

Provider content can leave the machine through Codex, Supermemory, XQuik, Zernio, and Firecrawl according to the configured operation. Rotate API credentials with `stan apis auth`; blank input preserves each existing key. Rebind WhatsApp through a temporary database with `stan whatsapp auth`.
