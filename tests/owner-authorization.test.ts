import { describe, expect, it } from "vitest";
import { deriveAuthorizationOperation } from "../src/gateway/owner-authorization.ts";

describe("owner X authorization classification", () => {
  it("does not authorize negations, discussion, or owner questions", () => {
    expect(deriveAuthorizationOperation("Do not post this")).toBeUndefined();
    expect(
      deriveAuthorizationOperation("Should we post this?"),
    ).toBeUndefined();
    expect(
      deriveAuthorizationOperation("Here is a draft to improve"),
    ).toBeUndefined();
    expect(deriveAuthorizationOperation("Edit this sentence")).toBeUndefined();
    expect(deriveAuthorizationOperation("Cancel the reminder")).toBeUndefined();
    expect(deriveAuthorizationOperation("Delete that memory")).toBeUndefined();
    expect(
      deriveAuthorizationOperation("Schedule a research reminder"),
    ).toBeUndefined();
    expect(
      deriveAuthorizationOperation("Schedule this reminder for tomorrow"),
    ).toBeUndefined();
    expect(
      deriveAuthorizationOperation("Reply with the setup steps"),
    ).toBeUndefined();
  });

  it("distinguishes future posting from immediate publishing", () => {
    expect(
      deriveAuthorizationOperation("Can you please post this tomorrow at 9am?"),
    ).toBe("schedule");
    expect(deriveAuthorizationOperation("Please post this on X now")).toBe(
      "publish",
    );
    expect(deriveAuthorizationOperation("Edit X post z-123")).toBe("edit");
    expect(deriveAuthorizationOperation("Cancel the scheduled post")).toBe(
      "cancel",
    );
  });
});
