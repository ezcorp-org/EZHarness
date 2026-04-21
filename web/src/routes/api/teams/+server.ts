import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { requireAuth, requireRole } from "$server/auth/middleware";
import { listTeams, createTeam, getUserTeams } from "$server/db/queries/teams";
import { requireScope } from "$lib/server/security/api-keys";

export const GET: RequestHandler = async ({ locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  try {
    const user = requireAuth(locals);
    const teams = user.role === "admin"
      ? await listTeams()
      : await getUserTeams(user.id);
    return json({ teams });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};

export const POST: RequestHandler = async ({ request, locals }) => {
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  try {
    requireRole(locals, "admin");
    const { name } = (await request.json()) as { name?: string };
    if (!name?.trim()) {
      return json({ error: "Team name is required" }, { status: 400 });
    }
    const team = await createTeam(name.trim());
    return json({ team }, { status: 201 });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};
