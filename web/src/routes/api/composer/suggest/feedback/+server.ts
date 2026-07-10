import { json } from "@sveltejs/kit";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { ensureInitialized } from "$lib/server/context";
import { validationError } from "$lib/server/security/validation";
import { insertSuggestionFeedback } from "$server/db/queries/suggestion-feedback";
import { suggestFeedbackSchema } from "../schema";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ locals, request }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  await ensureInitialized();

  const result = suggestFeedbackSchema.safeParse(await request.json().catch(() => null));
  if (!result.success) return validationError(result.error);

  await insertSuggestionFeedback({ userId: user.id, ...result.data });
  return json({ ok: true }, { status: 201 });
};
