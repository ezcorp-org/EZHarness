/**
 * The TREE-WIDE static assertion that keeps `scope: "session"` honest, in BOTH
 * directions.
 *
 * `ApiRouteScope` gained `"session"` so the registry could say what it
 * previously could only imply: this route is authorized by an INTERACTIVE
 * BROWSER SESSION and no API key can call it, whatever scopes the key holds.
 * Before the value existed, thirteen session-only routes declared NO scope —
 * which made them indistinguishable from the ninety entries whose author
 * simply never wrote one, and left the true statement unsayable.
 *
 * A declaration nobody checks rots in two directions, and only one of them is
 * loud:
 *
 *   • **Scope without the guard.** An entry says `"session"`, the handler runs
 *     `requireScope` and nothing else. The registry then publishes a security
 *     boundary the code does not enforce — #97's rule, and the failure that
 *     matters, because a reviewer reading the registry stops looking.
 *   • **Guard without the scope.** A handler calls `requireSessionAuth` and its
 *     entry declares a KEY scope, or none. `src/openapi.ts` renders a key scope
 *     as `security: [{ bearerAuth: [scope] }]` — "call this with a key holding
 *     that scope" — for a route that answers every key with a 403; and an entry
 *     with no scope at all is the pre-existing silence this value replaced.
 *
 * SO BOTH DIRECTIONS ARE DERIVED FROM THE SOURCE, and the equality is asserted
 * as a set, not as a subset. A subset assertion in one direction only is
 * exactly the shape that let four unguarded run-start routes ship — the
 * post-mortem is in `policy-run-start-surface.test.ts`, whose walker
 * (`helpers/source-walk.ts`: segment → seed → propagate to a fixed point) this
 * suite reuses unchanged.
 *
 * ── Why `requireAdminSession` is a primitive too ──────────────────────
 * The five `/api/service-accounts*` verbs call `requireAdminSession`, which IS
 * `requireSessionAuth` followed by `checkRole(locals,"admin")` — one call,
 * because the pair was being copy-pasted per route file and a copied gate
 * eventually ships with half of itself. The walk is intra-file, so seeding on
 * `requireSessionAuth(` alone would have missed all five and the equality would
 * have failed on routes that are correctly gated. The hop is PINNED below
 * ("the cross-file hop is real") rather than trusted, so a `requireAdminSession`
 * that stopped calling the session half fails here instead of silently
 * widening what this suite accepts.
 *
 * ── The one route that reaches the gate and must NOT declare the scope ──
 * `POST /api/hub/pages/[id]/actions/[action]` calls `requireSessionAuth`
 * CONDITIONALLY — only for an action the provider lists in `sessionOnlyActions`
 * (today: the workflow-approvals `answer`). The route as a whole is `chat`-
 * scoped and an API key is MEANT to drive it, so declaring `"session"` there
 * would be the first failure above wearing the second's clothes: a false claim
 * that no key can call a route keys call every day. It is carved out by name in
 * {@link CONDITIONALLY_SESSION_GATED}, and the carve-out is itself asserted —
 * the conditional must still be in the file, and the entry must still declare a
 * key scope. Make that gate unconditional and this suite fails until the entry
 * is re-declared.
 */
import { test, expect, describe } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";
import { apiRegistry } from "../api-registry";
import { API_KEY_SCOPES, SESSION_ROUTE_SCOPE, isApiKeyScope } from "../auth/api-key";
import { ROUTE_BUNDLES, routeIdToRegistryPath } from "../auth/tool-policy";
import { computeReaching, declarationsOf } from "./helpers/source-walk";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const ROUTES_ROOT = join(REPO_ROOT, "web/src/routes/api");

/** The HTTP verbs SvelteKit will serve from a `+server.ts`. */
const VERBS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * Source tokens that REFUSE EVERY API KEY.
 *
 * `requireAdminSession(` is here for the cross-file reason the header sets out:
 * it composes `requireSessionAuth` with the admin role check, and the walk
 * cannot see inside it.
 *
 * `isInteractiveSession(` is deliberately ABSENT. It is the same allowlist as a
 * predicate, for gates that BRANCH on the answer rather than refuse (the
 * permission-mode ceiling on the chat send body, and the consent-gate
 * confinement on `POST /api/tool-calls/[id]/permission`). A route that branches
 * still serves keys, so it is not session-only and must not declare the scope.
 */
const SESSION_GATE_PRIMITIVES = [
  "requireSessionAuth(",
  "requireAdminSession(",
] as const;

/**
 * The verb that reaches a session gate on SOME requests only, and so is
 * correctly registered with a KEY scope.
 *
 * One entry, and the assertions below hold it to that: the file must still
 * contain the `sessionOnlyActions` conditional, and the registry entry must
 * still declare a real key scope. This is the only sanctioned way to reach a
 * session gate without declaring the session scope.
 */
const CONDITIONALLY_SESSION_GATED: readonly string[] = [
  "POST /api/hub/pages/:id/actions/:action",
];

/**
 * Verbs this analysis is KNOWN to reach, one per gate shape. Guards against a
 * walker that stops matching and reports an empty, vacuously-passing set —
 * which would make the equality below hold by describing nothing.
 */
const MUST_DETECT = [
  "POST /api/workflows/approvals/:id", // requireSessionAuth(
  "PATCH /api/service-accounts/:id/daily-cap", // requireAdminSession(
  "PUT /api/projects/:id/tool-permission-mode", // requireSessionAuth( after requireScope(
  "POST /api/hub/pages/:id/actions/:action", // the conditional gate
] as const;

/** `service-accounts/[id]/+server.ts` → `/api/service-accounts/:id`. Registry
 *  path form (`:id`), because the registry is what this suite compares to. */
function registryPathFor(relPath: string): string {
  const dir = relPath.slice(0, -"/+server.ts".length);
  return routeIdToRegistryPath(dir === "" ? "/api" : `/api/${dir}`);
}

/**
 * Every (method, path) the tree gates on a session, derived per VERB.
 *
 * Per verb, not per file, and two shipped routes prove why: `service-accounts/
 * +server.ts` gates GET and POST differently (`requireSessionAuth` vs
 * `requireAdminSession`) and `projects/[id]/tool-permission-mode/+server.ts`
 * gates only its PUT — a file-level answer would demand the session scope on a
 * GET that an agent legitimately calls with a `read` key.
 */
async function derivedSessionGatedVerbs(): Promise<string[]> {
  const glob = new Glob("**/+server.ts");
  const out: string[] = [];
  for await (const rel of glob.scan({ cwd: ROUTES_ROOT, absolute: false })) {
    const decls = await declarationsOf(join(ROUTES_ROOT, rel));
    const reaching = computeReaching(decls, SESSION_GATE_PRIMITIVES);
    for (const method of VERBS) {
      if (reaching.has(method)) out.push(`${method} ${registryPathFor(rel)}`);
    }
  }
  return out.sort();
}

const derived = await derivedSessionGatedVerbs();

/** Registry entries declaring the session scope, as `"METHOD /api/path"`. */
const declaredSessionOnly = apiRegistry
  .filter((e) => e.scope === SESSION_ROUTE_SCOPE)
  .map((e) => `${e.method} ${e.path}`)
  .sort();

const scopeOf = (key: string): string | undefined =>
  apiRegistry.find((e) => `${e.method} ${e.path}` === key)?.scope;

describe("scope: \"session\" ⇄ requireSessionAuth — both directions, derived", () => {
  test("the walker actually parsed the route tree", () => {
    // Cheap structural sanity BEFORE any set assertion: a glob that matched
    // nothing would make the equality below hold between two empty sets.
    expect(derived.length).toBeGreaterThan(10);
    expect(declaredSessionOnly.length).toBeGreaterThan(10);
  });

  test("the detector is alive — it rediscovers every known session gate", () => {
    const missed = MUST_DETECT.filter((key) => !derived.includes(key));
    expect(missed).toEqual([]);
  });

  test("every entry declaring the session scope is SERVED by a session gate", () => {
    // Direction 1 — SCOPE WITHOUT THE GUARD. A failure here is a security
    // finding: the registry publishes "no key can call this" for a handler that
    // does not enforce it, and `src/openapi.ts` renders it as the cookie scheme
    // — a claim about a boundary, made in the published contract, that the code
    // does not keep.
    const undefended = declaredSessionOnly.filter((k) => !derived.includes(k));
    expect(undefended).toEqual([]);
  });

  test("every verb that CALLS a session gate declares the session scope", () => {
    // Direction 2 — GUARD WITHOUT THE SCOPE, which is the direction a subset
    // assertion cannot see and the reason this suite exists. A correctly-gated
    // route whose entry declares a KEY scope tells an integrator to mint a key
    // for a route that refuses every key; one that declares nothing is the
    // silence `"session"` was added to break.
    const undeclared = derived
      .filter((k) => !CONDITIONALLY_SESSION_GATED.includes(k))
      .filter((k) => scopeOf(k) !== SESSION_ROUTE_SCOPE)
      .map((k) => `${k} — declares ${JSON.stringify(scopeOf(k))}`);
    expect(undeclared).toEqual([]);
  });

  test("the two sets are EQUAL, not merely overlapping", () => {
    // The equality both tests above imply, asserted once as a set so neither
    // can be satisfied by an empty filter. `CONDITIONALLY_SESSION_GATED` is the
    // only difference between them, and it is pinned below.
    expect(derived.filter((k) => !CONDITIONALLY_SESSION_GATED.includes(k))).toEqual(
      declaredSessionOnly,
    );
  });

  test("the conditional carve-out is REAL and stays a carve-out", async () => {
    // The exemption is not a licence: it is an assertion about one file. The
    // gate must still sit behind `sessionOnlyActions` (make it unconditional
    // and the route becomes session-only, so the equality above must be
    // re-derived), and the entry must still declare a scope a key can actually
    // hold — because a key IS meant to drive this route.
    expect(CONDITIONALLY_SESSION_GATED).toHaveLength(1);
    for (const key of CONDITIONALLY_SESSION_GATED) {
      expect({ key, gated: derived.includes(key) }).toEqual({ key, gated: true });
      const scope = scopeOf(key);
      expect({ key, isKeyScope: scope !== undefined && isApiKeyScope(scope) }).toEqual({
        key,
        isKeyScope: true,
      });
    }
    const rel = "hub/pages/[id]/actions/[action]/+server.ts";
    const hubActions = await Bun.file(join(ROUTES_ROOT, rel)).text();
    // Asserted as a boolean, not with `toContain` — the failure message for a
    // missing substring is the whole 170-line file, which buries the one fact
    // the reader needs.
    expect({
      rel,
      conditional: hubActions.includes("provider.sessionOnlyActions?.includes(actionName)"),
    }).toEqual({ rel, conditional: true });
  });

  test("the cross-file hop is real — requireAdminSession IS a session gate", async () => {
    // `requireAdminSession(` is seeded as a primitive on the strength of what
    // it composes. Pin that, so removing the session half forces this list to
    // be revisited rather than leaving five service-account verbs declaring a
    // boundary nothing enforces.
    const middleware = await Bun.file(join(REPO_ROOT, "src/auth/middleware.ts")).text();
    const fn = middleware.slice(middleware.indexOf("export function requireAdminSession"));
    expect(fn).toContain("requireSessionAuth(locals)");
    expect(fn).toContain('checkRole(locals, "admin")');
  });

  test("a session gate is never confused with a plain read on the same file", () => {
    // Per-verb attribution, asserted directly. `tool-permission-mode`'s PUT is
    // session-only and its GET deliberately is not — an agent must be able to
    // read the posture it runs under. Were attribution per FILE, the GET would
    // demand the session scope and every `read` key would be told to stop
    // calling a route it is meant to call.
    expect(derived).toContain("PUT /api/projects/:id/tool-permission-mode");
    expect(derived).not.toContain("GET /api/projects/:id/tool-permission-mode");
    expect(scopeOf("GET /api/projects/:id/tool-permission-mode")).toBe("read");
  });
});

describe("\"session\" is not, and cannot become, an API-key scope", () => {
  test("it is absent from the mintable scope list", () => {
    // The invariant every other consumer leans on. If `"session"` were ever
    // minted onto a key, `hasRequiredScope` would let that key satisfy a
    // `requireScope` call and the value would have quietly become the thing it
    // exists to say is impossible.
    expect(isApiKeyScope(SESSION_ROUTE_SCOPE)).toBe(false);
    expect([...API_KEY_SCOPES] as string[]).not.toContain(SESSION_ROUTE_SCOPE);
  });

  test("no session-only route is marked harness-controllable", () => {
    // `harness: { controllable: true }` asserts an external harness is expected
    // to drive the route, and `HarnessClient` authenticates with an `ezk_*`
    // key — so the two claims cannot both be true. The route-contract
    // meta-test already forces a controllable entry to have a client method,
    // which means the pairing would ship a typed client call that 403s every
    // time. Closed here rather than left to whoever writes it.
    const both = apiRegistry
      .filter((e) => e.scope === SESSION_ROUTE_SCOPE && e.harness?.controllable === true)
      .map((e) => `${e.method} ${e.path}`);
    expect(both).toEqual([]);
  });

  test("no shipped route bundle names a session-only route", () => {
    // A bundle is the reviewed shape a key is minted against, so a session-only
    // entry in one would be a mint that validates today and denies forever.
    // `validateToolPolicy` refuses it (tool-policy.test.ts), but a bundle is
    // reviewed once and used many times — assert it directly rather than
    // relying on someone re-running the mint that would have caught it.
    const sessionOnlyRouteIds = new Set(
      declaredSessionOnly.map((k) => {
        const space = k.indexOf(" ");
        return `${k.slice(0, space)} ${k
          .slice(space + 1)
          .replace(/:([A-Za-z0-9_]+)/g, "[$1]")}`;
      }),
    );
    const offenders = Object.entries(ROUTE_BUNDLES).flatMap(([name, routes]) =>
      routes.filter((r) => sessionOnlyRouteIds.has(r)).map((r) => `${name}: ${r}`),
    );
    expect(offenders).toEqual([]);
  });
});
