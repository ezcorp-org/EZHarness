import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { listContextTypes } from "$server/db/queries/contexts";

export const GET: RequestHandler = async ({ locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  requireAuth(locals);

  const types = await listContextTypes();
  return json({
    types: types.map((t) => ({
      id: t.id,
      label: t.label,
      description: t.description,
      sortOrder: t.sortOrder,
    })),
  });
};
