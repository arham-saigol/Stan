import { describe, expect, it } from "vitest";
import {
  deriveAuthorization,
  deriveAuthorizationOperation,
  deriveAutomationAuthorization,
  deriveMemoryAuthorization,
  deriveHeartbeatSettingsAuthorization,
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
    expect(deriveAuthorization("Delete this X post")).toEqual({
      operation: "delete",
    });
    expect(
      deriveAuthorization("Reply to X post 1900123456789", "Exact reply"),
    ).toEqual({
      operation: "reply",
      targetPostId: "1900123456789",
    });
    expect(
      deriveAuthorization(
        "Reply to X post 1900123456789",
        "See https://x.com/other/status/999 and reply here",
      ),
    ).toMatchObject({ targetPostId: "1900123456789" });
    expect(deriveAuthorization("Reply to this thread")).toEqual({
      operation: "reply",
    });
  });

  it("authorizes natural references without verbatim IDs or instants", () => {
    expect(deriveAuthorization("Reply to the second one")).toEqual({
      operation: "reply",
    });
    expect(
      deriveAuthorization("Post the second one", "1. Draft A\n2. Draft B"),
    ).toEqual({ operation: "publish" });
    expect(deriveAuthorization("Post #2", "1. Draft A\n2. Draft B")).toEqual({
      operation: "publish",
    });
    expect(deriveAuthorization("Edit the second one")).toEqual({
      operation: "edit",
    });
    expect(deriveAuthorization("Cancel the scheduled one")).toEqual({
      operation: "cancel",
    });
    expect(deriveAuthorization("Delete #3")).toEqual({ operation: "delete" });
    expect(
      deriveAuthorization(
        "Schedule that for tomorrow at nine",
        "Exact post text",
      ),
    ).toEqual({
      operation: "schedule",
      authorizedContent: "Exact post text",
    });
    expect(
      deriveAuthorization(
        "Schedule the second one for tomorrow at nine",
        "1. Draft A\n2. Draft B",
      ),
    ).toEqual({ operation: "schedule" });
  });

  it("binds exact content and instants when the owner provides them", () => {
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
    expect(deriveAuthorization("Post this on X")).toEqual({
      operation: "publish",
    });
    expect(
      deriveAuthorization("Save this as an X draft", "Exact draft"),
    ).toEqual({
      operation: "draft",
      authorizedContent: "Exact draft",
    });
    expect(deriveAuthorization("Save this as an X draft")).toEqual({
      operation: "draft",
    });
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
    expect(deriveAuthorization("Post this on X", "x".repeat(25_001))).toEqual({
      operation: "publish",
    });
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
      deriveAutomationAuthorization(
        'create automation: {"name":"disabled","scheduleType":"once","at":"2099-08-13T04:00:00Z","instruction":"Research","deliveryMode":"silent","enabled":false}',
      ),
    ).toBeUndefined();
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

  it("does not derive an X write from non-X mutation commands", () => {
    expect(
      deriveAuthorizationOperation(
        'schedule automation: {"name":"x post research","at":"2099-08-13T04:00:00Z"}',
      ),
    ).toBeUndefined();
    expect(
      deriveAuthorization(
        'edit workspace: {"file":"playbook","operation":"append","text":"Review X post https://x.com/u/status/123"}',
        "Public replacement text",
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
    expect(
      deriveHeartbeatSettingsAuthorization(
        'update heartbeat: {"startTime":"09:00","timezone":"UTC"}',
      ),
    ).toBeUndefined();
  });
});
