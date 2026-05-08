/**
 * Phase 53 Stage 1 — golden-file parity test for the lessons-distiller
 * port. The bundled-extension code path
 * (`extensions/lessons-distiller/index.ts`) MUST produce the same
 * `DistillationOutcome` discriminant + payload as the legacy host-side
 * `runDistillation` (`src/runtime/lessons/distiller.ts`) for every one
 * of the 7 outcome variants:
 *
 *   1. success
 *   2. decline:slug_collision
 *   3. decline:trigger_gate_blocked
 *   4. decline:empty_conversation
 *   5. decline:llm_empty
 *   6. decline:llm_malformed
 *   7. error:llm_error  (proves error-class parity; db_error / internal
 *      reach the same shape via the same `kind: "error"` branch — they
 *      surface different `reason`s in real callers but the parity gate
 *      is structural.)
 *
 * The test uses the fixture at
 * `src/__tests__/fixtures/distiller-parity-conversation.json`. Both
 * paths feed the same conversation slice through a mocked LLM — the
 * legacy path via `mock.module("@mariozechner/pi-ai", …)` and the new
 * path via the extension's `_setRuntimeApiForTests` seam. Both write
 * to the same DB so the slug-collision case can compare row identity.
 *
 * This test ships in Stage 1 and gets deleted in Stage 2 — once the
 * legacy code is gone, there's no second pipeline to compare against.
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import fixture from "./fixtures/distiller-parity-conversation.json";

mockDbConnection();

// ── pi-ai mock — controls what BOTH pipelines see from the LLM ──────
let mockCompleteResponse = "EMPTY";
let mockCompleteShouldThrow = false;

mock.module("@mariozechner/pi-ai", () => ({
  complete: async () => {
    if (mockCompleteShouldThrow) throw new Error("simulated LLM API failure");
    return {
      content: [{ type: "text", text: mockCompleteResponse }],
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
    };
  },
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

// ── Imports of code-under-test (after mocks above) ──────────────────
const { runDistillation } = await import("../runtime/lessons/distiller");
const distillerExt = await import("../../extensions/lessons-distiller/index");
const { distill: extensionDistill, _setRuntimeApiForTests, _resetRuntimeApiForTests } =
  distillerExt;
const { createProject } = await import("../db/queries/projects");
const { createUser } = await import("../db/queries/users");
const { createConversation, createMessage } = await import("../db/queries/conversations");
const { createLesson } = await import("../db/queries/lessons");
const { lessons: lessonsTable } = await import("../db/schema");
const { getDb } = await import("../db/connection");
const { listToolCallsByConversation } = await import("../db/queries/tool-calls");
const triggers = await import("../runtime/lessons/triggers");

let projectId: string;
let userId: string;
let conversationId: string;
let emptyConversationId: string;

beforeAll(async () => {
  await setupTestDb();
  const project = await createProject({ name: "parity", path: "/tmp/parity" });
  projectId = project.id;
  const user = await createUser({ email: "parity@test.com", passwordHash: "h", name: "Parity" });
  userId = user.id;

  // Seed the "main" conversation from the fixture's recent_messages.
  const conv = await createConversation(projectId, { title: "fixture", userId });
  conversationId = conv.id;
  for (const m of fixture.recent_messages) {
    await createMessage(conversationId, {
      role: m.role,
      content: m.content,
      parentMessageId: undefined,
    });
  }

  // Empty conversation for the empty_conversation outcome.
  const empty = await createConversation(projectId, { title: "empty", userId });
  emptyConversationId = empty.id;
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

beforeEach(async () => {
  await getDb().delete(lessonsTable);
  mockCompleteResponse = "EMPTY";
  mockCompleteShouldThrow = false;
  _resetRuntimeApiForTests();
});

// ── Wire the extension's runtimeApi to host helpers (parity setup) ──
//
// The extension normally talks to the host via `ezcorp/invoke` JSON-RPC
// (handled by `runtime-invoke-handler.ts`) and `ctx.lessons.write`
// (handled by `lessons-handler.ts`). For an in-process parity test we
// short-circuit those round-trips by binding the extension's
// runtime-API seam to the SAME host helpers the legacy path uses. This
// keeps the test focused on the EXTENSION CODE — anything that diverges
// shows up as an outcome mismatch, not an RPC plumbing artifact.
function wireExtensionToHost(opts: { projectId: string; userId: string }): void {
  _setRuntimeApiForTests({
    async getMessages(conversationId: string) {
      const { getMessages } = await import("../db/queries/conversations");
      const rows = await getMessages(conversationId);
      return rows.map((m) => ({
        id: m.id,
        role: m.role,
        content: typeof m.content === "string" ? m.content : String(m.content ?? ""),
      }));
    },
    async getMessagesEnvelope(conversationId: string) {
      const { getMessages, getConversation } = await import("../db/queries/conversations");
      const rows = await getMessages(conversationId);
      const conv = await getConversation(conversationId);
      return {
        messages: rows.map((m) => ({
          id: m.id,
          role: m.role,
          content: typeof m.content === "string" ? m.content : String(m.content ?? ""),
        })),
        projectId: conv?.projectId ?? null,
      };
    },
    async triggerGate(conversationId: string) {
      const toolCallRows = await listToolCallsByConversation(conversationId);
      const { getMessages } = await import("../db/queries/conversations");
      const rows = await getMessages(conversationId);
      const recent = rows.slice(-20);
      const userTexts = recent
        .filter((m) => m.role === "user")
        .map((m) => (typeof m.content === "string" ? m.content : String(m.content ?? "")));
      const fire = triggers.shouldDistill({
        toolCallCount: toolCallRows.length,
        errorRecoveryObserved: triggers.detectErrorRecovery(
          toolCallRows.map((r) => ({ status: r.success ? "ok" as const : "error" as const })),
        ),
        userCorrectionObserved: triggers.detectUserCorrection(userTexts),
        explicitlyTagged: triggers.detectExplicitTag(userTexts),
      });
      return { shouldDistill: fire };
    },
    async llmComplete() {
      // Re-use the same mocked pi-ai response.
      if (mockCompleteShouldThrow) throw new Error("simulated LLM API failure");
      return { content: mockCompleteResponse };
    },
    async lessonsWrite(input): Promise<{
      lesson: import("../../extensions/lessons-distiller/index").DistilledLessonRecord | null;
      created: boolean;
    }> {
      try {
        const inserted = await createLesson({
          projectId: input.projectId,
          ownerId: opts.userId,
          visibility: "user",
          slug: input.slug,
          title: input.title,
          body: input.body,
          frontmatter: input.frontmatter ?? null,
          source: "distiller",
          // sha256 is internal to the legacy path; the parity test
          // doesn't compare it. Use a stable placeholder.
          sourceSha256: "parity-test-sha",
        });
        return {
          lesson: {
            id: inserted.id,
            slug: inserted.slug,
            title: inserted.title,
            body: inserted.body,
            visibility: inserted.visibility,
            frontmatter: inserted.frontmatter as Record<string, unknown> | null,
          },
          created: true,
        };
      } catch (err) {
        // Slug-collision soft outcome: re-fetch and return existing.
        // Walk the cause chain (Drizzle wraps the PG error) to find
        // SQLSTATE 23505 — same logic as the legacy `isUniqueViolationError`.
        let cur: unknown = err;
        let isUnique = false;
        for (let hops = 0; hops < 5 && cur != null; hops++) {
          const code = (cur as { code?: string }).code;
          const message = (cur as { message?: string }).message;
          if (code === "23505") { isUnique = true; break; }
          if (typeof message === "string" && /duplicate key|unique constraint/i.test(message)) {
            isUnique = true;
            break;
          }
          const next = (cur as { cause?: unknown }).cause;
          if (next === cur) break;
          cur = next;
        }
        if (!isUnique) throw err;
        const existing = await getDb()
          .select()
          .from(lessonsTable);
        const match = existing.find(
          (l: typeof existing[number]) =>
            l.slug === input.slug &&
            l.projectId === input.projectId &&
            l.ownerId === opts.userId,
        );
        return {
          lesson: match
            ? {
                id: match.id,
                slug: match.slug,
                title: match.title,
                body: match.body,
                visibility: match.visibility,
                frontmatter: match.frontmatter as Record<string, unknown> | null,
              }
            : null,
          created: false,
        };
      }
    },
    async getMySettings() {
      // Parity test exercises distill() directly with explicit
      // settings, so this path is unused. Return defaults.
      return { enabled: true, provider: "google", model: "" };
    },
  });
}

// Helpers — invoke each path with a single conversationId and a flag
// for whether to bypass the trigger gate. Both return the same outcome
// shape; we compare structurally.
async function runOldPath(opts: {
  conversationId: string;
  skipTriggerGate: boolean;
}): Promise<unknown> {
  return runDistillation({
    conversationId: opts.conversationId,
    projectId,
    ownerId: userId,
    skipTriggerGate: opts.skipTriggerGate,
  });
}

async function runNewPath(opts: {
  conversationId: string;
  skipTriggerGate: boolean;
}): Promise<unknown> {
  wireExtensionToHost({ projectId, userId });
  return extensionDistill({
    conversationId: opts.conversationId,
    skipTriggerGate: opts.skipTriggerGate,
    settings: {},
    projectId,
  });
}

const validLesson = JSON.stringify({
  slug: fixture.expected_lesson_slug,
  title: fixture.expected_lesson_title,
  body: "Use parameterized queries instead of string concatenation when building SQL with user input. Drizzle's `eq()` does this automatically.",
  frontmatter: {
    trigger: ["string-concat in SQL", "SQL injection"],
    applies_to: ["lang:ts", "tool:drizzle", "domain:auth"],
    confidence: "high",
  },
});

// ─────────────────────────────────────────────────────────────────────
describe("distiller port parity — outcome shape", () => {
  test("variant 1: success → both paths produce success with identical slug+title", async () => {
    mockCompleteResponse = validLesson;

    const oldOutcome = await runOldPath({
      conversationId, skipTriggerGate: true,
    }) as { kind: string; lesson?: { slug?: string; title?: string } };
    expect(oldOutcome.kind).toBe("success");
    const oldSlug = oldOutcome.lesson?.slug;

    // Reset DB for the new-path run so the slug doesn't collide.
    await getDb().delete(lessonsTable);

    const newOutcome = await runNewPath({
      conversationId, skipTriggerGate: true,
    }) as { kind: string; lesson?: { slug?: string; title?: string } };
    expect(newOutcome.kind).toBe("success");
    expect(newOutcome.lesson?.slug).toBe(oldSlug);
    expect(newOutcome.lesson?.title).toBe(oldOutcome.lesson?.title);
  });

  test("variant 2: slug_collision → both paths produce decline with the existing slug", async () => {
    mockCompleteResponse = validLesson;

    // Pre-seed a colliding lesson so BOTH paths hit the unique-index.
    await createLesson({
      projectId,
      ownerId: userId,
      visibility: "user",
      slug: fixture.expected_lesson_slug,
      title: "Pre-existing parity lesson",
      body: "Already captured.",
      frontmatter: null,
      source: "distiller",
      sourceSha256: "preseed-sha",
    });

    const oldOutcome = await runOldPath({
      conversationId, skipTriggerGate: true,
    }) as { kind: string; reason?: string; existingSlug?: string };
    expect(oldOutcome.kind).toBe("decline");
    expect(oldOutcome.reason).toBe("slug_collision");
    expect(oldOutcome.existingSlug).toBe(fixture.expected_lesson_slug);

    const newOutcome = await runNewPath({
      conversationId, skipTriggerGate: true,
    }) as { kind: string; reason?: string; existingSlug?: string };
    expect(newOutcome.kind).toBe("decline");
    expect(newOutcome.reason).toBe("slug_collision");
    expect(newOutcome.existingSlug).toBe(fixture.expected_lesson_slug);
  });

  test("variant 3: trigger_gate_blocked → both decline (auto-listener path; manual handler bypasses)", async () => {
    // Empty conversation has no tool calls and no [lesson] tag, so the
    // trigger gate should block both paths.
    const oldOutcome = await runOldPath({
      conversationId: emptyConversationId, skipTriggerGate: false,
    }) as { kind: string; reason?: string };
    // Empty conversation actually short-circuits at empty_conversation
    // BEFORE the gate runs in the legacy path. Use a NON-empty
    // low-signal conversation to specifically exercise the gate.

    // Spin up a low-signal conv: two benign messages, no tool calls,
    // no [lesson] tag.
    const lowSignal = await createConversation(projectId, { title: "lowsignal", userId });
    await createMessage(lowSignal.id, { role: "user", content: "good morning", parentMessageId: undefined });
    await createMessage(lowSignal.id, { role: "assistant", content: "morning!", parentMessageId: undefined });

    const oldGateBlocked = await runOldPath({
      conversationId: lowSignal.id, skipTriggerGate: false,
    }) as { kind: string; reason?: string };
    expect(oldGateBlocked.kind).toBe("decline");
    expect(oldGateBlocked.reason).toBe("trigger_gate_blocked");

    const newGateBlocked = await runNewPath({
      conversationId: lowSignal.id, skipTriggerGate: false,
    }) as { kind: string; reason?: string };
    expect(newGateBlocked.kind).toBe("decline");
    expect(newGateBlocked.reason).toBe("trigger_gate_blocked");

    // Reference oldOutcome to silence linter on intentional first call.
    void oldOutcome;
  });

  test("variant 4: empty_conversation → both decline", async () => {
    mockCompleteResponse = validLesson;

    const oldOutcome = await runOldPath({
      conversationId: emptyConversationId, skipTriggerGate: true,
    }) as { kind: string; reason?: string };
    expect(oldOutcome.kind).toBe("decline");
    expect(oldOutcome.reason).toBe("empty_conversation");

    const newOutcome = await runNewPath({
      conversationId: emptyConversationId, skipTriggerGate: true,
    }) as { kind: string; reason?: string };
    expect(newOutcome.kind).toBe("decline");
    expect(newOutcome.reason).toBe("empty_conversation");
  });

  test("variant 5: llm_empty → both decline silently", async () => {
    mockCompleteResponse = "EMPTY";

    const oldOutcome = await runOldPath({
      conversationId, skipTriggerGate: true,
    }) as { kind: string; reason?: string };
    expect(oldOutcome.kind).toBe("decline");
    expect(oldOutcome.reason).toBe("llm_empty");

    const newOutcome = await runNewPath({
      conversationId, skipTriggerGate: true,
    }) as { kind: string; reason?: string };
    expect(newOutcome.kind).toBe("decline");
    expect(newOutcome.reason).toBe("llm_empty");
  });

  test("variant 6: llm_malformed → both decline with detail", async () => {
    mockCompleteResponse = "this is definitely not json {{{";

    const oldOutcome = await runOldPath({
      conversationId, skipTriggerGate: true,
    }) as { kind: string; reason?: string; detail?: string };
    expect(oldOutcome.kind).toBe("decline");
    expect(oldOutcome.reason).toBe("llm_malformed");
    expect(typeof oldOutcome.detail).toBe("string");

    const newOutcome = await runNewPath({
      conversationId, skipTriggerGate: true,
    }) as { kind: string; reason?: string; detail?: string };
    expect(newOutcome.kind).toBe("decline");
    expect(newOutcome.reason).toBe("llm_malformed");
    expect(typeof newOutcome.detail).toBe("string");
  });

  test("variant 7: llm_error → both surface error variant", async () => {
    mockCompleteShouldThrow = true;

    const oldOutcome = await runOldPath({
      conversationId, skipTriggerGate: true,
    }) as { kind: string; reason?: string };
    expect(oldOutcome.kind).toBe("error");
    expect(oldOutcome.reason).toBe("llm_error");

    const newOutcome = await runNewPath({
      conversationId, skipTriggerGate: true,
    }) as { kind: string; reason?: string };
    expect(newOutcome.kind).toBe("error");
    expect(newOutcome.reason).toBe("llm_error");
  });
});

describe("distiller port parity — output content for the success path", () => {
  test("body contains the keyword 'parameterized' (fixture invariant)", async () => {
    mockCompleteResponse = validLesson;

    const oldOutcome = await runOldPath({
      conversationId, skipTriggerGate: true,
    }) as { kind: string; lesson?: { body?: string } };
    expect(oldOutcome.kind).toBe("success");
    expect(oldOutcome.lesson?.body).toContain("parameterized");

    await getDb().delete(lessonsTable);

    const newOutcome = await runNewPath({
      conversationId, skipTriggerGate: true,
    }) as { kind: string; lesson?: { body?: string } };
    expect(newOutcome.kind).toBe("success");
    expect(newOutcome.lesson?.body).toContain("parameterized");
    // Content equality across paths.
    expect(newOutcome.lesson?.body).toBe(oldOutcome.lesson?.body);
  });
});
