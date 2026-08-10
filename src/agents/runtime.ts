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

  async dispatch(
    conversationId: string,
    message: DeliveredMessage,
    idempotencyKey?: string,
  ): Promise<string> {
    if (!this.flue) throw new Error("Stan agent runtime is not started");
    const semantic =
      !idempotencyKey && this.semanticContext
        ? await this.semanticContext(message.body)
        : undefined;
    const enriched = semantic
      ? {
          ...message,
          body: `${message.body}\n\n<semantic-memory untrusted="true">\n${semantic}\n</semantic-memory>`,
        }
      : message;
    const handle = init(Stan, { id: conversationId });
    const receipt = await handle.dispatch({
      message: enriched,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    return receipt.submissionId;
  }

  async read(conversationId: string, submissionId: string): Promise<string> {
    if (!this.flue) throw new Error("Stan agent runtime is not started");
    this.active += 1;
    try {
      const reply = await init(Stan, { id: conversationId }).read(submissionId);
      return reply.text;
    } finally {
      this.active -= 1;
    }
  }

  async deliver(
    conversationId: string,
    message: DeliveredMessage,
  ): Promise<string> {
    const submissionId = await this.dispatch(conversationId, message);
    return this.read(conversationId, submissionId);
  }
}
