import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { requireAuth, requireTeamRole } from "$server/auth/middleware";
import {
  getTeamMembers,
  addTeamMember,
  removeTeamMember,
} from "$server/db/queries/teams";
import { requireScope } from "$lib/server/security/api-keys";

export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  try {
    await requireTeamRole(locals, params.id, "viewer");
    const members = await getTeamMembers(params.id);
    return json({ members });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  try {
    await requireTeamRole(locals, params.id, "owner");
    const { userId, role = "viewer" } = (await request.json()) as {
      userId?: string;
      role?: "owner" | "editor" | "viewer";
    };
    if (!userId) return json({ error: "userId is required" }, { status: 400 });
    if (!["owner", "editor", "viewer"].includes(role)) {
      return json({ error: "Invalid role" }, { status: 400 });
    }
    const member = await addTeamMember(params.id, userId, role);
    return json({ member }, { status: 201 });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};

export const DELETE: RequestHandler = async ({ params, request, locals }) => {
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  try {
    await requireTeamRole(locals, params.id, "owner");
    const { userId } = (await request.json()) as { userId?: string };
    if (!userId) return json({ error: "userId is required" }, { status: 400 });

    // Cannot remove last owner
    const members = await getTeamMembers(params.id);
    const owners = members.filter((m) => m.role === "owner");
    if (owners.length === 1 && owners[0]!.userId === userId) {
      return json({ error: "Cannot remove the last owner" }, { status: 400 });
    }

    const removed = await removeTeamMember(params.id, userId);
    if (!removed) return json({ error: "Member not found" }, { status: 404 });
    return json({ success: true });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};
