import { json } from "@sveltejs/kit";
import { searchMessages, type SearchMode } from "$server/db/queries/message-search";
import { isEmbeddingReady, generateEmbedding } from "$server/memory/embeddings";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { validationError } from "$lib/server/security/validation";
import { errorJson } from "$lib/server/http-errors";
import { searchMessagesQuerySchema } from "./schema";
import type { RequestHandler } from "./$types";

/**
 * GET /api/search/messages — hybrid/keyword/semantic message search (RRF).
 *
 * Thin glue over Wave-1's searchMessages(): auth/scope gate → zod mode →
 * limit/offset clamp → degraded gate (pre-check + try/catch around the
 * embedder) → searchMessages → { hits, degraded, requestedMode, servedMode }.
 *
 * The <2-char / whitespace guard is owned by searchMessages (returns []); the
 * envelope still reports degraded honestly.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const q = url.searchParams.get("q") ?? "";

  const parsed = searchMessagesQuerySchema.safeParse({
    mode: url.searchParams.get("mode") ?? undefined,
    scope: url.searchParams.get("scope") ?? undefined,
  });
  if (!parsed.success) return validationError(parsed.error);
  const mode = parsed.data.mode;
  const scope = parsed.data.scope;

  // scope=all resolves the tenant by userId across every project, so projectId
  // is NOT required. scope=project keeps the Phase 65 hard 400.
  const projectId = url.searchParams.get("projectId");
  if (scope === "project" && !projectId) return errorJson(400, "projectId required");

  const limitParam = url.searchParams.get("limit");
  const offsetParam = url.searchParams.get("offset");
  const limit = limitParam !== null ? Math.min(Math.max(parseInt(limitParam, 10) || 0, 1), 50) : 20;
  const offset = offsetParam !== null ? Math.max(parseInt(offsetParam, 10) || 0, 0) : 0;

  // Degraded gate: hybrid/semantic need an embedding; fall back to keyword
  // (degraded:true) when the embedder is unavailable or throws. keyword
  // never degrades and never touches the embedder.
  const wantsSemantic = mode === "hybrid" || mode === "semantic";
  let servedMode: SearchMode = mode;
  let degraded = false;
  let queryEmbedding: number[] | null = null;
  if (wantsSemantic) {
    if (!isEmbeddingReady()) {
      degraded = true;
      servedMode = "keyword";
    } else {
      try {
        queryEmbedding = await generateEmbedding(q);
      } catch {
        degraded = true;
        servedMode = "keyword";
        queryEmbedding = null;
      }
    }
  }

  const hits = await searchMessages({
    // scope=all ignores projectId (tenant resolved by userId); scope=project
    // passes the validated projectId through.
    projectId: scope === "all" ? undefined : projectId!,
    scope,
    query: q,
    mode: servedMode,
    queryEmbedding,
    userId: user.id,
    limit,
    offset,
  });

  return json({ hits, degraded, requestedMode: mode, servedMode });
};
