import { DatabaseSync } from "node:sqlite";
import { ConfigStore } from "../../config/store.ts";
import { CredentialStore } from "../../config/credentials.ts";
import { statePaths } from "../../state.ts";
import { getDaemonStatus } from "./service.ts";

export async function statusCommand(root: string): Promise<void> {
  const processStatus = await getDaemonStatus(root);
  const config = new ConfigStore(root).read();
  const credentials = new CredentialStore(root).tryRead();
  const database = new DatabaseSync(statePaths(root).applicationDb, {
    readOnly: true,
  });
  try {
    const session = database
      .prepare(
        "SELECT conversation_id FROM daily_sessions WHERE state = 'active' LIMIT 1",
      )
      .get() as { conversation_id: string } | undefined;
    const nextAutomation = database
      .prepare(
        "SELECT MIN(next_run_at) AS next FROM automations WHERE enabled = 1",
      )
      .get() as { next: string | null };
    const lastOwner = database
      .prepare(
        "SELECT received_at FROM inbound_messages WHERE state = 'delivered' ORDER BY received_at DESC LIMIT 1",
      )
      .get() as { received_at: string } | undefined;
    const lastHeartbeat = database
      .prepare(
        "SELECT updated_at FROM heartbeat_occurrences WHERE status IN ('notified', 'silent') ORDER BY updated_at DESC LIMIT 1",
      )
      .get() as { updated_at: string } | undefined;
    const attentionRequired = (
      database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM inbound_messages WHERE state = 'unknown') +
             (SELECT COUNT(*) FROM heartbeat_occurrences WHERE status = 'failed' AND attempts >= 3) +
             (SELECT COUNT(*) FROM automation_runs WHERE status IN ('unknown', 'notification_pending')) +
             (SELECT COUNT(*) FROM memory_documents WHERE status = 'failed') +
             (SELECT COUNT(*) FROM x_operations x WHERE status = 'publishing' AND next_retry_at IS NULL
                AND NOT EXISTS (SELECT 1 FROM scheduled_publications s WHERE s.logical_operation_id = x.logical_id))
           AS count`,
        )
        .get() as { count: number }
    ).count;
    console.log({
      process: processStatus ?? "stopped",
      activeSession: session?.conversation_id ?? "not created",
      model: `${config.model.provider}/${config.model.id}`,
      thinkingLevel: config.model.thinkingLevel,
      whatsapp: processStatus?.whatsapp ?? "offline",
      memory: credentials?.supermemoryApiKey ? "configured" : "degraded",
      database: "ok",
      selectedXAccount: config.selectedXAccountId ?? "not configured",
      nextAutomation: nextAutomation.next,
      lastOwnerTurn: lastOwner?.received_at,
      lastHeartbeat: lastHeartbeat?.updated_at,
      attentionRequired,
    });
  } finally {
    database.close();
  }
}
