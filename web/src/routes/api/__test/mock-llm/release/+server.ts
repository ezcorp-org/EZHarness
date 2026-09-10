/** Release a deterministic held mock-LLM SSE turn in real-auth browser tests. */
import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { isTestSurfaceEnabled } from "$lib/server/test-surface";
import { releaseMockHold } from "$lib/server/mock-llm";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!isTestSurfaceEnabled()) return errorJson(404, "Not found");
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  const body = await request.json().catch(() => null) as { holdKey?: unknown } | null;
  if (!body || typeof body.holdKey !== "string" || body.holdKey.length === 0) {
    return errorJson(400, "`holdKey` must be a non-empty string");
  }
  if (!releaseMockHold(body.holdKey)) return errorJson(404, "Hold not found");
  return json({ released: true, holdKey: body.holdKey });
};
