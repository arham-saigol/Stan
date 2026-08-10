import { init, type DeliveredMessage } from "@flue/runtime";
import { sqlite, start } from "@flue/runtime/node";
import type { Provider } from "@earendil-works/pi-ai";
import { Stan } from "./stan.ts";

export class StanAgentRuntime {
  private flue: Awaited<ReturnType<typeof start>> | undefined;
  private active = 0;

  constructor(
    private readonly databasePath: string,
    private readonly provider: Provider,
    private readonly semanticContext?: (query: string) => Promise<string>,
  ) {}

  async start(): Promise<void> {
    if (this.flue) return;
    this.flue = await start({
      agents: [Stan],
      db: sqlite(this.databasePath),
      providers: [this.provider as never],
    });
  }

  async stop(): Promise<void> {
    const current = this.flue;
    this.flue = undefined;
    if (current) await current.stop();
  }

  isBusy(): boolean {
    return this.active > 0;
  }

  async deliver(
    conversationId: string,
    message: DeliveredMessage,
  ): Promise<string> {
    if (!this.flue) throw new Error("Stan agent runtime is not started");
    this.active += 1;
    try {
      const semantic = this.semanticContext
        ? await this.semanticContext(message.body)
        : undefined;
      const enriched = semantic
        ? {
            ...message,
            body: `${message.body}\n\n<semantic-memory untrusted="true">\n${semantic}\n</semantic-memory>`,
          }
        : message;
      const handle = init(Stan, { id: conversationId });
      const receipt = await handle.dispatch({ message: enriched });
      const reply = await handle.read(receipt);
      return reply.text;
    } finally {
      this.active -= 1;
    }
  }
}
