/**
 * Pure-logic tests for the `workflow` kind under the `!` sigil.
 *
 * Coverage targets:
 *   - MENTION_REGEX picks up `![workflow:name]` as kind="workflow" via
 *     capture groups 1 + 2 — the SAME `!` alternative agent/ext/team/EZ
 *     use. Group NUMBERING is asserted explicitly: `web/src/lib/markdown.ts`
 *     destructures these groups positionally as named callback params, so
 *     a 6th top-level alternative would renumber groups 3-10 and mis-render
 *     pills with no type error and nothing a `match[N]` grep would find.
 *   - parseMentions / getSegments emit the correct token + offsets.
 *   - detectMentionTrigger returns `{type:"workflow", sigil:"!"}` for the
 *     `!workflow:` prefix, and bare `!` still falls through to
 *     `type: undefined` (which lists workflows alongside everything else).
 *   - insertMentionToken commits `![workflow:name] `.
 *   - The `!` kind-prefix alternation has exactly ONE definition, shared by
 *     trigger detection and span replacement. Those were separate copies
 *     until this change; the replacement copy's `[^\s]*` tail swallows an
 *     unlisted prefix and keeps working, so drift there is silent.
 *
 * Mirrors the structure of `mention-logic-EZ-sigil.unit.test.ts`.
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

describe("parseMentions — ![workflow:…] tokens", () => {
  test("single token → one workflow mention with correct offsets", () => {
    expect(parseMentions("![workflow:deploy]")).toEqual([
      { kind: "workflow", name: "deploy", start: 0, end: 18 },
    ]);
  });

  test("token in mid-text → captures correct start/end", () => {
    const result = parseMentions("please ![workflow:deploy] now");
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe("workflow");
    expect(result[0]!.name).toBe("deploy");
    expect(result[0]!.start).toBe(7);
    expect(result[0]!.end).toBe(25);
  });

  test("coexists with every other `!` kind in source order", () => {
    const result = parseMentions(
      "![agent:scout] ![workflow:deploy] ![EZ:distill] ![ext:fs] ![team:reviewers]",
    );
    expect(result.map((m) => m.kind)).toEqual([
      "agent",
      "workflow",
      "EZ",
      "ext",
      "team",
    ]);
    expect(result.map((m) => m.name)).toEqual([
      "scout",
      "deploy",
      "distill",
      "fs",
      "reviewers",
    ]);
  });

  test("coexists with the other four sigils in one string", () => {
    const result = parseMentions(
      "![workflow:deploy] @[file:bar.ts] /[cmd:baz] $[feature:qux] %[lesson:wat]",
    );
    expect(result.map((m) => m.kind)).toEqual([
      "workflow",
      "file",
      "cmd",
      "feature",
      "lesson",
    ]);
  });

  test("multiple workflow tokens are extracted independently", () => {
    const result = parseMentions("![workflow:deploy] then ![workflow:verify]");
    expect(result.map((m) => m.name)).toEqual(["deploy", "verify"]);
    expect(result.every((m) => m.kind === "workflow")).toBe(true);
  });

  test("extension-namespaced names survive — `:` is legal inside the name", () => {
    // Extension workflows are namespaced `<ext>:<name>`. The kind
    // alternation is matched first and non-greedily against the literal
    // `workflow:`, so the remaining `deployer:release` lands in the name.
    const result = parseMentions("![workflow:deployer:release]");
    expect(result).toEqual([
      { kind: "workflow", name: "deployer:release", start: 0, end: 28 },
    ]);
  });

  test("does NOT match `![Workflow:…]` — the kind is lowercase in the token", () => {
    expect(parseMentions("![Workflow:deploy]")).toEqual([]);
    expect(parseMentions("![WORKFLOW:deploy]")).toEqual([]);
  });

  test("does NOT match `![workflow:]` (empty name)", () => {
    expect(parseMentions("![workflow:]")).toEqual([]);
  });
});

describe("MENTION_REGEX shape — workflow kind in the `!` alternative", () => {
  test("workflow joins the EXISTING kind alternation (no 6th top-level alternative)", () => {
    expect(MENTION_REGEX.source).toContain("agent|ext|team|EZ|workflow");
  });

  test("still has exactly five top-level alternatives", () => {
    // `markdown.ts::styleMentions` names its callback params positionally
    // (bangKind, bangName, pathKind, pathName, slashKind, slashName). A new
    // top-level alternative shifts every later group by two and silently
    // paints the wrong pills. Counting `(` groups pins the layout.
    const groupCount = (MENTION_REGEX.source.match(/\((?!\?)/g) ?? []).length;
    expect(groupCount).toBe(10);
  });

  test("captures the workflow kind in group 1 and name in group 2", () => {
    const re = new RegExp(MENTION_REGEX.source, "g");
    const m = re.exec("![workflow:deploy]");
    expect(m).not.toBeNull();
    expect(m![1]).toBe("workflow");
    expect(m![2]).toBe("deploy");
    // The other alternatives' groups stay undefined — i.e. adding
    // `workflow` did NOT renumber them.
    expect(m![3]).toBeUndefined();
    expect(m![5]).toBeUndefined();
    expect(m![7]).toBeUndefined();
    expect(m![9]).toBeUndefined();
  });

  test("the OTHER sigils still occupy their original group numbers", () => {
    const at = new RegExp(MENTION_REGEX.source, "g").exec("@[file:a.ts]");
    expect(at![3]).toBe("file");
    expect(at![4]).toBe("a.ts");

    const slash = new RegExp(MENTION_REGEX.source, "g").exec("/[cmd:review]");
    expect(slash![5]).toBe("cmd");
    expect(slash![6]).toBe("review");

    const dollar = new RegExp(MENTION_REGEX.source, "g").exec("$[feature:chat]");
    expect(dollar![7]).toBe("feature");
    expect(dollar![8]).toBe("chat");

    const percent = new RegExp(MENTION_REGEX.source, "g").exec("%[lesson:bun]");
    expect(percent![9]).toBe("lesson");
    expect(percent![10]).toBe("bun");
  });
});

// ── getSegments ──────────────────────────────────────────────────────

describe("getSegments — ![workflow:…] segmentation", () => {
  test("interleaves text + workflow mention", () => {
    expect(getSegments("run ![workflow:deploy] please")).toEqual([
      { type: "text", text: "run " },
      {
        type: "mention",
        kind: "workflow",
        name: "deploy",
        raw: "![workflow:deploy]",
      },
      { type: "text", text: " please" },
    ]);
  });

  test("supports back-to-back tokens with no text between them", () => {
    expect(getSegments("![workflow:a]![workflow:b]")).toEqual([
      { type: "mention", kind: "workflow", name: "a", raw: "![workflow:a]" },
      { type: "mention", kind: "workflow", name: "b", raw: "![workflow:b]" },
    ]);
  });
});

// ── detectMentionTrigger — workflow prefix ───────────────────────────

describe("detectMentionTrigger — !workflow: prefix", () => {
  test("detects !workflow: with an empty query", () => {
    expect(detectMentionTrigger("hi !workflow:", 13)).toEqual({
      active: true,
      query: "",
      type: "workflow",
      sigil: "!",
    });
  });

  test("detects !workflow: with a partial query", () => {
    expect(detectMentionTrigger("hi !workflow:dep", 16)).toEqual({
      active: true,
      query: "dep",
      type: "workflow",
      sigil: "!",
    });
  });

  test("detects !workflow: at the start of the string", () => {
    expect(detectMentionTrigger("!workflow:deploy", 16)).toEqual({
      active: true,
      query: "deploy",
      type: "workflow",
      sigil: "!",
    });
  });

  test("partially-typed prefixes fall through to bare `!` (type=undefined)", () => {
    // `!work` is not yet a kind prefix — it's a plain `!` query, which the
    // search route answers with agents/exts/teams AND workflows, so the
    // user sees the workflow they're reaching for before finishing the
    // prefix.
    for (const [text, query] of [
      ["!w", "w"],
      ["!work", "work"],
      ["!workflow", "workflow"],
    ] as const) {
      expect(detectMentionTrigger(text, text.length)).toEqual({
        active: true,
        query,
        type: undefined,
        sigil: "!",
      });
    }
  });

  test("the prefix is case-SENSITIVE, like ext/agent/team (unlike EZ)", () => {
    // Only `EZ:` is matched case-insensitively. `!Workflow:` falls through
    // to a bare `!` query rather than routing to the workflow search.
    const upper = detectMentionTrigger("!Workflow:dep", 13);
    expect(upper?.type).toBeUndefined();
    expect(upper?.query).toBe("Workflow:dep");
  });

  test("does not shadow the sibling `!` kinds", () => {
    expect(detectMentionTrigger("!agent:sc", 9)?.type).toBe("agent");
    expect(detectMentionTrigger("!ext:fs", 7)?.type).toBe("ext");
    expect(detectMentionTrigger("!team:rev", 9)?.type).toBe("team");
    expect(detectMentionTrigger("!EZ:dis", 7)?.type).toBe("EZ");
  });

  test("rightmost-sigil-wins still applies", () => {
    expect(detectMentionTrigger("!workflow:deploy @bar", 21)).toEqual({
      active: true,
      query: "bar",
      type: "path",
      sigil: "@",
    });
  });

  test("whitespace after the sigil dismisses the trigger", () => {
    expect(detectMentionTrigger("!workflow:deploy done", 21)).toBeNull();
  });
});

// ── insertMentionToken — workflow kind ───────────────────────────────

describe("insertMentionToken — workflow kind", () => {
  test("inserts ![workflow:name] replacing the !workflow: trigger span", () => {
    const result = insertMentionToken("hi !workflow:dep", 16, {
      kind: "workflow",
      name: "deploy",
    });
    expect(result.text).toBe("hi ![workflow:deploy] ");
    expect(result.cursor).toBe(result.text.length);
  });

  test("inserts from a bare `!` trigger (no kind prefix typed)", () => {
    const result = insertMentionToken("go !d", 5, {
      kind: "workflow",
      name: "deploy",
    });
    expect(result.text).toBe("go ![workflow:deploy] ");
    expect(result.cursor).toBe(result.text.length);
  });

  test("inserts at the start of the string when there is no leading whitespace", () => {
    const result = insertMentionToken("!workflow:d", 11, {
      kind: "workflow",
      name: "deploy",
    });
    expect(result.text).toBe("![workflow:deploy] ");
    expect(result.cursor).toBe(result.text.length);
  });

  test("preserves text after the cursor", () => {
    const result = insertMentionToken("hi !workflow: please", 13, {
      kind: "workflow",
      name: "deploy",
    });
    expect(result.text).toBe("hi ![workflow:deploy]  please");
    expect(result.cursor).toBe("hi ![workflow:deploy] ".length);
  });

  test("no-op when there is no active `!` trigger span", () => {
    const result = insertMentionToken("foo bar", 7, {
      kind: "workflow",
      name: "deploy",
    });
    expect(result.text).toBe("foo bar");
    expect(result.cursor).toBe(7);
  });

  test("no-op on a mismatched sigil trigger", () => {
    for (const before of ["hi @src", "hi /rev", "hi $chat", "hi %bun"]) {
      const result = insertMentionToken(before, before.length, {
        kind: "workflow",
        name: "deploy",
      });
      expect(result.text).toBe(before);
    }
  });
});

// ── the shared `!` kind-prefix alternation ───────────────────────────

describe("`!` kind-prefix alternation is defined once", () => {
  // detectMentionTrigger and insertMentionToken used to carry SEPARATE
  // copies of `(?:ext:|agent:|team:|EZ:)?`. The insertion copy's `[^\s]*`
  // tail swallows an unlisted prefix, so a kind added to only one of them
  // still "works" — until it doesn't. These assert the two agree by
  // exercising both halves against every prefix.
  const PREFIXES = ["ext:", "agent:", "team:", "EZ:", "workflow:"] as const;

  for (const prefix of PREFIXES) {
    test(`\`!${prefix}\` is both detected and replaced`, () => {
      const before = `go !${prefix}na`;
      const trigger = detectMentionTrigger(before, before.length);
      expect(trigger?.active).toBe(true);
      expect(trigger?.sigil).toBe("!");
      // The detected query is the tail AFTER the prefix — proof the
      // prefix was recognised rather than swallowed into the query.
      expect(trigger?.query).toBe("na");

      // And the whole span (sigil + prefix + tail) is what gets replaced.
      const result = insertMentionToken(before, before.length, {
        kind: "agent",
        name: "Scout",
      });
      expect(result.text).toBe("go ![agent:Scout] ");
    });
  }
});

// ── round-trip ───────────────────────────────────────────────────────

describe("workflow kind round-trip — insert → parse → getSegments", () => {
  test("the inserted token is recognised by both readers", () => {
    const inserted = insertMentionToken("go !", 4, {
      kind: "workflow",
      name: "deploy",
    });
    expect(inserted.text).toContain("![workflow:deploy]");

    const tokens = parseMentions(inserted.text);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.kind).toBe("workflow");
    expect(tokens[0]!.name).toBe("deploy");

    expect(getSegments(inserted.text).find((s) => s.type === "mention")).toEqual({
      type: "mention",
      kind: "workflow",
      name: "deploy",
      raw: "![workflow:deploy]",
    });
  });
});
