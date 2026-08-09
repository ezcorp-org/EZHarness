import type { AuthUser } from "./types";
import { type ApiKeyScope, hasRequiredScope } from "./api-key";
import { getTeamMembership } from "../db/queries/teams";
import { getProjectMembership } from "../db/queries/project-members";
import type { ProjectMemberRole } from "../db/schema";

/**
 * HOW a request authenticated — stamped POSITIVELY at each auth site, so a
 * gate can ask "is this an interactive human session?" without inferring it
 * from the ABSENCE of something else.
 *
 * There is exactly one producer per value and they are all in the request
 * pipeline:
 *   - `session`  — a verified session-cookie JWT (`web/src/hooks.server.ts`).
 *                  The only value that represents a human at a browser.
 *   - `api-key`  — a user-issued `ezk_*` bearer key
 *                  (`web/src/lib/server/security/bearer-auth.ts`).
 *   - `internal` — a loopback-only `ezkint_*` bundled-extension subprocess
 *                  key (same module).
 *
 * `undefined` means NO auth site claimed the request. A gate that allowlists
 * a value therefore refuses both "not authenticated" and "authenticated by
 * some future mechanism that has not been taught to stamp itself" — which is
 * the whole point of stamping rather than sniffing. Do NOT add a value here
 * without deciding, at every {@link requireSessionAuth} call site, whether
 * that new principal may spend a consent gate.
 *
 * Declared HERE rather than in `./types` because this union is the vocabulary
 * of `requireSessionAuth`'s allowlist and has no meaning apart from it — and
 * because `./types` is declaration-only, so a change there carries no
 * executable line for the patch-coverage gate to measure.
 */
export type AuthMethod = "session" | "api-key" | "internal";

// Structural shape of SvelteKit's `App.Locals` that these helpers rely on.
// Declared locally so this module typechecks in the backend build where the
// SvelteKit `App` namespace is not in scope (see `scripts/typecheck.sh` —
// backend typecheck excludes `web/` where `app.d.ts` lives). SvelteKit's
// `App.Locals` is structurally compatible with this, so call sites in
// `web/src/routes/**` pass without casts. `apiKeyScopes` is present only on
// API-key-authed requests (undefined for a cookie session) and lets the role
// gate also enforce the SCOPE axis for key principals.
type AuthLocals = {
  user?: AuthUser;
  apiKeyScopes?: ApiKeyScope[];
  authMethod?: AuthMethod;
};

export function requireAuth(locals: AuthLocals): AuthUser {
  const user = locals.user;
  if (!user) {
    throw new Response(JSON.stringify({ error: "Authentication required" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return user;
}

export function requireRole(locals: AuthLocals, role: "admin"): AuthUser {
  const user = requireAuth(locals);
  if (user.role !== role) {
    throw new Response(JSON.stringify({ error: "Insufficient permissions" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  return user;
}

/**
 * Non-throwing sibling of `requireRole` for `+server.ts` handlers.
 *
 * `requireAuth`/`requireRole` throw a raw `Response` on denial. SvelteKit
 * does NOT recognise a thrown `Response` from a route handler — it surfaces
 * it as a 500. So a handler that calls `requireRole` directly returns 500
 * (not the intended 401/403) to any caller that trips the gate — most
 * notably an API-key principal, which is minted below `admin` role unless it
 * is an explicitly role-carrying key.
 *
 * `checkRole` runs the exact same auth+role logic (delegating to
 * `requireRole`, the single source of truth) but RETURNS the denial Response
 * instead of throwing — mirroring `requireScope`'s `Response | null` style
 * while still yielding the `AuthUser` on success. This is the one place the
 * throw→return conversion lives, so the "uncaught thrown Response = 500" bug
 * can't recur by copy-paste. Call sites become:
 *
 *   const admin = checkRole(locals, "admin");
 *   if (admin instanceof Response) return admin;
 *   // …use admin.id
 *
 * It also enforces the SECOND authorization axis for API-key principals: an
 * admin route needs an admin PRINCIPAL (role) *and*, when the caller is a key,
 * the `admin` SCOPE. `requireRole` alone would let an admin-role key minted
 * with a narrow scope (`--scopes read --role admin`) reach admin WRITES it was
 * never scoped for. A cookie session carries no `apiKeyScopes` and is
 * unaffected (authorized by role alone); a key missing the scope gets a clean
 * 403, never a thrown Response (which SvelteKit surfaces as a 500).
 */
export function checkRole(locals: AuthLocals, role: "admin"): AuthUser | Response {
  try {
    const user = requireRole(locals, role);
    if (!hasRequiredScope(locals.apiKeyScopes, "admin")) {
      return Response.json({ error: "Insufficient scope", required: "admin" }, { status: 403 });
    }
    return user;
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

/**
 * The auth methods that count as an INTERACTIVE HUMAN SESSION.
 *
 * An ALLOWLIST, deliberately, and deliberately a `Set<string>` rather than a
 * `Set<AuthMethod>`: the thing being tested is `AuthMethod | undefined`, and
 * a set typed to the union would force a cast at the one place where the
 * `undefined` case is the security-relevant one. Membership is checked, not
 * absence — so adding a new `AuthMethod` (or forgetting to stamp one at all)
 * lands on the DENY side by default, which is the only way this gate can
 * survive an auth mode nobody has thought of yet.
 */
const SESSION_AUTH_METHODS: ReadonlySet<string> = new Set<AuthMethod>(["session"]);

/**
 * Gate a route on the caller being a REAL, INTERACTIVE HUMAN SESSION.
 *
 * `requireScope(locals, "chat")` is not this. It passes for every cookie
 * session AND for every `chat`-scoped API key — `hasRequiredScope` treats
 * undefined scopes ("cookie session") as allow-all, and a key that HOLDS
 * `chat` satisfies it outright. That is correct for chatting. It is wrong
 * anywhere the act being authorized is a HUMAN DECISION rather than a
 * capability: answering a workflow approval is the load-bearing case, since
 * a run parks on an approval precisely so that a person decides. If a leaked
 * `chat` key can answer one, the key mints consent and the entire approval
 * mechanism is decorative against that threat.
 *
 * ## Fail-closed by construction
 *
 * The discriminator is `locals.authMethod`, stamped POSITIVELY by each auth
 * site (see {@link AuthMethod}), and matched against an ALLOWLIST. It is NOT
 * `locals.apiKeyScopes === undefined`. That inference happens to be true
 * today — every bearer path in `bearer-auth.ts` sets `apiKeyScopes`, and the
 * cookie path in `hooks.server.ts` does not — but it is an inference from an
 * ABSENCE, so it silently flips to ALLOW the first time some future auth mode
 * populates `locals.user` without also populating `apiKeyScopes`. A gate that
 * fails open when someone forgets an unrelated field is not a gate.
 *
 * Unstamped (`undefined`) is refused, `api-key` is refused, `internal` is
 * refused, and any value added to `AuthMethod` later is refused until someone
 * deliberately adds it here.
 *
 * ## Shape
 *
 * Returns `AuthUser | Response`, matching {@link checkRole} rather than
 * {@link requireAuth}: a `+server.ts` handler that THROWS a `Response` gets
 * a 500, not the status it meant (see checkRole's note). Call sites read
 *
 *   const user = requireSessionAuth(locals);
 *   if (user instanceof Response) return user;
 *
 * 401 when there is no principal at all (byte-identical body to
 * `requireAuth`, so swapping one for the other does not change what an
 * unauthenticated caller sees); 403 when there IS a principal but it is not
 * a session — a distinction the caller has already earned by authenticating.
 */
export function requireSessionAuth(locals: AuthLocals): AuthUser | Response {
  const user = locals.user;
  if (!user) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }
  const method = locals.authMethod;
  if (method === undefined || !SESSION_AUTH_METHODS.has(method)) {
    return Response.json({ error: "Interactive session required" }, { status: 403 });
  }
  return user;
}

/**
 * BOTH axes of the admin-console gate, in the one order they may run:
 * interactive session first, admin role second.
 *
 * It exists because the two calls were being copy-pasted per route file, and
 * a copied gate is a gate that eventually ships with only half of itself —
 * the failure is silent (a route that forgot `requireSessionAuth` still looks
 * gated, and simply admits every admin-scoped API key). One function means a
 * new admin-console route cannot get the pair wrong, and it means the ORDER
 * is decided once: session first, so a key principal is refused as "not a
 * session" rather than being told whether it holds the admin role — the
 * narrower answer, and the one that leaks nothing about the key.
 *
 * Returns, never throws, for the reason {@link checkRole} documents at
 * length: SvelteKit answers 500 to a thrown `Response` from a `+server.ts`
 * handler, so the 401/403 the gate meant would never reach the caller. Both
 * halves already return, and composing them cannot re-introduce the throw.
 *
 * NOT for a route that merely wants an admin: `checkRole` alone is right when
 * an admin-scoped API key SHOULD reach the route. This one is for the acts
 * that are HUMAN DECISIONS — minting a principal other people's jobs run as,
 * or raising the budget one of them may spend.
 */
export function requireAdminSession(locals: AuthLocals): AuthUser | Response {
  const session = requireSessionAuth(locals);
  if (session instanceof Response) return session;
  return checkRole(locals, "admin");
}

/**
 * PROJECT membership ladder — `member` < `owner`.
 *
 * A third role taxonomy alongside `users.role` (`admin`/`member`) and
 * `team_members.role` (`owner`/`editor`/`viewer`); see the "two role
 * taxonomies, one column name" gotcha in
 * docs/features/platform/rbac-and-permission-modes.md, which is now three.
 * `member` and `owner` mean here exactly what `project_members` says they
 * mean and nothing they mean on a team.
 */
const PROJECT_ROLE_LEVELS: Record<string, number> = { member: 0, owner: 1 };

/**
 * Gate a route on PROJECT MEMBERSHIP, returning the denial rather than
 * throwing it.
 *
 * Deliberately shaped like {@link checkRole} and NOT like
 * {@link requireTeamRole}: `requireTeamRole` throws a raw `Response`, which
 * SvelteKit surfaces from a `+server.ts` handler as a 500 rather than the
 * 401/403 it meant (see checkRole's note). Every consumer of this gate is a
 * route handler, so the throwing shape would be wrong at every call site.
 *
 * **Instance admins bypass**, matching `requireTeamRole` — an `admin` is
 * treated as holding `owner` on every project regardless of membership. That
 * override is what keeps a project reachable if its members are all deleted,
 * and it is why the migration's ownerless backfill is a re-statement of
 * existing reach rather than a new grant.
 *
 * **403, not 404.** The sec-H3 routes collapse denial into "not found" to
 * avoid an id-existence oracle. Projects have no existence to hide: `GET
 * /api/projects/:id` and the list route are deliberately instance-global and
 * unfiltered, so a 404 here would misreport a project the same caller can
 * read in the very next request.
 *
 * The membership read is the ONLY thing consulted — never a `projectId` off
 * the request body — because the row is keyed by the authenticated user id.
 */
export async function checkProjectRole(
  locals: AuthLocals,
  projectId: string,
  minRole: ProjectMemberRole,
): Promise<AuthUser | Response> {
  const user = locals.user;
  if (!user) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }
  if (user.role === "admin") return user;

  const membership = await getProjectMembership(user.id, projectId);
  if (!membership) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  // `?? -1` is the fail-closed read of a role this build does not know —
  // a row written by a newer version, or hand-edited in the DB, denies
  // rather than sorting as the lowest known rung.
  const held = PROJECT_ROLE_LEVELS[membership.role] ?? -1;
  const needed = PROJECT_ROLE_LEVELS[minRole] ?? 0;
  if (held < needed) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  return user;
}

const ROLE_LEVELS: Record<string, number> = { viewer: 0, editor: 1, owner: 2 };

export async function requireTeamRole(
  locals: AuthLocals,
  teamId: string,
  minRole: "viewer" | "editor" | "owner",
): Promise<AuthUser> {
  const user = requireAuth(locals);

  // Instance admins bypass team role check
  if (user.role === "admin") return user;

  const membership = await getTeamMembership(user.id, teamId);
  if (!membership) {
    throw new Response(JSON.stringify({ error: "Not a member of this team" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const userLevel = ROLE_LEVELS[membership.role] ?? -1;
  const requiredLevel = ROLE_LEVELS[minRole] ?? 0;

  if (userLevel < requiredLevel) {
    throw new Response(JSON.stringify({ error: "Insufficient team permissions" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  return user;
}
