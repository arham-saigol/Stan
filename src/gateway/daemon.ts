#!/usr/bin/env node
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { open, readFile, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { configureStanEnvironment } from "../agents/stan.ts";
import { StanAgentRuntime } from "../agents/runtime.ts";
import { createFlueCodexProvider } from "../auth/codex.ts";
import { CredentialStore } from "../config/credentials.ts";
import { ConfigStore } from "../config/store.ts";
import { createLogger, redactForLogging } from "../logging.ts";
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
  try {
    const logger = await createLogger(
      paths.logs,
      process.env.LOG_LEVEL ?? "info",
    );
    const configStore = new ConfigStore(root);
    const config = configStore.read();
    const credentialStore = new CredentialStore(root);
    const credentials = credentialStore.read();
    const database = new ApplicationDatabase(paths.applicationDb);
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

    const delivery: DeliveryService = new DeliveryService({
      send: (text, messageId): Promise<{ messageId: string }> =>
        whatsapp.send(text, messageId),
    });
    const ingress: OwnerIngress = new OwnerIngress({
      database,
      ownerPhone: config.ownerPhone,
      dispatch: ({ sessionId, body, metadata }) =>
        agent.deliver(sessionId, {
          kind: "signal",
          type: "owner.message",
          body,
          attributes: {
            sourceMessageId: metadata.sourceMessageId,
            ...(metadata.authorizationEnvelopeId
              ? { authorizationEnvelopeId: metadata.authorizationEnvelopeId }
              : {}),
            ...(metadata.quotedText
              ? { quoted: metadata.quotedText.slice(0, 4000) }
              : {}),
          },
        }),
      send: (text, sourceMessageId) =>
        delivery.sendOwner(text, `owner-reply:${sourceMessageId}`),
    });
    const whatsapp: WhatsAppGateway = new WhatsAppGateway(
      database,
      ingress,
      config.ownerPhone,
      logger,
    );
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
        await reconcilePendingReplies(database, delivery);
        if (memory) await reconcilePendingMemory(database, memory);
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
      },
      async () => {
        await watchlist.check(3);
      },
    );
    scheduler.start();
    whatsapp.start();

    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      logger.info("Graceful shutdown started");
      whatsapp.quiesce();
      await scheduler.stop();
      await whatsapp.drain();
      await agent.stop();
      await whatsapp.stop();
      database.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await releaseLock();
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
    await releaseLock();
    throw error;
  }
}

async function acquireDaemonLock(root: string): Promise<() => Promise<void>> {
  const path = join(root, "daemon.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`);
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await handle.close();
        await unlink(path).catch(() => undefined);
      };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      const pid = Number.parseInt(
        await readFile(path, "utf8").catch(() => ""),
        10,
      );
      if (Number.isInteger(pid) && processIsAlive(pid)) {
        throw new Error(
          `Stan daemon is already starting or running as PID ${pid}`,
          { cause: error },
        );
      }
      const metadata = await stat(path).catch(() => undefined);
      if (metadata && Date.now() - metadata.mtimeMs < 30_000) {
        throw new Error("Stan daemon is already starting", { cause: error });
      }
      await unlink(path).catch(() => undefined);
    }
  }
  throw new Error("Could not acquire the Stan daemon lock");
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
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
