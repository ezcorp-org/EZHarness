/**
 * Unit tests for `applyFeatureExpansion` in
 * `src/runtime/mention-wiring.ts`.
 *
 * The function takes a `FeatureResolver` callback so this layer is
 * DB-free — every test passes a deterministic in-memory resolver. The
 * REAL DB-backed resolver (via `getFeature(projectId, name)`) is wired
 * in `src/runtime/stream-chat/build-prompt.ts` and exercised by
 * `build-prompt-feature.test.ts`.
 *
 * Coverage targets (per design doc §4 + dev's #10 summary):
 *   1. Single token → exact system-note format.
 *   2. Multiple tokens preserve source order, dedupe by name.
 *   3. Unknown feature → silent no-op (NOT an error message).
 *   4. No tokens → empty string.
 *   5. **No double-expansion (CRITICAL)**: a feature description that
 *      contains `![ext:evil]` and a file path that contains
 *      `$[feature:meta]` are emitted VERBATIM. The function MUST NOT
 *      re-process its own output for further mention sigils.
 *   6. Empty-name token (`$[feature:]`) ignored — no resolver call.
 *   7. Whitespace in the name — trimmed before resolver call.
 *   8. Description-only block when files=[] → omits the
 *      "Look at and modify…" sentence.
 *   9. Function does NOT mutate or return userMessage — caller
 *      handles prepend.
 *  10. Token regex export (FEATURE_TOKEN_RE) parses tokens with
 *      colons, hyphens, and other slug-friendly punctuation in name.
 */
import { test, expect, describe, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

import {
  applyFeatureExpansion,
  FEATURE_TOKEN_RE,
  type FeatureResolver,
} from "../runtime/mention-wiring";

// ── Resolver factories ───────────────────────────────────────────────

/**
 * Resolver that looks up a name in a fixed dictionary; unknown names
 * return null (mirrors the design's silent no-op).
 */
function dictResolver(
  byName: Record<string, { description: string; files: string[] }>,
): FeatureResolver {
  return async (name: string) => byName[name] ?? null;
}

/** Resolver that records every name it was asked for, in call order. */
function recordingResolver(
  byName: Record<string, { description: string; files: string[] }>,
): { resolve: FeatureResolver; calls: string[] } {
  const calls: string[] = [];
  const resolve: FeatureResolver = async (name) => {
    calls.push(name);
    return byName[name] ?? null;
  };
  return { resolve, calls };
}

// ── applyFeatureExpansion ────────────────────────────────────────────

describe("applyFeatureExpansion — system note format", () => {
  test("single token produces the exact design-doc block", async () => {
    const resolver = dictResolver({
      chat: {
        description: "Files under src/chat",
        files: ["src/chat/a.ts", "src/chat/b.ts"],
      },
    });
    const out = await applyFeatureExpansion("see $[feature:chat]", resolver);
    expect(out).toBe(
      "**Feature: chat**\n" +
      "Files under src/chat. Look at and modify these files first when working on this feature:\n" +
      "- src/chat/a.ts\n" +
      "- src/chat/b.ts",
    );
  });

  test("file list uses '- ' prefix and is NOT formatted as @[file:…] tokens", async () => {
    // Per design §4: "Files are listed as plain text (not as @[file:…]
    // tokens) — the LLM can @-read on demand. No double-expansion."
    const resolver = dictResolver({
      x: { description: "desc", files: ["src/a.ts"] },
    });
    const out = await applyFeatureExpansion("$[feature:x]", resolver);
    expect(out).toContain("- src/a.ts");
    expect(out).not.toContain("@[file:");
  });

  test("description-only block when files=[] — omits 'Look at and modify…' sentence", async () => {
    const resolver = dictResolver({
      empty: { description: "Will be populated soon", files: [] },
    });
    const out = await applyFeatureExpansion("$[feature:empty]", resolver);
    expect(out).toBe("**Feature: empty**\nWill be populated soon");
    expect(out).not.toContain("Look at and modify");
    expect(out).not.toContain("- ");
  });
});

describe("applyFeatureExpansion — multi-token & dedupe", () => {
  test("multiple distinct tokens emit blocks in SOURCE order (not alpha)", async () => {
    const resolver = dictResolver({
      a: { description: "alpha", files: ["src/a/1.ts", "src/a/2.ts"] },
      b: { description: "beta", files: ["src/b/1.ts", "src/b/2.ts"] },
    });
    // Source order: b first, then a.
    const out = await applyFeatureExpansion(
      "first $[feature:b] then $[feature:a]",
      resolver,
    );
    const bIdx = out.indexOf("**Feature: b**");
    const aIdx = out.indexOf("**Feature: a**");
    expect(bIdx).toBeGreaterThanOrEqual(0);
    expect(aIdx).toBeGreaterThan(bIdx);
  });

  test("blocks are joined with a blank line between them", async () => {
    const resolver = dictResolver({
      a: { description: "A", files: ["src/a.ts", "src/a2.ts"] },
      b: { description: "B", files: ["src/b.ts", "src/b2.ts"] },
    });
    const out = await applyFeatureExpansion(
      "$[feature:a] $[feature:b]",
      resolver,
    );
    expect(out).toContain("**Feature: a**");
    expect(out).toContain("**Feature: b**");
    // Blocks separated by exactly "\n\n".
    expect(/\*\*Feature: a\*\*[\s\S]+?\n\n\*\*Feature: b\*\*/.test(out)).toBe(true);
  });

  test("duplicate token name → exactly ONE resolver call AND ONE block", async () => {
    const { resolve, calls } = recordingResolver({
      x: { description: "X", files: ["src/x.ts", "src/x2.ts"] },
    });
    const out = await applyFeatureExpansion(
      "$[feature:x] middle $[feature:x] tail $[feature:x]",
      resolve,
    );
    expect(calls).toEqual(["x"]);
    const blockCount = (out.match(/\*\*Feature: x\*\*/g) ?? []).length;
    expect(blockCount).toBe(1);
  });
});

describe("applyFeatureExpansion — unknown / no-op cases", () => {
  test("unknown feature → empty string (silent no-op, NOT an error message)", async () => {
    const { resolve, calls } = recordingResolver({});
    const out = await applyFeatureExpansion("$[feature:nope]", resolve);
    expect(out).toBe("");
    expect(calls).toEqual(["nope"]);
  });

  test("mix of known + unknown emits ONLY the known block", async () => {
    const resolver = dictResolver({
      real: { description: "Real", files: ["src/real.ts", "src/real2.ts"] },
    });
    const out = await applyFeatureExpansion(
      "$[feature:real] $[feature:ghost]",
      resolver,
    );
    expect(out).toContain("**Feature: real**");
    expect(out).not.toContain("**Feature: ghost**");
    expect(out).not.toContain("Unknown");
    expect(out).not.toContain("ghost");
  });

  test("no tokens at all → empty string", async () => {
    const { resolve, calls } = recordingResolver({
      x: { description: "x", files: ["a.ts", "b.ts"] },
    });
    const out = await applyFeatureExpansion("just plain text", resolve);
    expect(out).toBe("");
    expect(calls).toEqual([]);
  });

  test("empty-name token `$[feature:]` is skipped (no resolver call)", async () => {
    // The token regex requires `[^\]]+` so an empty body wouldn't match;
    // but the parser also defensively trims and skips empty names.
    const { resolve, calls } = recordingResolver({});
    const out = await applyFeatureExpansion("$[feature:]", resolve);
    expect(out).toBe("");
    expect(calls).toEqual([]);
  });

  test("whitespace-only name `$[feature:   ]` is trimmed → skipped", async () => {
    const { resolve, calls } = recordingResolver({});
    const out = await applyFeatureExpansion("$[feature:   ]", resolve);
    expect(out).toBe("");
    expect(calls).toEqual([]);
  });

  test("whitespace inside a name is trimmed before lookup", async () => {
    const { resolve, calls } = recordingResolver({
      foo: { description: "F", files: ["a.ts", "b.ts"] },
    });
    await applyFeatureExpansion("$[feature:  foo  ]", resolve);
    expect(calls).toEqual(["foo"]);
  });
});

describe("applyFeatureExpansion — NO double-expansion (injection guard)", () => {
  test("description containing other mention sigils is emitted VERBATIM (no re-parse)", async () => {
    // CRITICAL: if applyFeatureExpansion ever re-fed its output through
    // parseMentions or another expander, an evil description could
    // smuggle in extension wiring (`![ext:evil]`), unsafe file reads
    // (`@[file:/etc/passwd]`), or recursive expansion (`$[feature:meta]`).
    const evilDesc =
      "Helpful description ![ext:evil] @[file:/etc/passwd] $[feature:recursive] /[cmd:dangerous]";
    const evilFiles = [
      "src/normal.ts",
      "src/$[feature:meta]/path.ts",
      "src/![ext:also-evil].ts",
    ];
    const resolver = dictResolver({
      target: { description: evilDesc, files: evilFiles },
    });
    const out = await applyFeatureExpansion("$[feature:target]", resolver);

    // The evil strings are present — we did NOT strip them — but they
    // appear ONLY inside the feature block, NOT as additional resolved
    // content. The block format itself is the only thing surrounding them.
    expect(out).toContain("![ext:evil]");
    expect(out).toContain("@[file:/etc/passwd]");
    expect(out).toContain("$[feature:recursive]");
    expect(out).toContain("/[cmd:dangerous]");
    expect(out).toContain("- src/$[feature:meta]/path.ts");
    expect(out).toContain("- src/![ext:also-evil].ts");

    // Exactly ONE feature block was produced — no recursive spawn.
    const blockCount = (out.match(/\*\*Feature: /g) ?? []).length;
    expect(blockCount).toBe(1);
  });

  test("recursive token in resolver output does NOT trigger another expansion", async () => {
    // If applyFeatureExpansion re-parsed its own output, the resolver
    // would be called twice (once for "outer", once for "inner").
    const { resolve, calls } = recordingResolver({
      outer: {
        description: "leads to $[feature:inner]",
        files: ["src/outer.ts", "src/outer2.ts"],
      },
      inner: { description: "should never appear", files: ["src/inner.ts"] },
    });
    await applyFeatureExpansion("$[feature:outer]", resolve);
    expect(calls).toEqual(["outer"]); // NO call to "inner"
  });
});

describe("applyFeatureExpansion — caller contract", () => {
  test("does NOT mutate or return the userMessage — only the system note", async () => {
    const userMessage = "raw user message $[feature:x]";
    const resolver = dictResolver({
      x: { description: "X", files: ["a.ts", "b.ts"] },
    });
    const out = await applyFeatureExpansion(userMessage, resolver);
    // Output is JUST the block — no original user text.
    expect(out.startsWith("**Feature: x**")).toBe(true);
    expect(out).not.toContain("raw user message");
    // userMessage variable itself is unchanged (sanity).
    expect(userMessage).toBe("raw user message $[feature:x]");
  });

  test("resolver throwing propagates to caller (build-prompt wraps in try/catch)", async () => {
    const throwingResolver: FeatureResolver = async () => {
      throw new Error("resolver-boom");
    };
    await expect(
      applyFeatureExpansion("$[feature:x]", throwingResolver),
    ).rejects.toThrow(/resolver-boom/);
  });
});

describe("FEATURE_TOKEN_RE", () => {
  test("matches `$[feature:name]` and captures the name", () => {
    const re = new RegExp(FEATURE_TOKEN_RE.source, "g");
    const m = re.exec("see $[feature:chat-attachments]");
    expect(m).not.toBeNull();
    expect(m![1]).toBe("chat-attachments");
  });

  test("does not match other sigils", () => {
    const re = new RegExp(FEATURE_TOKEN_RE.source, "g");
    expect(re.exec("![agent:Bot]")).toBeNull();
    re.lastIndex = 0;
    expect(re.exec("@[file:src/a.ts]")).toBeNull();
    re.lastIndex = 0;
    expect(re.exec("/[cmd:foo]")).toBeNull();
  });

  test("does not match unrelated $-sequences (e.g. $5.00, ${var})", () => {
    const re = new RegExp(FEATURE_TOKEN_RE.source, "g");
    expect(re.exec("price is $5.00")).toBeNull();
    re.lastIndex = 0;
    expect(re.exec("var is ${someVar}")).toBeNull();
    re.lastIndex = 0;
    expect(re.exec("$ARGUMENTS")).toBeNull();
  });

  test("matches multiple in one string with the global flag", () => {
    const re = new RegExp(FEATURE_TOKEN_RE.source, "g");
    const text = "$[feature:a] and $[feature:b]";
    const names: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) names.push(m[1]!);
    expect(names).toEqual(["a", "b"]);
  });
});
