import { json } from "@sveltejs/kit";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { ensureInitialized } from "$lib/server/context";
import { validationError } from "$lib/server/security/validation";
import { resolveScopedTools, scopedToolKey, type ScopedToolRow } from "$lib/server/scoped-tools";
import { generateEmbedding } from "$server/memory/embeddings";
import { getToolEmbedding } from "$server/suggest/embedding-cache";
import { getUserToolPriors } from "$server/suggest/user-tool-priors";
import { rankCandidates } from "$server/suggest/intent-rank";
import { getSuggestConfig, isSuggestEnabledForProject } from "$server/suggest/config";
import { enhancePrompt, isEnhanceAvailable } from "$server/suggest/enhance";
import { suggestRequestSchema } from "./schema";
import type { RequestHandler } from "./$types";

interface SuggestedToolPayload {
  name: string;
  extension: string;
  extensionType: string;
  description: string;
  score: number;
}

/**
 * Rank the scoped tool surface against the draft: transient draft embedding
 * (never persisted) × content-cached tool-description embeddings, blended
 * with the user's usage prior (see src/suggest/intent-rank.ts for the
 * popular-tool-spam guard).
 */
async function rankScopedTools(
  draft: string,
  tools: ScopedToolRow[],
  userId: string,
): Promise<SuggestedToolPayload[]> {
  const candidates = tools.filter((t) => t.description.trim().length > 0);
  if (candidates.length === 0) return [];

  const byKey = new Map(candidates.map((t) => [scopedToolKey(t), t]));
  const [draftEmbedding, embedded, priors] = await Promise.all([
    generateEmbedding(draft),
    Promise.all(
      candidates.map(async (t) => ({
        key: scopedToolKey(t),
        embedding: await getToolEmbedding(scopedToolKey(t), t.description),
      })),
    ),
    getUserToolPriors(userId),
  ]);

  // tool_calls records the namespaced runtime name, so candidate keys line
  // up with prior keys directly; the bare-name fallback covers historical
  // rows recorded before namespacing.
  const priorForCandidates: Record<string, number> = {};
  for (const t of candidates) {
    const key = scopedToolKey(t);
    priorForCandidates[key] = priors[key] ?? priors[t.name] ?? 0;
  }

  return rankCandidates(draftEmbedding, embedded, priorForCandidates).map((r) => {
    const tool = byKey.get(r.key)!;
    return {
      name: tool.name,
      extension: tool.extension,
      extensionType: tool.extensionType,
      description: tool.description,
      score: Number(r.score.toFixed(4)),
    };
  });
}

export const POST: RequestHandler = async ({ locals, request }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  await ensureInitialized();

  const result = suggestRequestSchema.safeParse(await request.json().catch(() => null));
  if (!result.success) return validationError(result.error);
  const { draft, conversationId, projectId, modeId, include } = result.data;

  // Global override first — off means off everywhere, no further work.
  const config = await getSuggestConfig();
  if (!config.enabled) {
    return json({ enabled: false, tools: [], enhancement: null, llmAvailable: false });
  }

  const scoped = await resolveScopedTools(user, {
    conversationId: conversationId ?? null,
    modeId: modeId ?? null,
    hasModeParam: modeId !== undefined,
  });
  if (!scoped) return json({ error: "Not found" }, { status: 404 });

  // Per-project toggle (default ON): the resolved conversation's own
  // project is authoritative; the body's projectId only covers calls with
  // no conversation yet (brand-new chat).
  if (!(await isSuggestEnabledForProject(scoped.projectId ?? projectId ?? null))) {
    return json({ enabled: false, tools: [], enhancement: null, llmAvailable: false });
  }

  const started = performance.now();
  const ranked = await rankScopedTools(draft, scoped.tools, user.id);

  const payload: Record<string, unknown> = { enabled: true };
  if (include.includes("tools")) {
    payload.tools = ranked;
  }
  if (include.includes("enhance")) {
    const available = config.baseUrl !== null && (await isEnhanceAvailable(config.baseUrl));
    payload.llmAvailable = available;
    payload.enhancement = available
      ? await enhancePrompt(
          draft,
          {
            modeName: scoped.mode?.name ?? null,
            modeDescription: scoped.mode?.description ?? null,
            tools: ranked.map((t) => ({ name: t.name, description: t.description })),
          },
          { baseUrl: config.baseUrl!, model: config.model, timeoutMs: config.timeoutMs },
        )
      : null;
  }
  payload.latencyMs = Math.round(performance.now() - started);
  return json(payload);
};
