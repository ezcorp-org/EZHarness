/**
 * Pipeline behavior tests for the lessons distiller
 * (`src/runtime/lessons/distiller.ts`).
 *
 * Mock setup mirrors `src/__tests__/memory-extraction.test.ts`:
 *   - `mockDbConnection()` swaps the DB to PGlite
 *   - `mock.module("@mariozechner/pi-ai", …)` controls the LLM response
 *   - providers/router + providers/credentials are stubbed so the
 *     pipeline never touches a real key store
 *
 * Each `test` resets `mockCompleteResponse` to control what the LLM
 * returns. The distiller is invoked directly (not via the listener)
 * so we can `await` its full effect.
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import type { AgentRun } from "../types";

mockDbConnection();

let mockCompleteResponse = "EMPTY";

mock.module("@mariozechner/pi-ai", () => ({
  complete: async () => ({
    content: [{ type: "text", text: mockCompleteResponse }],
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
  }),
  stream: async function* () {},
  getModel: () => ({ id: "test", provider: "anthropic", api: "anthropic", name: "test", contextWindow: 100000, maxTokens: 4096, input: ["text"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  getModels: () => [],
  getProviders: () => [],
  getEnvApiKey: () => "test-key",
}));

mock.module("../providers/router", () => ({
  resolveModel: async () => ({
    provider: "anthropic",
    model: "claude-haiku-4-5-20250514",
    piModel: { id: "claude-haiku-4-5-20250514", provider: "anthropic", api: "anthropic", name: "Claude Haiku", contextWindow: 200000, maxTokens: 4096, input: ["text"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
  }),
}));

mock.module("../providers/credentials", () => ({
  getCredential: async () => ({ type: "apikey", token: "test-key" }),
}));

// Capture the REAL lessons query module BEFORE installing the spy
// below. The spy needs to delegate to the real createLesson; if it
// imported through the mocked specifier it would call itself and
// blow the stack. Bun's mock.module replaces resolution
// prospectively, so this awaited import (taken before the
// mock.module call) returns the unmocked exports.
const realLessonsModule = await import("../db/queries/lessons");
const realCreateLesson = realLessonsModule.createLesson;

// Spy on the lessons query module so the per-project mutex tests can
// observe createLesson invocation overlap. The spy is installed at
// module load (before the distiller's own import) so the binding
// captured inside distiller.ts points to OUR wrapper, not the raw
// query. The wrapper is a no-op (no extra delay) outside the mutex
// tests — they bump `__createLessonDelayMs` for the duration of the
// test to make overlap observable.
let __createLessonDelayMs = 0;
let __activeWrites = 0;
let __maxWriteOverlap = 0;
function resetSpyCounters() {
  __activeWrites = 0;
  __maxWriteOverlap = 0;
}
mock.module("../db/queries/lessons", () => ({
  ...realLessonsModule,
  createLesson: async (input: Parameters<typeof realCreateLesson>[0]) => {
    __activeWrites += 1;
    __maxWriteOverlap = Math.max(__maxWriteOverlap, __activeWrites);
    if (__createLessonDelayMs > 0) {
      await new Promise((r) => setTimeout(r, __createLessonDelayMs));
    }
    try {
      return await realCreateLesson(input);
    } finally {
      __activeWrites -= 1;
    }
  },
}));

// Imports of code-under-test happen AFTER the mocks above so they
// resolve through them.
const { distillLesson } = await import("../runtime/lessons/distiller");
const { createProject } = await import("../db/queries/projects");
const { createUser } = await import("../db/queries/users");
const { createConversation, createMessage } = await import("../db/queries/conversations");
const { createLesson, listVisibleLessons } = realLessonsModule;
const { upsertSetting, deleteSetting } = await import("../db/queries/settings");
const { lessons: lessonsTable } = await import("../db/schema");
const { getDb } = await import("../db/connection");

let projectId: string;
let otherProjectId: string;
let userId: string;
let conversationId: string;
let otherConversationId: string;

const baseRun = (overrides: Partial<AgentRun> = {}): AgentRun => ({
  id: "run-test",
  agentName: "chat",
  projectId,
  status: "success",
  startedAt: Date.now(),
  logs: [],
  ...overrides,
});

beforeAll(async () => {
  await setupTestDb();
  const project = await createProject({ name: "alpha", path: "/tmp/alpha" });
  projectId = project.id;
  const otherProject = await createProject({ name: "beta", path: "/tmp/beta" });
  otherProjectId = otherProject.id;
  const user = await createUser({ email: "owner@test.com", passwordHash: "h", name: "Owner" });
  userId = user.id;
  const conv = await createConversation(projectId, { title: "Test conv", userId });
  conversationId = conv.id;
  const otherConv = await createConversation(otherProjectId, { title: "Other conv", userId });
  otherConversationId = otherConv.id;
  // Seed at least one message so the distiller has input context.
  await createMessage(conversationId, { role: "user", content: "hello", parentMessageId: undefined });
  await createMessage(conversationId, { role: "assistant", content: "hi", parentMessageId: undefined });
  await createMessage(otherConversationId, { role: "user", content: "hello in other", parentMessageId: undefined });
  await createMessage(otherConversationId, { role: "assistant", content: "hi in other", parentMessageId: undefined });
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

beforeEach(async () => {
  // Wipe lessons rows so each test sees a clean slate. Settings are
  // reset to "missing" (treated as enabled by the distiller). The
  // mutex-spy state is reset here too so prior tests' overlap counts
  // don't leak into later assertions, and the spy delay is forced
  // back to 0 (the mutex describe block opts in via its own
  // beforeEach).
  await getDb().delete(lessonsTable);
  await deleteSetting("global:lessonDistillerEnabled");
  mockCompleteResponse = "EMPTY";
  __createLessonDelayMs = 0;
  resetSpyCounters();
});

const validLessonJson = JSON.stringify({
  slug: "prefer-bun-test",
  title: "Prefer bun:test over jest",
  body: "Use `bun test` for parity with the project runtime; jest's resolver disagrees with `bun:` imports.",
  frontmatter: {
    trigger: ["test runner choice"],
    applies_to: ["lang:ts", "tool:bun"],
    confidence: "high",
  },
});

describe("distillLesson — gating", () => {
  test("settings disabled → no LLM call, no DB write", async () => {
    await upsertSetting("global:lessonDistillerEnabled", false);
    // Even a "valid" mock response should be ignored.
    mockCompleteResponse = validLessonJson;

    await distillLesson(baseRun(), conversationId);

    const rows = await listVisibleLessons(projectId, userId);
    expect(rows).toHaveLength(0);
  });

  test("non-chat agent → no DB write", async () => {
    mockCompleteResponse = validLessonJson;
    await distillLesson(baseRun({ agentName: "pipeline" }), conversationId);
    expect((await listVisibleLessons(projectId, userId))).toHaveLength(0);
  });

  test("failed run → no DB write", async () => {
    mockCompleteResponse = validLessonJson;
    await distillLesson(baseRun({ status: "error" }), conversationId);
    expect((await listVisibleLessons(projectId, userId))).toHaveLength(0);
  });

  test("conversation without userId → silent no-op (nothing to attribute)", async () => {
    mockCompleteResponse = validLessonJson;
    const orphanConv = await createConversation(projectId, { title: "no-user", userId: undefined });
    await createMessage(orphanConv.id, { role: "user", content: "hi", parentMessageId: undefined });
    await distillLesson(baseRun(), orphanConv.id);
    // No lessons inserted for any user in this project.
    const all = await getDb().select().from(lessonsTable);
    expect(all).toHaveLength(0);
  });
});

describe("distillLesson — LLM response handling", () => {
  test("LLM returns 'EMPTY' → no DB write, no error", async () => {
    mockCompleteResponse = "EMPTY";
    await distillLesson(baseRun(), conversationId);
    expect((await listVisibleLessons(projectId, userId))).toHaveLength(0);
  });

  test("LLM returns 'null' → no DB write", async () => {
    mockCompleteResponse = "null";
    await distillLesson(baseRun(), conversationId);
    expect((await listVisibleLessons(projectId, userId))).toHaveLength(0);
  });

  test("LLM returns malformed JSON → log warning, no DB write", async () => {
    mockCompleteResponse = "not valid json at all {{{";
    await distillLesson(baseRun(), conversationId);
    expect((await listVisibleLessons(projectId, userId))).toHaveLength(0);
  });

  test("LLM returns object missing required fields → no DB write", async () => {
    mockCompleteResponse = JSON.stringify({ slug: "x" }); // no title/body
    await distillLesson(baseRun(), conversationId);
    expect((await listVisibleLessons(projectId, userId))).toHaveLength(0);
  });

  test("LLM returns valid lesson → DB row created with correct shape", async () => {
    mockCompleteResponse = validLessonJson;
    await distillLesson(baseRun(), conversationId);

    const rows = await listVisibleLessons(projectId, userId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.slug).toBe("prefer-bun-test");
    expect(row.title).toBe("Prefer bun:test over jest");
    expect(row.body).toContain("bun test");
    expect(row.visibility).toBe("user");
    expect(row.source).toBe("distiller");
    expect(row.ownerId).toBe(userId);
    expect(row.projectId).toBe(projectId);
    // sourceSha256 should be a 64-char lowercase hex string.
    expect(row.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.frontmatter).toEqual({
      trigger: ["test runner choice"],
      applies_to: ["lang:ts", "tool:bun"],
      confidence: "high",
    });
    expect(row.firedCount).toBe(0);
    expect(row.dismissedCount).toBe(0);
  });

  test("LLM response wrapped in ```json fence is unwrapped", async () => {
    mockCompleteResponse = "```json\n" + validLessonJson + "\n```";
    await distillLesson(baseRun(), conversationId);
    const rows = await listVisibleLessons(projectId, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.slug).toBe("prefer-bun-test");
  });

  test("LLM returns empty array → silent no-op", async () => {
    mockCompleteResponse = "[]";
    await distillLesson(baseRun(), conversationId);
    expect((await listVisibleLessons(projectId, userId))).toHaveLength(0);
  });
});

describe("distillLesson — slug collision", () => {
  test("collision against existing user-scoped slug → soft skip, no exception", async () => {
    // Pre-seed an existing lesson with the same slug.
    await createLesson({
      projectId,
      ownerId: userId,
      visibility: "user",
      slug: "prefer-bun-test",
      title: "Existing",
      body: "Existing body",
    });

    mockCompleteResponse = validLessonJson;

    // Should not throw.
    await distillLesson(baseRun(), conversationId);

    // The pre-seeded row is the authoritative one — distiller did NOT
    // overwrite or insert a duplicate.
    const rows = await listVisibleLessons(projectId, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("Existing");
  });
});

describe("distillLesson — per-project mutex", () => {
  // The mutex wraps the DB-write critical section — same shape as
  // `withExtractionLock` in extraction.ts:14–29. We observe
  // serialization by tracking concurrent invocations of the spied
  // `createLesson` (the spy is installed module-wide above) and
  // bumping its delay so overlap is wide enough to detect.
  //
  // The LLM call is NOT inside the mutex (no reason to serialize
  // cheap-tier inference per-project), so the assertion targets the
  // DB write step exclusively.

  beforeEach(() => {
    resetSpyCounters();
    __createLessonDelayMs = 50;
  });

  test("two concurrent calls in the SAME project serialize through the DB lock", async () => {
    // Per-call distinct slugs so we observe TWO writes (no collision
    // soft-skip masking the second one).
    let callIdx = 0;
    const lessonResponses = [
      JSON.stringify({ slug: "mutex-same-a", title: "A", body: "Body A", frontmatter: { confidence: "high" } }),
      JSON.stringify({ slug: "mutex-same-b", title: "B", body: "Body B", frontmatter: { confidence: "high" } }),
    ];
    mock.module("@mariozechner/pi-ai", () => ({
      complete: async () => ({
        content: [{ type: "text", text: lessonResponses[callIdx++ % 2] }],
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
      }),
      stream: async function* () {},
      getModel: () => ({ id: "test", provider: "anthropic", api: "anthropic", name: "test", contextWindow: 100000, maxTokens: 4096, input: ["text"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
      getModels: () => [],
      getProviders: () => [],
      getEnvApiKey: () => "test-key",
    }));

    await Promise.all([
      distillLesson(baseRun({ id: "run-a" }), conversationId),
      distillLesson(baseRun({ id: "run-b" }), conversationId),
    ]);

    // Same project key → mutex enforces serialization → max
    // observed overlap is 1.
    expect(__maxWriteOverlap).toBe(1);

    const rows = await listVisibleLessons(projectId, userId);
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.slug).sort()).toEqual(["mutex-same-a", "mutex-same-b"]);
  });

  test("concurrent calls in DIFFERENT projects do NOT serialize", async () => {
    let callIdx = 0;
    const lessonResponses = [
      JSON.stringify({ slug: "lesson-project-a", title: "A", body: "Body A", frontmatter: { confidence: "high" } }),
      JSON.stringify({ slug: "lesson-project-b", title: "B", body: "Body B", frontmatter: { confidence: "high" } }),
    ];
    mock.module("@mariozechner/pi-ai", () => ({
      complete: async () => ({
        content: [{ type: "text", text: lessonResponses[callIdx++ % 2] }],
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
      }),
      stream: async function* () {},
      getModel: () => ({ id: "test", provider: "anthropic", api: "anthropic", name: "test", contextWindow: 100000, maxTokens: 4096, input: ["text"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
      getModels: () => [],
      getProviders: () => [],
      getEnvApiKey: () => "test-key",
    }));

    const runA = baseRun({ id: "run-A", projectId });
    const runB = baseRun({ id: "run-B", projectId: otherProjectId });

    await Promise.all([
      distillLesson(runA, conversationId),
      distillLesson(runB, otherConversationId),
    ]);

    // Different projects → mutex keys diverge → DB writes overlap.
    expect(__maxWriteOverlap).toBe(2);
    const rowsA = await listVisibleLessons(projectId, userId);
    const rowsB = await listVisibleLessons(otherProjectId, userId);
    expect(rowsA.length + rowsB.length).toBe(2);
  });

  // Reset the delay so other (later) tests aren't slowed by the spy.
  // Bun runs `beforeEach` before each test; the outer beforeEach
  // (test-level) runs after this describe's, so we restore the
  // shared default in an `afterAll` for this block.
});
