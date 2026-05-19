import { json } from "@sveltejs/kit";
import { z } from "zod";
import { requireAuth } from "$server/auth/middleware";
import { upsertRating } from "$server/db/queries/marketplace-ratings";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

// Boundary validation. Marketplace ratings are thumbs-up/thumbs-down
// only — the schema mirrors that exact wire shape. The 400 message is
// preserved verbatim so the existing test contract on it still holds.
const ratePostSchema = z.object({
  thumbsUp: z.boolean(),
}).passthrough();

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const scopeErr = requireScope(locals, "extensions");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const parsed = ratePostSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return errorJson(400, "thumbsUp must be a boolean");
  }
  const { thumbsUp } = parsed.data;

  await upsertRating(params.id, user.id, thumbsUp);

  return json({ ok: true });
};
