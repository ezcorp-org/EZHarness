import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { getQuickstartSteps } from "$server/db/queries/quickstart";

export const GET: RequestHandler = async ({ locals }) => {
  try {
    const scopeErr = requireScope(locals, "read");
    if (scopeErr) return scopeErr;
    const user = requireAuth(locals);
    const steps = await getQuickstartSteps(user.id);
    return json({ steps });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};
