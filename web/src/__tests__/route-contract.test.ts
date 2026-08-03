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
  // CLAUDE.md makes registration binding for EVERY `/api/*` route, so each
  // entry below is a STANDING VIOLATION of that invariant — frozen so the debt
  // is individually visible and strictly bounded, rather than aggregated into a
  // number nobody can act on.
  //
  // This was a COUNT ratchet (`BASELINE_UNREGISTERED`) and it failed twice in
  // the way this guard keeps failing — something that looks like a check and
  // isn't:
  //   1. The baseline sat at 130 while the live count was 129, so the gate
  //      carried a FREE SLOT: one new unregistered route could land silently
  //      green.
  //   2. When it did trip it could not name the offender — it dumped all ~130
  //      unregistered routes sorted and asked the author to spot their own.
  //   3. Earlier still, its "newly unregistered" filter was the tautology
  //      `!diskKeys.has(k) ? false : true` (every key is built FROM
  //      `controlDisk`, so the guard was always true), which listed everything
  //      under a misleading label.
  // A frozen SET closes all three: a new offender is named exactly, and the set
  // has no slack to absorb one.
  //
  // TO REGISTER A ROUTE: add it to `src/api-registry.ts` AND delete its line
  // here. Deleting the line is not optional bookkeeping — the staleness test
  // below FAILS if an entry no longer describes an unregistered route, so this
  // list cannot rot into a second stale artifact (which is the exact failure
  // mode it replaces).
  //
  // This list may only SHRINK. Sorted; keep it sorted.
  const KNOWN_UNREGISTERED: ReadonlySet<string> = new Set([
    "DELETE /api/account/sessions",
    "DELETE /api/agents/:id/share",
    "DELETE /api/agents/:name/test-conversations",
    "DELETE /api/auth/oauth/callback",
    "DELETE /api/conversations/:id/tasks/:taskId/assign",
    "DELETE /api/extensions/:id/entities/:type/:slug",
    "DELETE /api/extensions/:id/settings/user",
    "DELETE /api/extensions/author/draft/:id",
    "DELETE /api/ez/conversation/messages",
    "DELETE /api/lessons/:id",
    "DELETE /api/marketplace/:id",
    "DELETE /api/modes/:id",
    "DELETE /api/projects/:id/features/:featureId",
    "DELETE /api/providers",
    "DELETE /api/search/backend",
    "DELETE /api/settings/:key",
    "DELETE /api/settings/developer",
    "DELETE /api/settings/developer/api-keys",
    "DELETE /api/teams/:id/members",
    "DELETE /api/user-commands/:name",
    "DELETE /api/workflows/:name",
    "GET /api/account/login-history",
    "GET /api/account/sessions",
    "GET /api/active-agents",
    "GET /api/agents/:id/share",
    "GET /api/attachments/:id",
    "GET /api/auth/invite",
    "GET /api/auth/invite/:token",
    "GET /api/auth/ping",
    "GET /api/conversations/:id/active-run",
    "GET /api/conversations/:id/audit",
    "GET /api/conversations/:id/extension-toolbar",
    "GET /api/conversations/:id/sub-conversations",
    "GET /api/conversations/:id/tasks",
    "GET /api/conversations/:id/tasks/:taskId/messages",
    "GET /api/conversations/:id/team/:agentConfigId/messages",
    "GET /api/docs",
    "GET /api/ext-files/:name/:path",
    "GET /api/extensions/:id/audit",
    "GET /api/extensions/:id/audit/stats",
    "GET /api/extensions/:id/entities/:type",
    "GET /api/extensions/:id/entities/:type/:slug",
    "GET /api/extensions/:id/expired-grants",
    "GET /api/extensions/:id/settings",
    "GET /api/extensions/:name/data/:path",
    "GET /api/ez/conversation",
    "GET /api/ez/drafts/:id",
    "GET /api/hub/pages",
    "GET /api/hub/pages/:id",
    "GET /api/lessons",
    "GET /api/marketplace/categories",
    "GET /api/models/capabilities",
    "GET /api/modes",
    "GET /api/modes/:id",
    "GET /api/projects/:id/features",
    "GET /api/projects/:id/features/:featureId",
    "GET /api/projects/:id/tool-permission-mode",
    "GET /api/ready",
    "GET /api/search/backend",
    "GET /api/settings/developer/api-keys",
    "GET /api/user-commands",
    "GET /api/user-commands/:name",
    "GET /api/user/agent-picker",
    "GET /api/version",
    "PATCH /api/conversations/:id/messages/:mid",
    "PATCH /api/lessons/:id",
    "PATCH /api/marketplace/:id/flags",
    "PATCH /api/memories/:id",
    "PATCH /api/projects/:id/features/:featureId",
    "PATCH /api/user-commands/:name",
    "POST /api/ask-user/answer",
    "POST /api/auth/oauth/callback",
    "POST /api/conversations/:id/agent-chat",
    "POST /api/conversations/:id/clone-turns",
    "POST /api/conversations/:id/tasks/:taskId/assign",
    "POST /api/conversations/:id/tasks/:taskId/assignments/:assignmentId/start",
    "POST /api/conversations/:id/tasks/:taskId/assignments/:assignmentId/stop",
    "POST /api/conversations/:id/tasks/:taskId/retry",
    "POST /api/conversations/:id/tool-results",
    "POST /api/extensions/:id/entities/:type",
    "POST /api/extensions/:id/modifiable",
    "POST /api/extensions/:id/reapprove",
    "POST /api/extensions/:id/reopen",
    "POST /api/extensions/:name/events/:event",
    "POST /api/extensions/:name/uploads",
    "POST /api/extensions/author/draft/:id/validate",
    "POST /api/extensions/author/install",
    "POST /api/ez-actions/:name",
    "POST /api/ez/conversation",
    "POST /api/ez/drafts/:id",
    "POST /api/ez/drafts/:id/consume",
    "POST /api/import/commit",
    "POST /api/import/preview",
    "POST /api/mcp-servers",
    "POST /api/mcp-servers/:id/refresh",
    "POST /api/modes",
    "POST /api/onboarding/complete",
    "POST /api/preview/:id/token",
    "POST /api/preview/consent",
    "POST /api/projects/:id/features",
    "POST /api/projects/:id/features/scan",
    "POST /api/providers",
    "POST /api/providers/local/models",
    "POST /api/providers/local/test",
    "POST /api/search/backend",
    "POST /api/settings/developer",
    "POST /api/user-commands",
    "POST /api/warmup",
    "POST /api/workflows",
    "PUT /api/conversations/:id",
    "PUT /api/extensions/:id/entities/:type/:slug",
    "PUT /api/extensions/:id/settings/user",
    "PUT /api/extensions/author/draft/:id",
    "PUT /api/mcp-servers/:id",
    "PUT /api/modes/:id",
    "PUT /api/user/agent-picker",
    "PUT /api/users/:id",
    "PUT /api/workflows/:name",
  ]);

  /** Every control route on disk that the registry does not describe. */
  function currentlyUnregistered(): Set<string> {
    const registered = new Set(registeredKeys);
    return new Set(
      controlDisk
        .map((r) => `${r.method} ${r.path}`)
        .filter((k) => !registered.has(k)),
    );
  }

  test("no NEW unregistered control route (frozen set names the offender)", () => {
    // Exact diff: the route(s) that are unregistered AND absent from the frozen
    // debt list. The author sees their own route and nothing else — the whole
    // point of moving off the count baseline.
    const novel = [...currentlyUnregistered()]
      .filter((k) => !KNOWN_UNREGISTERED.has(k))
      .sort();
    expect(novel).toEqual([]);
  });

  test("the frozen set does not rot (every entry is STILL unregistered)", () => {
    // Registering a route while leaving its line here would turn this list into
    // stale documentation that silently re-permits the route if it is ever
    // un-registered again. An entry that no longer describes an unregistered
    // route — because it was registered, renamed, or deleted from disk — fails
    // LOUDLY and must be removed.
    const live = currentlyUnregistered();
    const stale = [...KNOWN_UNREGISTERED].filter((k) => !live.has(k)).sort();
    expect(stale).toEqual([]);
  });

  test("the frozen set is non-empty and sorted (guards a vacuous pass)", () => {
    // An empty (or accidentally-cleared) set would make the offender test pass
    // for every route; an unsorted one makes review diffs unreadable.
    expect(KNOWN_UNREGISTERED.size).toBeGreaterThan(0);
    const listed = [...KNOWN_UNREGISTERED];
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
