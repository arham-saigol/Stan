import { describe, expect, it } from "vitest";
import { redactForLogging } from "../src/logging.ts";

describe("secret-safe logging", () => {
  it("redacts credential fields, authorization headers and provider URLs with tokens", () => {
    const secrets = {
      apiKey: "xq_secret_123",
      access_token: "oauth-access-secret",
      nested: {
        refreshToken: "oauth-refresh-secret",
        headers: {
          Authorization: "Bearer zernio-secret",
          "x-api-key": "another-secret",
        },
      },
      url: "https://example.com/callback?code=secret-code&state=okay",
      error:
        "GET https://example.com/fail?api_key=embedded-secret&safe=yes failed",
      safe: "visible",
    };

    const serialized = JSON.stringify(redactForLogging(secrets));

    for (const secret of [
      "xq_secret_123",
      "oauth-access-secret",
      "oauth-refresh-secret",
      "zernio-secret",
      "another-secret",
      "secret-code",
      "embedded-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain("visible");
  });
});
