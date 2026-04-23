import { json } from "@sveltejs/kit";
import { requireAuth } from "$server/auth/middleware";
import { upsertRating } from "$server/db/queries/marketplace-ratings";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const scopeErr = requireScope(locals, "extensions");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const body = await request.json();
  const { thumbsUp } = body as { thumbsUp: boolean };

  if (typeof thumbsUp !== "boolean") {
    return errorJson(400, "thumbsUp must be a boolean");
  }

  await upsertRating(params.id, user.id, thumbsUp);

  return json({ ok: true });
};
