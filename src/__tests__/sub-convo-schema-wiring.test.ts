import { test, expect, describe } from "bun:test";
import { createConversationSchema } from "../../web/src/routes/api/conversations/schema";

describe("createConversationSchema parent field wiring", () => {
  const base = { projectId: "a0000000-0000-1000-8000-000000000001" };

  test("accepts parentConversationId as optional uuid", () => {
    const result = createConversationSchema.safeParse({
      ...base,
      parentConversationId: "a0000000-0000-1000-8000-000000000002",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.parentConversationId).toBe("a0000000-0000-1000-8000-000000000002");
    }
  });

  test("accepts parentMessageId as optional uuid", () => {
    const result = createConversationSchema.safeParse({
      ...base,
      parentMessageId: "a0000000-0000-1000-8000-000000000003",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.parentMessageId).toBe("a0000000-0000-1000-8000-000000000003");
    }
  });

  test("allows both parent fields together", () => {
    const result = createConversationSchema.safeParse({
      ...base,
      parentConversationId: "a0000000-0000-1000-8000-000000000002",
      parentMessageId: "a0000000-0000-1000-8000-000000000003",
    });
    expect(result.success).toBe(true);
  });

  test("still works without parent fields", () => {
    const result = createConversationSchema.safeParse(base);
    expect(result.success).toBe(true);
  });

  test("rejects invalid uuid for parentConversationId", () => {
    const result = createConversationSchema.safeParse({
      ...base,
      parentConversationId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  test("rejects invalid uuid for parentMessageId", () => {
    const result = createConversationSchema.safeParse({
      ...base,
      parentMessageId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-string parentConversationId", () => {
    const result = createConversationSchema.safeParse({
      ...base,
      parentConversationId: 12345,
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-string parentMessageId", () => {
    const result = createConversationSchema.safeParse({
      ...base,
      parentMessageId: true,
    });
    expect(result.success).toBe(false);
  });

  test("strips unknown fields while keeping parent fields", () => {
    const result = createConversationSchema.safeParse({
      ...base,
      parentConversationId: "a0000000-0000-1000-8000-000000000002",
      unknownField: "should be stripped",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.parentConversationId).toBe("a0000000-0000-1000-8000-000000000002");
      expect((result.data as any).unknownField).toBeUndefined();
    }
  });

  test("inferred type includes parent fields as optional", () => {
    // Compile-time check: CreateConversationInput should have these fields
    type Input = import("../../web/src/routes/api/conversations/schema").CreateConversationInput;
    const input: Input = { projectId: "a0000000-0000-1000-8000-000000000001" };
    // Both fields should be assignable
    const withParents: Input = {
      ...input,
      parentConversationId: "a0000000-0000-1000-8000-000000000002",
      parentMessageId: "a0000000-0000-1000-8000-000000000003",
    };
    expect(withParents.parentConversationId).toBeDefined();
    expect(withParents.parentMessageId).toBeDefined();
  });
});
