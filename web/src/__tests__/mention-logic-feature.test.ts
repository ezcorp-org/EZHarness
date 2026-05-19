/**
 * Pure-logic tests for the `$` (Feature Index) sigil added to
 * `web/src/lib/mention-logic.ts` (dev's #4).
 *
 * Coverage targets (per design doc §4 + dev's #4 summary + PM's J-list):
 *   - MENTION_REGEX picks up `$[feature:name]` as kind="feature" with
 *     correct capture-group placement.
 *   - parseMentions emits the correct token + offsets.
 *   - getSegments interleaves text + mention segments for `$[feature:…]`.
 *   - detectMentionTrigger returns `{type:"feature", sigil:"$"}` for
 *     `$` at a word boundary; null for mid-word; null pre-sigil cursor.
 *   - insertMentionToken inserts `$[feature:name] ` for kind=feature
 *     and is a no-op when the active span is the wrong sigil
 *     (kind/sigil mismatch).
 *   - **No conflict with `!`/`@`/`/`** — the four sigils don't overlap;
 *     mid-text dollars (`$5.00`, `${var}`) don't trigger.
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

describe("parseMentions — $[feature:…] tokens", () => {
  test("single token → one feature mention with correct offsets", () => {
    const result = parseMentions("$[feature:chat]");
    expect(result).toEqual([
      { kind: "feature", name: "chat", start: 0, end: 15 },
    ]);
  });

  test("token in mid-text → captures correct start/end", () => {
    const result = parseMentions("see $[feature:chat-attachments] please");
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe("feature");
    expect(result[0]!.name).toBe("chat-attachments");
    expect(result[0]!.start).toBe(4);
    expect(result[0]!.end).toBe(31);
  });

  test("MIXED four-sigil string yields 4 distinct kinds in source order", () => {
    const result = parseMentions(
      "![ext:foo] @[file:bar.ts] /[cmd:baz] $[feature:qux]",
    );
    expect(result).toHaveLength(4);
    expect(result.map((m) => m.kind)).toEqual([
      "ext",
      "file",
      "cmd",
      "feature",
    ]);
    expect(result.map((m) => m.name)).toEqual(["foo", "bar.ts", "baz", "qux"]);
  });

  test("multiple feature tokens are extracted independently", () => {
    const result = parseMentions("$[feature:a] then $[feature:b] and $[feature:c]");
    expect(result.map((m) => m.name)).toEqual(["a", "b", "c"]);
    expect(result.every((m) => m.kind === "feature")).toBe(true);
  });

  test("does NOT match $5.00 / ${var} / $ARGUMENTS — no brackets, no false positives", () => {
    expect(parseMentions("price is $5.00")).toEqual([]);
    expect(parseMentions("template ${var}")).toEqual([]);
    expect(parseMentions("$ARGUMENTS placeholder")).toEqual([]);
    expect(parseMentions("Owe $5 to Bob")).toEqual([]);
  });

  test("does NOT match $[other:x] — only the literal `feature` kind is accepted", () => {
    expect(parseMentions("$[ext:x]")).toEqual([]);
    expect(parseMentions("$[file:x]")).toEqual([]);
    expect(parseMentions("$[cmd:x]")).toEqual([]);
    expect(parseMentions("$[other:x]")).toEqual([]);
  });

  test("does NOT match $[feature:] (empty name) — regex requires `[^\\]]+`", () => {
    expect(parseMentions("$[feature:]")).toEqual([]);
  });
});

describe("MENTION_REGEX shape", () => {
  test("regex source contains the four alternatives in order", () => {
    expect(MENTION_REGEX.source).toContain("agent|ext|team");
    expect(MENTION_REGEX.source).toContain("file|dir");
    expect(MENTION_REGEX.source).toContain("cmd");
    expect(MENTION_REGEX.source).toContain("feature");
    // The `$` alternative is the LAST option (capture groups 7+8).
    const featureIdx = MENTION_REGEX.source.indexOf("feature");
    const cmdIdx = MENTION_REGEX.source.indexOf("(cmd)");
    expect(featureIdx).toBeGreaterThan(cmdIdx);
  });

  test("captures the feature kind in group 7 and name in group 8", () => {
    const re = new RegExp(MENTION_REGEX.source, "g");
    const m = re.exec("$[feature:my-feat]");
    expect(m).not.toBeNull();
    expect(m![7]).toBe("feature");
    expect(m![8]).toBe("my-feat");
  });
});

// ── getSegments ──────────────────────────────────────────────────────

describe("getSegments — $[feature:…] segmentation", () => {
  test("returns single text segment for plain text containing only $5", () => {
    const segs = getSegments("Owe $5 to Bob");
    expect(segs).toEqual([{ type: "text", text: "Owe $5 to Bob" }]);
  });

  test("interleaves text + feature mention", () => {
    const segs = getSegments("see $[feature:chat] please");
    expect(segs).toEqual([
      { type: "text", text: "see " },
      { type: "mention", kind: "feature", name: "chat", raw: "$[feature:chat]" },
      { type: "text", text: " please" },
    ]);
  });

  test("supports back-to-back tokens with no text between them", () => {
    const segs = getSegments("$[feature:a]$[feature:b]");
    expect(segs).toEqual([
      { type: "mention", kind: "feature", name: "a", raw: "$[feature:a]" },
      { type: "mention", kind: "feature", name: "b", raw: "$[feature:b]" },
    ]);
  });
});

// ── detectMentionTrigger — $ sigil ────────────────────────────────────

describe("detectMentionTrigger — $ sigil", () => {
  test("detects $ with query at end of string", () => {
    expect(detectMentionTrigger("hi $cha", 7)).toEqual({
      active: true,
      query: "cha",
      type: "feature",
      sigil: "$",
    });
  });

  test("detects $ with empty query (just typed `$`)", () => {
    expect(detectMentionTrigger("hi $", 4)).toEqual({
      active: true,
      query: "",
      type: "feature",
      sigil: "$",
    });
  });

  test("detects $ at start of string", () => {
    expect(detectMentionTrigger("$foo", 4)).toEqual({
      active: true,
      query: "foo",
      type: "feature",
      sigil: "$",
    });
  });

  test("returns null when $ is mid-word (no word boundary)", () => {
    expect(detectMentionTrigger("foo$bar", 7)).toBeNull();
  });

  test("returns null when cursor is BEFORE the $", () => {
    expect(detectMentionTrigger("$cha", 0)).toBeNull();
  });

  test("returns null when there is whitespace between $ and cursor", () => {
    // The trigger anchors to the rightmost word-boundary `$`; whitespace
    // breaks the run, so the trigger is not active.
    expect(detectMentionTrigger("$ cha", 5)).toBeNull();
  });

  test("$ does NOT shadow !/@// — other sigils still detected", () => {
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
  });

  test("a $ followed earlier by another sigil — rightmost wins (here: $)", () => {
    // `! is at idx 0; $ is at idx 4. Trigger anchors to end-of-input
    // before cursor → $ wins because its trigger anchors to the rightmost
    // word-boundary sigil.
    expect(detectMentionTrigger("!foo $cha", 9)).toEqual({
      active: true,
      query: "cha",
      type: "feature",
      sigil: "$",
    });
  });
});

// ── insertMentionToken — $ sigil ──────────────────────────────────────

describe("insertMentionToken — $ sigil", () => {
  test("inserts $[feature:name] replacing the trigger span; cursor at end", () => {
    const result = insertMentionToken(
      "hi $cha",
      7,
      { kind: "feature", name: "chat-attachments" },
    );
    expect(result.text).toBe("hi $[feature:chat-attachments] ");
    expect(result.cursor).toBe(result.text.length);
  });

  test("inserts at start of string when no leading whitespace", () => {
    const result = insertMentionToken(
      "$ch",
      3,
      { kind: "feature", name: "chat" },
    );
    expect(result.text).toBe("$[feature:chat] ");
    expect(result.cursor).toBe("$[feature:chat] ".length);
  });

  test("preserves trailing text (after the cursor)", () => {
    const result = insertMentionToken(
      "hi $ch please",
      6,
      { kind: "feature", name: "chat" },
    );
    expect(result.text).toBe("hi $[feature:chat]  please");
    // cursor lands right after the inserted token (including its trailing space)
    expect(result.cursor).toBe("hi $[feature:chat] ".length);
  });

  test("no-op when there is no active $ trigger span (kind/sigil mismatch)", () => {
    // `foo bar` has no `$` near the cursor — return input unchanged.
    const result = insertMentionToken(
      "foo bar",
      7,
      { kind: "feature", name: "x" },
    );
    expect(result.text).toBe("foo bar");
    expect(result.cursor).toBe(7);
  });

  test("inserting kind=ext on a $ trigger → no-op (sigil mismatch)", () => {
    // The trigger is `$cha` but the insert is for `ext`, which uses the
    // `!` sigil. The function looks for `!` trigger span and finds none.
    const result = insertMentionToken(
      "hi $cha",
      7,
      { kind: "ext", name: "evil" },
    );
    expect(result.text).toBe("hi $cha");
    expect(result.cursor).toBe(7);
  });

  test("inserting kind=feature on a `!` trigger → no-op (sigil mismatch)", () => {
    const result = insertMentionToken(
      "hi !cha",
      7,
      { kind: "feature", name: "x" },
    );
    expect(result.text).toBe("hi !cha");
    expect(result.cursor).toBe(7);
  });
});

// ── C1: DOLLAR_TRIGGER_RE tightening (audit fix d25c126a) ──────────
// Audit defect C1 — the original `(?:^|\s)\$([^\s]*)$` triggered the
// popover on `$5`, `$5.00`, `${var}` etc. The fix narrows the post-`$`
// character class to `[a-z_-]` for the FIRST char (case-insensitive),
// followed by anything-but-whitespace. Empty query still allowed
// (just-typed `$`).
//
// These cases test `detectMentionTrigger`, NOT `parseMentions`, because
// the audit specifically called out that the LIVE TRIGGER regex was the
// bug surface — `parseMentions` reads completed `$[feature:…]` tokens
// which never had this problem.
describe("detectMentionTrigger — C1 false-positive guard", () => {
  test("rejects ${var} (curly brace immediately after $)", () => {
    expect(detectMentionTrigger("${var}", 6)).toBeNull();
    expect(detectMentionTrigger("hi ${var}", 9)).toBeNull();
  });

  test("rejects $5 / $5.00 / $5_test (digit immediately after $)", () => {
    expect(detectMentionTrigger("$5", 2)).toBeNull();
    expect(detectMentionTrigger("$5.00", 5)).toBeNull();
    expect(detectMentionTrigger("$5_test", 7)).toBeNull();
    expect(detectMentionTrigger("Owe $5 to Bob", 14)).toBeNull();
    expect(detectMentionTrigger("price is $5.00", 14)).toBeNull();
  });

  test("rejects '$ ' (space immediately after sigil)", () => {
    // The trigger anchors at end-of-input; whitespace after $ breaks
    // the run, so the trigger is no longer active.
    expect(detectMentionTrigger("$ ", 2)).toBeNull();
    expect(detectMentionTrigger("hi $ ", 5)).toBeNull();
  });

  test("ACCEPTS empty query (just-typed `$`)", () => {
    expect(detectMentionTrigger("$", 1)).toEqual({
      active: true,
      query: "",
      type: "feature",
      sigil: "$",
    });
    expect(detectMentionTrigger("hi $", 4)).toEqual({
      active: true,
      query: "",
      type: "feature",
      sigil: "$",
    });
  });

  test("ACCEPTS letter-led queries: $f, $cha, $chat-attachments, $ARGUMENTS", () => {
    expect(detectMentionTrigger("$f", 2)).toEqual({
      active: true,
      query: "f",
      type: "feature",
      sigil: "$",
    });
    expect(detectMentionTrigger("$cha", 4)).toEqual({
      active: true,
      query: "cha",
      type: "feature",
      sigil: "$",
    });
    expect(detectMentionTrigger("$chat-attachments", 17)).toEqual({
      active: true,
      query: "chat-attachments",
      type: "feature",
      sigil: "$",
    });
    expect(detectMentionTrigger("$ARGUMENTS", 10)).toEqual({
      active: true,
      query: "ARGUMENTS",
      type: "feature",
      sigil: "$",
    });
  });

  test("ACCEPTS underscore- and hyphen-led queries: $_under, $-leading", () => {
    expect(detectMentionTrigger("$_under", 7)).toEqual({
      active: true,
      query: "_under",
      type: "feature",
      sigil: "$",
    });
    expect(detectMentionTrigger("$-leading", 9)).toEqual({
      active: true,
      query: "-leading",
      type: "feature",
      sigil: "$",
    });
  });

  test("mid-word $ still rejected (sigil must be at word boundary)", () => {
    expect(detectMentionTrigger("foo$bar", 7)).toBeNull();
    expect(detectMentionTrigger("a$b", 3)).toBeNull();
  });

  test("cursor-position semantics: $cha at cursor 0 → null; cursor 4 → match", () => {
    expect(detectMentionTrigger("$cha", 0)).toBeNull();
    expect(detectMentionTrigger("$cha", 4)).toEqual({
      active: true,
      query: "cha",
      type: "feature",
      sigil: "$",
    });
  });

  test("digit after a valid letter prefix is fine: $f5 / $cha-2 accepted", () => {
    // The strictness is only on the FIRST char after $; subsequent chars
    // can be anything-but-whitespace.
    expect(detectMentionTrigger("$f5", 3)).toEqual({
      active: true,
      query: "f5",
      type: "feature",
      sigil: "$",
    });
    expect(detectMentionTrigger("$cha-2", 6)).toEqual({
      active: true,
      query: "cha-2",
      type: "feature",
      sigil: "$",
    });
  });
});

// ── Round-trip: insert → parse → segment ─────────────────────────────

describe("insertMentionToken → parseMentions round-trip", () => {
  test("inserted token is recognized by parseMentions and getSegments", () => {
    const inserted = insertMentionToken(
      "see $",
      5,
      { kind: "feature", name: "chat" },
    );
    const tokens = parseMentions(inserted.text);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.kind).toBe("feature");
    expect(tokens[0]!.name).toBe("chat");

    const segs = getSegments(inserted.text);
    expect(segs.find((s) => s.type === "mention")).toEqual({
      type: "mention",
      kind: "feature",
      name: "chat",
      raw: "$[feature:chat]",
    });
  });
});
