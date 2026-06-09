/**
 * Phase 4 (D) — updateConversationSchema accepts the extensionTools field.
 *
 * Pure zod schema unit test (no DOM, no DB). Runs under vitest.
 */
import { describe, test, expect } from "vitest";
import { updateConversationSchema } from "../routes/api/conversations/schema";

describe("updateConversationSchema.extensionTools", () => {
  test("accepts a valid extension→tools map", () => {
    const parsed = updateConversationSchema.safeParse({
      extensionTools: { "ext-1": ["alpha", "beta"], "ext-2": [] },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.extensionTools).toEqual({ "ext-1": ["alpha", "beta"], "ext-2": [] });
    }
  });

  test("accepts null (clear override)", () => {
    const parsed = updateConversationSchema.safeParse({ extensionTools: null });
    expect(parsed.success).toBe(true);
  });

  test("accepts omission (field optional)", () => {
    const parsed = updateConversationSchema.safeParse({ title: "x" });
    expect(parsed.success).toBe(true);
  });

  test("rejects a non-string tool name", () => {
    const parsed = updateConversationSchema.safeParse({
      extensionTools: { "ext-1": [123] },
    });
    expect(parsed.success).toBe(false);
  });

  test("rejects a non-array value", () => {
    const parsed = updateConversationSchema.safeParse({
      extensionTools: { "ext-1": "alpha" },
    });
    expect(parsed.success).toBe(false);
  });
});
