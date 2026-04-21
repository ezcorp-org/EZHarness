import { json } from "@sveltejs/kit";
import { buildHealthResponse } from "$server/health";
import { requireAuth } from "$server/auth/middleware";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url, locals }) => {
  const detail = url.searchParams.get("detail") === "true";

  if (detail) {
    requireAuth(locals);
    const user = locals.user as { role?: string } | undefined;
    if (!user || user.role !== "admin") {
      return json({ error: "Admin access required" }, { status: 401 });
    }
  }

  const result = await buildHealthResponse(detail);
  return json(result);
};
