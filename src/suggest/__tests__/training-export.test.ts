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
  dedupeSyntheticRows,
  syntheticPromptToolRows,
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

describe("syntheticPromptToolRows (pure)", () => {
  test("per-tool example → one namespaced row with a `synthetic:` messageId", () => {
    const rows = syntheticPromptToolRows([
      {
        name: "web-search",
        tools: [
          {
            name: "search-web",
            description: "d",
            inputSchema: {},
            suggestExamples: ["search the web now", "find recent news"],
          },
          { name: "read-url", description: "d", inputSchema: {} },
        ],
      },
    ]);
    expect(rows).toEqual([
      { messageId: "synthetic:web-search:search-web:0", prompt: "search the web now", toolName: "web-search__search-web" },
      { messageId: "synthetic:web-search:search-web:1", prompt: "find recent news", toolName: "web-search__search-web" },
    ]);
  });

  test("extension-level example → one shared-messageId row per declared tool", () => {
    const rows = syntheticPromptToolRows([
      {
        name: "file-organizer",
        suggestExamples: ["clean up my downloads"],
        tools: [
          { name: "propose_moves", description: "d", inputSchema: {} },
          { name: "teach_rule", description: "d", inputSchema: {} },
        ],
      },
    ]);
    expect(rows).toEqual([
      { messageId: "synthetic:file-organizer::0", prompt: "clean up my downloads", toolName: "file-organizer__propose_moves" },
      { messageId: "synthetic:file-organizer::0", prompt: "clean up my downloads", toolName: "file-organizer__teach_rule" },
    ]);
  });

  test("extension-level example on a tool-less manifest yields no rows", () => {
    expect(syntheticPromptToolRows([{ name: "x", suggestExamples: ["clean up my stuff"], tools: [] }])).toEqual([]);
    expect(syntheticPromptToolRows([{ name: "x", suggestExamples: ["clean up my stuff"] }])).toEqual([]);
  });

  test("a manifest with no authored examples yields no rows", () => {
    expect(
      syntheticPromptToolRows([{ name: "x", tools: [{ name: "t", description: "d", inputSchema: {} }] }]),
    ).toEqual([]);
  });
});

describe("dedupeSyntheticRows (pure)", () => {
  const synthetic = [
    { messageId: "synthetic:a:t:0", prompt: "Search The  Web  Now", toolName: "a__t" },
    { messageId: "synthetic:a:t:1", prompt: "brand new phrasing", toolName: "a__t" },
  ];

  test("drops synthetic whose normalized prompt already appears in real history", () => {
    // Real prompt differs only by case + surrounding/collapsed whitespace.
    const real = [{ messageId: "m1", prompt: "  search the web now  ", toolName: "x__y" }];
    expect(dedupeSyntheticRows(real, synthetic)).toEqual([
      { messageId: "synthetic:a:t:1", prompt: "brand new phrasing", toolName: "a__t" },
    ]);
  });

  test("empty real history keeps every synthetic row", () => {
    expect(dedupeSyntheticRows([], synthetic)).toEqual(synthetic);
  });
});

describe("buildTrainingExamples — synthetic provenance + grouping", () => {
  test("stamps source from the `synthetic:` messageId prefix", () => {
    const examples = buildTrainingExamples([
      { messageId: "m1", prompt: "scan my repository", toolName: "analyzer__scan" },
      { messageId: "synthetic:web-search:search-web:0", prompt: "search the web now", toolName: "web-search__search-web" },
    ]);
    const bySource = Object.fromEntries(examples.map((e) => [e.source, e]));
    expect(bySource.history!.messages[1]!.content).toBe("scan my repository");
    expect(bySource.manifest!.messages[1]!.content).toBe("search the web now");
  });

  test("extension-level synthetic rows group into one example over the whole tool set", () => {
    const rows = syntheticPromptToolRows([
      {
        name: "file-organizer",
        suggestExamples: ["clean up my downloads folder"],
        tools: [
          { name: "propose_moves", description: "d", inputSchema: {} },
          { name: "teach_rule", description: "d", inputSchema: {} },
        ],
      },
    ]);
    const [ex] = buildTrainingExamples(rows);
    expect(ex!.source).toBe("manifest");
    expect(ex!.messages[2]!.content).toBe(
      JSON.stringify({ tools: ["file-organizer__propose_moves", "file-organizer__teach_rule"] }),
    );
  });

  test("synthetic prompts below the signal floor are dropped like real ones", () => {
    const rows = syntheticPromptToolRows([
      { name: "x", tools: [{ name: "t", description: "d", inputSchema: {}, suggestExamples: ["go"] }] },
    ]);
    expect(rows).toHaveLength(1); // the row is produced,
    expect(buildTrainingExamples(rows)).toEqual([]); // but "go" is under MIN length.
  });

  test("toJsonl carries the source provenance on each line", () => {
    const examples = buildTrainingExamples([
      { messageId: "synthetic:x:t:0", prompt: "organize these files", toolName: "x__t" },
    ]);
    const line = JSON.parse(toJsonl(examples).trim());
    expect(line.source).toBe("manifest");
    expect(line.messages).toHaveLength(3);
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
