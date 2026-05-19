import { json } from "@sveltejs/kit";
import { requireAuth } from "$server/auth/middleware";
import { listUsers } from "$server/db/queries/users";
import { requireScope } from "$lib/server/security/api-keys";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  const query = url.searchParams.get("q")?.toLowerCase().trim();
  if (!query || query.length < 2) {
    return json({ users: [] });
  }

  const allUsers = await listUsers();
  const matches = allUsers
    .filter((u) => u.name?.toLowerCase().includes(query) || u.email.toLowerCase().includes(query))
    .slice(0, 10)
    .map((u) => ({ id: u.id, name: u.name, email: u.email }));

  return json({ users: matches });
};
