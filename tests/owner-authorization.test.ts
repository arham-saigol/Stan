import { describe, expect, it } from "vitest";
import {
  deriveAuthorization,
  deriveAuthorizationOperation,
  deriveAutomationAuthorization,
  deriveMemoryAuthorization,
  deriveHeartbeatSettingsAuthorization,
  deriveWorkspaceAuthorization,
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
    expect(
      deriveAuthorization("Save this as an X draft", "Exact draft"),
    ).toEqual({
      operation: "draft",
      authorizedContent: "Exact draft",
    });
    expect(deriveAuthorization("Save this as an X draft")).toBeUndefined();
    expect(
      deriveAuthorization(
        "Schedule this X post for 2026-02-30T09:00:00Z",
        "Exact post text",
      ),
    ).toBeUndefined();
  });

  it("retains the full quoted write payload within the tool limit", () => {
    const content = "x".repeat(5_000);
    expect(deriveAuthorization("Post this on X", content)).toEqual({
      operation: "publish",
      authorizedContent: content,
    });
    expect(
      deriveAuthorization("Post this on X", "x".repeat(25_001)),
    ).toBeUndefined();
  });

  it("requires an explicit automation mutation verb and object", () => {
    expect(
      deriveAutomationAuthorization(
        'Please create automation: {"name":"research","scheduleType":"once","at":"2099-08-13T04:00:00Z","instruction":"Research the topic","deliveryMode":"owner_whatsapp"}',
      ),
    ).toEqual({
      operation: "create",
      payloadJson:
        '{"name":"research","scheduleType":"once","at":"2099-08-13T04:00:00Z","instruction":"Research the topic","deliveryMode":"owner_whatsapp"}',
    });
    expect(
      deriveAutomationAuthorization("Delete automation automation-1"),
    ).toEqual({
      operation: "delete",
      payloadJson: '{"id":"automation-1"}',
    });
    expect(
      deriveAutomationAuthorization("Research our automation rate"),
    ).toBeUndefined();
  });

  it("binds workspace authorization to one exact edit payload", () => {
    expect(
      deriveWorkspaceAuthorization(
        'edit workspace: {"file":"goals","operation":"append","text":"Ship Stan"}',
      ),
    ).toEqual({
      payloadJson: '{"file":"goals","operation":"append","text":"Ship Stan"}',
    });
    expect(
      deriveWorkspaceAuthorization(
        'edit workspace: {"file":"secrets","operation":"append","text":"oops"}',
      ),
    ).toBeUndefined();
    expect(deriveWorkspaceAuthorization("Update our goals")).toBeUndefined();
  });

  it("binds semantic-memory mutations to exact content or document IDs", () => {
    expect(
      deriveMemoryAuthorization("remember: prefers simple systems"),
    ).toEqual({
      operation: "remember",
      payloadJson: '{"content":"prefers simple systems"}',
    });
    expect(deriveMemoryAuthorization("forget memory document-123")).toEqual({
      operation: "forget",
      payloadJson: '{"documentId":"document-123"}',
    });
    expect(deriveMemoryAuthorization("What do you remember?")).toBeUndefined();
  });

  it("does not derive an X write from an automation confirmation", () => {
    expect(
      deriveAuthorizationOperation(
        'schedule automation: {"name":"x post research","at":"2099-08-13T04:00:00Z"}',
      ),
    ).toBeUndefined();
  });

  it("binds heartbeat settings to an exact validated patch", () => {
    expect(
      deriveHeartbeatSettingsAuthorization(
        'update heartbeat: {"enabled":true,"intervalMinutes":60}',
      ),
    ).toEqual({
      payloadJson: '{"enabled":true,"intervalMinutes":60}',
    });
    expect(
      deriveHeartbeatSettingsAuthorization(
        'update heartbeat: {"intervalMinutes":5}',
      ),
    ).toBeUndefined();
  });
});
