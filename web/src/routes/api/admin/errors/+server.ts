import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { requireRole } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { listErrors, countErrors } from "$server/db/queries/error-logs";

export const GET: RequestHandler = async ({ url, locals }) => {
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  try {
    requireRole(locals, "admin");

    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get("limit") ?? "100", 10) || 100, 1),
      500,
    );
    const offset = Math.max(
      parseInt(url.searchParams.get("offset") ?? "0", 10) || 0,
      0,
    );

    const [errors, total] = await Promise.all([
      listErrors({ limit, offset }),
      countErrors(),
    ]);

    return json({ errors, total });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};
