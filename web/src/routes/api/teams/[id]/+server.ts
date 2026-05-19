import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { z } from "zod";
import { errorJson } from "$lib/server/http-errors";
import { requireRole, requireTeamRole } from "$server/auth/middleware";
import { getTeam, updateTeamName, deleteTeam, getTeamMembers } from "$server/db/queries/teams";
import { requireScope } from "$lib/server/security/api-keys";

// Boundary validation for team rename. The PUT handler reads only
// `name`; the post-trim emptiness check stays so the test-pinned 400
// "Team name is required" message fires for missing/whitespace input.
const renameTeamSchema = z.object({
  name: z.string().optional(),
}).strict();

export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  try {
    await requireTeamRole(locals, params.id, "viewer");
    const team = await getTeam(params.id);
    if (!team) return errorJson(404, "Team not found");
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
    const parsed = renameTeamSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return errorJson(400, "Team name is required");
    }
    const { name } = parsed.data;
    if (!name?.trim()) {
      return errorJson(400, "Team name is required");
    }
    const team = await updateTeamName(params.id, name.trim());
    if (!team) return errorJson(404, "Team not found");
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
    if (!deleted) return errorJson(404, "Team not found");
    return json({ success: true });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};
