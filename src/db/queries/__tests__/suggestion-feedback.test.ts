import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import {
  setupTestDb,
  closeTestDb,
  mockDbConnection,
  getTestDb,
} from "../../../__tests__/helpers/test-pglite";

mockDbConnection();

const { insertSuggestionFeedback } = await import("../suggestion-feedback");
const { suggestionFeedback, users } = await import("../../schema");

describe("insertSuggestionFeedback", () => {
  beforeEach(async () => {
    await setupTestDb();
    await getTestDb().insert(users).values({
      id: "u1",
      email: "u1@test.dev",
      passwordHash: "x",
      name: "u1",
    });
  });
  afterAll(async () => {
    await closeTestDb();
  });

  test("persists a full event", async () => {
    await insertSuggestionFeedback({
      userId: "u1",
      conversationId: null,
      kind: "tool",
      action: "accepted",
      toolName: "analyzer__scan",
      latencyMs: 42,
    });
    const rows = await getTestDb().select().from(suggestionFeedback);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: "u1",
      conversationId: null,
      kind: "tool",
      action: "accepted",
      toolName: "analyzer__scan",
      latencyMs: 42,
    });
    expect(rows[0]!.id).toBeTruthy();
    expect(rows[0]!.createdAt).toBeInstanceOf(Date);
  });

  test("optional fields default to null (content-free minimal event)", async () => {
    await insertSuggestionFeedback({ userId: "u1", kind: "enhance", action: "shown" });
    const rows = await getTestDb().select().from(suggestionFeedback);
    expect(rows[0]).toMatchObject({
      kind: "enhance",
      action: "shown",
      toolName: null,
      latencyMs: null,
      conversationId: null,
    });
  });
});
