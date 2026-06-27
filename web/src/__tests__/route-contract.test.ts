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
      if (ROLE_ADMIN.test(src) || REQUIRE_ADMIN.test(src)) continue;
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
      if (ROLE_ADMIN.test(src) || REQUIRE_ADMIN.test(src)) continue;
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
    expect(SCOPE_ADMIN.test(offending)).toBe(true);
    expect(ROLE_ADMIN.test(offending)).toBe(false);
    expect(ROLE_ADMIN.test(safeRole)).toBe(true);
    expect(REQUIRE_ADMIN.test(safeAdmin)).toBe(true);
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
    // Extension-secrets entry route — registered in Phase 0 (the storage
    // primitive) so the OpenAPI contract is centralized; the handler lands
    // in Phase 1B, which REMOVES these two lines when it adds the +server.ts.
    "POST /api/extensions/:id/secrets",
    "DELETE /api/extensions/:id/secrets",
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
  const BASELINE_UNREGISTERED = 135;

  test("unregistered control-route count does not grow (ratchet)", () => {
    const registered = new Set(registeredKeys);
    const unregistered = controlDisk
      .map((r) => `${r.method} ${r.path}`)
      .filter((k) => !registered.has(k));
    if (unregistered.length > BASELINE_UNREGISTERED) {
      const newly = unregistered.filter((k) => !diskKeys.has(k) ? false : true).sort();
      throw new Error(
        `Unregistered control routes rose to ${unregistered.length} (baseline ${BASELINE_UNREGISTERED}). ` +
        `Register new /api/* routes in src/api-registry.ts (see docs/harness-contract.md).\n${newly.join("\n")}`,
      );
    }
    expect(unregistered.length).toBeLessThanOrEqual(BASELINE_UNREGISTERED);
  });
});
