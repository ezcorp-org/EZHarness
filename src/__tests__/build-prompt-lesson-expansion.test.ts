/**
 * Integration tests for the `%[lesson:…]` expansion path inside
 * `buildPromptInput` (`src/runtime/stream-chat/build-prompt.ts`).
 *
 * These exercise the wiring between:
 *   - `applyLessonExpansion` in `src/runtime/mention-wiring.ts` (Phase 2)
 *   - `getLessonBySlug(projectId, ownerId, slug)` in
 *     `src/db/queries/lessons.ts` (Phase 1)
 *   - `incrementFiredCount(lessonId)` (also Phase 1, fire-and-forget)
 *
 * Mocking strategy mirrors `build-prompt-feature.test.ts`: stub the lesson
 * + features + projects modules at the loader level, then import
 * `buildPromptInput` so its dynamic `await import()`s resolve to our
 * stubs.
 *
 * The Phase 4 plan calls out one critical end-to-end test: a single user
 * message containing 10 `%[lesson:…]` tokens should expand exactly 5 of
 * them and silently drop the rest. This proves the per-turn cap fires
 * correctly through the real call path (not just the unit-tested
 * `applyLessonExpansion` in isolation). That + four supporting cases:
 *
 *   1. Per-turn cap (10 → 5) end-to-end
 *   2. `onFired` actually invokes `incrementFiredCount`
 *   3. Unknown slug → silent no-op (no system note, no DB write, no error)
 *   4. Mixed feature + lesson tokens both resolve in the same turn
 *   5. Missing ownerId → expansion entirely skipped (resolver never called)
 */
import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

// ── Mock state ───────────────────────────────────────────────────────

interface FakeLesson {
  id: string;
  title: string;
  body: string;
}

let mockLessons: Record<string, FakeLesson> = {};
let getLessonShouldThrow = false;
let incrementShouldThrow = false;
const lessonCalls: Array<{ projectId: string; ownerId: string; slug: string }> = [];
const incrementCalls: string[] = [];

let mockFeatures: Record<string, {
  id: string;
  projectId: string;
  name: string;
  description: string;
  files: { relpath: string }[];
}> = {};

mock.module("../db/queries/projects", () => ({
  // build-prompt's @[file:…] block calls getProject(projectId). Return a
  // shape with no `path` so resolveFileMentions short-circuits without
  // touching the filesystem — these tests focus on lesson + feature only.
  getProject: async (id: string) => ({ id, path: undefined }),
}));

mock.module("../db/queries/features", () => ({
  getFeature: async (_projectId: string, name: string) => mockFeatures[name],
}));

mock.module("../db/queries/lessons", () => ({
  getLessonBySlug: async (projectId: string, ownerId: string, slug: string) => {
    lessonCalls.push({ projectId, ownerId, slug });
    if (getLessonShouldThrow) throw new Error("boom-lesson");
    return mockLessons[slug];
  },
  incrementFiredCount: async (lessonId: string) => {
    incrementCalls.push(lessonId);
    if (incrementShouldThrow) throw new Error("boom-increment");
  },
}));

mock.module("../db/queries/conversation-extensions", () => ({
  getConversationExtensionMimes: async (_id: string) => [],
}));

// IMPORTANT: import after the mocks register so the dynamic imports
// inside buildPromptInput resolve to our stubs.
import { buildPromptInput } from "../runtime/stream-chat/build-prompt";

beforeEach(() => {
  mockLessons = {};
  mockFeatures = {};
  getLessonShouldThrow = false;
  incrementShouldThrow = false;
  lessonCalls.length = 0;
  incrementCalls.length = 0;
});

// ── Per-turn cap end-to-end ──────────────────────────────────────────

describe("buildPromptInput — lesson expansion per-turn cap", () => {
  test("10 %[lesson:…] tokens → exactly 5 system notes; remaining 5 silently dropped", async () => {
    // Seed 10 distinct lessons with short bodies so the byte cap is
    // never the limiting factor — the COUNT cap (5) is what we're
    // testing here.
    for (let i = 1; i <= 10; i++) {
      mockLessons[`l${i}`] = { id: `id-${i}`, title: `T${i}`, body: `body ${i}` };
    }
    const message = Array.from({ length: 10 }, (_, i) => `%[lesson:l${i + 1}]`).join(" ");
    const result = await buildPromptInput(message, {
      projectId: "proj-1",
      ownerId: "user-1",
    });

    // Exactly 5 lesson blocks rendered (matches MAX_LESSON_EXPANSIONS_PER_TURN).
    const blockCount = (result.text.match(/\*\*Lesson: /g) ?? []).length;
    expect(blockCount).toBe(5);

    // First five (source-order) won; last five silently dropped.
    for (let i = 1; i <= 5; i++) {
      expect(result.text).toContain(`**Lesson: T${i}**`);
    }
    for (let i = 6; i <= 10; i++) {
      expect(result.text).not.toContain(`**Lesson: T${i}**`);
    }

    // onFired fires once per *included* lesson (5), not per token (10).
    expect(incrementCalls).toEqual(["id-1", "id-2", "id-3", "id-4", "id-5"]);

    // Resolver was called only for the slugs that actually consumed a
    // slot — applyLessonExpansion short-circuits once the cap hits, so
    // slugs 6..10 are never even looked up.
    expect(lessonCalls.map((c) => c.slug)).toEqual(["l1", "l2", "l3", "l4", "l5"]);
    // Every resolver call carried the (projectId, ownerId) pair from the
    // build-prompt options through unchanged.
    for (const call of lessonCalls) {
      expect(call.projectId).toBe("proj-1");
      expect(call.ownerId).toBe("user-1");
    }
  });
});

// ── onFired bumps firedCount ─────────────────────────────────────────

describe("buildPromptInput — onFired callback wiring", () => {
  test("known lesson → incrementFiredCount called once with the lesson id", async () => {
    mockLessons.welcome = { id: "lesson-welcome", title: "Welcome", body: "hello" };
    const result = await buildPromptInput("read %[lesson:welcome]", {
      projectId: "proj-1",
      ownerId: "user-1",
    });

    expect(result.text).toContain("**Lesson: Welcome**");
    // Increment ran exactly once with the resolved lesson id (NOT the
    // slug — the resolver maps slug→id inside build-prompt).
    expect(incrementCalls).toEqual(["lesson-welcome"]);
  });

  test("incrementFiredCount throwing does NOT block prompt build", async () => {
    mockLessons.welcome = { id: "lesson-welcome", title: "Welcome", body: "hello" };
    incrementShouldThrow = true;

    // The promise rejection from incrementFiredCount is swallowed by a
    // .catch in build-prompt. Hence: prompt still has the lesson block,
    // build-prompt does not throw.
    const result = await buildPromptInput("read %[lesson:welcome]", {
      projectId: "proj-1",
      ownerId: "user-1",
    });

    expect(result.text).toContain("**Lesson: Welcome**");
    // The increment was *attempted* (recorded) before throwing.
    expect(incrementCalls).toEqual(["lesson-welcome"]);
  });
});

// ── Unknown slug ─────────────────────────────────────────────────────

describe("buildPromptInput — lesson expansion no-op cases", () => {
  test("unknown slug → no system note, no error, no increment call", async () => {
    const result = await buildPromptInput("read %[lesson:does-not-exist]", {
      projectId: "proj-1",
      ownerId: "user-1",
    });

    // Resolver was queried (so we know the call path ran)…
    expect(lessonCalls).toEqual([
      { projectId: "proj-1", ownerId: "user-1", slug: "does-not-exist" },
    ]);
    // …but no system note prepended and no DB write.
    expect(result.text).toBe("read %[lesson:does-not-exist]");
    expect(result.text).not.toContain("**Lesson:");
    expect(incrementCalls).toEqual([]);
  });

  test("missing ownerId → expansion entirely skipped (resolver never called)", async () => {
    mockLessons.welcome = { id: "lesson-welcome", title: "Welcome", body: "hello" };
    // projectId set, ownerId omitted → block guard short-circuits.
    const result = await buildPromptInput("read %[lesson:welcome]", {
      projectId: "proj-1",
    });

    expect(result.text).toBe("read %[lesson:welcome]");
    expect(lessonCalls).toEqual([]);
    expect(incrementCalls).toEqual([]);
  });

  test("getLessonBySlug throwing → caught (non-fatal); user text passes through", async () => {
    getLessonShouldThrow = true;
    const result = await buildPromptInput("read %[lesson:welcome]", {
      projectId: "proj-1",
      ownerId: "user-1",
    });

    // try/catch in build-prompt swallows the error; original user text
    // still surfaces (no system note prepended).
    expect(result.text).toBe("read %[lesson:welcome]");
    expect(result.text).not.toContain("**Lesson:");
    expect(incrementCalls).toEqual([]);
  });
});

// ── Mixed feature + lesson tokens ────────────────────────────────────

describe("buildPromptInput — feature + lesson expansion together", () => {
  test("both $[feature:…] and %[lesson:…] notes prepend; lesson note ends up at the TOP", async () => {
    mockFeatures.bar = {
      id: "fbar",
      projectId: "proj-1",
      name: "bar",
      description: "Bar",
      files: [{ relpath: "src/bar/1.ts" }],
    };
    mockLessons.dont = {
      id: "lesson-dont",
      title: "Don't do X",
      body: "Avoid pattern X.",
    };

    const result = await buildPromptInput(
      "consider $[feature:bar] and %[lesson:dont]",
      { projectId: "proj-1", ownerId: "user-1" },
    );

    // Both blocks present.
    const lessonIdx = result.text.indexOf("**Lesson: Don't do X**");
    const featureIdx = result.text.indexOf("**Feature: bar**");
    const userIdx = result.text.indexOf("consider $[feature:bar]");
    expect(lessonIdx).toBeGreaterThanOrEqual(0);
    expect(featureIdx).toBeGreaterThanOrEqual(0);
    expect(userIdx).toBeGreaterThanOrEqual(0);

    // build-prompt prepends in this order:
    //   feature-note → THEN lesson-note (so lesson ends up FIRST).
    // The user message is last.
    expect(lessonIdx).toBeLessThan(featureIdx);
    expect(featureIdx).toBeLessThan(userIdx);

    // Both DB calls fired exactly once.
    expect(incrementCalls).toEqual(["lesson-dont"]);
    expect(lessonCalls.map((c) => c.slug)).toEqual(["dont"]);
  });
});
