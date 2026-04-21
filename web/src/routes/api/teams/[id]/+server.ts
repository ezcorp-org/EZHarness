import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { requireRole, requireTeamRole } from "$server/auth/middleware";
import { getTeam, updateTeamName, deleteTeam, getTeamMembers } from "$server/db/queries/teams";
import { requireScope } from "$lib/server/security/api-keys";

export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  try {
    await requireTeamRole(locals, params.id, "viewer");
    const team = await getTeam(params.id);
    if (!team) return json({ error: "Team not found" }, { status: 404 });
    const members = await getTeamMembers(params.id);
    return json({ team, members });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};

export const PUT: RequestHandler = async ({ params, request, locals }) => {
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  try {
    await requireTeamRole(locals, params.id, "owner");
    const { name } = (await request.json()) as { name?: string };
    if (!name?.trim()) {
      return json({ error: "Team name is required" }, { status: 400 });
    }
    const team = await updateTeamName(params.id, name.trim());
    if (!team) return json({ error: "Team not found" }, { status: 404 });
    return json({ team });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  try {
    requireRole(locals, "admin");
    const deleted = await deleteTeam(params.id);
    if (!deleted) return json({ error: "Team not found" }, { status: 404 });
    return json({ success: true });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};
