/** Reset the real invite limiter between isolated, serial browser cases. */
import { json } from "@sveltejs/kit";
import { checkRole } from "$server/auth/middleware";
import { errorJson } from "$lib/server/http-errors";
import { isTestSurfaceEnabled } from "$lib/server/test-surface";
import { __rateLimiter } from "../../auth/invite/[token]/+server";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ locals }) => {
  if (!isTestSurfaceEnabled()) return errorJson(404, "Not found");
  const administrator = checkRole(locals, "admin");
  if (administrator instanceof Response) return administrator;
  __rateLimiter.reset();
  return json({ reset: true });
};
