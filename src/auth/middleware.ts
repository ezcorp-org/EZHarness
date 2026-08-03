import type { AuthMethod, AuthUser } from "./types";
import { type ApiKeyScope, hasRequiredScope } from "./api-key";
import { getTeamMembership } from "../db/queries/teams";

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
      return Response.json(
        { error: "Insufficient scope", required: "admin" },
        { status: 403 },
      );
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
    return Response.json(
      { error: "Interactive session required" },
      { status: 403 },
    );
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
