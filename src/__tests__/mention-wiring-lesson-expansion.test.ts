/**
 * Unit tests for `applyLessonExpansion` in `src/runtime/mention-wiring.ts`.
 *
 * Sister test to `mention-wiring-feature.test.ts`. The function takes a
 * `LessonResolver` callback so this layer is DB-free — every test passes
 * a deterministic in-memory resolver. The REAL DB-backed resolver
 * (via `getLessonBySlug(projectId, ownerId, slug)`) is wired by Phase 4
 * in `src/runtime/stream-chat/build-prompt.ts` and exercised by its
 * own integration test there.
 *
 * Coverage targets (per Phase 2.4 of tasks/lessons-keeper-v1.md and the
 * scout-review caps that block this from landing without enforcement):
 *
 *   1. Per-turn count cap — 10 unique tokens collapse to exactly 5
 *      blocks; the remaining 5 are dropped silently.
 *   2. Per-turn byte cap — 8 KB ceiling — large bodies accumulate until
 *      one would push the joined output past 8 KB; that block (and any
 *      later ones) is dropped.
 *   3. Silent no-op on missing slug (resolver returns null) — no error,
 *      no system note, no `onFired`.
 *   4. Dedup — same slug repeated in the message expands ONCE; resolver
 *      called once; `onFired` invoked once.
 *   5. `onFired` invocation — lessonId values + call count match the
 *      blocks emitted (NOT the tokens parsed).
 *   6. Empty / no-token input → empty string + no resolver / `onFired`
 *      activity.
 *   7. Source order preserved — first-occurrence wins for dedup, and
 *      blocks appear in source order (NOT alphabetical / resolver
 *      order).
 */
import { test, expect, describe, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

import {
  applyLessonExpansion,
  LESSON_TOKEN_RE,
  type LessonResolver,
} from "../runtime/mention-wiring";

// ── Resolver factories ────────────────────────────────────────────────

interface FakeLesson {
  title: string;
  body: string;
  lessonId: string;
}

/**
 * Resolver that looks slugs up in a fixed dictionary. Unknown slugs
 * resolve to `null` (the silent-no-op path in the expander).
 */
function dictResolver(byName: Record<string, FakeLesson>): LessonResolver {
  return async (slug: string) => byName[slug] ?? null;
}

/**
 * Resolver that records the order of slugs it's been asked for, in
 * addition to looking them up. Lets tests assert resolver-call counts
 * AND the cap short-circuits without invoking the resolver further.
 */
function recordingResolver(byName: Record<string, FakeLesson>): {
  resolve: LessonResolver;
  calls: string[];
} {
  const calls: string[] = [];
  const resolve: LessonResolver = async (slug) => {
    calls.push(slug);
    return byName[slug] ?? null;
  };
  return { resolve, calls };
}

/** Factory that builds a fake lesson with a body of EXACT length `bodyLen`. */
function makeLesson(slug: string, bodyLen: number): FakeLesson {
  // "x" repeated to exactly bodyLen so per-block size is predictable.
  return {
    title: `Title for ${slug}`,
    body: "x".repeat(bodyLen),
    lessonId: `id-${slug}`,
  };
}

// ── Per-turn count cap ────────────────────────────────────────────────

describe("applyLessonExpansion — per-turn count cap (5)", () => {
  test("10 unique tokens → exactly 5 blocks, 5 dropped silently", async () => {
    const dict: Record<string, FakeLesson> = {};
    for (let i = 0; i < 10; i++) {
      dict[`s${i}`] = { title: `t${i}`, body: `body-${i}`, lessonId: `id-${i}` };
    }
    const fired: string[] = [];
    const message = Array.from({ length: 10 }, (_, i) => `%[lesson:s${i}]`).join(" ");
    const out = await applyLessonExpansion(message, dictResolver(dict), (id) => {
      fired.push(id);
    });

    const blockCount = (out.match(/\*\*Lesson: /g) ?? []).length;
    expect(blockCount).toBe(5);
    expect(fired).toHaveLength(5);
    // First five (source-order) are the ones that survived.
    expect(fired).toEqual(["id-0", "id-1", "id-2", "id-3", "id-4"]);
    // The 6th-10th lessons must NOT appear in the output.
    for (let i = 5; i < 10; i++) {
      expect(out).not.toContain(`Title: t${i}`);
      expect(out).not.toContain(`body-${i}`);
    }
  });

  test("cap counts BLOCKS, not tokens — duplicates don't waste slots", async () => {
    // 5 unique slugs each duplicated 3× = 15 tokens, but only 5 unique
    // → all 5 should expand.
    const dict: Record<string, FakeLesson> = {};
    for (let i = 0; i < 5; i++) {
      dict[`u${i}`] = { title: `t${i}`, body: `b${i}`, lessonId: `id-${i}` };
    }
    const tokens = Array.from({ length: 5 }, (_, i) => `%[lesson:u${i}]`);
    const message = [...tokens, ...tokens, ...tokens].join(" ");
    const fired: string[] = [];
    const out = await applyLessonExpansion(message, dictResolver(dict), (id) => {
      fired.push(id);
    });

    const blockCount = (out.match(/\*\*Lesson: /g) ?? []).length;
    expect(blockCount).toBe(5);
    expect(fired).toEqual(["id-0", "id-1", "id-2", "id-3", "id-4"]);
  });
});

// ── Per-turn byte cap ─────────────────────────────────────────────────

describe("applyLessonExpansion — 8 KB total-expanded-chars cap", () => {
  test("blocks accumulate until adding the next would exceed 8 KB; later blocks dropped", async () => {
    // 3 KB body each + ~25 chars of "**Lesson: …**\n" framing.
    // Block 1: ~3 KB total, totalChars ~= 3KB.
    // Block 2: + 2 chars separator + 3 KB = ~6 KB. Still under.
    // Block 3: + 2 + 3 KB = ~9 KB. Over 8 KB → dropped, stop here.
    const dict: Record<string, FakeLesson> = {
      a: makeLesson("a", 3 * 1024),
      b: makeLesson("b", 3 * 1024),
      c: makeLesson("c", 3 * 1024),
      d: makeLesson("d", 3 * 1024),
    };
    const fired: string[] = [];
    const out = await applyLessonExpansion(
      "%[lesson:a] %[lesson:b] %[lesson:c] %[lesson:d]",
      dictResolver(dict),
      (id) => fired.push(id),
    );
    const blockCount = (out.match(/\*\*Lesson: /g) ?? []).length;
    expect(blockCount).toBe(2);
    expect(fired).toEqual(["id-a", "id-b"]);
    // Output stays at-or-under the cap.
    expect(out.length).toBeLessThanOrEqual(8 * 1024);
    // c and d are NOT in the output.
    expect(out).not.toContain("Title for c");
    expect(out).not.toContain("Title for d");
  });

  test("byte cap is 'whole-block-or-nothing' — no partial truncation of a body", async () => {
    // Block 1: 7 KB body — fits comfortably (under 8 KB w/ framing).
    // Block 2: 2 KB body — would push joined output well past 8 KB → dropped whole.
    const dict: Record<string, FakeLesson> = {
      big: makeLesson("big", 7 * 1024),
      small: makeLesson("small", 2 * 1024),
    };
    const fired: string[] = [];
    const out = await applyLessonExpansion(
      "%[lesson:big] %[lesson:small]",
      dictResolver(dict),
      (id) => fired.push(id),
    );
    expect(out).toContain("Title for big");
    // The small lesson's framing is absent — proves it wasn't half-emitted.
    // (Body strings are all 'x' so a substring check on body alone is
    // ambiguous; the framing string is unique per slug.)
    expect(out).not.toContain("Title for small");
    // Exactly one block kept.
    expect((out.match(/\*\*Lesson: /g) ?? []).length).toBe(1);
    expect(fired).toEqual(["id-big"]);
  });

  test("a single oversized block (>8 KB on its own) is dropped — never half-emitted", async () => {
    // Body bigger than the cap. Even as the very first block, it
    // shouldn't be partially-emitted. Implementation drops it.
    const dict: Record<string, FakeLesson> = {
      huge: makeLesson("huge", 16 * 1024),
    };
    const fired: string[] = [];
    const out = await applyLessonExpansion(
      "%[lesson:huge]",
      dictResolver(dict),
      (id) => fired.push(id),
    );
    expect(out).toBe("");
    expect(fired).toEqual([]);
  });
});

// ── Silent no-op on missing slug ──────────────────────────────────────

describe("applyLessonExpansion — unknown / no-op cases", () => {
  test("unknown slug → empty string, no `onFired` call (silent no-op)", async () => {
    const { resolve, calls } = recordingResolver({});
    const fired: string[] = [];
    const out = await applyLessonExpansion(
      "%[lesson:nope]",
      resolve,
      (id) => fired.push(id),
    );
    expect(out).toBe("");
    expect(calls).toEqual(["nope"]); // resolver WAS asked
    expect(fired).toEqual([]); // but `onFired` was NOT called
  });

  test("mix of known + unknown emits ONLY the known block, fires only for that one", async () => {
    const dict: Record<string, FakeLesson> = {
      real: { title: "Real", body: "Real body", lessonId: "id-real" },
    };
    const fired: string[] = [];
    const out = await applyLessonExpansion(
      "%[lesson:real] %[lesson:ghost]",
      dictResolver(dict),
      (id) => fired.push(id),
    );
    expect(out).toContain("**Lesson: Real**");
    expect(out).not.toContain("ghost");
    expect(fired).toEqual(["id-real"]);
  });

  test("no tokens at all → empty string, resolver never called", async () => {
    const { resolve, calls } = recordingResolver({
      x: { title: "x", body: "x", lessonId: "id-x" },
    });
    const fired: string[] = [];
    const out = await applyLessonExpansion(
      "just plain text — no sigils here",
      resolve,
      (id) => fired.push(id),
    );
    expect(out).toBe("");
    expect(calls).toEqual([]);
    expect(fired).toEqual([]);
  });

  test("empty input → empty string", async () => {
    const { resolve, calls } = recordingResolver({});
    const fired: string[] = [];
    const out = await applyLessonExpansion("", resolve, (id) => fired.push(id));
    expect(out).toBe("");
    expect(calls).toEqual([]);
    expect(fired).toEqual([]);
  });

  test("`onFired` is optional — can be omitted entirely", async () => {
    const dict: Record<string, FakeLesson> = {
      x: { title: "X", body: "Body", lessonId: "id-x" },
    };
    const out = await applyLessonExpansion("%[lesson:x]", dictResolver(dict));
    expect(out).toBe("**Lesson: X**\nBody");
  });
});

// ── Dedup ─────────────────────────────────────────────────────────────

describe("applyLessonExpansion — dedup by slug", () => {
  test("same slug repeated → one resolver call, one block, one `onFired` call", async () => {
    const { resolve, calls } = recordingResolver({
      x: { title: "X", body: "Body of X", lessonId: "id-x" },
    });
    const fired: string[] = [];
    const out = await applyLessonExpansion(
      "%[lesson:x] middle %[lesson:x] tail %[lesson:x]",
      resolve,
      (id) => fired.push(id),
    );
    expect(calls).toEqual(["x"]);
    expect(fired).toEqual(["id-x"]);
    const blockCount = (out.match(/\*\*Lesson: /g) ?? []).length;
    expect(blockCount).toBe(1);
  });
});

// ── `onFired` invocation semantics ────────────────────────────────────

describe("applyLessonExpansion — onFired invocation", () => {
  test("fires exactly once per *included* (resolved + un-capped) lesson with correct lessonId", async () => {
    const dict: Record<string, FakeLesson> = {
      a: { title: "A", body: "body A", lessonId: "id-a" },
      b: { title: "B", body: "body B", lessonId: "id-b" },
      c: { title: "C", body: "body C", lessonId: "id-c" },
    };
    const fired: string[] = [];
    await applyLessonExpansion(
      "%[lesson:a] %[lesson:b] %[lesson:c]",
      dictResolver(dict),
      (id) => fired.push(id),
    );
    expect(fired).toEqual(["id-a", "id-b", "id-c"]);
  });

  test("does NOT fire for slugs dropped by the count cap", async () => {
    // 6 unique slugs but cap is 5 → the 6th should not invoke `onFired`.
    const dict: Record<string, FakeLesson> = {};
    for (let i = 0; i < 6; i++) {
      dict[`s${i}`] = { title: `t${i}`, body: `b${i}`, lessonId: `id-${i}` };
    }
    const message = Array.from({ length: 6 }, (_, i) => `%[lesson:s${i}]`).join(" ");
    const fired: string[] = [];
    await applyLessonExpansion(message, dictResolver(dict), (id) => fired.push(id));
    expect(fired).toEqual(["id-0", "id-1", "id-2", "id-3", "id-4"]);
    expect(fired).not.toContain("id-5");
  });
});

// ── Source-order preservation ─────────────────────────────────────────

describe("applyLessonExpansion — source order", () => {
  test("blocks appear in source order, not resolver / dictionary order", async () => {
    const dict: Record<string, FakeLesson> = {
      alpha: { title: "Alpha", body: "first-defined", lessonId: "id-alpha" },
      bravo: { title: "Bravo", body: "second-defined", lessonId: "id-bravo" },
    };
    // Source order: bravo first, then alpha. Output must mirror source.
    const out = await applyLessonExpansion(
      "%[lesson:bravo] then %[lesson:alpha]",
      dictResolver(dict),
    );
    const bIdx = out.indexOf("**Lesson: Bravo**");
    const aIdx = out.indexOf("**Lesson: Alpha**");
    expect(bIdx).toBeGreaterThanOrEqual(0);
    expect(aIdx).toBeGreaterThan(bIdx);
  });

  test("blocks are joined with exactly '\\n\\n' between them", async () => {
    const dict: Record<string, FakeLesson> = {
      a: { title: "A", body: "body-a", lessonId: "id-a" },
      b: { title: "B", body: "body-b", lessonId: "id-b" },
    };
    const out = await applyLessonExpansion(
      "%[lesson:a] %[lesson:b]",
      dictResolver(dict),
    );
    expect(out).toBe("**Lesson: A**\nbody-a\n\n**Lesson: B**\nbody-b");
  });
});

// ── LESSON_TOKEN_RE shape ─────────────────────────────────────────────

describe("LESSON_TOKEN_RE", () => {
  test("matches `%[lesson:slug]` and captures the slug", () => {
    const re = new RegExp(LESSON_TOKEN_RE.source, "g");
    const m = re.exec("see %[lesson:retry-on-429]");
    expect(m).not.toBeNull();
    expect(m![1]).toBe("retry-on-429");
  });

  test("does not match other sigils", () => {
    const re = new RegExp(LESSON_TOKEN_RE.source, "g");
    expect(re.exec("![agent:Bot]")).toBeNull();
    re.lastIndex = 0;
    expect(re.exec("@[file:src/a.ts]")).toBeNull();
    re.lastIndex = 0;
    expect(re.exec("/[cmd:foo]")).toBeNull();
    re.lastIndex = 0;
    expect(re.exec("$[feature:chat]")).toBeNull();
  });

  test("does not match unrelated %-sequences (printf, urlencode)", () => {
    const re = new RegExp(LESSON_TOKEN_RE.source, "g");
    expect(re.exec("%s and %d")).toBeNull();
    re.lastIndex = 0;
    expect(re.exec("100% complete")).toBeNull();
    re.lastIndex = 0;
    expect(re.exec("%20")).toBeNull();
  });
});
