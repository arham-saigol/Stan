import XTwitterScraper from "x-twitter-scraper";

export class XQuikProvider {
  private readonly client: XTwitterScraper;

  constructor(apiKey: string) {
    this.client = new XTwitterScraper({
      apiKey,
      timeout: 30_000,
      maxRetries: 2,
    });
  }

  async health(): Promise<unknown> {
    const [account, balance] = await Promise.all([
      this.client.account.retrieve(),
      this.client.credits.retrieveBalance(),
    ]);
    return { account, balance };
  }

  async searchPosts(input: {
    query: string;
    limit?: number | undefined;
    cursor?: string | undefined;
  }): Promise<unknown> {
    const page = await this.client.x.tweets.search({
      q: boundedText(input.query, 500),
      limit: clamp(input.limit ?? 10, 1, 25),
      ...(input.cursor ? { cursor: boundedText(input.cursor, 2000) } : {}),
    });
    return untrusted("xquik.search", page);
  }

  async getPost(postId: string): Promise<unknown> {
    return untrusted(
      "xquik.post",
      await this.client.x.tweets.retrieve(boundedText(postId, 200)),
    );
  }

  async getThread(input: {
    postId: string;
    limit?: number | undefined;
    cursor?: string | undefined;
  }): Promise<unknown> {
    const page = await this.client.x.tweets.getThread(
      boundedText(input.postId, 200),
      {
        pageSize: clamp(input.limit ?? 20, 1, 25),
        ...(input.cursor ? { cursor: boundedText(input.cursor, 2000) } : {}),
      },
    );
    return untrusted("xquik.thread", page);
  }

  async getReplies(input: {
    postId: string;
    limit?: number | undefined;
    cursor?: string | undefined;
  }): Promise<unknown> {
    const page = await this.client.x.tweets.getReplies(
      boundedText(input.postId, 200),
      {
        pageSize: clamp(input.limit ?? 20, 1, 25),
        ...(input.cursor ? { cursor: boundedText(input.cursor, 2000) } : {}),
      },
    );
    return untrusted("xquik.replies", page);
  }

  async getProfile(idOrUsername: string): Promise<unknown> {
    return untrusted(
      "xquik.profile",
      await this.client.x.users.retrieve(boundedText(idOrUsername, 100)),
    );
  }

  async getUserPosts(input: {
    idOrUsername: string;
    limit?: number | undefined;
    cursor?: string | undefined;
  }): Promise<unknown> {
    const page = await this.client.x.users.retrieveTweets(
      boundedText(input.idOrUsername, 100),
      {
        pageSize: clamp(input.limit ?? 10, 1, 25),
        ...(input.cursor ? { cursor: boundedText(input.cursor, 2000) } : {}),
      },
    );
    return untrusted("xquik.user-posts", page);
  }
}

function untrusted(source: string, data: unknown): unknown {
  const serialized = JSON.stringify(data) ?? "null";
  return {
    source,
    untrusted: true,
    data:
      serialized.length <= 80_000
        ? data
        : { truncated: true, json: serialized.slice(0, 80_000) },
  };
}

function boundedText(value: string, max: number): string {
  const text = value.trim();
  if (!text || text.length > max)
    throw new Error(`Input must contain 1-${max} characters`);
  return text;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}
