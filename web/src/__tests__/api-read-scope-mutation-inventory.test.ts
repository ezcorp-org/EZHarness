/**
 * PINNING TEST for the API-key scope ⇄ mutation mapping.
 *
 * The `read` scope used to authorize MUTATION and DESTRUCTION on 18 handlers
 * (`DELETE /api/projects/:id`, `DELETE /api/memories/:id`, …) while the shipped
 * operator doc called `read` "no writes". The 2026-08 re-scope moved 12 of them
 * onto the new `write` scope (plus `admin` / `chat` for two), backfilled `write`
 * onto every issued `read` key so nothing broke, and left 6 — three read-shaped
 * by design, three blocked by a concurrent branch. Full reasoning and the
 * "could not touch" list: `docs/audit/2026-08-read-scope-mutation-inventory.md`.
 *
 * Scopes are FLAT — `hasRequiredScope` (`src/auth/api-key.ts`) is a plain
 * `includes()`, so `read` admitting a delete was a deliberate route-by-route
 * choice, not an implication of some ordering; and `write` does not imply
 * `read` now either. That flatness is asserted below so nobody later
 * "simplifies" it into a hierarchy.
 *
 * This test freezes the mapping in BOTH halves — what still takes `read` and
 * what takes `write` — so drift in either direction (a new route quietly gating
 * a delete on `read`, or a re-scoped one loosened back) fails loudly and by
 * name.
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
import { API_KEY_SCOPES, hasRequiredScope, isApiKeyScope } from "../../../src/auth/api-key";

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
 * FROZEN: every mutating handler that STILL gates on the `read` scope.
 *
 * Was 18 on 2026-08-02. The 2026-08 re-scope moved 12 of them onto `write` /
 * `admin` / `chat` (see WRITE_SCOPED_MUTATIONS below and the doc's mapping
 * table). What remains is deliberate, in two groups:
 *
 *   - **Read-shaped by design** — `POST /api/ez/conversation` (idempotent
 *     find-or-create keyed by the caller's own id), `POST /api/composer/suggest`
 *     (returns suggestions; POST is for body size) and `POST /api/warmup`
 *     (idempotent cache warm). Nothing is destroyed and the caller chooses
 *     nothing, so `write` would be noise.
 *   - **Blocked by a concurrent branch** — the three `projects/[id]` and
 *     `knowledge-base/[id]` handlers. Those two files are owned by the
 *     cross-tenant ownership fix and could not be edited here without a
 *     collision. They are listed in the doc's "could not touch" section with
 *     the exact one-line change each needs. This is the ONE incoherent edge
 *     of the current state: `POST /api/projects` takes `write` while
 *     `DELETE /api/projects/:id` still takes `read`.
 *
 * A PIN, not a debt list — this list and the doc are edited together whenever
 * the semantics deliberately change, in EITHER direction. Sorted; keep sorted.
 */
const READ_SCOPED_MUTATIONS: readonly string[] = [
  "POST /api/composer/suggest",
  "POST /api/ez/conversation",
  "POST /api/warmup",
];

/**
 * FROZEN: the mutating handlers moved onto the new `write` scope in 2026-08.
 *
 * Frozen for the same reason as the list above — this is the half that must
 * not silently erode back. A handler dropping off this list has had its
 * mutation gate loosened, which is precisely the regression the whole
 * investigation was about.
 */
const WRITE_SCOPED_MUTATIONS: readonly string[] = [
  "DELETE /api/contexts/:id",
  "DELETE /api/knowledge-base/:id",
  "DELETE /api/lessons/:id",
  "DELETE /api/memories/:id",
  "DELETE /api/projects/:id",
  "PATCH /api/lessons/:id",
  "PATCH /api/memories/:id",
  "POST /api/import/preview",
  "POST /api/knowledge-base",
  "POST /api/memories",
  "POST /api/projects",
  "PUT /api/memories/:id",
  "PUT /api/projects/:id",
];

/**
 * `write`-scoped mutating handlers added AFTER the 2026-08 investigation.
 *
 * A separate list, not extra entries in the frozen one, because the frozen
 * one is a CENSUS: "3 + 13 + 2 = the 18 the investigation found, nothing
 * dropped on the floor". Appending to it would make that arithmetic drift
 * every time an unrelated feature ships a mutating route, and the first time
 * someone had to change the number to make CI pass, the census would stop
 * being evidence of anything.
 *
 * Kept under the same rules: sorted, disjoint from the frozen list, and part
 * of the EXACTLY-equal live comparison — so a handler dropping off this list
 * fails just as loudly. It is a new-arrivals ledger, not a waiver.
 */
const WRITE_SCOPED_ADDED_SINCE: readonly string[] = [
  // The project-members API (round 4 — the `project_members` membership
  // model). `write` from birth; neither ever held `read`.
  // KB sharing (round 5 — the verb that creates the ownerless row
  // `KB-SHARED-NULL-OWNER` always described). `write` from birth: both change
  // who a document is disclosed to, so neither may sit behind `read`.
  // (Sorted, per the ledger invariant below — hence the interleave with the
  // round-4 entries rather than an append.)
  "DELETE /api/knowledge-base/:id/share",
  "DELETE /api/projects/:id/members/:userId",
  "POST /api/knowledge-base/:id/share",
  "POST /api/projects/:id/members",
];

/** Every handler expected to hold `write` today, sorted. */
const ALL_WRITE_SCOPED: readonly string[] = [
  ...WRITE_SCOPED_MUTATIONS,
  ...WRITE_SCOPED_ADDED_SINCE,
].sort();

/** The two handlers that moved to a scope other than `write`. */
const REHOMED_ELSEWHERE: ReadonlyArray<[string, string]> = [
  // Enforced admin INLINE (`fs/mkdir/+server.ts:22`) while advertising `read`
  // — the F4 blind spot. The scope now says what the gate does.
  ["POST /api/fs/mkdir", "admin"],
  // Dispatches a bundled-extension tool and persists a message row: that is
  // the `chat` surface, and `chat` gains nothing it lacked (the same tools are
  // reachable via POST /api/conversations/:id/messages).
  ["POST /api/ez-actions/:name", "chat"],
];

function liveMutationsWithScope(scope: string): string[] {
  return handlers
    .filter((h) => MUTATING.has(h.key.split(" ")[0]!) && h.scopes.includes(scope))
    .map((h) => h.key)
    .sort();
}

describe("read-scope mutation inventory (frozen baseline)", () => {
  test("the set of read-gated mutating handlers is EXACTLY the frozen list", () => {
    // toEqual on sorted arrays fails in BOTH directions: a new read-gated
    // mutation is an unlisted addition, a re-scoped one is a missing entry.
    // Either way the diff names the route, so nobody has to guess.
    expect(liveMutationsWithScope("read")).toEqual([...READ_SCOPED_MUTATIONS]);
  });

  test("the set of write-gated mutating handlers is EXACTLY the frozen list", () => {
    // The other half of the same pin. A handler falling off this list has had
    // its mutation gate loosened. The comparison spans the frozen list AND
    // the added-since ledger, so a route in neither still fails as an
    // unlisted addition.
    expect(liveMutationsWithScope("write")).toEqual([...ALL_WRITE_SCOPED]);
  });

  test("every frozen entry is still live — the ledger cannot mask a dropout", () => {
    // Discrimination for the equality above: if a frozen handler lost its
    // `write` gate and an added-since one covered for it, the sorted sets
    // could still differ — but this asserts the frozen 13 SPECIFICALLY, so
    // the ledger can never be a hiding place.
    const live = new Set(liveMutationsWithScope("write"));
    for (const key of WRITE_SCOPED_MUTATIONS) {
      expect(live.has(key)).toBe(true);
    }
  });

  test("the two rehomed handlers gate on the scope they were moved to", () => {
    for (const [key, scope] of REHOMED_ELSEWHERE) {
      const h = handlers.find((x) => x.key === key);
      expect(h).toBeDefined();
      expect(h!.scopes).toEqual([scope]);
    }
  });

  test("the frozen lists are non-empty and sorted (guards a vacuous pass)", () => {
    // An emptied list would make the equalities above pass only when the live
    // set is ALSO empty — but an unsorted list makes a real diff unreadable,
    // and a shrinking one must be a deliberate edit.
    expect(READ_SCOPED_MUTATIONS.length).toBe(3);
    expect(WRITE_SCOPED_MUTATIONS.length).toBe(13);
    expect(REHOMED_ELSEWHERE.length).toBe(2);
    // 3 + 13 + 2 = the 18 the investigation found. Nothing was dropped on the
    // floor by the re-scope; every handler is still accounted for.
    expect(
      READ_SCOPED_MUTATIONS.length + WRITE_SCOPED_MUTATIONS.length + REHOMED_ELSEWHERE.length,
    ).toBe(18);
    expect([...READ_SCOPED_MUTATIONS]).toEqual([...READ_SCOPED_MUTATIONS].sort());
    expect([...WRITE_SCOPED_MUTATIONS]).toEqual([...WRITE_SCOPED_MUTATIONS].sort());
  });

  test("the added-since ledger is sorted and disjoint from the frozen list", () => {
    // The ledger exists so the census above stays exact. It only holds if it
    // cannot quietly become a second home for a frozen entry.
    expect([...WRITE_SCOPED_ADDED_SINCE]).toEqual([...WRITE_SCOPED_ADDED_SINCE].sort());
    const frozen = new Set(WRITE_SCOPED_MUTATIONS);
    for (const key of WRITE_SCOPED_ADDED_SINCE) {
      expect(frozen.has(key)).toBe(false);
    }
  });

  test("the GET siblings of the re-scoped routes still take `read`", () => {
    // The split is per-VERB. If a re-scope accidentally moved a whole file,
    // read-only integrations would break for no reason — the opposite failure
    // from the one being fixed, and just as invisible without this.
    for (const key of [
      "GET /api/memories/:id",
      "GET /api/memories",
      "GET /api/projects",
      "GET /api/knowledge-base",
    ]) {
      expect(handlers.find((h) => h.key === key)?.scopes).toEqual(["read"]);
    }
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

  test("cross-file gates remain limited to extension admission and GitHub authorization", () => {
    expect([...crossFileGatingHelpers()]).toEqual([
      ["hooks.server.ts:handleApp", ["extensions"]],
      ["hooks.server.ts:handle", ["extensions"]],
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

describe("scopes are FLAT — `write` does not imply, and is not implied by, `read`", () => {
  test("a read-only key does NOT satisfy a write gate", () => {
    // The semantic the whole re-scope buys, asserted against the shared
    // predicate rather than restated in prose.
    expect(hasRequiredScope(["read"], "write")).toBe(false);
  });

  test("a write-only key does NOT satisfy a read gate either", () => {
    // Flatness cuts both ways, which is why the CLI mints `read,write,chat`
    // rather than assuming `write` covers reads (src/cli.ts DEFAULT_KEY_SCOPES).
    expect(hasRequiredScope(["write"], "read")).toBe(false);
  });

  test("the pair a migrated key carries satisfies both", () => {
    // What backfill-api-key-write-scope.ts leaves an existing `read` key with.
    expect(hasRequiredScope(["read", "write"], "read")).toBe(true);
    expect(hasRequiredScope(["read", "write"], "write")).toBe(true);
  });

  test("a chat-only key is still refused by every read- and write-gated route", () => {
    // The counter-intuitive fact the investigation surfaced, unchanged by the
    // re-scope: `chat` never subsumed `read`, and it does not subsume `write`.
    // Pinned so the re-scope cannot be "simplified" into a hierarchy later.
    expect(hasRequiredScope(["chat"], "read")).toBe(false);
    expect(hasRequiredScope(["chat"], "write")).toBe(false);
  });

  test("no scope subsumes another (there is no hierarchy to lean on)", () => {
    for (const held of API_KEY_SCOPES) {
      for (const needed of API_KEY_SCOPES) {
        expect(hasRequiredScope([held], needed)).toBe(held === needed);
      }
    }
  });

  test("`write` is a real member of the canonical vocabulary", () => {
    // Guards the loop above against passing vacuously if `write` were dropped
    // from API_KEY_SCOPES while the routes still demanded it — which would
    // make every mutating route unreachable by any mintable key.
    expect([...API_KEY_SCOPES]).toEqual(["read", "write", "chat", "extensions", "admin"]);
    expect(isApiKeyScope("write")).toBe(true);
  });

  test("a cookie session is not scope-gated at all (undefined => allow)", () => {
    // Why re-scoping breaks only API-key callers, never the browser UI.
    expect(hasRequiredScope(undefined, "read")).toBe(true);
    expect(hasRequiredScope(undefined, "admin")).toBe(true);
  });
});
