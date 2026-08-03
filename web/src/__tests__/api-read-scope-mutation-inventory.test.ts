/**
 * PINNING TEST — asserts what IS, not what SHOULD BE.
 *
 * The `read` API-key scope currently authorizes MUTATION and DESTRUCTION on 18
 * handlers (`DELETE /api/projects/:id`, `DELETE /api/memories/:id`, …). Scopes
 * are FLAT — `src/auth/api-key.ts:32-38` (`hasRequiredScope`) is a plain
 * `includes()`, so `read` admitting a delete is a deliberate route-by-route
 * choice, not an implication of some ordering.
 *
 * Whether that is a bug or a naming problem is an OPEN decision (see
 * `docs/audit/2026-08-read-scope-mutation-inventory.md`). This test takes no
 * side. It freezes today's behaviour so that whichever way the decision goes,
 * it starts from a measured baseline rather than an assumption — and so that
 * an accidental drift in EITHER direction (a 19th route quietly gating a
 * delete on `read`, or one silently re-scoped) fails loudly and by name.
 *
 * ── DETECTION METHOD (this is the part that matters) ───────────────────────
 * The audit that produced the original "at least 17" scanned only the text
 * AFTER each `export const <METHOD>` line. That misses every route whose
 * `requireScope` call sits in a helper declared ABOVE the export — a whole
 * CLASS of route, invisible, with no signal that anything was skipped. It is
 * exactly the "looks like a check and isn't" shape this repo keeps finding.
 *
 * So this scan splits each module into TOP-LEVEL DECLARATIONS and takes the
 * transitive closure of the identifiers a handler references, then looks for
 * `requireScope` anywhere in that closure. `POST /api/ez/conversation` is the
 * live proof: its gate lives in `findOrCreate()` at
 * `web/src/routes/api/ez/conversation/+server.ts:36`, ten lines ABOVE the
 * export at `:60`. A dedicated test below asserts the closure method sees it
 * and the naive method does not, so "simplifying" this scanner back into the
 * broken shape fails the build instead of silently shrinking the inventory.
 *
 * ── WHAT THIS METHOD CANNOT SEE (stated, not hidden) ───────────────────────
 *  1. Gates in an IMPORTED helper. Verified empirically to be a non-issue
 *     TODAY: the only cross-file `requireScope` caller in `web/src` is
 *     `authGithubRoute` (`routes/api/integrations/github-projects/_shared.ts:46`,
 *     scope `extensions`, not `read`). `crossFileGatingHelpers` below re-derives
 *     that set on every run, so if a SECOND one ever appears the test fails and
 *     forces this comment to be re-verified.
 *  2. Dynamically computed scopes (`requireScope(locals, someVar)`). None exist;
 *     asserted below.
 *  3. Gate ORDER. It reports the scopes a handler can require, not which fires
 *     first. Immaterial here — all 18 call `requireScope` as their first
 *     statement.
 * These limits were cross-checked against a behavioral probe that imports and
 * INVOKES all 291 handlers with a zero-scope key and reads the `required` field
 * off the resulting 403; the two methods agreed on all 287 control-tier
 * handlers. See the doc for the probe source and the 4 `/api/__test/**`
 * differences (their `isTestSurfaceEnabled` 404 fires before the scope gate).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";
import { hasRequiredScope } from "../../../src/auth/api-key";

const routesDir = `${import.meta.dir}/../routes`;
const webSrcDir = `${import.meta.dir}/..`;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** A top-level declaration head at column 0. These modules are flat, so a
 *  declaration runs until the next one — no brace matching needed. */
const DECL_START =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/;

/** `requireScope(<anything>, "<scope>")` — the literal-scope call shape. */
const SCOPE_CALL = /requireScope\s*\(\s*[\w.$]+\s*,\s*["'`](\w+)["'`]\s*\)/g;

/** First non-space character of a `requireScope` call's SECOND argument.
 *  `(\S)` forces the preceding `\s*` to consume every space — a `(?!["'`])`
 *  lookahead would backtrack `\s*` to zero width and match the space instead,
 *  flagging every literal call as dynamic. */
const SCOPE_ARG2_HEAD = /requireScope\s*\(\s*[\w.$]+\s*,\s*(\S)/g;

/** Does this source call `requireScope` with a NON-literal scope argument? */
function hasDynamicScopeCall(src: string): boolean {
  return [...decomment(src).matchAll(SCOPE_ARG2_HEAD)].some(
    (m) => !["\"", "'", "`"].includes(m[1]!),
  );
}

/** Strip comments so prose mentioning `requireScope(locals, "admin")` in a
 *  doc-block never counts as a call site. */
function decomment(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function topLevelDecls(src: string): Map<string, string> {
  const lines = src.split("\n");
  const starts: { name: string; line: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = DECL_START.exec(lines[i]!);
    if (m) starts.push({ name: m[1]!, line: i });
  }
  const out = new Map<string, string>();
  for (let k = 0; k < starts.length; k++) {
    const to = k + 1 < starts.length ? starts[k + 1]!.line : lines.length;
    out.set(starts[k]!.name, lines.slice(starts[k]!.line, to).join("\n"));
  }
  return out;
}

/** Transitive closure of the same-file declarations a handler reaches. */
function closureSource(decls: Map<string, string>, root: string): string {
  const seen = new Set([root]);
  const queue = [root];
  let text = "";
  while (queue.length > 0) {
    const body = decls.get(queue.shift()!);
    if (body === undefined) continue;
    text += `\n${body}`;
    for (const id of decomment(body).match(/[A-Za-z_$][\w$]*/g) ?? []) {
      if (!seen.has(id) && decls.has(id)) {
        seen.add(id);
        queue.push(id);
      }
    }
  }
  return text;
}

function scopesIn(text: string): string[] {
  return [...new Set([...decomment(text).matchAll(SCOPE_CALL)].map((m) => m[1]!))];
}

function fileToRoutePath(rel: string): string {
  let p = rel.replace(/\/\+server\.ts$/, "");
  p = p.split("/").filter((s) => !(s.startsWith("(") && s.endsWith(")"))).join("/");
  return `/${p.replace(/\[\.\.\.([^\]]+)\]/g, ":$1").replace(/\[([^\]]+)\]/g, ":$1")}`;
}

/** Exported helpers OUTSIDE `+server.ts` whose body calls `requireScope` —
 *  the cross-file blind spot, re-derived every run so it can't silently grow. */
function crossFileGatingHelpers(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const rel of new Glob("**/*.ts").scanSync(webSrcDir)) {
    if (rel.endsWith("+server.ts")) continue;
    if (rel.includes("__tests__") || rel.includes(".test.")) continue;
    const src = readFileSync(`${webSrcDir}/${rel}`, "utf8");
    if (!/requireScope\s*\(/.test(decomment(src))) continue;
    const decls = topLevelDecls(src);
    for (const name of decls.keys()) {
      // `requireScope` itself is the definition, not a gate that wraps one.
      if (name === "requireScope") continue;
      const s = scopesIn(closureSource(decls, name));
      if (s.length > 0) out.set(`${rel}:${name}`, s);
    }
  }
  return out;
}

interface Handler {
  key: string;
  file: string;
  scopes: string[];
}

function scanHandlers(): Handler[] {
  const out: Handler[] = [];
  for (const rel of new Glob("api/**/+server.ts").scanSync(routesDir)) {
    const src = readFileSync(`${routesDir}/${rel}`, "utf8");
    const decls = topLevelDecls(src);
    for (const m of METHODS) {
      if (!new RegExp(`export\\s+(?:const|function|async\\s+function)\\s+${m}\\b`).test(src)) continue;
      out.push({
        key: `${m} ${fileToRoutePath(rel)}`,
        file: rel,
        scopes: scopesIn(closureSource(decls, m)),
      });
    }
  }
  return out;
}

const handlers = scanHandlers();

/**
 * FROZEN: every mutating handler that gates on the `read` scope, as of
 * 2026-08-02. This is a PIN, not a debt list — it must be edited (with the
 * doc) whenever the semantics are deliberately changed, in EITHER direction.
 * Sorted; keep it sorted.
 */
const READ_SCOPED_MUTATIONS: readonly string[] = [
  "DELETE /api/contexts/:id",
  "DELETE /api/knowledge-base/:id",
  "DELETE /api/lessons/:id",
  "DELETE /api/memories/:id",
  "DELETE /api/projects/:id",
  "PATCH /api/lessons/:id",
  "PATCH /api/memories/:id",
  "POST /api/composer/suggest",
  "POST /api/ez-actions/:name",
  "POST /api/ez/conversation",
  "POST /api/fs/mkdir",
  "POST /api/import/preview",
  "POST /api/knowledge-base",
  "POST /api/memories",
  "POST /api/projects",
  "POST /api/warmup",
  "PUT /api/memories/:id",
  "PUT /api/projects/:id",
];

function liveReadScopedMutations(): string[] {
  return handlers
    .filter((h) => MUTATING.has(h.key.split(" ")[0]!) && h.scopes.includes("read"))
    .map((h) => h.key)
    .sort();
}

describe("read-scope mutation inventory (frozen baseline)", () => {
  test("the set of read-gated mutating handlers is EXACTLY the frozen list", () => {
    // toEqual on sorted arrays fails in BOTH directions: a new read-gated
    // mutation is an unlisted addition, a re-scoped one is a missing entry.
    // Either way the diff names the route, so nobody has to guess.
    expect(liveReadScopedMutations()).toEqual([...READ_SCOPED_MUTATIONS]);
  });

  test("the frozen list is non-empty and sorted (guards a vacuous pass)", () => {
    // An emptied list would make the equality above pass only when the live
    // set is ALSO empty — but an unsorted list would make a real diff
    // unreadable, and a shrinking one must be a deliberate edit.
    expect(READ_SCOPED_MUTATIONS.length).toBe(18);
    expect([...READ_SCOPED_MUTATIONS]).toEqual([...READ_SCOPED_MUTATIONS].sort());
  });

  test("the scan found the whole route surface (guards a broken glob)", () => {
    // If the glob or the export regex ever breaks, `liveReadScopedMutations`
    // returns [] and the equality above would fail — but only AFTER someone
    // deleted the frozen list. Assert the population directly so a scanner
    // that silently sees nothing can never be mistaken for a clean repo.
    expect(handlers.length).toBeGreaterThan(250);
    expect(handlers.filter((h) => h.scopes.length > 0).length).toBeGreaterThan(150);
  });
});

describe("the detection method itself (this is what the audit got wrong)", () => {
  const EZ_CONV = "api/ez/conversation/+server.ts";

  test("a gate declared ABOVE the export is attributed to the handler", () => {
    // POST /api/ez/conversation gates on `read` inside `findOrCreate()`,
    // declared above `export const POST`. The original audit's scan could not
    // see this and reported 17 instead of 18.
    const h = handlers.find((x) => x.key === "POST /api/ez/conversation");
    expect(h).toBeDefined();
    expect(h!.file).toBe(EZ_CONV);
    expect(h!.scopes).toEqual(["read"]);
  });

  test("the naive 'text after the export line' scan MISSES that route", () => {
    // Pins the delta rather than asserting it in prose: if someone rewrites
    // the scanner in the naive shape, the frozen list silently loses an entry
    // and this test is the one that explains why.
    const src = readFileSync(`${routesDir}/${EZ_CONV}`, "utf8");
    const lines = src.split("\n");
    const exportLine = lines.findIndex((l) => /export\s+const\s+POST\b/.test(l));
    expect(exportLine).toBeGreaterThan(-1);
    const naiveBody = lines.slice(exportLine).join("\n");
    expect(scopesIn(naiveBody)).toEqual([]);
    // …while the closure method does see it.
    expect(scopesIn(closureSource(topLevelDecls(src), "POST"))).toEqual(["read"]);
  });

  test("the only cross-file scope gate is authGithubRoute (extensions)", () => {
    // The one gate this file-local scan would otherwise be blind to. Frozen so
    // that a SECOND cross-file gate cannot appear without forcing a re-read of
    // this module's "what it cannot see" contract.
    expect([...crossFileGatingHelpers()]).toEqual([
      ["routes/api/integrations/github-projects/_shared.ts:authGithubRoute", ["extensions"]],
    ]);
  });

  test("no route computes its scope dynamically", () => {
    // A `requireScope(locals, someVariable)` would be invisible to every
    // literal-matching scan, including this one. Assert none exists.
    const dynamic = handlers
      .filter((h) => hasDynamicScopeCall(readFileSync(`${routesDir}/${h.file}`, "utf8")))
      .map((h) => h.file);
    expect([...new Set(dynamic)]).toEqual([]);
  });

  test("the scan's own regexes match the shapes it depends on (self-check)", () => {
    // Guards the failure mode where a regex typo makes every test above pass
    // by matching nothing at all.
    expect(scopesIn(`requireScope(locals, "read");`)).toEqual(["read"]);
    expect(scopesIn(`// requireScope(locals, "read")`)).toEqual([]);
    expect(scopesIn(`/* requireScope(locals, "admin") */`)).toEqual([]);
    expect(hasDynamicScopeCall(`requireScope(locals, wanted)`)).toBe(true);
    expect(hasDynamicScopeCall(`requireScope(locals, "read")`)).toBe(false);
    expect(hasDynamicScopeCall(`requireScope(locals,"read")`)).toBe(false);
    const decls = topLevelDecls(`const helper = () => requireScope(l, "read");\nexport const POST = () => helper();\n`);
    expect(scopesIn(closureSource(decls, "POST"))).toEqual(["read"]);
  });
});

describe("scopes are FLAT — `read` does not imply, and is not implied by, anything", () => {
  test("a read-only key satisfies a read gate, so it reaches all 18 mutations", () => {
    // The semantic under the inventory, asserted against the shared predicate
    // rather than restated in prose: nothing about `read` marks it read-only.
    expect(hasRequiredScope(["read"], "read")).toBe(true);
  });

  test("a chat-only key is REFUSED by those same 18 handlers", () => {
    // The counter-intuitive half, and the reason re-scoping is a real breaking
    // change: today `chat` cannot delete a memory or a project — only `read`
    // can. Pinned so that inverting it is a visible decision.
    expect(hasRequiredScope(["chat"], "read")).toBe(false);
  });

  test("no scope subsumes another (there is no hierarchy to lean on)", () => {
    for (const held of ["read", "chat", "extensions", "admin"] as const) {
      for (const needed of ["read", "chat", "extensions", "admin"] as const) {
        expect(hasRequiredScope([held], needed)).toBe(held === needed);
      }
    }
  });

  test("a cookie session is not scope-gated at all (undefined => allow)", () => {
    // Why re-scoping breaks only API-key callers, never the browser UI.
    expect(hasRequiredScope(undefined, "read")).toBe(true);
    expect(hasRequiredScope(undefined, "admin")).toBe(true);
  });
});
