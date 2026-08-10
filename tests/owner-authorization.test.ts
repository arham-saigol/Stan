import { describe, expect, it } from "vitest";
import {
  deriveAuthorization,
  deriveAuthorizationOperation,
  deriveAutomationAuthorizationOperation,
} from "../src/gateway/owner-authorization.ts";

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

  it("binds destructive authorization to an explicit owner target", () => {
    expect(deriveAuthorization("Delete X post z-123")).toEqual({
      operation: "delete",
      targetPostId: "z-123",
    });
    expect(
      deriveAuthorization(
        "Delete this X post",
        "https://x.com/arham/status/1900123456789",
      ),
    ).toEqual({ operation: "delete", targetPostId: "1900123456789" });
    expect(deriveAuthorization("Delete this X post")).toBeUndefined();
    expect(
      deriveAuthorization("Reply to X post 1900123456789", "Exact reply"),
    ).toEqual({
      operation: "reply",
      targetPostId: "1900123456789",
      authorizedContent: "Exact reply",
    });
    expect(deriveAuthorization("Reply to this thread")).toBeUndefined();
  });

  it("requires exact content and an explicit ISO instant for schedules", () => {
    expect(
      deriveAuthorization(
        "Schedule this X post for 2026-08-14T09:00:00+05:00",
        "Exact post text",
      ),
    ).toEqual({
      operation: "schedule",
      authorizedContent: "Exact post text",
      authorizedScheduledFor: "2026-08-14T04:00:00.000Z",
    });
    expect(
      deriveAuthorization("Post this on X", "Exact post text"),
    ).toMatchObject({
      operation: "publish",
      authorizedContent: "Exact post text",
    });
    expect(deriveAuthorization("Post this on X")).toBeUndefined();
  });

  it("requires an explicit automation mutation verb and object", () => {
    expect(
      deriveAutomationAuthorizationOperation(
        "Please schedule a research reminder automation",
      ),
    ).toBe("create");
    expect(
      deriveAutomationAuthorizationOperation("Delete the daily automation"),
    ).toBe("delete");
    expect(
      deriveAutomationAuthorizationOperation("Research our automation rate"),
    ).toBeUndefined();
  });
});
