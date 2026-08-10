import { describe, expect, it } from "vitest";
import { assertPublicHttpUrl } from "../src/providers/network-safety.ts";

describe("web fetch boundary", () => {
  it("rejects local, private, credential-bearing and non-HTTP targets", async () => {
    await expect(assertPublicHttpUrl("http://127.0.0.1/admin")).rejects.toThrow(
      /private/i,
    );
    await expect(assertPublicHttpUrl("http://10.0.0.1/admin")).rejects.toThrow(
      /private/i,
    );
    await expect(assertPublicHttpUrl("http://192.0.2.1/")).rejects.toThrow(
      /private/i,
    );
    await expect(assertPublicHttpUrl("file:///etc/passwd")).rejects.toThrow(
      /HTTP/i,
    );
    await expect(
      assertPublicHttpUrl("https://user:pass@example.com"),
    ).rejects.toThrow(/credential/i);
  });
});
