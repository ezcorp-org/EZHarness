/**
 * Governance meta-test — keeps the remote-control contract from rotting.
 *
 *  1. Every `/api/__test/**` route is gated by `isTestSurfaceEnabled` (no
 *     ungated test/determinism surface can ship).
 *  2. Every control-tier `/api/*` route on disk is registered in
 *     `src/api-registry.ts` (so it is documented + appears in the generated
 *     OpenAPI contract) — and every registered route exists on disk. Both
 *     directions are now absolute: the frozen BASELINE of 75 unregistered
 *     routes and the KNOWN_STALE allowance of 4 phantom entries were paid off
 *     in 2026-08, so neither carve-out remains for a new gap to hide in.
 *  3. Every registry entry declares the `scope` it enforces. Enforced as a
 *     ratchet against a frozen set (`KNOWN_SCOPELESS`), because `scope` is
 *     still optional on `ApiRouteEntry` and 93 entries predated the rule (91
 *     remain) — see the block at the end of "registry ⇄ filesystem parity".
 *
 * See docs/harness-contract.md.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";
import { apiRegistry } from "../../../src/api-registry";
// Cross-package relative imports (the standalone package isn't a root dep in
// this checkout — mirrors index.test.ts importing the app's event list). Both
// modules are pure data with no side effects.
import { HARNESS_ROUTES } from "../../../packages/@ezcorp/harness-client/src/routes";
import { RUNTIME_EVENT_NAMES as HARNESS_EVENT_NAMES } from "../../../packages/@ezcorp/harness-client/src/events";
import { RUNTIME_EVENT_NAMES as APP_EVENT_NAMES } from "../lib/runtime-event-names";

const routesDir = `${import.meta.dir}/../routes`;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

function fileToRoutePath(rel: string): string {
  let p = rel.replace(/\/\+server\.ts$/, "");
  // Drop SvelteKit route groups: "(group)" segments don't appear in URLs.
  p = p.split("/").filter((seg) => !(seg.startsWith("(") && seg.endsWith(")"))).join("/");
  // [...rest] -> :rest ; [param] -> :param  (registry uses Express syntax).
  p = p.replace(/\[\.\.\.([^\]]+)\]/g, ":$1").replace(/\[([^\]]+)\]/g, ":$1");
  return "/" + p;
}

function exportedMethods(src: string): string[] {
  const found = new Set<string>();
  for (const m of METHODS) {
    if (new RegExp(`export\\s+(?:const|function|async\\s+function)\\s+${m}\\b`).test(src)) found.add(m);
    // re-export form: export { GET, POST }
    if (new RegExp(`export\\s*\\{[^}]*\\b${m}\\b[^}]*\\}`).test(src)) found.add(m);
  }
  return [...found];
}

interface DiskRoute { method: string; path: string; file: string }

function discoverDiskRoutes(): DiskRoute[] {
  const out: DiskRoute[] = [];
  const glob = new Glob("api/**/+server.ts");
  for (const rel of glob.scanSync(routesDir)) {
    const src = readFileSync(`${routesDir}/${rel}`, "utf8");
    const path = fileToRoutePath(rel);
    for (const method of exportedMethods(src)) out.push({ method, path, file: rel });
  }
  return out;
}

const disk = discoverDiskRoutes();

describe("test-surface gating", () => {
  test("every /api/__test/** route INVOKES isTestSurfaceEnabled as a guard", () => {
    const glob = new Glob("api/__test/**/+server.ts");
    const ungated: string[] = [];
    for (const rel of glob.scanSync(routesDir)) {
      const src = readFileSync(`${routesDir}/${rel}`, "utf8");
      // Require the actual negated guard (`if (!isTestSurfaceEnabled())`),
      // not a mere import/mention — so a route can't reference the symbol in
      // a comment or unused import and slip through ungated.
      if (!/if\s*\(\s*!\s*isTestSurfaceEnabled\s*\(\s*\)\s*\)/.test(src)) ungated.push(rel);
    }
    expect(ungated).toEqual([]);
  });

  test("there is at least one __test route (sanity: glob works)", () => {
    expect(disk.some((r) => r.path.startsWith("/api/__test/"))).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// F4 — inline admin gates, the blind spot in the scan above.
//
// The pairing scan only ever OPENS files matching `requireScope(_,"admin")` —
// 28 of 209. A route that enforces admin with a bare `if (user.role !==
// "admin") return 403` and carries some OTHER scope is invisible to it, so
// DELETING that `if` would land green. `POST /api/fs/mkdir` and
// `GET /api/fs/list` are exactly that shape.
//
// The hard part is not finding `role` comparisons — 38 files have one. It is
// telling a GATE from the sec-H3 OWNERSHIP BYPASS idiom, which is 34 of them.
// A scan that confuses the two drowns in false positives and gets weakened or
// ignored, which is worse than the gap.
//
// THE RULE — a condition is an inline admin GATE iff BOTH hold:
//   1. it is SOLE: the `if (...)` contains no `&&` / `||`. A compound
//      condition is the ownership idiom — `row.userId !== user.id &&
//      user.role !== "admin"` — where admin is an escape hatch from an
//      ownership check, not the thing being demanded.
//   2. it is NEGATED: `.role !== "admin"`, the DENY direction. A sole but
//      POSITIVE `if (user.role === "admin") return true` is an allow/bypass
//      branch (e.g. `callerOwnsRun` in `api/runs/[id]/+server.ts`), not a gate.
//
// Both halves are load-bearing and both are proven, in both directions, by the
// tests below: the rule must FLAG fs/mkdir and fs/list and must NOT flag any
// of the ownership-bypass sites.
// ───────────────────────────────────────────────────────────────────────────

/** Strip comments so prose about `user.role !== "admin"` is never a match. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Every `if (...)` condition in `src`, paren-balanced. */
function ifConditions(src: string): string[] {
  const out: string[] = [];
  const re = /\bif\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < src.length && depth > 0) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
      i++;
    }
    if (depth === 0) out.push(src.slice(start, i - 1));
  }
  return out;
}

const ROLE_VS_ADMIN = /\.role\s*(===|!==|==|!=)\s*["']admin["']/;

/** Does this single `if` condition express a standalone admin DENY gate? */
function isInlineAdminGate(condition: string): boolean {
  const m = ROLE_VS_ADMIN.exec(condition);
  if (!m) return false;
  if (/&&|\|\|/.test(condition)) return false; // (1) compound ⇒ ownership idiom
  return m[1] === "!==" || m[1] === "!="; //     (2) negated ⇒ deny direction
}

/** Route files enforcing admin through an inline gate. */
function inlineAdminGates(): string[] {
  const out: string[] = [];
  for (const rel of new Glob("api/**/+server.ts").scanSync(routesDir)) {
    const src = stripComments(readFileSync(`${routesDir}/${rel}`, "utf8"));
    if (ifConditions(src).some(isInlineAdminGate)) out.push(rel);
  }
  return out.sort();
}

/** Route files that compare a role against "admin" ANYWHERE but are NOT
 *  inline-gated — the ownership-bypass population the rule must leave alone.
 *
 *  Deliberately broader than `ifConditions`: a comparison in a ternary, a
 *  boolean expression or a `.filter()` predicate is still something a sloppier
 *  rule ("mentions role and admin") would trip over, so it belongs in the
 *  population this scan is measured against. */
function ownershipBypassFiles(): string[] {
  const gates = new Set(inlineAdminGates());
  const out: string[] = [];
  for (const rel of new Glob("api/**/+server.ts").scanSync(routesDir)) {
    const src = stripComments(readFileSync(`${routesDir}/${rel}`, "utf8"));
    if (!ROLE_VS_ADMIN.test(src)) continue;
    if (gates.has(rel)) continue;
    out.push(rel);
  }
  return out.sort();
}

describe("admin-gate pairing (FINDING A regression guard)", () => {
  // requireScope(locals,"admin") is allow-all for cookie sessions (it only
  // gates API-key principals, since locals.apiKeyScopes is undefined for a
  // cookie). On its own it lets any logged-in MEMBER through an admin route.
  // Every route that gates on the "admin" SCOPE must therefore ALSO gate on
  // ROLE — via requireRole(locals,"admin") or requireAdmin(locals) — so a
  // non-admin member is rejected on both axes. This static scan fails the
  // whole class of bug rather than catching one instance.
  const SCOPE_ADMIN = /requireScope\s*\(\s*\w+\s*,\s*["']admin["']\s*\)/;
  const ROLE_ADMIN = /requireRole\s*\(\s*\w+\s*,\s*["']admin["']\s*\)/;
  const REQUIRE_ADMIN = /requireAdmin\s*\(/;
  // `checkRole(locals, "admin")` is the non-throwing role gate for +server.ts
  // handlers. It is BOTH a role and (for key principals) a scope gate, so it
  // counts as a role gate here — a route pairing requireScope(admin) with
  // checkRole(admin) is correctly gated, not a scope-only offender.
  const CHECK_ROLE = /checkRole\s*\(\s*\w+\s*,\s*["']admin["']\s*\)/;
  /** Files whose role gate is written inline — see the F4 rule above. */
  const inlineGated = new Set(inlineAdminGates());

  // Pre-existing routes that gate on the admin SCOPE without a role check.
  // Surfaced by this very scan. Most are user SELF-SERVICE writes
  // (/api/account*, own developer keys, own team membership) where the
  // scope-admin is a write-gate for API-key principals and the cookie
  // allow-all is intentional — forcing requireRole(admin) there would lock
  // every member out of their own data. `extensions/[id]/violations` USED to sit
  // here because it enforces admin via an INLINE `locals.user?.role !== "admin"`
  // check the role-regexes can't see; `inlineAdminGates()` below now recognises
  // that shape, so the entry was removed rather than carried as permanent debt.
  // The instance-state routes that genuinely needed role-gating
  // (providers/[provider]/{test,refresh-models}) have been fixed with
  // requireAdmin and removed from this list. FROZEN so a NEW offender fails the
  // test (the regression guard) while pre-existing ones don't block it. Shrink
  // this list as each is reviewed; never add to it without justification.
  const KNOWN_SCOPE_ONLY_ADMIN = new Set<string>([
    "api/account/+server.ts",
    "api/account/password/+server.ts",
    "api/account/sessions/+server.ts",
    "api/settings/developer/+server.ts",
    "api/settings/developer/api-keys/+server.ts",
    "api/teams/[id]/members/+server.ts",
  ]);

  test("every route gating on requireScope(admin) ALSO gates on role", () => {
    const offenders: string[] = [];
    const glob = new Glob("api/**/+server.ts");
    for (const rel of glob.scanSync(routesDir)) {
      const src = readFileSync(`${routesDir}/${rel}`, "utf8");
      if (!SCOPE_ADMIN.test(src)) continue;
      if (ROLE_ADMIN.test(src) || REQUIRE_ADMIN.test(src) || CHECK_ROLE.test(src)) continue;
      // F4: an INLINE `if (user.role !== "admin")` is a real role gate. Before
      // this clause the scan could not see one, which is why
      // `extensions/[id]/violations` needed a carve-out and why `fs/mkdir`
      // would have registered as an offender the moment it gained the admin
      // scope. `inlineAdminGates()` distinguishes it from the ownership-bypass
      // idiom; see the rule above.
      if (inlineGated.has(rel)) continue;
      if (KNOWN_SCOPE_ONLY_ADMIN.has(rel)) continue;
      offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  test("the baseline of scope-only admin routes does not grow", () => {
    // Belt-and-suspenders: independently of the offenders test, prove the
    // current scope-only set is EXACTLY the frozen baseline (no shrink-and-
    // re-add, no silent growth). A removed entry that's still scope-only
    // would surface here too.
    const scopeOnly = new Set<string>();
    const glob = new Glob("api/**/+server.ts");
    for (const rel of glob.scanSync(routesDir)) {
      const src = readFileSync(`${routesDir}/${rel}`, "utf8");
      if (!SCOPE_ADMIN.test(src)) continue;
      if (ROLE_ADMIN.test(src) || REQUIRE_ADMIN.test(src) || CHECK_ROLE.test(src)) continue;
      // F4: an INLINE `if (user.role !== "admin")` is a real role gate. Before
      // this clause the scan could not see one, which is why
      // `extensions/[id]/violations` needed a carve-out and why `fs/mkdir`
      // would have registered as an offender the moment it gained the admin
      // scope. `inlineAdminGates()` distinguishes it from the ownership-bypass
      // idiom; see the rule above.
      if (inlineGated.has(rel)) continue;
      scopeOnly.add(rel);
    }
    const extra = [...scopeOnly].filter((r) => !KNOWN_SCOPE_ONLY_ADMIN.has(r)).sort();
    expect(extra).toEqual([]);
  });

  test("an INLINE admin gate counts as a role gate (F4)", () => {
    // `extensions/[id]/violations` sat in KNOWN_SCOPE_ONLY_ADMIN purely because
    // its role gate is written inline (`locals.user?.role !== "admin"`) and the
    // three regexes above cannot see that shape. Now that `inlineAdminGates()`
    // recognises it, the route is correctly gated on both axes and needs no
    // carve-out. Asserted rather than just deleted from the list, so the reason
    // the entry left is recorded.
    expect(inlineAdminGates()).toContain("api/extensions/[id]/violations/+server.ts");
    expect(KNOWN_SCOPE_ONLY_ADMIN.has("api/extensions/[id]/violations/+server.ts")).toBe(false);
  });

  test("the scan actually matches the patterns it relies on (self-check)", () => {
    // Guards against a regex typo silently passing the test above by never
    // matching anything. Proves both the offender and the safe shapes parse.
    const offending = `requireScope(locals, "admin");`;
    const safeRole = `requireScope(locals, "admin"); requireRole(locals, "admin");`;
    const safeAdmin = `requireAdmin(locals);`;
    const safeCheckRole = `requireScope(locals, "admin"); checkRole(locals, "admin");`;
    expect(SCOPE_ADMIN.test(offending)).toBe(true);
    expect(ROLE_ADMIN.test(offending)).toBe(false);
    expect(ROLE_ADMIN.test(safeRole)).toBe(true);
    expect(REQUIRE_ADMIN.test(safeAdmin)).toBe(true);
    // checkRole is recognized as a role gate; its regex must NOT also match a
    // plain requireScope offender (else scope-only routes would pass).
    expect(CHECK_ROLE.test(safeCheckRole)).toBe(true);
    expect(CHECK_ROLE.test(offending)).toBe(false);
  });
});

describe("inline admin gates (F4 — the pairing scan's blind spot)", () => {
  // FROZEN. Deleting an inline `if (user.role !== "admin")` drops its file from
  // this list and fails the test BY NAME — which is the whole point: that
  // deletion is invisible to every other guard in this file.
  const KNOWN_INLINE_ADMIN_GATES: readonly string[] = [
    "api/extensions/[id]/violations/+server.ts",
    "api/fs/list/+server.ts",
    "api/fs/mkdir/+server.ts",
  ];

  test("the set of inline-admin-gated routes is EXACTLY the frozen list", () => {
    expect(inlineAdminGates()).toEqual([...KNOWN_INLINE_ADMIN_GATES]);
  });

  test("the rule FLAGS the two fs routes (positive direction)", () => {
    // The named F4 instances. Both carry a NON-admin scope, so the pairing scan
    // above never opens them.
    expect(inlineAdminGates()).toContain("api/fs/mkdir/+server.ts");
    expect(inlineAdminGates()).toContain("api/fs/list/+server.ts");
  });

  test("the rule flags NONE of the ownership-bypass sites (negative direction)", () => {
    // The discrimination that makes this scan usable. If the rule degraded to
    // "mentions role and admin", every one of these would be a false positive.
    const bypass = ownershipBypassFiles();
    const gates = new Set(inlineAdminGates());
    expect(bypass.filter((f) => gates.has(f))).toEqual([]);
    // …and the bypass population is large, so the assertion above is not
    // passing merely because there is nothing to confuse the rule with. The
    // DISCRIMINATION is the number that matters: of every route file that
    // compares a role against "admin", only a small minority are gates.
    const population = bypass.length + gates.size;
    expect(gates.size).toBe(3);
    expect(population).toBeGreaterThanOrEqual(35);
    expect(bypass.length).toBe(population - 3);
  });

  test("known bypass sites are classified as bypasses, by name", () => {
    const bypass = ownershipBypassFiles();
    // The sec-H3 compound idiom.
    expect(bypass).toContain("api/memories/[id]/+server.ts");
    expect(bypass).toContain("api/conversations/[id]/+server.ts");
    // The SOLE-but-POSITIVE shape: `if (user.role === "admin") return true`
    // inside `callerOwnsRun`. Rule half (2) is the only thing separating this
    // from a gate — half (1) alone would misclassify it.
    expect(bypass).toContain("api/runs/[id]/+server.ts");
  });

  test("the rule's two halves are each necessary (self-check)", () => {
    // GATE: sole + negated.
    expect(isInlineAdminGate(`user.role !== "admin"`)).toBe(true);
    expect(isInlineAdminGate(`locals.user?.role !== "admin"`)).toBe(true);
    // Half (1): compound ⇒ ownership idiom, not a gate.
    expect(isInlineAdminGate(`m.userId !== user.id && user.role !== "admin"`)).toBe(false);
    expect(isInlineAdminGate(`user.role !== "admin" || x`)).toBe(false);
    // Half (2): sole but POSITIVE ⇒ allow branch, not a gate.
    expect(isInlineAdminGate(`user.role === "admin"`)).toBe(false);
    // Unrelated conditions.
    expect(isInlineAdminGate(`user.role !== "editor"`)).toBe(false);
    expect(isInlineAdminGate(`!user`)).toBe(false);
  });

  test("the condition extractor handles nested parens and comments", () => {
    // A naive `/if\s*\(([^)]*)\)/` would truncate at the FIRST `)` and read
    // this condition as `(a.b ?? c` — losing the role test entirely.
    expect(ifConditions(`if ((user.role ?? "x") !== "admin") {}`)).toEqual([
      `(user.role ?? "x") !== "admin"`,
    ]);
    expect(ifConditions(stripComments(`// if (user.role !== "admin")\nif (a) {}`))).toEqual(["a"]);
    expect(ifConditions(stripComments(`/* if (user.role !== "admin") */ if (b) {}`))).toEqual(["b"]);
  });
});

describe("thrown-Response denials (500-instead-of-403 regression guard)", () => {
  // `requireRole`/`requireAuth` signal denial by THROWING a `Response`.
  // SvelteKit does not recognise a thrown Response from a `+server.ts`
  // handler: it treats it as an unhandled error, runs `handleError`, and
  // answers the caller with a generic 500 `{"message":"Internal Error"}`.
  // So a handler that calls the throwing role gate directly returns 500 to
  // every caller that trips it — never the intended 401/403.
  //
  // That shipped: `POST /api/extensions/[id]/reapprove-drift` answered 500 to
  // an API key minted without `--role admin`, and 20 more routes had the same
  // defect. It survived review because the route suites asserted denial with
  // `try { await POST(e); expect.fail("should have thrown") } catch { … }`,
  // which PINS the bug as the contract (see `fixtures/expect-denied.ts`).
  //
  // The sanctioned non-throwing gates all RETURN their denial Response:
  //   - `checkRole(locals,"admin")`  → AuthUser | Response  (role + admin scope)
  //   - `requireAdmin(locals)`       → Response | null      (role only)
  // A route may still call the throwing `requireRole` PROVIDED it converts the
  // throw itself, which is the pre-existing
  // `catch (e) { if (e instanceof Response) return e; }` idiom.
  //
  // This is a static scan, so it fails the whole CLASS rather than one
  // instance. `requireAuth` is deliberately NOT scanned: its denial fires only
  // when `locals.user` is unset, and `hooks.server.ts` answers every
  // unauthenticated `/api/*` request with 401 before the handler runs — so
  // unlike the role gates it is not reachable by a real caller.
  const ROLE_THROW = /requireRole\s*\(\s*\w+\s*,/;
  const CONVERTS_THROW = /if\s*\(\s*\w+\s+instanceof\s+Response\s*\)\s*return\s+\w+/;

  /** Drop block + line comments so a mention in prose isn't read as a call. */
  function stripComments(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
      .join("\n");
  }

  test("no +server.ts throws its role-gate denial without converting it", () => {
    const offenders: string[] = [];
    const glob = new Glob("api/**/+server.ts");
    for (const rel of glob.scanSync(routesDir)) {
      const src = stripComments(readFileSync(`${routesDir}/${rel}`, "utf8"));
      if (!ROLE_THROW.test(src)) continue;
      if (CONVERTS_THROW.test(src)) continue;
      offenders.push(rel);
    }
    // No frozen baseline on purpose: the sweep that added this guard fixed
    // every offender, so the correct value is EMPTY. A baseline here would be
    // a standing licence to ship 500s where a 403 was meant.
    expect(offenders).toEqual([]);
  });

  test("the scan matches the shapes it relies on (self-check)", () => {
    // Guards against a regex typo silently passing the test above by never
    // matching anything — the same vacuous-pass hazard the admin-gate scan
    // above defends with its own self-check.
    const offending = `const admin = requireRole(locals, "admin");`;
    const converted =
      `try { requireRole(locals, "admin"); } catch (e) { if (e instanceof Response) return e; throw e; }`;
    const nonThrowing = `const admin = checkRole(locals, "admin"); if (admin instanceof Response) return admin;`;
    expect(ROLE_THROW.test(offending)).toBe(true);
    expect(CONVERTS_THROW.test(offending)).toBe(false);
    expect(ROLE_THROW.test(converted)).toBe(true);
    expect(CONVERTS_THROW.test(converted)).toBe(true);
    // checkRole is not the throwing gate, so it must not trip ROLE_THROW at all.
    expect(ROLE_THROW.test(nonThrowing)).toBe(false);
    expect(CONVERTS_THROW.test(nonThrowing)).toBe(true);
    // Prose mentioning the gate in a comment must not count as a call site.
    expect(ROLE_THROW.test(stripComments(`// gate: requireRole(locals, "admin")`))).toBe(false);
    expect(ROLE_THROW.test(stripComments(`/** requireRole(locals, "admin") */`))).toBe(false);
  });

  test("the scan actually visits route files (guards a vacuous pass)", () => {
    // An empty/failed glob would make the offenders test pass for every route.
    const seen = [...new Glob("api/**/+server.ts").scanSync(routesDir)];
    expect(seen.length).toBeGreaterThan(100);
  });
});

describe("registry ⇄ filesystem parity", () => {
  const controlDisk = disk.filter((r) => !r.path.startsWith("/api/__test/"));
  const diskKeys = new Set(controlDisk.map((r) => `${r.method} ${r.path}`));
  const registeredKeys = apiRegistry.map((e) => `${e.method} ${e.path}`);

  // KNOWN_STALE is GONE. It held four registry entries that described no
  // handler on disk (`GET /api/auth/oauth/callback` — the file exports POST +
  // DELETE; `GET /api/users/:id` — PUT only; `PATCH /api/conversations/:id` —
  // PUT; `POST /api/quickstart` — GET). Each was checked against the file's
  // exports and deleted from `src/api-registry.ts`, and the real verb
  // registered in its place. The allowance is not needed, so it is not kept:
  // a carve-out that no longer carves anything out is a standing licence for
  // the next stale entry to hide behind.
  test("no stale registry entry — every registered route exists on disk", () => {
    // Keeps the generated OpenAPI contract honest — a registry entry with no
    // matching handler advertises a route that 404s.
    const stale = registeredKeys.filter((k) => !diskKeys.has(k)).sort();
    expect(stale).toEqual([]);
  });

  // CLAUDE.md makes registration binding for EVERY `/api/*` route. This guard
  // used to carry that invariant as DEBT: a frozen `KNOWN_UNREGISTERED` set of
  // 75 standing violations, plus the rule "this list may only SHRINK".
  //
  // The debt is paid. All 75 are registered in `src/api-registry.ts`, so the
  // frozen set is gone and the assertion is the invariant itself: NO control
  // route on disk may be missing from the registry. That is a strengthening —
  // there is no longer a list to add a line to.
  //
  // Two earlier shapes of this guard failed in ways worth not repeating:
  //   1. A COUNT ratchet (`BASELINE_UNREGISTERED`) sat at 130 while the live
  //      count was 129, so the gate carried a FREE SLOT — one new unregistered
  //      route could land silently green — and when it did trip it could not
  //      name the offender, dumping all ~130 routes and asking the author to
  //      spot their own.
  //   2. Earlier still, its "newly unregistered" filter was the tautology
  //      `!diskKeys.has(k) ? false : true` (every key is built FROM
  //      `controlDisk`, so the guard was always true), listing everything under
  //      a misleading label.
  // The exact-diff assertion below has neither problem: it names precisely the
  // route(s) at fault, and it has no slack to absorb one.

  /** Every control route on disk that the registry does not describe. */
  function currentlyUnregistered(): Set<string> {
    const registered = new Set(registeredKeys);
    return new Set(
      controlDisk
        .map((r) => `${r.method} ${r.path}`)
        .filter((k) => !registered.has(k)),
    );
  }

  test("every control route on disk is registered (names the offender exactly)", () => {
    expect([...currentlyUnregistered()].sort()).toEqual([]);
  });

  test("the scan actually sees the surface it is asserting over (vacuous-pass guard)", () => {
    // With no frozen list left, an empty assertion is the failure mode: a
    // broken glob or an empty registry would make the test above pass for
    // every route. Both sides must be substantial, and the registry must
    // actually cover the disk rather than merely not contradicting it.
    expect(controlDisk.length).toBeGreaterThan(100);
    expect(registeredKeys.length).toBeGreaterThan(100);
    expect(registeredKeys.length).toBeGreaterThanOrEqual(new Set(controlDisk.map((r) => `${r.method} ${r.path}`)).size);
  });

  // ── THE SECOND HALF OF THE INVARIANT: registered WITH A SCOPE ────────────
  //
  // CLAUDE.md says "every new `/api/*` route registers in `src/api-registry.ts`
  // with a scope". Only the first half was ever enforced — the tests above.
  // `scope?: ApiRouteScope` is still OPTIONAL (`src/api-registry.ts:22`) and
  // its own docblock has promised since it was written that "the route-contract
  // meta-test will tighten the requirement over time". Nothing tightened. 93 of
  // 300 entries declared no scope, so the sentence in CLAUDE.md described a rule
  // that a new route could ignore for free. 91 remain: the two `:name/run`
  // routes were backfilled once their handlers were read.
  //
  // WHY IT MATTERS: `src/openapi.ts` emits `security: [{ bearerAuth: [scope] }]`
  // only `if (e.scope && e.scope !== "public")`, so an entry with NO scope
  // describes a route that needs no auth. Under-declaring is not the neutral
  // direction, and these are not ungated routes — `GET /api/users`,
  // `GET /api/teams` and `GET /api/audit-log` each call
  // `requireScope(locals,"admin")` on disk and are registered bare.
  //
  // SIZED HONESTLY, THOUGH: that lie is LATENT, not live. `buildOpenApiSpec()`
  // has exactly one caller — `src/__tests__/openapi.test.ts`. Nothing serves it,
  // no build emits it, and `@ezcorp/harness-client`'s route table is hand-written
  // and parity-tested rather than generated. `GET /api/docs` does serve the
  // registry but drops `scope` from its projection entirely. So no shipped
  // artifact currently advertises an admin route as open; the defect is a
  // wrong answer waiting in a builder the moment anyone publishes it. Worth
  // fixing before that, which is the point of freezing it now.
  //
  // FROZEN, NOT FIXED, and the backfill is deliberately NOT mechanical. #97
  // established the rule that `scope` records what the handler ENFORCES, never
  // what it ought to — a scope declared but not enforced is a false statement
  // about a security boundary in the published contract. So the 93 are a MIXED
  // population and each needs a read of its handler: some enforce a scope the
  // entry simply omits (copy it across), some enforce none at all
  // (`POST /api/auth/logout`) and have nothing truthful to declare until the
  // handler is gated or `ApiRouteScope` grows an explicit "no key-scope gate"
  // value. That is a reviewed security change, not a registry edit, which is
  // why this commit ratchets instead of backfilling.
  //
  // INTENDED END STATE: every entry backfilled, `scope` made REQUIRED on
  // `ApiRouteEntry` so the COMPILER refuses an entry without one, and then this
  // whole block DELETED as redundant. A type is a better gate than a test.
  //
  // SHAPE — a frozen SET, not a bare count, for the reasons the
  // `BASELINE_UNREGISTERED` post-mortem ~60 lines above already sets out. Not
  // restated here; that block is the argument.
  //
  // TO FIX A ROUTE: declare its enforced `scope` in `src/api-registry.ts`,
  // delete its line here, and lower `BASELINE_SCOPELESS` by the same number.
  // All three, together — the rot test below fails if a line no longer
  // describes a scope-less entry (so the list cannot become stale fiction) and
  // the count test fails if the baseline no longer matches the list (so the
  // ratchet cannot be loosened by deleting lines). Both failures name what to
  // do. This list may only SHRINK. Sorted; keep it sorted.
  const BASELINE_SCOPELESS = 90;
  const KNOWN_SCOPELESS: ReadonlySet<string> = new Set([
    "DELETE /api/agent-configs/:id",
    "DELETE /api/extensions/:id/settings/user",
    "DELETE /api/marketplace/:id/delete",
    "DELETE /api/service-accounts/:id",
    "DELETE /api/teams/:id",
    "DELETE /api/workflows/delegations/:id",
    "GET /api/account",
    "GET /api/agent-configs",
    "GET /api/agent-configs/:id",
    "GET /api/agents",
    "GET /api/agents/:name/test-conversations",
    "GET /api/audit-log",
    "GET /api/auth/me",
    "GET /api/auth/ping",
    "GET /api/briefing/config",
    "GET /api/conversations",
    "GET /api/conversations/:id/export",
    "GET /api/extensions/:id",
    "GET /api/extensions/:id/permissions",
    "GET /api/extensions/:id/settings",
    "GET /api/favicon",
    "GET /api/fs/list",
    "GET /api/marketplace",
    "GET /api/marketplace/:id",
    "GET /api/marketplace/:id/flags",
    "GET /api/marketplace/:id/versions",
    "GET /api/marketplace/categories",
    "GET /api/marketplace/export/:id",
    "GET /api/marketplace/flags",
    "GET /api/marketplace/updates",
    "GET /api/mentions/search",
    "GET /api/models",
    "GET /api/observability",
    "GET /api/observability/:conversationId",
    "GET /api/providers",
    "GET /api/quickstart",
    "GET /api/search/messages",
    "GET /api/service-accounts",
    "GET /api/settings/developer",
    "GET /api/teams",
    "GET /api/teams/:id",
    "GET /api/teams/:id/members",
    "GET /api/tool-calls/:id/output",
    "GET /api/tools",
    "GET /api/user/agent-picker",
    "GET /api/users",
    "GET /api/users/search",
    "GET /api/workflows",
    "GET /api/workflows/:name",
    "GET /api/workflows/:name/versions",
    "GET /api/workflows/delegated-runs",
    "GET /api/workflows/delegations",
    "PATCH /api/service-accounts/:id",
    "PATCH /api/service-accounts/:id/daily-cap",
    "PATCH /api/workflows/delegations/:id",
    "POST /api/agent-configs",
    "POST /api/agent-configs/generate",
    "POST /api/auth/invite/:token",
    "POST /api/auth/logout",
    "POST /api/auth/reset-password",
    "POST /api/auth/reset-password/:token",
    "POST /api/auth/setup",
    "POST /api/briefing/run-now",
    "POST /api/conversations/:id/active-run",
    "POST /api/extensions/:id/confirm",
    "POST /api/extensions/:id/modifiable",
    "POST /api/marketplace",
    "POST /api/marketplace/:id/flag",
    "POST /api/marketplace/:id/install",
    "POST /api/marketplace/:id/rate",
    "POST /api/marketplace/import",
    "POST /api/onboarding/complete",
    "POST /api/preview/:id/token",
    "POST /api/preview/consent",
    "POST /api/service-accounts",
    "POST /api/settings/developer/api-keys",
    "POST /api/teams",
    "POST /api/teams/:id/members",
    "POST /api/workflows/:name/dry-run",
    "POST /api/workflows/:name/fork",
    "POST /api/workflows/approvals/:id",
    "POST /api/workflows/delegations",
    "POST /api/workflows/delegations/preview",
    "PUT /api/account",
    "PUT /api/account/password",
    "PUT /api/agent-configs/:id",
    "PUT /api/briefing/config",
    "PUT /api/extensions/:id/settings/user",
    "PUT /api/teams/:id",
    "PUT /api/user/agent-picker",
  ]);

  /** Every registry entry that declares no `scope`. */
  function currentlyScopeless(): Set<string> {
    return new Set(
      apiRegistry.filter((e) => e.scope === undefined).map((e) => `${e.method} ${e.path}`),
    );
  }

  test("no NEW scope-less registry entry (names the offender exactly)", () => {
    // Exact diff: the entry (entries) declaring no scope AND absent from the
    // frozen list. The author sees their own route and nothing else — the
    // failure mode that sank the count ratchet this replaces.
    const novel = [...currentlyScopeless()].filter((k) => !KNOWN_SCOPELESS.has(k)).sort();
    expect(novel).toEqual([]);
  });

  test("the frozen set does not rot (every entry is STILL scope-less)", () => {
    // Backfilling a scope while leaving its line here would turn this list into
    // stale documentation that silently re-permits the entry if the scope is
    // ever dropped again. An entry that no longer describes a scope-less route
    // fails LOUDLY and must be removed — which is also how the list SHRINKS.
    const live = currentlyScopeless();
    const stale = [...KNOWN_SCOPELESS].filter((k) => !live.has(k)).sort();
    expect(stale).toEqual([]);
  });

  test("the scope-less count is EXACTLY the baseline (visibility, not a gate)", () => {
    // BE PRECISE ABOUT WHAT THIS BUYS, because the honest answer is "less than
    // it looks like" and this file has retired two guards for looking like a
    // check without being one.
    //
    // It does NOT close the free slot. An UNPAIRED deletion from the frozen
    // list is already caught by the first test, which names the route — this
    // adds nothing there. And the defeat that matters goes green anyway:
    // backfill one route's scope, land one NEW scope-less route, swap the two
    // lines here, leave the baseline unmoved. Measured — 25 pass / 0 fail. No
    // assertion in this block catches that, and a count never could, because
    // the population size is exactly what the swap preserves.
    //
    // What it DOES buy is cheap and worth one line: the number is stated in the
    // source, so shrinking the debt shows up as a conspicuous `-93 +91` in the
    // diff rather than as two lines lost in a 93-line list, and a defeat has to
    // touch three places instead of one. Review bait, not a gate. The gate is
    // the exact diff above; the real fix is making `scope` required so the
    // compiler decides.
    expect(KNOWN_SCOPELESS.size).toBe(BASELINE_SCOPELESS);
    expect(currentlyScopeless().size).toBe(BASELINE_SCOPELESS);
  });

  test("the two `:name/run` routes declare the `chat` scope their handlers enforce", () => {
    // Backfilled out of KNOWN_SCOPELESS. Both handlers open with
    // `requireScope(locals, "chat")` (`agents/[name]/run/+server.ts:12`,
    // `workflows/[name]/run/+server.ts:37`), so the registry now states the
    // boundary the code actually enforces and the generated OpenAPI stops
    // describing two run endpoints as needing no auth. Asserted by NAME rather
    // than left to the count above: the count is preserved by any swap, this
    // is not.
    const scopeOf = (key: string): string | undefined =>
      apiRegistry.find((e) => `${e.method} ${e.path}` === key)?.scope;
    expect(scopeOf("POST /api/agents/:name/run")).toBe("chat");
    expect(scopeOf("POST /api/workflows/:name/run")).toBe("chat");
    expect(KNOWN_SCOPELESS.has("POST /api/agents/:name/run")).toBe(false);
    expect(KNOWN_SCOPELESS.has("POST /api/workflows/:name/run")).toBe(false);
  });

  test("the frozen list is sorted (a new line cannot hide mid-list)", () => {
    // The retired `KNOWN_UNREGISTERED` carried this same assertion. Sortedness
    // is hygiene, not a defense — an author who inserts at the correct position
    // passes it — but it makes an appended or randomly-placed line obvious in
    // review, and it keeps the list diffable as it shrinks.
    const listed = [...KNOWN_SCOPELESS];
    expect(listed).toEqual([...listed].sort());
  });
});

describe("controllable ⇄ harness-client route-table parity", () => {
  // The registry's `harness.controllable` flag (server side) and the typed
  // client's HARNESS_ROUTES table (client side) are the two halves of the
  // remote-control contract. Enforce they agree BOTH ways so neither a
  // controllable registry entry without a client method nor a client method
  // without a registered controllable route can ship. Two carve-outs from the
  // routes.ts header apply: the `/api/__test/**` determinism tier is gated by
  // isTestSurfaceEnabled and never registered (exclude it), and getRun/awaitRun
  // deliberately share `GET /api/runs/:id` — the Set collapses that duplicate.
  const clientRoutes = new Set(
    Object.values(HARNESS_ROUTES)
      .filter((r) => !r.pathTemplate.startsWith("/api/__test/"))
      .map((r) => `${r.httpMethod} ${r.pathTemplate}`),
  );
  const controllableRegistered = new Set(
    apiRegistry
      .filter((e) => e.harness?.controllable === true)
      .map((e) => `${e.method} ${e.path}`),
  );

  test("both sides are non-empty (guards against a vacuous pass)", () => {
    expect(clientRoutes.size).toBeGreaterThan(0);
    expect(controllableRegistered.size).toBeGreaterThan(0);
  });

  test("every controllable registry route has a harness-client method", () => {
    const missingFromClient = [...controllableRegistered].filter((k) => !clientRoutes.has(k)).sort();
    expect(missingFromClient).toEqual([]);
  });

  test("every harness-client route is a registered controllable route", () => {
    const missingFromRegistry = [...clientRoutes].filter((k) => !controllableRegistered.has(k)).sort();
    expect(missingFromRegistry).toEqual([]);
  });
});

describe("runtime-event name parity (harness-client ⇄ app)", () => {
  // events.ts mirrors web/src/lib/runtime-event-names.ts by hand (the package
  // ships standalone and can't import the app's source). This is the CI
  // cross-check the events.ts header refers to: the two lists must stay
  // byte-for-byte identical, in the same order, so a harness decoding the SSE
  // stream sees exactly the app's event set.
  test("harness-client RUNTIME_EVENT_NAMES === app canonical list", () => {
    expect([...HARNESS_EVENT_NAMES]).toEqual([...APP_EVENT_NAMES]);
  });
});
