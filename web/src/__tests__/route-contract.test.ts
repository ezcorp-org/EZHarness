/**
 * Governance meta-test — keeps the remote-control contract from rotting.
 *
 *  1. Every `/api/__test/**` route is gated by `isTestSurfaceEnabled` (no
 *     ungated test/determinism surface can ship).
 *  2. Every control-tier `/api/*` route on disk is registered in
 *     `src/api-registry.ts` (so it is documented + appears in the generated
 *     OpenAPI contract). A frozen BASELINE captures pre-existing gaps so the
 *     test is green today but fails when a NEW unregistered route lands.
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

  // Pre-existing routes that gate on the admin SCOPE without a role check.
  // Surfaced by this very scan. Most are user SELF-SERVICE writes
  // (/api/account*, own developer keys, own team membership) where the
  // scope-admin is a write-gate for API-key principals and the cookie
  // allow-all is intentional — forcing requireRole(admin) there would lock
  // every member out of their own data. `extensions/[id]/violations` stays
  // here because it enforces admin via an INLINE `locals.user?.role !== "admin"`
  // check the role-regex below can't see (verified safe, not exploitable).
  // The instance-state routes that genuinely needed role-gating
  // (providers/[provider]/{test,refresh-models}) have been fixed with
  // requireAdmin and removed from this list. FROZEN so a NEW offender fails the
  // test (the regression guard) while pre-existing ones don't block it. Shrink
  // this list as each is reviewed; never add to it without justification.
  const KNOWN_SCOPE_ONLY_ADMIN = new Set<string>([
    "api/account/+server.ts",
    "api/account/password/+server.ts",
    "api/account/sessions/+server.ts",
    "api/extensions/[id]/violations/+server.ts",
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
      scopeOnly.add(rel);
    }
    const extra = [...scopeOnly].filter((r) => !KNOWN_SCOPE_ONLY_ADMIN.has(r)).sort();
    expect(extra).toEqual([]);
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

describe("registry ⇄ filesystem parity", () => {
  const controlDisk = disk.filter((r) => !r.path.startsWith("/api/__test/"));
  const diskKeys = new Set(controlDisk.map((r) => `${r.method} ${r.path}`));
  const registeredKeys = apiRegistry.map((e) => `${e.method} ${e.path}`);

  // Pre-existing registry inaccuracies (wrong method/path vs the handler on
  // disk) — surfaced by this very test, but unrelated to the remote-control
  // feature so left for a separate registry-reconciliation pass. Frozen so a
  // NEW stale entry fails; shrink as these are corrected.
  const KNOWN_STALE = new Set<string>([
    "GET /api/auth/oauth/callback", // disk: POST + DELETE
    "GET /api/users/:id",           // disk: PUT only
    "GET /api/warmup",              // disk: POST
    "PATCH /api/conversations/:id", // disk: PUT
    "POST /api/quickstart",         // disk: GET
  ]);

  test("no NEW stale registry entry (registered routes exist on disk)", () => {
    // Keeps the generated OpenAPI contract honest — a registry entry with no
    // matching handler would advertise a route that 404s.
    const stale = registeredKeys.filter((k) => !diskKeys.has(k) && !KNOWN_STALE.has(k)).sort();
    expect(stale).toEqual([]);
  });

  // The registry is a curated (currently partial) mirror of the HTTP surface.
  // Rather than freeze ~135 pre-existing gaps, ratchet the count: a NEW
  // unregistered control route pushes it over the line and fails, forcing the
  // author to register it (and so document it + expose it in OpenAPI). Lower
  // this number as gaps close; never raise it without registering the route.
  const BASELINE_UNREGISTERED = 130;

  test("unregistered control-route count does not grow (ratchet)", () => {
    const registered = new Set(registeredKeys);
    const unregistered = controlDisk
      .map((r) => `${r.method} ${r.path}`)
      .filter((k) => !registered.has(k));
    if (unregistered.length > BASELINE_UNREGISTERED) {
      // Only a COUNT baseline is stored (not a frozen set), so the specific new
      // offender can't be isolated by name — surface every currently
      // unregistered control route (sorted) plus how many the count rose by, so
      // the author can spot the one they just added. The previous
      // `!diskKeys.has(k) ? false : true` filter was a tautology (every
      // `unregistered` key is built from `controlDisk`, so `diskKeys.has(k)` is
      // always true) that silently listed everything under a misleading "newly".
      const overBy = unregistered.length - BASELINE_UNREGISTERED;
      const listing = [...unregistered].sort();
      throw new Error(
        `Unregistered control routes rose to ${unregistered.length} ` +
        `(baseline ${BASELINE_UNREGISTERED}, ${overBy} over). Register new /api/* routes ` +
        `in src/api-registry.ts (see docs/harness-contract.md).\n` +
        `Currently-unregistered control routes (the new one is among these):\n${listing.join("\n")}`,
      );
    }
    expect(unregistered.length).toBeLessThanOrEqual(BASELINE_UNREGISTERED);
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
