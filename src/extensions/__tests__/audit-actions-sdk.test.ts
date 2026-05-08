/**
 * Coverage for the Phase 50 SDK_* additions to EXT_AUDIT_ACTIONS.
 *
 * Pure constants/types — no DB. Asserts the exact wire strings match
 * the spec (`tasks/v1.3-phase-50-audit-foundation.md` § 50.5.1) plus
 * the optional-permission type change doesn't break existing usage.
 */
import { test, expect, describe } from "bun:test";
import { EXT_AUDIT_ACTIONS, type ExtensionAuditMetadata } from "../audit-actions";

describe("EXT_AUDIT_ACTIONS SDK_* wire strings", () => {
  test("SDK_LLM_CALL", () => expect(EXT_AUDIT_ACTIONS.SDK_LLM_CALL).toBe("ext:sdk-llm-call"));
  test("SDK_LLM_REJECTED", () => expect(EXT_AUDIT_ACTIONS.SDK_LLM_REJECTED).toBe("ext:sdk-llm-rejected"));
  test("SDK_MEMORY_READ", () => expect(EXT_AUDIT_ACTIONS.SDK_MEMORY_READ).toBe("ext:sdk-memory-read"));
  test("SDK_MEMORY_WRITE", () => expect(EXT_AUDIT_ACTIONS.SDK_MEMORY_WRITE).toBe("ext:sdk-memory-write"));
  test("SDK_MEMORY_REJECTED", () => expect(EXT_AUDIT_ACTIONS.SDK_MEMORY_REJECTED).toBe("ext:sdk-memory-rejected"));
  test("SDK_LESSONS_READ", () => expect(EXT_AUDIT_ACTIONS.SDK_LESSONS_READ).toBe("ext:sdk-lessons-read"));
  test("SDK_LESSONS_WRITE", () => expect(EXT_AUDIT_ACTIONS.SDK_LESSONS_WRITE).toBe("ext:sdk-lessons-write"));
  test("SDK_LESSONS_REJECTED", () => expect(EXT_AUDIT_ACTIONS.SDK_LESSONS_REJECTED).toBe("ext:sdk-lessons-rejected"));
  test("SDK_SCHEDULE_REGISTERED", () => expect(EXT_AUDIT_ACTIONS.SDK_SCHEDULE_REGISTERED).toBe("ext:sdk-schedule-registered"));
  test("SDK_SCHEDULE_FIRE", () => expect(EXT_AUDIT_ACTIONS.SDK_SCHEDULE_FIRE).toBe("ext:sdk-schedule-fire"));
  test("SDK_SCHEDULE_REJECTED", () => expect(EXT_AUDIT_ACTIONS.SDK_SCHEDULE_REJECTED).toBe("ext:sdk-schedule-rejected"));
  test("SDK_EVENT_SUBSCRIBED", () => expect(EXT_AUDIT_ACTIONS.SDK_EVENT_SUBSCRIBED).toBe("ext:sdk-event-subscribed"));
  test("SDK_EVENT_DELIVERY_REJECTED", () => expect(EXT_AUDIT_ACTIONS.SDK_EVENT_DELIVERY_REJECTED).toBe("ext:sdk-event-delivery-rejected"));
});

describe("EXT_AUDIT_ACTIONS — all SDK_* values share the ext:sdk- prefix", () => {
  test("every SDK_* wire value starts with `ext:sdk-`", () => {
    const sdkEntries = Object.entries(EXT_AUDIT_ACTIONS).filter(([k]) => k.startsWith("SDK_"));
    // Phase 50 baseline (13) + Phase 51 additions:
    //   SDK_EVENT_DELIVERED, SDK_SCHEDULE_DISABLED, SDK_LLM_DENIED_AND_DISABLED,
    //   SDK_LESSONS_VISIBILITY_CLAMPED, SDK_SCHEDULE_FIRE_NOW,
    //   SDK_SCHEDULE_QUOTA_EXCEEDED, SDK_SCHEDULE_REAPED.
    expect(sdkEntries.length).toBe(20);
    for (const [, v] of sdkEntries) {
      expect(v.startsWith("ext:sdk-")).toBe(true);
    }
  });
});

describe("ExtensionAuditMetadata — optional permission + new capability field", () => {
  test("permission is optional; SDK row populates capability instead", () => {
    // This compiles only if `permission` is optional. If a future
    // refactor reverts it to required, this fixture fails type-check.
    const sdkMeta: ExtensionAuditMetadata = {
      capability: "llm",
      oldValue: null,
      newValue: { tokensUsed: 100, costUsd: 0.003 },
      actor: "user-1",
      reason: "ext:llm.complete",
    };
    expect(sdkMeta.permission).toBeUndefined();
    expect(sdkMeta.capability).toBe("llm");
  });

  test("permission-tier rows still typecheck with permission populated", () => {
    const permMeta: ExtensionAuditMetadata = {
      permission: "storage",
      oldValue: false,
      newValue: true,
      actor: "system",
    };
    expect(permMeta.permission).toBe("storage");
    expect(permMeta.capability).toBeUndefined();
  });

  test("capability narrowed to the 5-buck enum", () => {
    // The literal-union typing means an invalid value would fail
    // type-check; runtime asserts only the populated value.
    const buckets: ExtensionAuditMetadata["capability"][] = [
      "llm", "memory", "lessons", "schedule", "events", undefined,
    ];
    expect(buckets.length).toBe(6);
  });
});
