/**
 * Pure-function tests for `stripEzActionTokens` in
 * `src/runtime/mention-wiring.ts` (Phase 3.2 of EZ Actions v1).
 *
 * Coverage targets (per plan §3.5):
 *   - single token stripped from prompt; surrounding text retained
 *   - multiple tokens stripped, all action names captured in source
 *     order with offsets
 *   - mixed content: token stripped, surrounding text retained
 *   - unknown action name: stripped same as known (silent — the
 *     dispatcher decides what to do per-name)
 *   - zero tokens: no-op (returns input verbatim)
 *   - action-only message: stripped result is empty/whitespace-only
 *     so the dispatcher can detect "no LLM call needed"
 *   - other mention sigils (`@[file:…]`, `/[cmd:…]`, `$[feature:…]`,
 *     `%[lesson:…]`, `![agent:…]`) pass through untouched
 *
 * Pure logic; no DB / pi-ai mock needed.
 */
import { test, expect, describe } from "bun:test";
import {
  stripEzActionTokens,
  EZ_ACTION_TOKEN_RE,
} from "../runtime/mention-wiring";

describe("stripEzActionTokens — basic cases", () => {
  test("zero tokens → returns input verbatim, empty actions list", () => {
    const out = stripEzActionTokens("plain prose with nothing in it");
    expect(out.stripped).toBe("plain prose with nothing in it");
    expect(out.actions).toEqual([]);
  });

  test("single token in mid-text → stripped, name captured", () => {
    const out = stripEzActionTokens("trigger ![EZ:distill] now");
    expect(out.stripped).toBe("trigger now");
    expect(out.actions).toEqual([
      { name: "distill", start: 8, end: 21 },
    ]);
  });

  test("multiple tokens → all stripped, names in source order", () => {
    const out = stripEzActionTokens(
      "do ![EZ:distill] then ![EZ:summarize] please",
    );
    // Each token-strip consumes one trailing whitespace, so we end
    // up with `do then please` (no double-spaces).
    expect(out.stripped).toBe("do then please");
    expect(out.actions.map((a) => a.name)).toEqual(["distill", "summarize"]);
  });

  test("action-only message → stripped is empty after trim", () => {
    const out = stripEzActionTokens("![EZ:distill]");
    // Strip leaves nothing — the dispatcher uses
    // `stripped.trim().length === 0` to detect "no LLM call".
    expect(out.stripped.trim()).toBe("");
    expect(out.actions.map((a) => a.name)).toEqual(["distill"]);
  });

  test("action-only message with surrounding whitespace → trimmed-empty after strip", () => {
    const out = stripEzActionTokens("  ![EZ:distill]  ");
    expect(out.stripped.trim()).toBe("");
    expect(out.actions.map((a) => a.name)).toEqual(["distill"]);
  });

  test("multiple action-only tokens → trimmed-empty stripped", () => {
    const out = stripEzActionTokens("![EZ:distill] ![EZ:summarize]");
    expect(out.stripped.trim()).toBe("");
    expect(out.actions.map((a) => a.name)).toEqual(["distill", "summarize"]);
  });
});

describe("stripEzActionTokens — silent unknown-action strip", () => {
  test("unknown action name → still stripped (dispatcher decides per-name)", () => {
    const out = stripEzActionTokens("hi ![EZ:nonsense] world");
    expect(out.stripped).toBe("hi world");
    expect(out.actions.map((a) => a.name)).toEqual(["nonsense"]);
  });

  test("known + unknown mixed → both stripped, both captured", () => {
    const out = stripEzActionTokens(
      "![EZ:distill] then ![EZ:fakeaction] done",
    );
    expect(out.stripped).toBe("then done");
    expect(out.actions.map((a) => a.name)).toEqual(["distill", "fakeaction"]);
  });
});

describe("stripEzActionTokens — coexistence with other sigils", () => {
  test("agent / ext / team mentions (other `!` kinds) are NOT stripped", () => {
    const out = stripEzActionTokens(
      "![agent:scout] ![EZ:distill] ![ext:fs] ![team:reviewers]",
    );
    // Only the `EZ` token is removed; the other ! kinds stay so they
    // can be wired into the conversation downstream.
    expect(out.stripped).toBe(
      "![agent:scout] ![ext:fs] ![team:reviewers]",
    );
    expect(out.actions.map((a) => a.name)).toEqual(["distill"]);
  });

  test("@[file:…] passes through untouched", () => {
    const out = stripEzActionTokens("![EZ:distill] read @[file:src/app.ts]");
    expect(out.stripped).toBe("read @[file:src/app.ts]");
    expect(out.actions.map((a) => a.name)).toEqual(["distill"]);
  });

  test("/[cmd:…] passes through untouched", () => {
    const out = stripEzActionTokens("![EZ:distill] /[cmd:plan]");
    expect(out.stripped).toBe("/[cmd:plan]");
    expect(out.actions.map((a) => a.name)).toEqual(["distill"]);
  });

  test("$[feature:…] passes through untouched", () => {
    const out = stripEzActionTokens("![EZ:distill] $[feature:auth]");
    expect(out.stripped).toBe("$[feature:auth]");
    expect(out.actions.map((a) => a.name)).toEqual(["distill"]);
  });

  test("%[lesson:…] passes through untouched", () => {
    const out = stripEzActionTokens("![EZ:distill] %[lesson:always-quote]");
    expect(out.stripped).toBe("%[lesson:always-quote]");
    expect(out.actions.map((a) => a.name)).toEqual(["distill"]);
  });

  test("FIVE-sigil mixture: only EZ stripped", () => {
    const out = stripEzActionTokens(
      "go ![EZ:distill] @[file:a.ts] /[cmd:b] $[feature:c] %[lesson:d]",
    );
    expect(out.stripped).toBe(
      "go @[file:a.ts] /[cmd:b] $[feature:c] %[lesson:d]",
    );
    expect(out.actions.map((a) => a.name)).toEqual(["distill"]);
  });
});

describe("stripEzActionTokens — edge cases", () => {
  test("token with leading whitespace ONLY (no leading space stripped)", () => {
    // Per the doc: we strip ONE trailing whitespace per token to
    // avoid double-spaces, but leading whitespace is preserved
    // verbatim so `prefix![EZ:x]` (no space) keeps the prefix glued.
    const out = stripEzActionTokens("prefix![EZ:distill]");
    expect(out.stripped).toBe("prefix");
    expect(out.actions.map((a) => a.name)).toEqual(["distill"]);
  });

  test("empty action name → not captured (regex requires `[^\\]]+`)", () => {
    // Regex disallows empty name, so this is treated as plain text.
    const out = stripEzActionTokens("![EZ:]");
    expect(out.stripped).toBe("![EZ:]");
    expect(out.actions).toEqual([]);
  });

  test("back-to-back tokens collapse cleanly", () => {
    const out = stripEzActionTokens("![EZ:a]![EZ:b]");
    expect(out.stripped.trim()).toBe("");
    expect(out.actions.map((a) => a.name)).toEqual(["a", "b"]);
  });

  test("EZ_ACTION_TOKEN_RE source isolates the EZ kind only", () => {
    // Defensive: make sure the standalone regex doesn't accidentally
    // match agent/ext/team tokens. `EZ_ACTION_TOKEN_RE` is exported
    // for use in dispatch-side correlation; it must NEVER eat
    // ![agent:…] etc.
    const re = new RegExp(EZ_ACTION_TOKEN_RE.source, "g");
    expect(re.test("![agent:foo]")).toBe(false);
    re.lastIndex = 0;
    expect(re.test("![ext:foo]")).toBe(false);
    re.lastIndex = 0;
    expect(re.test("![team:foo]")).toBe(false);
    re.lastIndex = 0;
    expect(re.test("![EZ:foo]")).toBe(true);
  });
});
