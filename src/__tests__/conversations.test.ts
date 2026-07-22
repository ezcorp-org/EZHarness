import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

// Re-establish real settings implementation — parallel tests (model-router.test.ts etc.)
// mock db/queries/settings globally. This ensures our imports get the real implementation.
mock.module("../db/queries/settings", () => {
  const { eq } = require("drizzle-orm");
  const { settings: tbl } = require("../db/schema");
  return {
    async getAllSettings() {
      const { getDb } = require("../db/connection");
      const rows = await getDb().select().from(tbl);
      return Object.fromEntries(rows.map((r: any) => [r.key, r.value]));
    },
    async getSetting(key: string) {
      const { getDb } = require("../db/connection");
      const rows = await getDb().select().from(tbl).where(eq(tbl.key, key));
      return rows[0]?.value;
    },
    async upsertSetting(key: string, value: unknown) {
      const { getDb } = require("../db/connection");
      const db = getDb();
      const rows = await db.select().from(tbl).where(eq(tbl.key, key));
      if (rows[0]) {
        await db.update(tbl).set({ value, updatedAt: new Date() }).where(eq(tbl.key, key));
      } else {
        await db.insert(tbl).values({ key, value, updatedAt: new Date() });
      }
    },
    async deleteSetting(key: string) {
      const { getDb } = require("../db/connection");
      const rows = await getDb().select().from(tbl).where(eq(tbl.key, key));
      if (!rows[0]) return false;
      await getDb().delete(tbl).where(eq(tbl.key, key));
      return true;
    },
    async isListingInstalled() { return false; },
  };
});

mockDbConnection();

// Import after mock
import {
  createConversation,
  listConversations,
  getConversation,
  updateConversation,
  deleteConversation,
  createMessage,
  getMessages,
  getConversationPath,
  getSiblings,
  getLatestLeaf,
  searchConversations,
  resolveSystemPrompt,
  getOrCreateExtServiceConversation,
} from "../db/queries/conversations";
import { createProject, getProjectByPath } from "../db/queries/projects";
import { upsertSetting, deleteSetting, getSetting } from "../db/queries/settings";
import { createUser } from "../db/queries/users";

let projectId: string;

beforeAll(async () => {
  await setupTestDb();
  const project = await createProject({ name: "Test Project", path: "/tmp/test" });
  projectId = project.id;
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

describe("conversations", () => {
  test("createConversation returns a conversation with defaults", async () => {
    const conv = await createConversation(projectId);
    expect(conv.id).toBeDefined();
    expect(conv.projectId).toBe(projectId);
    expect(conv.title).toBe("New conversation");
    expect(conv.model).toBeNull();
    expect(conv.provider).toBeNull();
    expect(conv.createdAt).toBeInstanceOf(Date);
    expect(conv.updatedAt).toBeInstanceOf(Date);
  });

  test("createConversation with options", async () => {
    const conv = await createConversation(projectId, {
      title: "My Chat",
      model: "gpt-4o",
      provider: "openai",
    });
    expect(conv.title).toBe("My Chat");
    expect(conv.model).toBe("gpt-4o");
    expect(conv.provider).toBe("openai");
  });

  test("listConversations returns conversations sorted by updatedAt desc", async () => {
    const convs = await listConversations(projectId);
    expect(convs.length).toBeGreaterThanOrEqual(2);
    // Verify descending order
    for (let i = 1; i < convs.length; i++) {
      expect(convs[i - 1]!.updatedAt.getTime()).toBeGreaterThanOrEqual(convs[i]!.updatedAt.getTime());
    }
  });

  test("getConversation returns conversation by id", async () => {
    const created = await createConversation(projectId, { title: "Find Me" });
    const found = await getConversation(created.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.title).toBe("Find Me");
  });

  test("getConversation returns null for missing id", async () => {
    const found = await getConversation("nonexistent-id");
    expect(found).toBeNull();
  });

  test("updateConversation updates title and updatedAt", async () => {
    const conv = await createConversation(projectId, { title: "Old Title" });
    const updated = await updateConversation(conv.id, { title: "New Title" });
    expect(updated).not.toBeNull();
    expect(updated!.title).toBe("New Title");
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(conv.updatedAt.getTime());
  });

  test("updateConversation updates model and provider", async () => {
    const conv = await createConversation(projectId);
    const updated = await updateConversation(conv.id, { model: "claude-sonnet-4-20250514", provider: "anthropic" });
    expect(updated!.model).toBe("claude-sonnet-4-20250514");
    expect(updated!.provider).toBe("anthropic");
  });

  test("deleteConversation removes conversation", async () => {
    const conv = await createConversation(projectId, { title: "Delete Me" });
    await deleteConversation(conv.id);
    const found = await getConversation(conv.id);
    expect(found).toBeNull();
  });
});

describe("messages", () => {
  let conversationId: string;

  beforeEach(async () => {
    const conv = await createConversation(projectId, { title: "Messages Test" });
    conversationId = conv.id;
  });

  test("createMessage returns a message", async () => {
    const msg = await createMessage(conversationId, {
      role: "user",
      content: "Hello!",
    });
    expect(msg.id).toBeDefined();
    expect(msg.conversationId).toBe(conversationId);
    expect(msg.role).toBe("user");
    expect(msg.content).toBe("Hello!");
    expect(msg.model).toBeNull();
    expect(msg.provider).toBeNull();
    expect(msg.usage).toBeNull();
    expect(msg.runId).toBeNull();
    expect(msg.createdAt).toBeInstanceOf(Date);
  });

  test("createMessage with model, provider, usage, runId", async () => {
    const msg = await createMessage(conversationId, {
      role: "assistant",
      content: "Hi there!",
      model: "gpt-4o",
      provider: "openai",
      usage: { inputTokens: 10, outputTokens: 20 },
    });
    expect(msg.model).toBe("gpt-4o");
    expect(msg.provider).toBe("openai");
    expect(msg.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  test("createMessage touches conversation updatedAt", async () => {
    const convBefore = await getConversation(conversationId);
    // Small delay to ensure timestamp difference
    await new Promise((r) => setTimeout(r, 10));
    await createMessage(conversationId, { role: "user", content: "bump" });
    const convAfter = await getConversation(conversationId);
    expect(convAfter!.updatedAt.getTime()).toBeGreaterThanOrEqual(convBefore!.updatedAt.getTime());
  });

  test("getMessages returns messages sorted by createdAt asc", async () => {
    await createMessage(conversationId, { role: "user", content: "First" });
    await createMessage(conversationId, { role: "assistant", content: "Second" });
    await createMessage(conversationId, { role: "user", content: "Third" });

    const msgs = await getMessages(conversationId);
    expect(msgs.length).toBe(3);
    expect(msgs[0]!.content).toBe("First");
    expect(msgs[1]!.content).toBe("Second");
    expect(msgs[2]!.content).toBe("Third");
    // Verify ascending order
    for (let i = 1; i < msgs.length; i++) {
      expect(msgs[i]!.createdAt.getTime()).toBeGreaterThanOrEqual(msgs[i - 1]!.createdAt.getTime());
    }
  });

  test("deleting conversation cascades to messages", async () => {
    await createMessage(conversationId, { role: "user", content: "Will be deleted" });
    await deleteConversation(conversationId);
    const msgs = await getMessages(conversationId);
    expect(msgs.length).toBe(0);
  });
});

describe("branching", () => {
  let conversationId: string;

  beforeEach(async () => {
    const conv = await createConversation(projectId, { title: "Branch Test" });
    conversationId = conv.id;
  });

  test("createMessage with parentMessageId links to parent", async () => {
    const msg1 = await createMessage(conversationId, { role: "user", content: "First" });
    const msg2 = await createMessage(conversationId, {
      role: "assistant",
      content: "Reply",
      parentMessageId: msg1.id,
    });
    expect(msg2.parentMessageId).toBe(msg1.id);
  });

  test("getConversationPath walks from leaf to root and returns ordered path", async () => {
    const msg1 = await createMessage(conversationId, { role: "user", content: "First" });
    await new Promise(r => setTimeout(r, 10)); // ensure distinct timestamps
    const msg2 = await createMessage(conversationId, {
      role: "assistant",
      content: "Second",
      parentMessageId: msg1.id,
    });
    await new Promise(r => setTimeout(r, 10));
    const msg3 = await createMessage(conversationId, {
      role: "user",
      content: "Third",
      parentMessageId: msg2.id,
    });

    const path = await getConversationPath(msg3.id, conversationId);
    expect(path).toHaveLength(3);
    expect(path[0]!.id).toBe(msg1.id);
    expect(path[1]!.id).toBe(msg2.id);
    expect(path[2]!.id).toBe(msg3.id);
  });

  test("getConversationPath on a branched conversation returns only the active branch", async () => {
    const msg1 = await createMessage(conversationId, { role: "user", content: "Root" });
    await new Promise((r) => setTimeout(r, 10)); // ensure distinct timestamps
    const msg2 = await createMessage(conversationId, {
      role: "assistant",
      content: "Reply A",
      parentMessageId: msg1.id,
    });
    await new Promise((r) => setTimeout(r, 10));
    // Branch: msg3 is a sibling of msg2 (both have msg1 as parent)
    const msg3 = await createMessage(conversationId, {
      role: "assistant",
      content: "Reply B (branch)",
      parentMessageId: msg1.id,
    });
    await new Promise((r) => setTimeout(r, 10));
    const msg4 = await createMessage(conversationId, {
      role: "user",
      content: "Follow-up on B",
      parentMessageId: msg3.id,
    });

    // Path from msg4 should include msg1 -> msg3 -> msg4 (not msg2)
    const path = await getConversationPath(msg4.id, conversationId);
    expect(path).toHaveLength(3);
    expect(path[0]!.id).toBe(msg1.id);
    expect(path[1]!.id).toBe(msg3.id);
    expect(path[2]!.id).toBe(msg4.id);
    expect(path.find((m) => m.id === msg2.id)).toBeUndefined();
  });

  test("getSiblings returns all messages sharing the same parentMessageId", async () => {
    const root = await createMessage(conversationId, { role: "user", content: "Root" });
    const a = await createMessage(conversationId, {
      role: "assistant",
      content: "Reply A",
      parentMessageId: root.id,
    });
    const b = await createMessage(conversationId, {
      role: "assistant",
      content: "Reply B",
      parentMessageId: root.id,
    });
    const c = await createMessage(conversationId, {
      role: "assistant",
      content: "Reply C",
      parentMessageId: root.id,
    });

    const siblings = await getSiblings(root.id);
    expect(siblings).toHaveLength(3);
    expect(siblings.map((s) => s.id)).toContain(a.id);
    expect(siblings.map((s) => s.id)).toContain(b.id);
    expect(siblings.map((s) => s.id)).toContain(c.id);
  });

  test("getLatestLeaf returns the most recent message with no children", async () => {
    const msg1 = await createMessage(conversationId, { role: "user", content: "Root" });
    const msg2 = await createMessage(conversationId, {
      role: "assistant",
      content: "Reply",
      parentMessageId: msg1.id,
    });
    const msg3 = await createMessage(conversationId, {
      role: "user",
      content: "Follow-up",
      parentMessageId: msg2.id,
    });

    const leaf = await getLatestLeaf(conversationId);
    expect(leaf).not.toBeNull();
    expect(leaf!.id).toBe(msg3.id);
  });
});

describe("memoriesUsed attachment", () => {
  let convId: string;

  // Seed a run into the runs table with a synthetic result payload. This mirrors what
  // the executor persists at runtime (executor.ts:1200) without spinning up the full
  // streaming pipeline — we only care that getMessages/getConversationPath surface
  // `run.result.output.memoriesUsed` on assistant rows.
  async function seedRun(
    runId: string,
    output: { memoriesUsed?: { id: string; content: string; category: string }[]; fullText?: string } | null,
  ) {
    const { getDb } = await import("../db/connection");
    const { runs } = await import("../db/schema");
    await getDb().insert(runs).values({
      id: runId,
      agentName: "chat",
      projectId: null,
      status: "success",
      input: null,
      startedAt: new Date(),
      finishedAt: new Date(),
      result: output === null ? null : { success: true, output },
      createdAt: new Date(),
    });
  }

  beforeEach(async () => {
    const conv = await createConversation(projectId, { title: "MemoriesUsed Test" });
    convId = conv.id;
  });

  test("getMessages attaches memoriesUsed from run.result.output to assistant messages", async () => {
    await seedRun("run-with-mem", {
      fullText: "response",
      memoriesUsed: [
        { id: "m1", content: "User likes dark mode", category: "preferences" },
        { id: "m2", content: "Uses TypeScript", category: "technical" },
      ],
    });
    await createMessage(convId, { role: "user", content: "Hi" });
    await createMessage(convId, {
      role: "assistant",
      content: "Hello!",
      runId: "run-with-mem",
    });

    const msgs = await getMessages(convId);
    expect(msgs.length).toBe(2);
    const userMsg = msgs.find((m) => m.role === "user")!;
    const asst = msgs.find((m) => m.role === "assistant")!;

    // User messages never get memoriesUsed attached
    expect((userMsg as any).memoriesUsed).toBeUndefined();

    // Assistant message gets the full memoriesUsed array
    expect((asst as any).memoriesUsed).toBeDefined();
    expect((asst as any).memoriesUsed).toHaveLength(2);
    expect((asst as any).memoriesUsed[0]).toEqual({
      id: "m1",
      content: "User likes dark mode",
      category: "preferences",
    });
    expect((asst as any).memoriesUsed[1]!.category).toBe("technical");
  });

  test("getMessages omits memoriesUsed when run has empty memoriesUsed array", async () => {
    await seedRun("run-empty-mem", { fullText: "response", memoriesUsed: [] });
    await createMessage(convId, {
      role: "assistant",
      content: "Hello",
      runId: "run-empty-mem",
    });

    const msgs = await getMessages(convId);
    expect((msgs[0] as any).memoriesUsed).toBeUndefined();
  });

  test("getMessages omits memoriesUsed when run.result.output has no memoriesUsed field", async () => {
    await seedRun("run-no-mem", { fullText: "text only" });
    await createMessage(convId, {
      role: "assistant",
      content: "Hello",
      runId: "run-no-mem",
    });

    const msgs = await getMessages(convId);
    expect((msgs[0] as any).memoriesUsed).toBeUndefined();
  });

  test("getMessages omits memoriesUsed when run.result is null", async () => {
    await seedRun("run-null-result", null);
    await createMessage(convId, {
      role: "assistant",
      content: "Hello",
      runId: "run-null-result",
    });

    const msgs = await getMessages(convId);
    expect((msgs[0] as any).memoriesUsed).toBeUndefined();
  });

  test("getMessages leaves messages unchanged when assistant message has no runId", async () => {
    await createMessage(convId, {
      role: "assistant",
      content: "Hello without a run",
    });

    const msgs = await getMessages(convId);
    expect(msgs.length).toBe(1);
    expect((msgs[0] as any).memoriesUsed).toBeUndefined();
  });

  test("getMessages is a no-op when an assistant message's run was deleted (runId set to null by FK cascade)", async () => {
    // messages.run_id has ON DELETE SET NULL — when a run is purged, the surviving
    // message row just has runId=null. attachMemoriesUsed must skip it cleanly.
    await seedRun("run-will-die", {
      memoriesUsed: [{ id: "m1", content: "doomed", category: "technical" }],
    });
    await createMessage(convId, {
      role: "assistant",
      content: "Hello",
      runId: "run-will-die",
    });

    // Delete the run — the message's runId becomes null via FK cascade.
    const { getDb } = await import("../db/connection");
    const { runs } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");
    await getDb().delete(runs).where(eq(runs.id, "run-will-die"));

    const msgs = await getMessages(convId);
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.runId).toBeNull();
    expect((msgs[0] as any).memoriesUsed).toBeUndefined();
  });

  test("getMessages attaches memoriesUsed only to assistant rows (not user rows even if runId set)", async () => {
    // Edge case: if a user row somehow had a runId, it must NOT receive memoriesUsed.
    // This guards the `role === "assistant"` filter in attachMemoriesUsed.
    await seedRun("run-user-edge", {
      memoriesUsed: [{ id: "m1", content: "should not leak", category: "preferences" }],
    });
    await createMessage(convId, {
      role: "user",
      content: "user with runId",
      runId: "run-user-edge",
    });
    await createMessage(convId, {
      role: "assistant",
      content: "response",
      runId: "run-user-edge",
    });

    const msgs = await getMessages(convId);
    const userMsg = msgs.find((m) => m.role === "user")!;
    const asst = msgs.find((m) => m.role === "assistant")!;
    expect((userMsg as any).memoriesUsed).toBeUndefined();
    expect((asst as any).memoriesUsed).toHaveLength(1);
  });

  test("getMessages batches: multiple assistant messages sharing a runId both get memoriesUsed", async () => {
    await seedRun("run-shared", {
      memoriesUsed: [{ id: "m1", content: "shared", category: "technical" }],
    });
    const m1 = await createMessage(convId, {
      role: "assistant",
      content: "first chunk",
      runId: "run-shared",
    });
    await createMessage(convId, {
      role: "assistant",
      content: "second chunk",
      runId: "run-shared",
      parentMessageId: m1.id,
    });

    const msgs = await getMessages(convId);
    const assistants = msgs.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(2);
    for (const a of assistants) {
      expect((a as any).memoriesUsed).toHaveLength(1);
      expect((a as any).memoriesUsed[0]!.id).toBe("m1");
    }
  });

  test("getConversationPath (recursive CTE) also attaches memoriesUsed", async () => {
    // getConversationPath uses a different code path (raw SQL CTE) — make sure
    // attachMemoriesUsed runs there too.
    await seedRun("run-path", {
      memoriesUsed: [{ id: "m1", content: "on the path", category: "preferences" }],
    });
    const root = await createMessage(convId, { role: "user", content: "hi" });
    const leaf = await createMessage(convId, {
      role: "assistant",
      content: "hello",
      runId: "run-path",
      parentMessageId: root.id,
    });

    const path = await getConversationPath(leaf.id, convId);
    expect(path.length).toBe(2);
    const asst = path.find((m) => m.role === "assistant")!;
    expect((asst as any).memoriesUsed).toHaveLength(1);
    expect((asst as any).memoriesUsed[0]!.content).toBe("on the path");
  });

  test("getMessages returns empty list unchanged (no runs query fired)", async () => {
    const msgs = await getMessages(convId);
    expect(msgs).toEqual([]);
  });
});

describe("search", () => {
  let searchProjectId: string;

  beforeAll(async () => {
    const project = await createProject({ name: "Search Project", path: "/tmp/search" });
    searchProjectId = project.id;

    const conv1 = await createConversation(searchProjectId, { title: "Recipe discussion" });
    await createMessage(conv1.id, { role: "user", content: "How do I make chocolate cake?" });
    await createMessage(conv1.id, { role: "assistant", content: "Here is a recipe for delicious chocolate cake with frosting." });

    const conv2 = await createConversation(searchProjectId, { title: "TypeScript help" });
    await createMessage(conv2.id, { role: "user", content: "How do I use generics in TypeScript?" });
    await createMessage(conv2.id, { role: "assistant", content: "Generics allow you to create reusable components." });
  });

  test("searchConversations finds matches in message content and returns snippets", async () => {
    const results = await searchConversations(searchProjectId, "chocolate cake");
    expect(results.length).toBeGreaterThanOrEqual(1);
    const match = results.find((r) => r.title === "Recipe discussion");
    expect(match).toBeDefined();
    expect(match!.snippet).toBeDefined();
  });

  test("searchConversations finds matches in conversation titles", async () => {
    const results = await searchConversations(searchProjectId, "TypeScript");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.title === "TypeScript help")).toBe(true);
  });

  test("searchConversations with empty/short query returns empty (not error)", async () => {
    const empty = await searchConversations(searchProjectId, "");
    expect(empty).toEqual([]);
    const short = await searchConversations(searchProjectId, "a");
    expect(short).toEqual([]);
  });
});

describe("systemPrompt", () => {
  let spProjectId: string;

  beforeEach(async () => {
    const project = await createProject({ name: "SP Project", path: "/tmp/sp" });
    spProjectId = project.id;
  });

  test("resolveSystemPrompt returns conversation-level when set", async () => {
    const conv = await createConversation(spProjectId, { title: "SP Test" });
    await updateConversation(conv.id, { systemPrompt: "You are a helpful chef." });

    const prompt = await resolveSystemPrompt(conv.id, spProjectId);
    expect(prompt).toBe("You are a helpful chef.");
  });

  test("resolveSystemPrompt falls back to project-level setting", async () => {
    const conv = await createConversation(spProjectId, { title: "SP Test 2" });
    await upsertSetting(`project:${spProjectId}:systemPrompt`, "Project-level instructions");

    const prompt = await resolveSystemPrompt(conv.id, spProjectId);
    expect(prompt).toBe("Project-level instructions");

    // Cleanup
    await deleteSetting(`project:${spProjectId}:systemPrompt`);
  });

  test("resolveSystemPrompt falls back to global setting", async () => {
    const conv = await createConversation(spProjectId, { title: "SP Test 3" });
    await upsertSetting("global:systemPrompt", "Global instructions");

    const prompt = await resolveSystemPrompt(conv.id, spProjectId);
    expect(prompt).toBe("Global instructions");

    // Cleanup
    await deleteSetting("global:systemPrompt");
  });

  test("resolveSystemPrompt returns undefined when none set", async () => {
    const conv = await createConversation(spProjectId, { title: "SP Test 4" });

    const prompt = await resolveSystemPrompt(conv.id, spProjectId);
    expect(prompt).toBeUndefined();
  });

  test("project setting overrides global setting", async () => {
    const conv = await createConversation(spProjectId, { title: "SP Override Test" });
    await upsertSetting("global:systemPrompt", "Global instructions");
    await upsertSetting(`project:${spProjectId}:systemPrompt`, "Project instructions");

    const prompt = await resolveSystemPrompt(conv.id, spProjectId);
    expect(prompt).toBe("Project instructions");

    await deleteSetting("global:systemPrompt");
    await deleteSetting(`project:${spProjectId}:systemPrompt`);
  });

  test("conversation overrides both project and global settings", async () => {
    const conv = await createConversation(spProjectId, { title: "SP Full Override" });
    await upsertSetting("global:systemPrompt", "Global instructions");
    await upsertSetting(`project:${spProjectId}:systemPrompt`, "Project instructions");
    await updateConversation(conv.id, { systemPrompt: "Conversation instructions" });

    const prompt = await resolveSystemPrompt(conv.id, spProjectId);
    expect(prompt).toBe("Conversation instructions");

    await deleteSetting("global:systemPrompt");
    await deleteSetting(`project:${spProjectId}:systemPrompt`);
  });

  test("resolveSystemPrompt with global project id respects chain", async () => {
    const conv = await createConversation("global", { title: "Global Project Test" });
    await upsertSetting("project:global:systemPrompt", "Global project instructions");

    const prompt = await resolveSystemPrompt(conv.id, "global");
    expect(prompt).toBe("Global project instructions");

    await deleteSetting("project:global:systemPrompt");
  });

  test("global project falls back to global setting when no project setting", async () => {
    const conv = await createConversation("global", { title: "Global Fallback Test" });
    await upsertSetting("global:systemPrompt", "Global fallback");

    const prompt = await resolveSystemPrompt(conv.id, "global");
    expect(prompt).toBe("Global fallback");

    await deleteSetting("global:systemPrompt");
  });
});

// ── ECF control plane (L1): per-(project, extension) service conversation ──
describe("getOrCreateExtServiceConversation + getProjectByPath", () => {
  let svcProjectId: string;
  let svcProjectPath: string;
  let gateUserId: string;

  beforeAll(async () => {
    svcProjectPath = `/repos/svc-${crypto.randomUUID()}`;
    const project = await createProject({ name: "Svc App", path: svcProjectPath });
    svcProjectId = project.id;
    const user = await createUser({ email: `gate-${crypto.randomUUID()}@t.com`, passwordHash: "h", name: "Gate" });
    gateUserId = user.id;
  });

  test("getProjectByPath resolves a registered path, and is undefined for unknown / empty", async () => {
    const found = await getProjectByPath(svcProjectPath);
    expect(found?.id).toBe(svcProjectId);
    expect(await getProjectByPath("/repos/does-not-exist")).toBeUndefined();
    expect(await getProjectByPath("")).toBeUndefined();
  });

  test("creates a kind='ext-service' conversation carrying the real projectId + gate owner + mapping key", async () => {
    const conv = await getOrCreateExtServiceConversation({
      extensionName: "ez-code-factory",
      projectId: svcProjectId,
      userId: gateUserId,
      title: "ez-code-factory gate — Svc App",
    });
    expect(conv.kind).toBe("ext-service");
    expect(conv.projectId).toBe(svcProjectId);
    expect(conv.userId).toBe(gateUserId);
    expect(conv.title).toBe("ez-code-factory gate — Svc App");
    // The find-or-create mapping was recorded under the documented key.
    const mapped = await getSetting(`ext:ez-code-factory:service-conv:${svcProjectId}`);
    expect(mapped).toBe(conv.id);
  });

  test("is idempotent — a second call reuses the SAME conversation (find-or-create)", async () => {
    const first = await getOrCreateExtServiceConversation({
      extensionName: "idem-ext",
      projectId: svcProjectId,
      userId: gateUserId,
      title: "idem-ext gate — Svc App",
    });
    const second = await getOrCreateExtServiceConversation({
      extensionName: "idem-ext",
      projectId: svcProjectId,
      userId: gateUserId,
      title: "idem-ext gate — Svc App",
    });
    expect(second.id).toBe(first.id);
  });

  test("a stale mapping (conversation deleted) is recreated, not resurrected", async () => {
    const created = await getOrCreateExtServiceConversation({
      extensionName: "stale-ext",
      projectId: svcProjectId,
      userId: gateUserId,
      title: "stale-ext gate — Svc App",
    });
    await deleteConversation(created.id);
    const recreated = await getOrCreateExtServiceConversation({
      extensionName: "stale-ext",
      projectId: svcProjectId,
      userId: gateUserId,
      title: "stale-ext gate — Svc App",
    });
    expect(recreated.id).not.toBe(created.id);
    expect(recreated.kind).toBe("ext-service");
  });

  test("listConversations EXCLUDES service conversations (never pollute chat lists)", async () => {
    const svc = await getOrCreateExtServiceConversation({
      extensionName: "list-ext",
      projectId: svcProjectId,
      userId: gateUserId,
      title: "list-ext gate — Svc App",
    });
    // A regular conversation in the same project DOES list.
    const regular = await createConversation(svcProjectId, { title: "Regular", userId: gateUserId });
    const listed = await listConversations(svcProjectId);
    const ids = listed.map((c) => c.id);
    expect(ids).toContain(regular.id);
    expect(ids).not.toContain(svc.id);
  });

  test("createConversation honors kind:'ext-service'", async () => {
    const conv = await createConversation(svcProjectId, { title: "Direct svc", kind: "ext-service" });
    expect(conv.kind).toBe("ext-service");
  });
});
