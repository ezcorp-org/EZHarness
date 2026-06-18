/**
 * TEST-ONLY deterministic state seeding. Gated by `isTestSurfaceEnabled()`
 * (404 otherwise) and `chat`-scoped auth — called by the external harness to
 * stand up a known project + conversation (owned by the caller) before a
 * spec, and optionally relax rate limits for high-volume runs.
 *
 * POST { projectName?, title?, rateLimitPerMin? }
 *   → { projectId, conversationId, rateLimitPerMin? }
 */
import crypto from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { isTestSurfaceEnabled } from "$lib/server/test-surface";
import { createProject } from "$server/db/queries/projects";
import { createConversation } from "$server/db/queries/conversations";
import { upsertSetting } from "$server/db/queries/settings";
import type { RequestHandler } from "./$types";

// Categories matched by hooks.server.ts RATE_LIMITED_ROUTES, overridable via
// the `limits:rateLimit` settings row (60s-cached there).
const RATE_LIMIT_CATEGORIES = [
  "login", "conversationCreate", "chat", "agentRun", "agentGenerate", "pipelineRun",
] as const;

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!isTestSurfaceEnabled()) return errorJson(404, "Not found");
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  let body: { projectName?: unknown; title?: unknown; rateLimitPerMin?: unknown };
  try {
    body = (await request.json().catch(() => ({}))) as typeof body;
  } catch {
    return errorJson(400, "Invalid JSON body");
  }

  const projectName = typeof body.projectName === "string" && body.projectName.length > 0
    ? body.projectName
    : `harness-${crypto.randomUUID().slice(0, 8)}`;
  const title = typeof body.title === "string" && body.title.length > 0 ? body.title : "harness";

  const project = await createProject({
    name: projectName,
    path: join(tmpdir(), `ezcorp-harness-${crypto.randomUUID()}`),
  });
  const conversation = await createConversation(project.id, { title, userId: user.id });

  let rateLimitPerMin: number | undefined;
  if (typeof body.rateLimitPerMin === "number" && Number.isFinite(body.rateLimitPerMin) && body.rateLimitPerMin > 0) {
    rateLimitPerMin = Math.floor(body.rateLimitPerMin);
    const overrides: Record<string, number> = {};
    for (const c of RATE_LIMIT_CATEGORIES) overrides[c] = rateLimitPerMin;
    await upsertSetting("limits:rateLimit", overrides);
  }

  return json(
    { projectId: project.id, conversationId: conversation.id, ...(rateLimitPerMin ? { rateLimitPerMin } : {}) },
    { status: 201 },
  );
};
