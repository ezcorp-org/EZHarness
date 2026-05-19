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
