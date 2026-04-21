import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection, mockRealSettings } from "./helpers/test-pglite";
import { mockEmbedding, mockEmbeddingsModule } from "./helpers/mock-vectors";
import type { MemoryProvenance } from "../memory/types";

mockDbConnection();
mockRealSettings();
mockEmbeddingsModule();

const { insertMemory } = await import("../db/queries/memories");
const { buildSystemPromptWithMemories } = await import("../memory/injection");
const { hybridSearch } = await import("../memory/retrieval");
const { createProject } = await import("../db/queries/projects");
const { createConversation } = await import("../db/queries/conversations");
const { upsertSetting } = await import("../db/queries/settings");
const { getDb } = await import("../db/connection");
const { memories } = await import("../db/schema");
const { eq } = await import("drizzle-orm");

let projectId: string;
let projectId2: string;
let conversationId: string;
let nameMemoryId: string;
let prefMemoryId: string;
let archivedMemoryId: string;

function makeProvenance(): MemoryProvenance {
  return {
    sourceConversationId: conversationId,
    sourceMessageIds: ["msg-pipeline-test"],
    extractedAt: new Date(),
    confidence: "high",
    history: [{ action: "created", timestamp: new Date(), reason: "test" }],
  };
}

async function insertTestMemory(
  content: string,
  opts?: { category?: string; status?: string; projectId?: string | null },
) {
  const embedding = mockEmbedding();
  const mem = await insertMemory({
    content,
    category: (opts?.category ?? "biographical") as any,
    projectId: opts?.projectId === null ? undefined : (opts?.projectId ?? projectId),
    conversationId,
    messageIds: ["msg-pipeline-test"],
    confidence: "high",
    embedding,
    provenance: makeProvenance(),
  });
  if (opts?.status && opts.status !== "active") {
    const db = getDb();
    await db.update(memories).set({ status: opts.status } as any).where(eq(memories.id, mem.id));
  }
  return mem;
}

beforeAll(async () => {
  await setupTestDb();
  const project = await createProject({ name: "pipeline-test", path: "/tmp/pipeline-test" });
  projectId = project.id;
  const project2 = await createProject({ name: "pipeline-test-2", path: "/tmp/pipeline-test-2" });
  projectId2 = project2.id;
  const conv = await createConversation(projectId, { title: "pipeline conv" });
  conversationId = conv.id;

  const nameMem = await insertTestMemory("User's name is Geff", { category: "biographical" });
  nameMemoryId = nameMem.id;

  const prefMem = await insertTestMemory("Always greet with hi billy", { category: "preferences" });
  prefMemoryId = prefMem.id;

  const archivedMem = await insertTestMemory("Old forgotten fact", {
    category: "biographical",
    status: "archived",
  });
  archivedMemoryId = archivedMem.id;
});

afterAll(async () => {
  await closeTestDb();
  try {
    const { restoreModuleMocks } = require("./helpers/mock-cleanup");
    restoreModuleMocks();
  } catch {}
});

describe("Memory injection pipeline", () => {
  test("buildSystemPromptWithMemories injects memories into system prompt", async () => {
    const result = await buildSystemPromptWithMemories("You are an assistant.", "What is the user's name?", projectId);
    expect(result.systemPrompt).toContain("## Relevant Memories");
  });

  test("buildSystemPromptWithMemories returns memoriesUsed array", async () => {
    const result = await buildSystemPromptWithMemories("You are an assistant.", "name greeting", projectId);
    expect(result.memoriesUsed.length).toBeGreaterThan(0);
    for (const mem of result.memoriesUsed) {
      expect(mem.id).toBeDefined();
      expect(mem.content).toBeDefined();
      expect(mem.category).toBeDefined();
    }
  });

  test("buildSystemPromptWithMemories with empty DB returns base prompt unchanged", async () => {
    // Create a separate project with no memories and enable isolation so
    // memories from other projects don't leak in
    const emptyProject = await createProject({ name: "empty-project", path: "/tmp/empty-project" });
    await upsertSetting(`project:${emptyProject.id}:memoryIsolation`, true);
    try {
      const result = await buildSystemPromptWithMemories(
        "Base prompt only.",
        "anything",
        emptyProject.id,
        { tokenBudget: 2000 },
      );
      expect(result.systemPrompt).toBe("Base prompt only.");
      expect(result.memoriesUsed).toEqual([]);
    } finally {
      await upsertSetting(`project:${emptyProject.id}:memoryIsolation`, false);
    }
  });

  test("hybridSearch returns memories matching query", async () => {
    const embedding = mockEmbedding();
    const results = await hybridSearch("name", embedding, { projectId });
    const contents = results.map((r) => r.content);
    expect(contents).toContain("User's name is Geff");
  });

  test("hybridSearch excludes archived memories", async () => {
    const embedding = mockEmbedding();
    const results = await hybridSearch("old forgotten", embedding, { projectId });
    const ids = results.map((r) => r.id);
    expect(ids).not.toContain(archivedMemoryId);
  });

  test("hybridSearch with project isolation", async () => {
    // Insert a memory in a different project
    const otherMem = await insertTestMemory("Secret from other project", {
      category: "technical",
      projectId: projectId2,
    });

    const embedding = mockEmbedding();
    const results = await hybridSearch("secret", embedding, {
      projectId,
      isolateToProject: true,
    });
    const ids = results.map((r) => r.id);
    expect(ids).not.toContain(otherMem.id);
  });

  test("hybridSearch with global scope (no isolation)", async () => {
    // Insert a global memory (null projectId)
    const globalMem = await insertTestMemory("Global knowledge shared everywhere", {
      category: "technical",
      projectId: null,
    });

    const embedding = mockEmbedding();
    const results = await hybridSearch("global knowledge", embedding, {
      projectId,
      isolateToProject: false,
    });
    const ids = results.map((r) => r.id);
    expect(ids).toContain(globalMem.id);
  });

  test("buildSystemPromptWithMemories respects memoryEnabled setting", async () => {
    await upsertSetting("global:memoryEnabled", false);
    try {
      const result = await buildSystemPromptWithMemories("Base prompt.", "name", projectId);
      expect(result.systemPrompt).toBe("Base prompt.");
      expect(result.memoriesUsed).toEqual([]);
    } finally {
      await upsertSetting("global:memoryEnabled", true);
    }
  });

  test("hybridSearch without isolation does NOT leak other project memories", async () => {
    // Insert a memory ONLY in project2 — it should NOT appear when searching project1
    const leakyMem = await insertTestMemory("Super secret project2 only data", {
      category: "technical",
      projectId: projectId2,
    });

    const embedding = mockEmbedding();
    // Search in project1 WITHOUT isolation (the default behavior)
    const results = await hybridSearch("super secret", embedding, {
      projectId,
      isolateToProject: false,
    });
    const ids = results.map((r) => r.id);

    // This was the bug: previously project2's memories would leak into project1's results
    expect(ids).not.toContain(leakyMem.id);
  });

  test("buildSystemPromptWithMemories does NOT include other project memories", async () => {
    // Insert distinctive content in project2
    await insertTestMemory("Unique zebra unicorn content from project2", {
      category: "biographical",
      projectId: projectId2,
    });

    const result = await buildSystemPromptWithMemories(
      "You are an assistant.",
      "zebra unicorn",
      projectId, // searching in project1
    );

    // project2's memory should NOT leak into project1's system prompt
    expect(result.systemPrompt).not.toContain("zebra unicorn");
    // None of the used memories should contain project2-only content
    for (const mem of result.memoriesUsed) {
      expect(mem.content).not.toContain("zebra unicorn");
    }
  });

  test("full pipeline: injection result contains memory content in system prompt", async () => {
    const result = await buildSystemPromptWithMemories(
      "You are a helpful assistant.",
      "What is the user's name and how should I greet them?",
      projectId,
    );
    // The actual memory text should appear in the injected prompt
    expect(result.systemPrompt).toContain("Geff");
    expect(result.systemPrompt).toContain("hi billy");
    expect(result.memoriesUsed.length).toBeGreaterThanOrEqual(2);
  });
});
