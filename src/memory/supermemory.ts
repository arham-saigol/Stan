import Supermemory from "supermemory";

export class SupermemoryProvider {
  private readonly client: Supermemory;

  constructor(
    apiKey: string,
    private readonly containerTag: string,
    baseURL?: string,
  ) {
    this.client = new Supermemory({ apiKey, ...(baseURL ? { baseURL } : {}) });
  }

  async remember(
    content: string,
    customId = `stan-memory-${crypto.randomUUID()}`,
    metadata: Record<string, string | number | boolean> = {},
  ): Promise<{ id: string; status: string }> {
    return this.client.add({
      content: bounded(content, 20_000),
      customId,
      containerTag: this.containerTag,
      metadata: { source: "stan-explicit", ...metadata },
    });
  }

  async ingestSession(input: {
    localDate: string;
    conversationId: string;
    transcript: string;
    complete: boolean;
  }): Promise<{ id: string; status: string }> {
    const transcript = input.transcript.trim();
    return this.client.add({
      content: truncated(transcript, 200_000),
      customId: `stan-session-${input.localDate}`,
      containerTag: this.containerTag,
      metadata: {
        source: "stan-session",
        date: input.localDate,
        conversationId: input.conversationId,
        complete: input.complete && transcript.length <= 200_000,
      },
    });
  }

  async recall(query: string, limit = 5): Promise<unknown> {
    return this.client.search({
      q: bounded(query, 1000),
      containerTag: this.containerTag,
      searchMode: "hybrid",
      limit: clamp(limit, 1, 10),
      threshold: 0.5,
    });
  }

  async profile(query?: string): Promise<unknown> {
    return this.client.profile({
      containerTag: this.containerTag,
      ...(query ? { q: bounded(query, 1000), threshold: 0.5 } : {}),
    });
  }

  async listRecent(limit = 10): Promise<unknown> {
    return this.client.documents.list({
      containerTags: [this.containerTag],
      limit: clamp(limit, 1, 25),
      page: 1,
      sort: "createdAt",
      order: "desc",
    });
  }

  async forgetDocument(id: string, missingIsSuccess = false): Promise<void> {
    const documentId = bounded(id, 200);
    let document;
    try {
      document = await this.client.documents.get(documentId);
    } catch (error) {
      if (missingIsSuccess && isNotFound(error)) return;
      throw error;
    }
    if (!document.containerTags?.includes(this.containerTag)) {
      throw new Error(
        "The memory document is outside Stan's private container",
      );
    }
    await this.client.documents.delete(documentId);
  }

  async status(id: string): Promise<unknown> {
    return this.client.documents.get(bounded(id, 200));
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "status" in error &&
    error.status === 404,
  );
}

function bounded(value: string, maximum: number): string {
  const result = value.trim();
  if (!result || result.length > maximum)
    throw new Error(`Input must contain 1-${maximum} characters`);
  return result;
}

function truncated(value: string, maximum: number): string {
  const result = value.trim();
  if (!result) throw new Error(`Input must contain 1-${maximum} characters`);
  return result.length <= maximum ? result : result.slice(-maximum);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}
