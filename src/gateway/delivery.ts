import { createHash } from "node:crypto";

export interface BoundOwnerDelivery {
  send(text: string, messageId?: string): Promise<{ messageId: string }>;
}

export class DeliveryService {
  constructor(private readonly owner: BoundOwnerDelivery) {}

  async sendOwner(
    text: string,
    idempotencyKey?: string,
  ): Promise<{ messageId: string }> {
    const value = text.trim();
    if (!value) throw new Error("Cannot send an empty WhatsApp message");
    const bounded =
      value.length <= 12_000
        ? value
        : `${value.slice(0, 11_970)}\n\n[response truncated]`;
    const messageId = idempotencyKey
      ? createHash("sha256")
          .update(idempotencyKey)
          .digest("hex")
          .slice(0, 24)
          .toUpperCase()
      : undefined;
    return this.owner.send(bounded, messageId);
  }
}
