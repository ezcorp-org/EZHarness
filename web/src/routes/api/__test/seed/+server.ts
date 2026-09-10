/**
 * TEST-ONLY deterministic state seeding. Gated by `isTestSurfaceEnabled()`
 * (404 otherwise) and `chat`-scoped auth — called by the external harness to
 * stand up a known project + conversation (owned by the caller) before a
 * spec, and optionally relax rate limits for high-volume runs.
 *
 * POST { projectName?, title?, provider?, model?, history?, rateLimitPerMin?, seedAgentConfig? }
 *   → { projectId, conversationId, history?, rateLimitPerMin?, agentExtensions? }
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
import { createConversation, createMessage } from "$server/db/queries/conversations";
import { upsertSetting } from "$server/db/queries/settings";
import { seedAgentExtensions } from "$lib/server/test-agent-config";
import type { RequestHandler } from "./$types";

// Categories matched by hooks.server.ts RATE_LIMITED_ROUTES, overridable via
// the `limits:rateLimit` settings row (60s-cached there).
const RATE_LIMIT_CATEGORIES = [
  "login", "conversationCreate", "chat", "agentRun", "agentGenerate", "workflowRun",
] as const;

interface SeedHistory {
  turns: number;
  charsPerTurn: number;
}

function parseHistory(raw: unknown): SeedHistory | null | Response {
  if (raw === undefined) return null;
  if (typeof raw !== "object" || raw === null) return errorJson(400, "`history` must be an object");
  const { turns, charsPerTurn } = raw as Record<string, unknown>;
  if (!Number.isInteger(turns) || turns < 1 || turns > 80) {
    return errorJson(400, "`history.turns` must be an integer in [1,80]");
  }
  if (!Number.isInteger(charsPerTurn) || charsPerTurn < 32 || charsPerTurn > 8_000) {
    return errorJson(400, "`history.charsPerTurn` must be an integer in [32,8000]");
  }
  return { turns, charsPerTurn };
}

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!isTestSurfaceEnabled()) return errorJson(404, "Not found");
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  // Body is optional; a missing/invalid body just means "use defaults", so
  // swallow parse errors rather than 400.
  const body = (await request.json().catch(() => ({}))) as {
    projectName?: unknown;
    title?: unknown;
    provider?: unknown;
    model?: unknown;
    history?: unknown;
    rateLimitPerMin?: unknown;
    seedAgentConfig?: unknown;
  };

  const projectName = typeof body.projectName === "string" && body.projectName.length > 0
    ? body.projectName
    : `harness-${crypto.randomUUID().slice(0, 8)}`;
  const title = typeof body.title === "string" && body.title.length > 0 ? body.title : "harness";
  const hasProvider = body.provider !== undefined;
  const hasModel = body.model !== undefined;
  const modelPin = typeof body.provider === "string" && body.provider.length > 0 &&
    typeof body.model === "string" && body.model.length > 0
    ? { provider: body.provider, model: body.model }
    : undefined;
  if (hasProvider !== hasModel || (hasProvider && !modelPin)) {
    return errorJson(400, "`provider` and `model` must be non-empty strings supplied together");
  }
  const history = parseHistory(body.history);
  if (history instanceof Response) return history;

  const project = await createProject({
    name: projectName,
    path: join(tmpdir(), `ezcorp-harness-${crypto.randomUUID()}`),
  });
  const conversation = await createConversation(project.id, {
    title,
    userId: user.id,
    ...modelPin,
  });
  let seededHistory: { firstContent: string; lastContent: string; count: number } | undefined;
  if (history) {
    const historyId = crypto.randomUUID();
    let parentMessageId: string | undefined;
    let firstContent = "";
    let lastContent = "";
    for (let index = 0; index < history.turns; index++) {
      const unit = `history-token-${index} `;
      const content = `E2E_HISTORY_${historyId}_${index}: ${unit.repeat(Math.ceil(history.charsPerTurn / unit.length)).slice(0, history.charsPerTurn)}`;
      const message = await createMessage(conversation.id, {
        role: index % 2 === 0 ? "user" : "assistant",
        content,
        parentMessageId,
      });
      parentMessageId = message.id;
      if (index === 0) firstContent = content;
      lastContent = content;
    }
    seededHistory = { firstContent, lastContent, count: history.turns };
  }
  const agentExtensions = body.seedAgentConfig === true
    ? await seedAgentExtensions(user.id)
    : undefined;

  let rateLimitPerMin: number | undefined;
  if (typeof body.rateLimitPerMin === "number" && Number.isFinite(body.rateLimitPerMin) && body.rateLimitPerMin > 0) {
    rateLimitPerMin = Math.floor(body.rateLimitPerMin);
    const overrides: Record<string, number> = {};
    for (const c of RATE_LIMIT_CATEGORIES) overrides[c] = rateLimitPerMin;
    await upsertSetting("limits:rateLimit", overrides);
  }

  return json(
    {
      projectId: project.id,
      conversationId: conversation.id,
      ...(seededHistory ? { history: seededHistory } : {}),
      ...(rateLimitPerMin ? { rateLimitPerMin } : {}),
      ...(agentExtensions ? { agentExtensions } : {}),
    },
    { status: 201 },
  );
};
