import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { z } from "zod";
import { requireAuth, requireRole } from "$server/auth/middleware";
import { listTeams, createTeam, getUserTeams } from "$server/db/queries/teams";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";

// Boundary validation. POST creates a team — handler reads only `name`
// then trims and rejects empty/whitespace. The post-trim emptiness
// check stays so the test-pinned 400 "Team name is required" message
// fires for both the missing-name and whitespace-only cases.
const createTeamSchema = z.object({
  name: z.string().optional(),
}).strict();

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
    const parsed = createTeamSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return errorJson(400, "Team name is required");
    }
    const { name } = parsed.data;
    if (!name?.trim()) {
      return errorJson(400, "Team name is required");
    }
    const team = await createTeam(name.trim());
    return json({ team }, { status: 201 });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};
