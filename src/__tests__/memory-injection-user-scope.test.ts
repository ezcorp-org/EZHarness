// Regression test for the cross-user PII disclosure bug: LLM memory injection
// into the system prompt was scoped by PROJECT only, with no per-user filter.
// In a SHARED project, user B's chat would get user A's private auto-extracted
// memories injected into the prompt — even though every other memory read path
// enforces per-user ownership (`ownedByActingUser` in
// src/extensions/memory-handler.ts, the single-row CRUD routes, etc.).
//
// The fix threads the acting user through the injection path
// (buildSystemPromptWithMemories → hybridSearch) and applies the SAME two
// ownership shapes as ownedByActingUser:
//   (1) memories.user_id === actingUser      (directly-attributed rows)
//   (2) user_id IS NULL, source conversation owned by actingUser
//       (host-extracted rows — dedup/compaction don't stamp user_id)
// A null/unowned actor matches neither shape → ZERO memories (fail-closed).
//
// This test runs against real PGlite and proves BOTH ownership shapes survive
// for the owner while a co-tenant (and a null owner) get nothing.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection, mockRealSettings } from "./helpers/test-pglite";
import { mockEmbedding, mockEmbeddingsModule } from "./helpers/mock-vectors";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { MemoryProvenance } from "../memory/types";

mockDbConnection();
mockRealSettings();
mockEmbeddingsModule();

const { insertMemory, getMemoryById } = await import("../db/queries/memories");
const { buildSystemPromptWithMemories } = await import("../memory/injection");
const { hybridSearch } = await import("../memory/retrieval");
const { createProject } = await import("../db/queries/projects");
const { createConversation } = await import("../db/queries/conversations");
const { getDb } = await import("../db/connection");
const { users } = await import("../db/schema");

const USER_A = "user-a";
const USER_B = "user-b";

let projectId: string;
let convAId: string;

// Directly-attributed to user A (shape 1).
let memAAttributed: { id: string };
// Host-extracted for user A: user_id NULL, conversation owned by user A (shape 2).
let memAExtracted: { id: string };
// Directly-attributed to user B (shape 1).
let memB: { id: string };
// Fully-orphaned: user_id NULL AND conversation_id NULL — owned by no one.
let memOrphan: { id: string };
// Owned by user A but flagged injection-ineligible (injection_eligible=false).
let memAIneligible: { id: string };

function makeProvenance(): MemoryProvenance {
  return {
    sourceConversationId: convAId,
    sourceMessageIds: ["msg-user-scope-test"],
    extractedAt: new Date(),
    confidence: "high",
    history: [{ action: "created", timestamp: new Date(), reason: "test" }],
  };
}

beforeAll(async () => {
  await setupTestDb();

  await getDb().insert(users).values([
    { id: USER_A, email: "user-a@test.local", name: "User A", passwordHash: "fake-hash" },
    { id: USER_B, email: "user-b@test.local", name: "User B", passwordHash: "fake-hash" },
  ]).onConflictDoNothing();

  const project = await createProject({ name: "proj-shared", path: "/tmp/proj-shared" });
  projectId = project.id;

  // A conversation OWNED by user A — the ownership anchor for shape-2 memories.
  const convA = await createConversation(projectId, { title: "A's conversation", userId: USER_A });
  convAId = convA.id;

  const embedding = mockEmbedding();

  // Shape 1 — directly attributed to user A.
  memAAttributed = await insertMemory({
    content: "Alpha attributed secret belonging to user A",
    category: "biographical",
    projectId,
    conversationId: convAId,
    userId: USER_A,
    confidence: "high",
    embedding,
    provenance: makeProvenance(),
  });

  // Shape 2 — host-extracted for user A: user_id NULL, owner via conversation.
  memAExtracted = await insertMemory({
    content: "Alpha extracted secret belonging to user A",
    category: "biographical",
    projectId,
    conversationId: convAId,
    // userId intentionally omitted → NULL
    confidence: "high",
    embedding,
    provenance: makeProvenance(),
  });

  // Shape 1 — directly attributed to user B.
  memB = await insertMemory({
    content: "Bravo secret belonging to user B",
    category: "biographical",
    projectId,
    userId: USER_B,
    confidence: "high",
    embedding,
    provenance: makeProvenance(),
  });

  // Fully-orphaned — user_id NULL AND conversation_id NULL.
  memOrphan = await insertMemory({
    content: "Orphan secret with no owner at all",
    category: "biographical",
    projectId,
    // no userId, no conversationId → unattributable
    confidence: "high",
    embedding,
    provenance: makeProvenance(),
  });

  // Owned by user A but injection-ineligible — the injection path must skip it,
  // while owner-scoped CRUD/search still returns it.
  memAIneligible = await insertMemory({
    content: "Ineligible secret belonging to user A",
    category: "biographical",
    projectId,
    conversationId: convAId,
    userId: USER_A,
    injectionEligible: false,
    confidence: "high",
    embedding,
    provenance: makeProvenance(),
  });
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

describe("memory injection — per-user PII scope (cross-user leak regression)", () => {
  test("hybridSearch as user B returns ONLY user B's memory", async () => {
    const results = await hybridSearch("secret", mockEmbedding(), { projectId, userId: USER_B });
    const ids = results.map((r) => r.id);
    expect(ids).toContain(memB.id);
    // The leak: none of user A's memories (either shape) nor the orphan.
    expect(ids).not.toContain(memAAttributed.id);
    expect(ids).not.toContain(memAExtracted.id);
    expect(ids).not.toContain(memOrphan.id);
    const contents = results.map((r) => r.content).join("\n");
    expect(contents).not.toContain("belonging to user A");
    expect(contents).not.toContain("Orphan secret");
  });

  test("hybridSearch as user A returns BOTH of user A's ownership shapes, not user B's", async () => {
    const results = await hybridSearch("secret", mockEmbedding(), { projectId, userId: USER_A });
    const ids = results.map((r) => r.id);
    // Shape 1 (attributed) AND shape 2 (extracted, owned via conversation).
    expect(ids).toContain(memAAttributed.id);
    expect(ids).toContain(memAExtracted.id);
    // Not the co-tenant's, not the orphan.
    expect(ids).not.toContain(memB.id);
    expect(ids).not.toContain(memOrphan.id);
  });

  test("hybridSearch with a null acting user returns ZERO memories (fail-closed)", async () => {
    const results = await hybridSearch("secret", mockEmbedding(), { projectId, userId: null });
    expect(results).toHaveLength(0);
  });

  test("buildSystemPromptWithMemories injects ONLY the acting user's memories (user B)", async () => {
    const result = await buildSystemPromptWithMemories("You are an assistant.", "secret", projectId, USER_B);
    expect(result.systemPrompt).toContain("Bravo secret belonging to user B");
    // The leak the fix closes: user A's private memories must NOT appear.
    expect(result.systemPrompt).not.toContain("belonging to user A");
    expect(result.systemPrompt).not.toContain("Orphan secret");
    const usedIds = result.memoriesUsed.map((m) => m.id);
    expect(usedIds).toContain(memB.id);
    expect(usedIds).not.toContain(memAAttributed.id);
    expect(usedIds).not.toContain(memAExtracted.id);
  });

  test("buildSystemPromptWithMemories injects both of user A's shapes, not user B's", async () => {
    const result = await buildSystemPromptWithMemories("You are an assistant.", "secret", projectId, USER_A);
    expect(result.systemPrompt).toContain("Alpha attributed secret belonging to user A");
    expect(result.systemPrompt).toContain("Alpha extracted secret belonging to user A");
    expect(result.systemPrompt).not.toContain("belonging to user B");
  });

  test("buildSystemPromptWithMemories with a null owner injects NOTHING (fail-closed)", async () => {
    const result = await buildSystemPromptWithMemories("Base prompt.", "secret", projectId, null);
    expect(result.systemPrompt).toBe("Base prompt.");
    expect(result.memoriesUsed).toEqual([]);
  });

  test("the excluded memories still exist in storage (scope filters reads, not rows)", async () => {
    // Sanity: user A's memories weren't deleted — they're simply invisible to
    // user B's injection. CRUD (owner-scoped) still returns them.
    expect(await getMemoryById(memAAttributed.id)).toBeDefined();
    expect(await getMemoryById(memAExtracted.id)).toBeDefined();
  });
});

describe("memory injection — injection_eligible enforcement", () => {
  test("an injection-ineligible memory owned by the acting user is NOT injected", async () => {
    const result = await buildSystemPromptWithMemories("You are an assistant.", "secret", projectId, USER_A);
    expect(result.systemPrompt).not.toContain("Ineligible secret");
    expect(result.memoriesUsed.map((m) => m.id)).not.toContain(memAIneligible.id);
    // The eligible ones for the same user still inject — proves it's the flag,
    // not the user scope, doing the exclusion here.
    expect(result.systemPrompt).toContain("Alpha attributed secret belonging to user A");
  });

  test("the ineligible memory still exists (CRUD) and is visible to non-injection search", async () => {
    const row = await getMemoryById(memAIneligible.id);
    expect(row).toBeDefined();
    expect(row?.injectionEligible).toBe(false);
    // hybridSearch WITHOUT injectionEligibleOnly (search/palette path) still
    // returns it — the eligibility filter is opt-in to the injection path.
    const results = await hybridSearch("secret", mockEmbedding(), { projectId, userId: USER_A });
    expect(results.map((r) => r.id)).toContain(memAIneligible.id);
  });
});
