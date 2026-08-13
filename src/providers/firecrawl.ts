import { Firecrawl } from "firecrawl";
import { assertPublicHttpUrl } from "./network-safety.ts";

export class FirecrawlProvider {
  private readonly client: Firecrawl;

  constructor(apiKey?: string) {
    this.client = new Firecrawl(apiKey ? { apiKey } : undefined);
  }

  async search(
    input: { query: string; limit?: number | undefined },
    signal?: AbortSignal,
  ): Promise<unknown> {
    const query = bounded(input.query, 500);
    const data = await abortable(
      this.client.search(query, { limit: clamp(input.limit ?? 5, 1, 10) }),
      signal,
    );
    return {
      source: "firecrawl.search",
      untrusted: true,
      data: boundOutput(data, 40_000),
    };
  }

  async fetch(url: string, signal?: AbortSignal): Promise<unknown> {
    const safe = await assertPublicHttpUrl(url);
    const data = await abortable(
      this.client.scrape(safe.toString(), { formats: ["markdown"] }),
      signal,
    );
    const markdown =
      typeof data.markdown === "string" ? data.markdown.slice(0, 50_000) : "";
    return {
      source: safe.toString(),
      untrusted: true,
      title: data.metadata?.title,
      markdown,
      truncated:
        typeof data.markdown === "string" &&
        data.markdown.length > markdown.length,
    };
  }
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError(signal));
    signal.addEventListener("abort", abort, { once: true });
    void promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Aborted", "AbortError");
}

function bounded(value: string, maximum: number): string {
  const result = value.trim();
  if (!result || result.length > maximum)
    throw new Error(`Input must contain 1-${maximum} characters`);
  return result;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function boundOutput(value: unknown, maximum: number): unknown {
  const serialized = JSON.stringify(value);
  return serialized.length <= maximum
    ? value
    : { truncated: true, json: serialized.slice(0, maximum) };
}
