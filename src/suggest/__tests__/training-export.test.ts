import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import {
  setupTestDb,
  closeTestDb,
  mockDbConnection,
  getTestDb,
} from "../../__tests__/helpers/test-pglite";

mockDbConnection();

const {
  buildTrainingExamples,
  collectPromptToolRows,
  toJsonl,
  TRAINING_SYSTEM_PROMPT,
  MAX_TRAINING_PROMPT_LENGTH,
} = await import("../training-export");
const { conversations, messages, toolCalls } = await import("../../db/schema");

describe("buildTrainingExamples (pure)", () => {
  test("groups tools per message, dedupes, sorts, wraps in chat format", () => {
    const examples = buildTrainingExamples([
      { messageId: "m1", prompt: "scan my repository", toolName: "analyzer__scan" },
      { messageId: "m1", prompt: "scan my repository", toolName: "analyzer__lint" },
      { messageId: "m1", prompt: "scan my repository", toolName: "analyzer__scan" },
      { messageId: "m2", prompt: "search the web for bun docs", toolName: "websearch__search" },
    ]);
    expect(examples).toHaveLength(2);
    expect(examples[0]!.messages).toEqual([
      { role: "system", content: TRAINING_SYSTEM_PROMPT },
      { role: "user", content: "scan my repository" },
      { role: "assistant", content: '{"tools":["analyzer__lint","analyzer__scan"]}' },
    ]);
  });

  test("drops prompts below the signal floor", () => {
    expect(buildTrainingExamples([{ messageId: "m1", prompt: "  ok  ", toolName: "t" }])).toEqual([]);
  });

  test("caps pasted walls of text", () => {
    const [ex] = buildTrainingExamples([
      { messageId: "m1", prompt: "x".repeat(MAX_TRAINING_PROMPT_LENGTH + 500), toolName: "t" },
    ]);
    expect(ex!.messages[1]!.content).toHaveLength(MAX_TRAINING_PROMPT_LENGTH);
  });
});

describe("toJsonl", () => {
  test("one JSON object per line with trailing newline; empty → empty string", () => {
    const examples = buildTrainingExamples([
      { messageId: "m1", prompt: "scan my repository", toolName: "t" },
    ]);
    const jsonl = toJsonl(examples);
    expect(jsonl.endsWith("\n")).toBe(true);
    expect(JSON.parse(jsonl.trim())).toEqual(examples[0]);
    expect(toJsonl([])).toBe("");
  });
});

describe("collectPromptToolRows (DB)", () => {
  beforeEach(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  const T0 = new Date("2026-06-01T10:00:00Z");
  const at = (mins: number) => new Date(T0.getTime() + mins * 60_000);

  async function seedConversation(id: string): Promise<void> {
    await getTestDb().insert(conversations).values({ id, projectId: "global" });
  }

  async function seedMessage(id: string, conversationId: string, role: string, content: string, createdAt: Date) {
    await getTestDb().insert(messages).values({ id, conversationId, role, content, createdAt });
  }

  async function seedCall(conversationId: string, toolName: string, createdAt: Date, success = true) {
    await getTestDb().insert(toolCalls).values({
      extensionId: "builtin",
      conversationId,
      toolName,
      success,
      durationMs: 5,
      createdAt,
    });
  }

  test("pairs each successful call with the nearest preceding user message", async () => {
    await seedConversation("c1");
    await seedMessage("m1", "c1", "user", "scan my repository please", at(0));
    await seedMessage("m2", "c1", "assistant", "on it", at(1));
    await seedCall("c1", "analyzer__scan", at(2));
    await seedMessage("m3", "c1", "user", "now search the web for bun docs", at(10));
    await seedCall("c1", "websearch__search", at(11));

    const rows = await collectPromptToolRows(365);
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual({
      messageId: "m1",
      prompt: "scan my repository please",
      toolName: "analyzer__scan",
    });
    expect(rows).toContainEqual({
      messageId: "m3",
      prompt: "now search the web for bun docs",
      toolName: "websearch__search",
    });
  });

  test("failed calls, conversation-less calls, and out-of-window calls are excluded", async () => {
    await seedConversation("c1");
    await seedMessage("m1", "c1", "user", "scan my repository please", at(0));
    await seedCall("c1", "failed__tool", at(1), false);
    await getTestDb().insert(toolCalls).values({
      extensionId: "builtin",
      toolName: "orphan__tool",
      success: true,
      durationMs: 5,
      createdAt: at(1),
    });
    await seedCall("c1", "ancient__tool", new Date("2020-01-01T00:00:00Z"));

    expect(await collectPromptToolRows(365)).toEqual([]);
  });

  test("assistant-only conversations produce no pairs (LATERAL finds no user turn)", async () => {
    await seedConversation("c1");
    await seedMessage("m1", "c1", "assistant", "unprompted output", at(0));
    await seedCall("c1", "analyzer__scan", at(1));
    expect(await collectPromptToolRows(365)).toEqual([]);
  });
});
