/**
 * Pure-logic tests for the `EZ` kind under the `!` sigil added to
 * `web/src/lib/mention-logic.ts` as part of EZ Actions v1 Phase 1.1.
 *
 * Coverage targets (per plan §1.1 + §1.3):
 *   - MENTION_REGEX picks up `![EZ:name]` as kind="EZ" (capture groups
 *     1 + 2, sharing the `!` alternative with agent/ext/team).
 *   - parseMentions emits the correct token + offsets.
 *   - getSegments interleaves text + mention segments for `![EZ:…]`.
 *   - detectMentionTrigger returns `{type:"EZ", sigil:"!"}` for any
 *     casing of the EZ prefix at a word boundary (`!EZ:`, `!ez:`,
 *     `!Ez:`, `!eZ:`). The persisted token is always canonical
 *     `![EZ:name]` regardless of typed casing.
 *   - insertMentionToken inserts `![EZ:name] ` for kind=EZ.
 *   - Round-trip: insert → parse → getSegments preserves kind+name.
 *   - Coexists with all four other sigils in a single string.
 *
 * Mirrors the structure of `mention-logic-lesson-sigil.test.ts`.
 */
import { test, expect, describe } from "vitest";
import {
  MENTION_REGEX,
  detectMentionTrigger,
  parseMentions,
  insertMentionToken,
  getSegments,
} from "../lib/mention-logic";

// ── MENTION_REGEX & parseMentions ─────────────────────────────────────

describe("parseMentions — ![EZ:…] tokens", () => {
  test("single token → one EZ mention with correct offsets", () => {
    const result = parseMentions("![EZ:distill]");
    expect(result).toEqual([
      { kind: "EZ", name: "distill", start: 0, end: 13 },
    ]);
  });

  test("token in mid-text → captures correct start/end", () => {
    const result = parseMentions("trigger ![EZ:distill] now");
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe("EZ");
    expect(result[0]!.name).toBe("distill");
    expect(result[0]!.start).toBe(8);
    expect(result[0]!.end).toBe(21);
  });

  test("MIXED five-sigil string yields 5 distinct kinds in source order — EZ included", () => {
    const result = parseMentions(
      "![EZ:distill] @[file:bar.ts] /[cmd:baz] $[feature:qux] %[lesson:wat]",
    );
    expect(result).toHaveLength(5);
    expect(result.map((m) => m.kind)).toEqual([
      "EZ",
      "file",
      "cmd",
      "feature",
      "lesson",
    ]);
    expect(result.map((m) => m.name)).toEqual([
      "distill",
      "bar.ts",
      "baz",
      "qux",
      "wat",
    ]);
  });

  test("EZ coexists with agent/ext/team in the same `!` sigil family", () => {
    const result = parseMentions(
      "![agent:scout] ![EZ:distill] ![ext:fs] ![team:reviewers]",
    );
    expect(result.map((m) => m.kind)).toEqual([
      "agent",
      "EZ",
      "ext",
      "team",
    ]);
    expect(result.map((m) => m.name)).toEqual([
      "scout",
      "distill",
      "fs",
      "reviewers",
    ]);
  });

  test("multiple EZ tokens are extracted independently", () => {
    const result = parseMentions("![EZ:distill] then ![EZ:summarize]");
    expect(result.map((m) => m.name)).toEqual(["distill", "summarize"]);
    expect(result.every((m) => m.kind === "EZ")).toBe(true);
  });

  test("does NOT match `![ez:...]` (lowercase) — only literal `EZ` kind", () => {
    // The regex hard-codes `EZ` (uppercase) — lowercase `ez` would be
    // an entirely different kind name. Currently no `ez` agent/ext/team
    // is registered; the regex's kind alternation rejects it outright.
    expect(parseMentions("![ez:distill]")).toEqual([]);
    expect(parseMentions("![Ez:distill]")).toEqual([]);
  });

  test("does NOT match `![EZ:]` (empty name) — regex requires `[^\\]]+`", () => {
    expect(parseMentions("![EZ:]")).toEqual([]);
  });
});

describe("MENTION_REGEX shape — EZ kind in `!` alternative", () => {
  test("regex source contains EZ in the kind alternation alongside agent/ext/team", () => {
    expect(MENTION_REGEX.source).toContain("agent|ext|team|EZ");
  });

  test("captures the EZ kind in group 1 and name in group 2", () => {
    const re = new RegExp(MENTION_REGEX.source, "g");
    const m = re.exec("![EZ:distill]");
    expect(m).not.toBeNull();
    expect(m![1]).toBe("EZ");
    expect(m![2]).toBe("distill");
    // Other-alt groups stay undefined.
    expect(m![3]).toBeUndefined();
    expect(m![5]).toBeUndefined();
    expect(m![7]).toBeUndefined();
    expect(m![9]).toBeUndefined();
  });
});

// ── getSegments ──────────────────────────────────────────────────────

describe("getSegments — ![EZ:…] segmentation", () => {
  test("interleaves text + EZ mention", () => {
    const segs = getSegments("run ![EZ:distill] please");
    expect(segs).toEqual([
      { type: "text", text: "run " },
      { type: "mention", kind: "EZ", name: "distill", raw: "![EZ:distill]" },
      { type: "text", text: " please" },
    ]);
  });

  test("supports back-to-back tokens with no text between them", () => {
    const segs = getSegments("![EZ:distill]![EZ:summarize]");
    expect(segs).toEqual([
      { type: "mention", kind: "EZ", name: "distill", raw: "![EZ:distill]" },
      { type: "mention", kind: "EZ", name: "summarize", raw: "![EZ:summarize]" },
    ]);
  });
});

// ── detectMentionTrigger — EZ prefix ─────────────────────────────────

describe("detectMentionTrigger — !EZ: prefix", () => {
  test("detects !EZ: prefix with empty query", () => {
    expect(detectMentionTrigger("hi !EZ:", 7)).toEqual({
      active: true,
      query: "",
      type: "EZ",
      sigil: "!",
    });
  });

  test("detects !EZ: prefix with partial query", () => {
    expect(detectMentionTrigger("hi !EZ:dis", 10)).toEqual({
      active: true,
      query: "dis",
      type: "EZ",
      sigil: "!",
    });
  });

  test("detects !EZ: at start of string", () => {
    expect(detectMentionTrigger("!EZ:dist", 8)).toEqual({
      active: true,
      query: "dist",
      type: "EZ",
      sigil: "!",
    });
  });

  test("plain `!` with no kind prefix still triggers (type=undefined)", () => {
    expect(detectMentionTrigger("hi !ag", 6)).toEqual({
      active: true,
      query: "ag",
      type: undefined,
      sigil: "!",
    });
  });

  test("`!ez:` (lowercase) routes to type=EZ — case-insensitive trigger", () => {
    expect(detectMentionTrigger("hi !ez:dist", 11)).toEqual({
      active: true,
      query: "dist",
      type: "EZ",
      sigil: "!",
    });
  });

  test("`!Ez:` (mixed case) routes to type=EZ", () => {
    expect(detectMentionTrigger("hi !Ez:dist", 11)).toEqual({
      active: true,
      query: "dist",
      type: "EZ",
      sigil: "!",
    });
  });

  test("`!eZ:` (mixed case, reversed) routes to type=EZ", () => {
    expect(detectMentionTrigger("!eZ:", 4)).toEqual({
      active: true,
      query: "",
      type: "EZ",
      sigil: "!",
    });
  });

  test("Case-insensitivity is scoped to the EZ kind only — agent/ext/team stay case-sensitive", () => {
    // `!Agent:` with uppercase A does NOT route to type=agent today; it falls
    // through to plain `!` (type=undefined). Documenting this asymmetry as a
    // regression guard — broaden if desired in a follow-up.
    const agent = detectMentionTrigger("!Agent:foo", 10);
    expect(agent?.type).toBeUndefined();
    expect(agent?.query).toBe("Agent:foo");
  });

  test("`!EZ:` does NOT shadow other sigils — rightmost-sigil-wins still applies", () => {
    expect(detectMentionTrigger("!EZ:foo @bar", 12)).toEqual({
      active: true,
      query: "bar",
      type: "path",
      sigil: "@",
    });
  });
});

// ── insertMentionToken — EZ kind ──────────────────────────────────────

describe("insertMentionToken — EZ kind", () => {
  test("inserts ![EZ:name] replacing the !EZ: trigger span", () => {
    const result = insertMentionToken(
      "hi !EZ:dist",
      11,
      { kind: "EZ", name: "distill" },
    );
    expect(result.text).toBe("hi ![EZ:distill] ");
    expect(result.cursor).toBe(result.text.length);
  });

  test("inserts ![EZ:name] from a plain `!` trigger (no kind prefix typed)", () => {
    const result = insertMentionToken(
      "go !d",
      5,
      { kind: "EZ", name: "distill" },
    );
    expect(result.text).toBe("go ![EZ:distill] ");
    expect(result.cursor).toBe("go ![EZ:distill] ".length);
  });

  test("inserts at start of string when no leading whitespace", () => {
    const result = insertMentionToken(
      "!EZ:dis",
      7,
      { kind: "EZ", name: "distill" },
    );
    expect(result.text).toBe("![EZ:distill] ");
    expect(result.cursor).toBe("![EZ:distill] ".length);
  });

  test("preserves trailing text (after the cursor)", () => {
    const result = insertMentionToken(
      "hi !EZ: please",
      7,
      { kind: "EZ", name: "distill" },
    );
    expect(result.text).toBe("hi ![EZ:distill]  please");
    expect(result.cursor).toBe("hi ![EZ:distill] ".length);
  });

  test("no-op when there is no active `!` trigger span", () => {
    const result = insertMentionToken(
      "foo bar",
      7,
      { kind: "EZ", name: "distill" },
    );
    expect(result.text).toBe("foo bar");
    expect(result.cursor).toBe(7);
  });

  test("inserting kind=EZ on a `%` trigger → no-op (sigil mismatch)", () => {
    const result = insertMentionToken(
      "hi %les",
      7,
      { kind: "EZ", name: "x" },
    );
    expect(result.text).toBe("hi %les");
    expect(result.cursor).toBe(7);
  });
});

// ── kind→sigil derivation: round-trip ────────────────────────────────

describe("EZ kind round-trip — insert → parse → getSegments", () => {
  test("inserted token is recognized by parseMentions and getSegments", () => {
    const inserted = insertMentionToken(
      "go !",
      4,
      { kind: "EZ", name: "distill" },
    );
    expect(inserted.text).toContain("![EZ:distill]");

    const tokens = parseMentions(inserted.text);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.kind).toBe("EZ");
    expect(tokens[0]!.name).toBe("distill");

    const segs = getSegments(inserted.text);
    expect(segs.find((s) => s.type === "mention")).toEqual({
      type: "mention",
      kind: "EZ",
      name: "distill",
      raw: "![EZ:distill]",
    });
  });
});
