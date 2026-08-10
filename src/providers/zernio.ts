import { Zernio, type Post, type SocialAccount } from "@zernio/node";
import type {
  ProviderMutationResult,
  ZernioMutationProvider,
  ZernioMutationRequest,
} from "./zernio-write-service.ts";

export interface ConnectedXAccount {
  id: string | undefined;
  platform: string | undefined;
  username: string | undefined;
  displayName: string | undefined;
  connected: boolean;
}

export class ZernioProvider implements ZernioMutationProvider {
  private readonly client: Zernio;

  constructor(apiKey: string) {
    this.client = new Zernio({ apiKey, timeout: 60_000 });
  }

  async verifyPostAccount(postId: string, accountId: string): Promise<boolean> {
    const post = await this.getPost(postId);
    return this.postBelongsToAccount(post, accountId);
  }

  async mutate(input: {
    requestId: string;
    accountId: string;
    request: ZernioMutationRequest;
  }): Promise<ProviderMutationResult> {
    const request = input.request;
    if (
      request.operation === "draft" ||
      request.operation === "publish" ||
      request.operation === "schedule" ||
      request.operation === "reply"
    ) {
      const body = createBody(input.accountId, request);
      const { data } = await this.client.posts.createPost({
        body,
        headers: { "x-request-id": input.requestId },
      });
      return mapPost(data.post);
    }
    if (request.operation === "edit") {
      const { data } = await this.client.posts.editPost({
        path: { postId: request.providerPostId },
        body: { platform: "twitter", content: request.content },
      });
      return {
        status: data.success ? "published" : "failed",
        providerId: request.providerPostId,
        ...(data.id ? { publicId: data.id } : {}),
        ...(data.url ? { publicUrl: data.url } : {}),
        ...(!data.success && data.message ? { error: data.message } : {}),
      };
    }
    if (request.operation === "cancel") {
      await this.client.posts.deletePost({
        path: { postId: request.providerPostId },
      });
      return { status: "cancelled", providerId: request.providerPostId };
    }
    const current = await this.getPost(request.providerPostId);
    if (current.status === "published" || current.status === "partial") {
      const { data } = await this.client.posts.unpublishPost({
        path: { postId: request.providerPostId },
        body: { platform: "twitter" },
      });
      return {
        status: data.success ? "cancelled" : "failed",
        providerId: request.providerPostId,
        ...(!data.success && data.message ? { error: data.message } : {}),
      };
    }
    await this.client.posts.deletePost({
      path: { postId: request.providerPostId },
    });
    return { status: "cancelled", providerId: request.providerPostId };
  }

  async getBoundAccount(accountId: string): Promise<ConnectedXAccount> {
    const account = (await this.listAccounts()).find(
      (candidate) => candidate.id === accountId,
    );
    if (!account) throw new Error("The configured X account is not connected");
    return account;
  }

  async listAccounts(): Promise<ConnectedXAccount[]> {
    const { data } = await this.client.accounts.listAccounts({
      query: { platform: "twitter", status: "connected" },
    });
    return data.accounts.map((account: SocialAccount) => ({
      id: account._id,
      platform: account.platform,
      username: account.username,
      displayName: account.displayName,
      connected: account.isActive && !account.needsReconnection,
    }));
  }

  async listPosts(accountId: string, limit = 10): Promise<unknown> {
    const { data } = await this.client.posts.listPosts({
      query: {
        accountId,
        limit: clamp(limit, 1, 25),
        page: 1,
        sortBy: "created-desc",
      },
    });
    return data.posts ?? [];
  }

  async getPostForAccount(postId: string, accountId: string): Promise<Post> {
    const post = await this.getPost(postId);
    if (!this.postBelongsToAccount(post, accountId)) {
      throw new Error(
        "The target post does not belong to the configured X account",
      );
    }
    return post;
  }

  async getPost(postId: string): Promise<Post> {
    const { data } = await this.client.posts.getPost({ path: { postId } });
    if (!data.post) throw new Error("Zernio returned no post");
    return data.post;
  }

  async analyticsForAccount(
    postId: string,
    accountId: string,
  ): Promise<unknown> {
    await this.getPostForAccount(postId, accountId);
    const { data } = await this.client.analytics.getAnalytics({
      query: { postId },
    });
    return data;
  }

  private postBelongsToAccount(post: Post, accountId: string): boolean {
    return Boolean(
      post.platforms?.some((target) => {
        const targetAccount =
          typeof target.accountId === "string"
            ? target.accountId
            : target.accountId?._id;
        return target.platform === "twitter" && targetAccount === accountId;
      }),
    );
  }
}

function createBody(
  accountId: string,
  request:
    | Extract<ZernioMutationRequest, { content: string }>
    | Extract<ZernioMutationRequest, { operation: "reply" }>,
) {
  const platform = {
    platform: "twitter",
    accountId,
    ...(request.operation === "reply"
      ? { platformSpecificData: { replyToTweetId: request.replyToPostId } }
      : {}),
  };
  if (request.operation === "draft") {
    return {
      content: request.content,
      platforms: [platform],
      isDraft: true,
      timezone: "Asia/Karachi",
    };
  }
  if (request.operation === "schedule") {
    return {
      content: request.content,
      platforms: [platform],
      scheduledFor: request.scheduledFor,
      timezone: "Asia/Karachi",
    };
  }
  return {
    content: request.content,
    platforms: [platform],
    publishNow: true,
    timezone: "Asia/Karachi",
  };
}

function mapPost(post: Post | undefined): ProviderMutationResult {
  if (!post)
    return { status: "failed", error: "Zernio returned no post record" };
  const target = post.platforms?.find(
    (platform) => platform.platform === "twitter",
  );
  const status = normalizeStatus(post.status, target?.status);
  return {
    status,
    ...(post._id ? { providerId: post._id } : {}),
    ...(target?.platformPostId ? { publicId: target.platformPostId } : {}),
    ...(target?.platformPostUrl ? { publicUrl: target.platformPostUrl } : {}),
    ...(post.scheduledFor ? { scheduledFor: post.scheduledFor } : {}),
    ...(target?.errorMessage ? { error: target.errorMessage } : {}),
  };
}

function normalizeStatus(
  postStatus: Post["status"],
  platformStatus: string | undefined,
): ProviderMutationResult["status"] {
  if (platformStatus === "failed" && postStatus === "published")
    return "partial";
  if (
    postStatus === "draft" ||
    postStatus === "scheduled" ||
    postStatus === "publishing" ||
    postStatus === "published" ||
    postStatus === "failed" ||
    postStatus === "partial"
  ) {
    return postStatus;
  }
  return "failed";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
