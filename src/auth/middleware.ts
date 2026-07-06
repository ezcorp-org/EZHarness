import type { AuthUser } from "./types";
import { getTeamMembership } from "../db/queries/teams";

// Structural shape of SvelteKit's `App.Locals` that these helpers rely on.
// Declared locally so this module typechecks in the backend build where the
// SvelteKit `App` namespace is not in scope (see `scripts/typecheck.sh` —
// backend typecheck excludes `web/` where `app.d.ts` lives). SvelteKit's
// `App.Locals` is structurally compatible with this, so call sites in
// `web/src/routes/**` pass without casts.
type AuthLocals = { user?: AuthUser };

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
 */
export function checkRole(locals: AuthLocals, role: "admin"): AuthUser | Response {
  try {
    return requireRole(locals, role);
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
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
