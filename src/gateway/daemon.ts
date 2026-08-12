#!/usr/bin/env node
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { lock } from "proper-lockfile";
import { configureStanEnvironment } from "../agents/stan.ts";
import { StanAgentRuntime } from "../agents/runtime.ts";
import { createFlueCodexProvider } from "../auth/codex.ts";
import { CredentialStore } from "../config/credentials.ts";
import { ConfigStore } from "../config/store.ts";
import {
  createLogger,
  redactForLogging,
  type ManagedLogger,
} from "../logging.ts";
import { SupermemoryProvider } from "../memory/supermemory.ts";
import { SemanticContextCache } from "../memory/context.ts";
import { reconcilePendingMemory } from "../memory/ingestion.ts";
import { FirecrawlProvider } from "../providers/firecrawl.ts";
import { XQuikProvider } from "../providers/xquik.ts";
import { ZernioProvider } from "../providers/zernio.ts";
import { ZernioWriteService } from "../providers/zernio-write-service.ts";
import { reconcileScheduledPublications } from "../providers/zernio-reconciliation.ts";
import { reconcilePendingXOperations } from "../providers/zernio-operation-reconciliation.ts";
import { AutomationStore } from "../scheduler/automations.ts";
import { repairDailyRollover } from "../scheduler/rollover-job.ts";
import { Scheduler } from "../scheduler/scheduler.ts";
import { WatchlistRotator } from "../scheduler/watchlist.ts";
import {
  initializeStateRoot,
  resolveStateRoot,
  statePaths,
  atomicWritePrivate,
} from "../state.ts";
import { ApplicationDatabase } from "../storage/application-db.ts";
import { WorkspaceStore } from "../workspace/store.ts";
import { loadPromptContext } from "../workspace/prompt-context.ts";
import { DeliveryService } from "./delivery.ts";
import { OwnerIngress, reconcilePendingReplies } from "./owner-ingress.ts";
import { WhatsAppGateway } from "./whatsapp.ts";

const CONTROL_PORT = 43127;

export async function runDaemon(root = resolveStateRoot()): Promise<void> {
  root = resolve(root);
  await initializeStateRoot(root);
  const paths = statePaths(root);
  const releaseLock = await acquireDaemonLock(paths.root);
  let startedDatabase: ApplicationDatabase | undefined;
  let startedLogger: ManagedLogger | undefined;
  let startedAgent: StanAgentRuntime | undefined;
  let startedWhatsApp: WhatsAppGateway | undefined;
  let startedScheduler: Scheduler | undefined;
  let startedServer: ServerType | undefined;
  try {
    const logger = await createLogger(
      paths.logs,
      process.env.LOG_LEVEL ?? "info",
    );
    startedLogger = logger;
    const configStore = new ConfigStore(root);
    const config = configStore.read();
    const credentialStore = new CredentialStore(root);
    const credentials = credentialStore.read();
    const database = new ApplicationDatabase(paths.applicationDb);
    startedDatabase = database;
    database.migrate();
    database.database.exec(
      "UPDATE inbound_messages SET state = 'unknown', error = 'Daemon restarted before delivery outcome was verified' WHERE state IN ('claimed', 'dispatched', 'reply_pending')",
    );
    const workspace = new WorkspaceStore(paths.workspace);
    await workspace.initialize();
    const automations = new AutomationStore(database);
    const xquik = credentials.xquikApiKey
      ? new XQuikProvider(credentials.xquikApiKey)
      : undefined;
    const firecrawl = new FirecrawlProvider(credentials.firecrawlApiKey);
    const zernio = credentials.zernioApiKey
      ? new ZernioProvider(credentials.zernioApiKey)
      : undefined;
    const zernioWrites = zernio
      ? new ZernioWriteService(database, zernio)
      : undefined;
    const memory = credentials.supermemoryApiKey
      ? new SupermemoryProvider(
          credentials.supermemoryApiKey,
          config.memoryContainerTag,
        )
      : undefined;
    configureStanEnvironment({
      database,
      config: configStore,
      workspace,
      automations,
      ...(xquik ? { xquik } : {}),
      firecrawl,
      ...(zernio ? { zernio } : {}),
      ...(zernioWrites ? { zernioWrites } : {}),
      ...(memory ? { memory } : {}),
      promptContext: (kind) =>
        loadPromptContext(paths.workspace, kind, database),
    });
    const codex = await createFlueCodexProvider(root);
    const semanticContext = new SemanticContextCache(memory);
    const agent = new StanAgentRuntime(paths.flueDb, codex, (query) =>
      semanticContext.forTask(query),
    );
    await agent.start();
    startedAgent = agent;

    const delivery: DeliveryService = new DeliveryService({
      send: (text, messageId): Promise<{ messageId: string }> =>
        whatsapp.send(text, messageId),
    });
    const ingress: OwnerIngress = new OwnerIngress({
      database,
      ownerPhone: config.ownerPhone,
      dispatch: ({ sessionId, body, idempotencyKey, metadata }) =>
        agent.dispatch(
          sessionId,
          {
            kind: "signal",
            type: "owner.message",
            body,
            attributes: {
              sourceMessageId: metadata.sourceMessageId,
              ...(metadata.quotedText ? { quoted: metadata.quotedText } : {}),
            },
          },
          idempotencyKey,
        ),
      read: (sessionId, submissionId) => agent.read(sessionId, submissionId),
      send: (text, sourceMessageId) =>
        delivery.sendOwner(text, `owner-reply:${sourceMessageId}`),
    });
    const whatsapp = new WhatsAppGateway(
      database,
      ingress,
      config.ownerPhone,
      logger,
    );
    startedWhatsApp = whatsapp;
    await repairDailyRollover(database, memory, logger);
    const watchlist = new WatchlistRotator(database, workspace, xquik);
    const scheduler = new Scheduler(
      database,
      configStore,
      agent,
      delivery,
      automations,
      logger,
      async (now) => {
        await repairDailyRollover(database, memory, logger, now);
        if (memory) await reconcilePendingMemory(database, memory);
        if (whatsapp.status() === "open") {
          await ingress.reconcilePending();
          await reconcilePendingReplies(database, delivery);
          if (zernio) {
            await reconcilePendingXOperations(
              database,
              zernio,
              delivery,
              new Date(now.epochMilliseconds),
            );
            await reconcileScheduledPublications(
              database,
              zernio,
              delivery,
              new Date(now.epochMilliseconds),
            );
          }
        }
      },
      async () => {
        await watchlist.check(3);
      },
      () => whatsapp.status() === "open",
    );
    startedScheduler = scheduler;
    scheduler.start();
    whatsapp.start();

    let stopping = false;
    let shutdownPromise: Promise<void> | undefined;
    const shutdown = () => {
      if (shutdownPromise) return shutdownPromise;
      stopping = true;
      shutdownPromise = (async () => {
        logger.info("Graceful shutdown started");
        whatsapp.quiesce();
        await scheduler.stop();
        await whatsapp.drain();
        await agent.stop();
        await whatsapp.stop();
        database.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await releaseLock();
        await logger.close();
      })();
      return shutdownPromise;
    };
    const app = controlApp(
      credentials.controlToken,
      () => ({
        status: stopping ? "stopping" : "running",
        pid: process.pid,
        uptimeSeconds: Math.floor(process.uptime()),
        whatsapp: whatsapp.status(),
        agentBusy: agent.isBusy(),
      }),
      () => void shutdown().then(() => process.exit(0)),
    );
    const server: ServerType = serve({
      fetch: app.fetch,
      hostname: "127.0.0.1",
      port: CONTROL_PORT,
    });
    startedServer = server;
    await atomicWritePrivate(
      paths.service,
      `${JSON.stringify({ pid: process.pid, port: CONTROL_PORT, startedAt: new Date().toISOString() }, null, 2)}\n`,
    );
    logger.info(
      { port: CONTROL_PORT, pid: process.pid },
      "Stan daemon started",
    );
    process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
    process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
  } catch (error) {
    startedWhatsApp?.quiesce();
    await startedScheduler?.stop().catch(() => undefined);
    await startedWhatsApp?.drain().catch(() => undefined);
    await startedAgent?.stop().catch(() => undefined);
    await startedWhatsApp?.stop().catch(() => undefined);
    if (startedServer)
      await new Promise<void>((resolvePromise) =>
        startedServer!.close(() => resolvePromise()),
      ).catch(() => undefined);
    try {
      startedDatabase?.close();
    } catch {
      // Preserve the startup failure that caused cleanup.
    }
    await releaseLock();
    await startedLogger?.close().catch(() => undefined);
    throw error;
  }
}

async function acquireDaemonLock(root: string): Promise<() => Promise<void>> {
  const path = join(root, "daemon.lock");
  try {
    return await lock(root, {
      lockfilePath: path,
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries: 0,
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ELOCKED") {
      throw new Error("Stan daemon is already starting or running", {
        cause: error,
      });
    }
    throw error;
  }
}

function controlApp(
  token: string,
  status: () => object,
  stop: () => void,
): Hono {
  const app = new Hono();
  app.use("*", async (context, next) => {
    if (context.req.header("authorization") !== `Bearer ${token}`)
      return context.json({ error: "unauthorized" }, 401);
    return next();
  });
  app.get("/health", (context) => context.json({ ok: true }));
  app.get("/status", (context) => context.json(status()));
  app.post("/stop", (context) => {
    setTimeout(stop, 10).unref();
    return context.json({ stopping: true }, 202);
  });
  return app;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const rootIndex = process.argv.indexOf("--state-root");
  const root = rootIndex >= 0 ? process.argv[rootIndex + 1] : undefined;
  runDaemon(root).catch((error: unknown) => {
    console.error(
      redactForLogging(
        error instanceof Error ? error.message : "Stan daemon failed",
      ),
    );
    process.exitCode = 1;
  });
}
