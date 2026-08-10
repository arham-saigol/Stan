#!/usr/bin/env node
import { Command, Option } from "commander";
import { resolve } from "node:path";
import { authCommand } from "./commands/auth.ts";
import { apisAuthCommand } from "./commands/apis-auth.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { logsCommand } from "./commands/logs.ts";
import {
  getDaemonStatus,
  installAutostart,
  startService,
  stopService,
} from "./commands/service.ts";
import { setupCommand } from "./commands/setup.ts";
import { statusCommand } from "./commands/status.ts";
import { authenticateWhatsApp } from "./commands/whatsapp-auth.ts";
import { ConfigStore } from "../config/store.ts";
import { initializeStateRoot, resolveStateRoot, statePaths } from "../state.ts";
import { ApplicationDatabase } from "../storage/application-db.ts";
import { redactForLogging } from "../logging.ts";

const program = new Command();
program
  .name("stan")
  .description("Private WhatsApp X agent")
  .version("0.1.0")
  .option("--state-root <path>", "override the platform state directory");

const root = () => {
  const configured = program.opts<{ stateRoot?: string }>().stateRoot;
  return configured ? resolve(configured) : resolveStateRoot();
};
const action =
  <T extends unknown[]>(handler: (...arguments_: T) => Promise<void>) =>
  async (...arguments_: T) => {
    try {
      await handler(...arguments_);
    } catch (error) {
      console.error(
        redactForLogging(
          error instanceof Error ? error.message : "Stan command failed",
        ),
      );
      process.exitCode = 1;
    }
  };

program
  .command("setup")
  .description("run resumable interactive setup")
  .action(action(async () => setupCommand(root())));
program
  .command("auth")
  .description("authenticate OpenAI Codex and select model/thinking")
  .action(action(async () => authCommand(root())));
program
  .command("start")
  .description("idempotently start the daemon")
  .action(
    action(async () => {
      console.log(await startService(root()));
    }),
  );
program
  .command("stop")
  .description("gracefully stop the daemon")
  .action(
    action(async () => {
      console.log(
        (await stopService(root())) ? "Stopped." : "Already stopped.",
      );
    }),
  );
program
  .command("restart")
  .description("gracefully restart the daemon")
  .action(
    action(async () => {
      await stopService(root());
      console.log(await startService(root()));
    }),
  );
program
  .command("status")
  .description("show service and provider state without secrets")
  .action(action(async () => statusCommand(root())));
program
  .command("logs")
  .description("read redacted rolling logs")
  .option("-f, --follow", "follow new records", false)
  .option("-n, --lines <count>", "number of lines", "100")
  .addOption(
    new Option("--level <level>").choices([
      "trace",
      "debug",
      "info",
      "warn",
      "error",
      "fatal",
    ]),
  )
  .action(
    action(
      async (options: { follow: boolean; lines: string; level?: string }) =>
        logsCommand(root(), {
          follow: options.follow,
          lines: Math.max(
            1,
            Math.min(10_000, Number.parseInt(options.lines, 10) || 100),
          ),
          ...(options.level ? { level: options.level } : {}),
        }),
    ),
  );
program
  .command("doctor")
  .description("run non-mutating health checks")
  .action(action(async () => doctorCommand(root())));

const whatsapp = program
  .command("whatsapp")
  .description("manage the WhatsApp connection");
whatsapp
  .command("auth")
  .description(
    "authenticate in a temporary store and atomically replace credentials",
  )
  .addOption(new Option("--method <method>").choices(["qr", "pairing"]))
  .action(
    action(async (options: { method?: "qr" | "pairing" }) => {
      const stateRoot = root();
      await initializeStateRoot(stateRoot);
      const daemonWasRunning = Boolean(await getDaemonStatus(stateRoot));
      if (daemonWasRunning) await stopService(stateRoot);
      let database: ApplicationDatabase | undefined;
      try {
        database = new ApplicationDatabase(statePaths(stateRoot).applicationDb);
        database.migrate();
        await authenticateWhatsApp(
          database,
          new ConfigStore(stateRoot).read(),
          options.method,
        );
      } finally {
        database?.close();
        if (daemonWasRunning) await startService(stateRoot);
      }
    }),
  );

const apis = program
  .command("apis")
  .description("manage provider API credentials");
apis
  .command("auth")
  .description(
    "add or rotate XQuik, Zernio, Firecrawl, and Supermemory credentials",
  )
  .action(action(async () => apisAuthCommand(root())));

const service = program
  .command("service")
  .description("manage native autostart");
service
  .command("install")
  .description("install a systemd user service or Windows scheduled task")
  .action(action(async () => installAutostart(root())));

await program.parseAsync();
