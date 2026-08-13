export interface BoundedContextSection {
  name: string;
  content: string;
  truncated: boolean;
}

export function boundContextSection(
  name: string,
  content: string,
  maximumCharacters: number,
): BoundedContextSection {
  if (content.length <= maximumCharacters)
    return { name, content, truncated: false };
  return {
    name,
    content: `${content.slice(0, maximumCharacters)}\n\n[truncated by Stan at ${maximumCharacters} characters]`,
    truncated: true,
  };
}

export function renderContextPacket(sections: BoundedContextSection[]): string {
  return sections
    .map((section) => `## ${section.name}\n\n${section.content}`)
    .join("\n\n");
}

export interface SemanticMemoryClient {
  profile(query?: string): Promise<unknown>;
}

export class SemanticContextCache {
  private cachedProfile: { value: unknown; expiresAt: number } | undefined;

  constructor(private readonly memory: SemanticMemoryClient | undefined) {}

  async forTask(query: string): Promise<string> {
    if (!this.memory)
      return "[Supermemory unavailable: continue with exact local context]";
    try {
      const now = Date.now();
      if (!this.cachedProfile || this.cachedProfile.expiresAt <= now) {
        this.cachedProfile = {
          value: await this.memory.profile(),
          expiresAt: now + 10 * 60_000,
        };
      }
      const relevant = await this.memory.profile(query.slice(0, 1000));
      const serialized = JSON.stringify({
        compactProfile: this.cachedProfile.value,
        relevant,
      });
      return serialized.length <= 10_000
        ? serialized
        : `${serialized.slice(0, 10_000)}\n[semantic context truncated]`;
    } catch {
      return "[Supermemory unavailable: continue with exact local context]";
    }
  }
}
