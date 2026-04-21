import { json } from "@sveltejs/kit";
import * as modeQueries from "$server/db/queries/modes";
import { requireAuth } from "$server/auth/middleware";
import { createModeSchema } from "./schema";
import { validationError } from "$lib/server/security/validation";
import { requireScope } from "$lib/server/security/api-keys";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  return json(await modeQueries.listModes(user.id));
};

export const POST: RequestHandler = async ({ request, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const result = createModeSchema.safeParse(await request.json());
  if (!result.success) return validationError(result.error);
  const mode = await modeQueries.createMode({ ...result.data, userId: user.id });
  return json(mode, { status: 201 });
};
