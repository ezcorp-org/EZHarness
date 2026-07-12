import { json } from "@sveltejs/kit";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { ensureInitialized } from "$lib/server/context";
import { validationError } from "$lib/server/security/validation";
import {
  resolveScopedTools,
  resolveSuggestableExtensions,
  isModeToolRestricted,
  scopedToolKey,
  type ScopedToolRow,
  type SuggestableExtension,
} from "$lib/server/scoped-tools";
import { generateEmbedding } from "$server/memory/embeddings";
import { getToolEmbedding, getRawTextEmbedding } from "$server/suggest/embedding-cache";
import { getUserToolPriors, deriveExtensionPriors } from "$server/suggest/user-tool-priors";
import { contentTokens, rankCandidates, EXTENSION_SUGGEST_DEFAULTS } from "$server/suggest/intent-rank";
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

interface SuggestedExtensionPayload {
  name: string;
  description: string;
  score: number;
}

/**
 * Rank the scoped tool surface against the draft: transient draft embedding
 * (never persisted, computed ONCE by the caller and shared with extension
 * ranking) × content-cached tool-description embeddings, folded as a MAX
 * with each tool's authored `suggestExamples` (embedded verbatim), plus a
 * lexical token-overlap signal (hybrid relevance — see intent-rank.ts for
 * the live-measured MiniLM recall gap it papers over), blended with the
 * user's usage prior (same module documents the popular-tool-spam guard).
 * Example tokens fold into `descTokens` at description weight; lexicalScore
 * is a fraction of the draft, so example-stuffing can never exceed 1.0.
 */
async function rankScopedTools(
  draftEmbedding: number[],
  draftTokens: ReadonlySet<string>,
  tools: ScopedToolRow[],
  priors: Record<string, number>,
): Promise<SuggestedToolPayload[]> {
  const candidates = tools.filter((t) => t.description.trim().length > 0);
  if (candidates.length === 0) return [];

  const byKey = new Map(candidates.map((t) => [scopedToolKey(t), t]));
  // Human-readable label for BOTH the embedded text and the lexical name
  // tokens — the namespaced `ext__tool` key measurably drags the cosine
  // down (-0.04 live), while "extension name" wording is what users type.
  const labelFor = (t: ScopedToolRow) => `${t.extension} ${t.name}`;
  const embedded = await Promise.all(
    candidates.map(async (t) => {
      const examples = t.suggestExamples ?? [];
      return {
        key: scopedToolKey(t),
        embedding: await getToolEmbedding(labelFor(t), t.description),
        exampleEmbeddings: await Promise.all(examples.map((ex) => getRawTextEmbedding(ex))),
        nameTokens: contentTokens(labelFor(t)),
        descTokens: contentTokens([t.description, ...examples].join(" ")),
      };
    }),
  );

  // tool_calls records the namespaced runtime name, so candidate keys line
  // up with prior keys directly; the bare-name fallback covers historical
  // rows recorded before namespacing.
  const priorForCandidates: Record<string, number> = {};
  for (const t of candidates) {
    const key = scopedToolKey(t);
    priorForCandidates[key] = priors[key] ?? priors[t.name] ?? 0;
  }

  return rankCandidates(draftEmbedding, embedded, priorForCandidates, undefined, draftTokens).map((r) => {
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

/**
 * Rank whole-EXTENSION candidates against the same shared draft embedding +
 * tokens the tool ranking used. Key = extension name; embedding = the
 * extension name + description (getToolEmbedding, cached); example folding
 * mirrors rankScopedTools. Priors come from `deriveExtensionPriors` (max
 * over the extension's `${name}__`-prefixed tool priors). Candidates whose
 * name already appears among the FINAL ranked tool chips are excluded
 * (`excludeNames`) so one extension never yields both a tool chip and an
 * extension chip in the same response. Uses EXTENSION_SUGGEST_DEFAULTS
 * (top-2, minScore 0.35 — clear of the 0.32 noise cosine).
 */
async function rankScopedExtensions(
  draftEmbedding: number[],
  draftTokens: ReadonlySet<string>,
  candidates: SuggestableExtension[],
  priors: Record<string, number>,
  excludeNames: Set<string>,
): Promise<SuggestedExtensionPayload[]> {
  const usable = candidates.filter(
    (c) => !excludeNames.has(c.name) && c.description.trim().length > 0,
  );
  if (usable.length === 0) return [];

  const byName = new Map(usable.map((c) => [c.name, c]));
  const embedded = await Promise.all(
    usable.map(async (c) => {
      const examples = c.suggestExamples ?? [];
      return {
        key: c.name,
        embedding: await getToolEmbedding(c.name, c.description),
        exampleEmbeddings: await Promise.all(examples.map((ex) => getRawTextEmbedding(ex))),
        nameTokens: contentTokens(c.name),
        descTokens: contentTokens([c.description, ...examples].join(" ")),
      };
    }),
  );

  const extPriors = deriveExtensionPriors(priors, usable.map((c) => c.name));

  return rankCandidates(draftEmbedding, embedded, extPriors, EXTENSION_SUGGEST_DEFAULTS, draftTokens).map(
    (r) => {
      const ext = byName.get(r.key)!;
      return { name: ext.name, description: ext.description, score: Number(r.score.toFixed(4)) };
    },
  );
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

  // Whole-extension suggestions are suppressed inside a mode that curates
  // its own surface (isModeToolRestricted): don't even query the DB in that
  // case. Otherwise resolve the unwired-but-enabled candidates now so the
  // shared-embedding block below can rank them alongside the tools.
  const wantExtensions = include.includes("extensions") && !isModeToolRestricted(scoped.mode);
  const suggestable = wantExtensions
    ? await resolveSuggestableExtensions(conversationId ?? null)
    : [];

  // Draft embedding + priors are the two shared inputs for BOTH rankings —
  // compute each ONCE. Skip them entirely when there's nothing rankable
  // (empty tool surface AND no extension candidates), preserving the
  // tools-only fast path's zero-embedding-work contract.
  const draftTokens = contentTokens(draft);
  const hasToolCandidates = scoped.tools.some((t) => t.description.trim().length > 0);
  let ranked: SuggestedToolPayload[] = [];
  let rankedExtensions: SuggestedExtensionPayload[] = [];
  if (hasToolCandidates || suggestable.length > 0) {
    const [draftEmbedding, priors] = await Promise.all([
      generateEmbedding(draft),
      getUserToolPriors(user.id),
    ]);
    ranked = await rankScopedTools(draftEmbedding, draftTokens, scoped.tools, priors);
    if (wantExtensions) {
      // Dedupe against the FINAL ranked tool chips' extensions.
      const toolExtNames = new Set(ranked.map((t) => t.extension));
      rankedExtensions = await rankScopedExtensions(
        draftEmbedding,
        draftTokens,
        suggestable,
        priors,
        toolExtNames,
      );
    }
  }

  const payload: Record<string, unknown> = { enabled: true };
  if (include.includes("tools")) {
    payload.tools = ranked;
  }
  // Only emitted when requested — old clients (include without "extensions")
  // get a byte-identical response. Mode-restricted → [] (never queried).
  if (include.includes("extensions")) {
    payload.extensions = rankedExtensions;
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
