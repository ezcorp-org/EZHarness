import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { requireRole } from "$server/auth/middleware";
import { listUsers } from "$server/db/queries/users";
import { requireScope } from "$lib/server/security/api-keys";

export const GET: RequestHandler = async ({ locals }) => {
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  try {
    requireRole(locals, "admin");
    const allUsers = await listUsers();
    // Don't expose password hashes
    const sanitized = allUsers.map(({ passwordHash, ...u }) => u);
    return json({ users: sanitized });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};
