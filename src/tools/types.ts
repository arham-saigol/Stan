import type { ConfigStore } from "../config/store.ts";
import type { ApplicationDatabase } from "../storage/application-db.ts";
import type { AutomationStore } from "../scheduler/automations.ts";
import type { SupermemoryProvider } from "../memory/supermemory.ts";
import type { FirecrawlProvider } from "../providers/firecrawl.ts";
import type { XQuikProvider } from "../providers/xquik.ts";
import type { ZernioProvider } from "../providers/zernio.ts";
import type { ZernioWriteService } from "../providers/zernio-write-service.ts";
import type { WorkspaceStore } from "../workspace/store.ts";

export interface ToolEnvironment {
  database: ApplicationDatabase;
  config: ConfigStore;
  workspace: WorkspaceStore;
  automations: AutomationStore;
  xquik?: XQuikProvider;
  firecrawl?: FirecrawlProvider;
  zernio?: ZernioProvider;
  zernioWrites?: ZernioWriteService;
  memory?: SupermemoryProvider;
  promptContext(kind: TrustedDeliveryContext["kind"]): string;
}

export interface TrustedDeliveryContext {
  kind: "owner" | "heartbeat" | "automation" | "other";
  sourceMessageId?: string;
  authorizationEnvelopeId?: string;
  occurrenceId?: string;
  isMorning?: boolean;
}
