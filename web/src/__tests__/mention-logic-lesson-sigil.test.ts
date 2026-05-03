/**
 * Pure-logic tests for the `%` (Lessons-Keeper) sigil added to
 * `web/src/lib/mention-logic.ts` as part of lessons-keeper v1 Phase 2.1.
 *
 * Coverage targets (per plan §2.1 + §2.4):
 *   - MENTION_REGEX picks up `%[lesson:name]` as kind="lesson" with the
 *     correct capture-group placement (groups 9 + 10).
 *   - parseMentions emits the correct token + offsets.
 *   - getSegments interleaves text + mention segments for `%[lesson:…]`.
 *   - detectMentionTrigger returns `{type:"lesson", sigil:"%"}` for `%`
 *     at a word boundary; null for mid-word; null pre-sigil cursor; null
 *     for digit-led / curly-led / space-led false positives (`%20`,
 *     `5 % 2`, `printf("%s")`).
 *   - insertMentionToken inserts `%[lesson:name] ` for kind=lesson and
 *     is a no-op on kind/sigil mismatch.
 *   - **No conflict with `!`/`@`/`/`/`$`** — the five sigils don't overlap.
 *
 * Mirrors the structure of `mention-logic-feature.test.ts` so the test
 * suite stays consistent across sigils.
 */
import { test, expect, describe } from "bun:test";
import {
  MENTION_REGEX,
  detectMentionTrigger,
  parseMentions,
  insertMentionToken,
  getSegments,
} from "../lib/mention-logic";

// ── MENTION_REGEX & parseMentions ─────────────────────────────────────

describe("parseMentions — %[lesson:…] tokens", () => {
  test("single token → one lesson mention with correct offsets", () => {
    const result = parseMentions("%[lesson:foo]");
    expect(result).toEqual([
      { kind: "lesson", name: "foo", start: 0, end: 13 },
    ]);
  });

  test("token in mid-text → captures correct start/end", () => {
    const result = parseMentions("recall %[lesson:always-quote-paths] now");
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe("lesson");
    expect(result[0]!.name).toBe("always-quote-paths");
    expect(result[0]!.start).toBe(7);
    expect(result[0]!.end).toBe(35);
  });

  test("MIXED five-sigil string yields 5 distinct kinds in source order", () => {
    const result = parseMentions(
      "![ext:foo] @[file:bar.ts] /[cmd:baz] $[feature:qux] %[lesson:wat]",
    );
    expect(result).toHaveLength(5);
    expect(result.map((m) => m.kind)).toEqual([
      "ext",
      "file",
      "cmd",
      "feature",
      "lesson",
    ]);
    expect(result.map((m) => m.name)).toEqual([
      "foo",
      "bar.ts",
      "baz",
      "qux",
      "wat",
    ]);
  });

  test("multiple lesson tokens are extracted independently", () => {
    const result = parseMentions(
      "%[lesson:a] then %[lesson:b] and %[lesson:c]",
    );
    expect(result.map((m) => m.name)).toEqual(["a", "b", "c"]);
    expect(result.every((m) => m.kind === "lesson")).toBe(true);
  });

  test("does NOT match %20 / 5 % 2 / %s — no brackets, no false positives", () => {
    expect(parseMentions("URL has %20 in it")).toEqual([]);
    expect(parseMentions("5 % 2 == 1")).toEqual([]);
    expect(parseMentions("printf(\"%s\\n\", x)")).toEqual([]);
  });

  test("does NOT match %[other:x] — only the literal `lesson` kind is accepted", () => {
    expect(parseMentions("%[ext:x]")).toEqual([]);
    expect(parseMentions("%[file:x]")).toEqual([]);
    expect(parseMentions("%[cmd:x]")).toEqual([]);
    expect(parseMentions("%[feature:x]")).toEqual([]);
    expect(parseMentions("%[other:x]")).toEqual([]);
  });

  test("does NOT match %[lesson:] (empty name) — regex requires `[^\\]]+`", () => {
    expect(parseMentions("%[lesson:]")).toEqual([]);
  });
});

describe("MENTION_REGEX shape — % alternative", () => {
  test("regex source contains all five alternatives in order", () => {
    expect(MENTION_REGEX.source).toContain("agent|ext|team");
    expect(MENTION_REGEX.source).toContain("file|dir");
    expect(MENTION_REGEX.source).toContain("(cmd)");
    expect(MENTION_REGEX.source).toContain("(feature)");
    expect(MENTION_REGEX.source).toContain("(lesson)");
    // `%` alternative is the LAST option (capture groups 9+10).
    const lessonIdx = MENTION_REGEX.source.indexOf("(lesson)");
    const featureIdx = MENTION_REGEX.source.indexOf("(feature)");
    expect(lessonIdx).toBeGreaterThan(featureIdx);
  });

  test("captures the lesson kind in group 9 and name in group 10", () => {
    const re = new RegExp(MENTION_REGEX.source, "g");
    const m = re.exec("%[lesson:my-lesson]");
    expect(m).not.toBeNull();
    expect(m![9]).toBe("lesson");
    expect(m![10]).toBe("my-lesson");
  });
});

// ── getSegments ──────────────────────────────────────────────────────

describe("getSegments — %[lesson:…] segmentation", () => {
  test("returns single text segment for plain text containing only a bare %", () => {
    const segs = getSegments("5 % 2 is 1");
    expect(segs).toEqual([{ type: "text", text: "5 % 2 is 1" }]);
  });

  test("interleaves text + lesson mention", () => {
    const segs = getSegments("recall %[lesson:foo] please");
    expect(segs).toEqual([
      { type: "text", text: "recall " },
      { type: "mention", kind: "lesson", name: "foo", raw: "%[lesson:foo]" },
      { type: "text", text: " please" },
    ]);
  });

  test("supports back-to-back tokens with no text between them", () => {
    const segs = getSegments("%[lesson:a]%[lesson:b]");
    expect(segs).toEqual([
      { type: "mention", kind: "lesson", name: "a", raw: "%[lesson:a]" },
      { type: "mention", kind: "lesson", name: "b", raw: "%[lesson:b]" },
    ]);
  });
});

// ── detectMentionTrigger — % sigil ────────────────────────────────────

describe("detectMentionTrigger — % sigil", () => {
  test("detects % with query at end of string", () => {
    expect(detectMentionTrigger("hi %les", 7)).toEqual({
      active: true,
      query: "les",
      type: "lesson",
      sigil: "%",
    });
  });

  test("detects % with empty query (just typed `%`)", () => {
    expect(detectMentionTrigger("hi %", 4)).toEqual({
      active: true,
      query: "",
      type: "lesson",
      sigil: "%",
    });
  });

  test("detects % at start of string", () => {
    expect(detectMentionTrigger("%foo", 4)).toEqual({
      active: true,
      query: "foo",
      type: "lesson",
      sigil: "%",
    });
  });

  test("returns null when % is mid-word (no word boundary)", () => {
    expect(detectMentionTrigger("foo%bar", 7)).toBeNull();
  });

  test("returns null when cursor is BEFORE the %", () => {
    expect(detectMentionTrigger("%les", 0)).toBeNull();
  });

  test("returns null when there is whitespace between % and cursor", () => {
    // The trigger anchors to the rightmost word-boundary `%`; whitespace
    // breaks the run, so the trigger is not active.
    expect(detectMentionTrigger("% les", 5)).toBeNull();
  });

  test("% does NOT shadow !/@///$ — other sigils still detected", () => {
    expect(detectMentionTrigger("hi !ag", 6)).toEqual({
      active: true,
      query: "ag",
      type: undefined,
      sigil: "!",
    });
    expect(detectMentionTrigger("hi @sr", 6)).toEqual({
      active: true,
      query: "sr",
      type: "path",
      sigil: "@",
    });
    expect(detectMentionTrigger("hi /cm", 6)).toEqual({
      active: true,
      query: "cm",
      type: "cmd",
      sigil: "/",
    });
    expect(detectMentionTrigger("hi $cha", 7)).toEqual({
      active: true,
      query: "cha",
      type: "feature",
      sigil: "$",
    });
  });

  test("rightmost-sigil-wins — a $ followed by a later % yields % trigger", () => {
    expect(detectMentionTrigger("$foo %les", 9)).toEqual({
      active: true,
      query: "les",
      type: "lesson",
      sigil: "%",
    });
  });
});

// ── detectMentionTrigger — false-positive guard (parallel to $ C1) ────

describe("detectMentionTrigger — % false-positive guard", () => {
  test("rejects %20 (digit immediately after %, common URL encoding)", () => {
    expect(detectMentionTrigger("%20", 3)).toBeNull();
    expect(detectMentionTrigger("hi %20foo", 9)).toBeNull();
  });

  test("rejects 5 % 2 (space immediately after sigil)", () => {
    // Whitespace after % breaks the trigger run.
    expect(detectMentionTrigger("5 % ", 4)).toBeNull();
    expect(detectMentionTrigger("5 % 2", 5)).toBeNull();
  });

  test("ACCEPTS letter-led queries: %f, %les, %ALWAYS_QUOTE", () => {
    expect(detectMentionTrigger("%f", 2)).toEqual({
      active: true,
      query: "f",
      type: "lesson",
      sigil: "%",
    });
    expect(detectMentionTrigger("%les", 4)).toEqual({
      active: true,
      query: "les",
      type: "lesson",
      sigil: "%",
    });
    expect(detectMentionTrigger("%ALWAYS_QUOTE", 13)).toEqual({
      active: true,
      query: "ALWAYS_QUOTE",
      type: "lesson",
      sigil: "%",
    });
  });

  test("ACCEPTS underscore- and hyphen-led queries: %_under, %-leading", () => {
    expect(detectMentionTrigger("%_under", 7)).toEqual({
      active: true,
      query: "_under",
      type: "lesson",
      sigil: "%",
    });
    expect(detectMentionTrigger("%-leading", 9)).toEqual({
      active: true,
      query: "-leading",
      type: "lesson",
      sigil: "%",
    });
  });

  test("digit after a valid letter prefix is fine: %f5 / %les-2 accepted", () => {
    expect(detectMentionTrigger("%f5", 3)).toEqual({
      active: true,
      query: "f5",
      type: "lesson",
      sigil: "%",
    });
    expect(detectMentionTrigger("%les-2", 6)).toEqual({
      active: true,
      query: "les-2",
      type: "lesson",
      sigil: "%",
    });
  });
});

// ── insertMentionToken — % sigil ──────────────────────────────────────

describe("insertMentionToken — % sigil", () => {
  test("inserts %[lesson:name] replacing the trigger span; cursor at end", () => {
    const result = insertMentionToken(
      "hi %les",
      7,
      { kind: "lesson", name: "always-quote-paths" },
    );
    expect(result.text).toBe("hi %[lesson:always-quote-paths] ");
    expect(result.cursor).toBe(result.text.length);
  });

  test("inserts at start of string when no leading whitespace", () => {
    const result = insertMentionToken(
      "%le",
      3,
      { kind: "lesson", name: "lesson-foo" },
    );
    expect(result.text).toBe("%[lesson:lesson-foo] ");
    expect(result.cursor).toBe("%[lesson:lesson-foo] ".length);
  });

  test("preserves trailing text (after the cursor)", () => {
    const result = insertMentionToken(
      "hi %le please",
      6,
      { kind: "lesson", name: "foo" },
    );
    expect(result.text).toBe("hi %[lesson:foo]  please");
    // cursor lands right after the inserted token (including its trailing space)
    expect(result.cursor).toBe("hi %[lesson:foo] ".length);
  });

  test("no-op when there is no active % trigger span (kind/sigil mismatch)", () => {
    // `foo bar` has no `%` near the cursor — return input unchanged.
    const result = insertMentionToken(
      "foo bar",
      7,
      { kind: "lesson", name: "x" },
    );
    expect(result.text).toBe("foo bar");
    expect(result.cursor).toBe(7);
  });

  test("inserting kind=lesson on a `$` trigger → no-op (sigil mismatch)", () => {
    const result = insertMentionToken(
      "hi $cha",
      7,
      { kind: "lesson", name: "x" },
    );
    expect(result.text).toBe("hi $cha");
    expect(result.cursor).toBe(7);
  });

  test("inserting kind=feature on a `%` trigger → no-op (sigil mismatch)", () => {
    const result = insertMentionToken(
      "hi %les",
      7,
      { kind: "feature", name: "x" },
    );
    expect(result.text).toBe("hi %les");
    expect(result.cursor).toBe(7);
  });
});

// ── kind→sigil derivation: round-trip ────────────────────────────────

describe("kind→sigil derivation — lesson serializes back to %[lesson:…]", () => {
  test("inserted token is recognized by parseMentions and getSegments", () => {
    const inserted = insertMentionToken(
      "see %",
      5,
      { kind: "lesson", name: "always-quote-paths" },
    );
    expect(inserted.text).toContain("%[lesson:always-quote-paths]");

    const tokens = parseMentions(inserted.text);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.kind).toBe("lesson");
    expect(tokens[0]!.name).toBe("always-quote-paths");

    const segs = getSegments(inserted.text);
    expect(segs.find((s) => s.type === "mention")).toEqual({
      type: "mention",
      kind: "lesson",
      name: "always-quote-paths",
      raw: "%[lesson:always-quote-paths]",
    });
  });
});
