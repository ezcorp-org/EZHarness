import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { insertMemory, updateMemory, searchMemories, getMemoryProjectIds, getProjectIdsForMemories } from "$server/db/queries/memories";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";

const VALID_CATEGORIES = ["preferences", "biographical", "technical", "decisions_goals"] as const;
const VALID_CONFIDENCES = ["high", "medium", "low"] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET: RequestHandler = async ({ url, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  requireAuth(locals); // gate: must be authenticated, but memories are org-wide
  const projectId = url.searchParams.get("projectId") ?? undefined;
  const scope = url.searchParams.get("scope") as "project" | "global" | "all" | undefined;
  const search = url.searchParams.get("search") ?? undefined;
  const status = url.searchParams.get("status") ?? undefined;
  const category = url.searchParams.get("category") ?? undefined;
  const limit = url.searchParams.get("limit");
  const offset = url.searchParams.get("offset");

  const memories = await searchMemories({
    projectId,
    scope: scope ?? undefined,
    search,
    status: status as any,
    category,
    limit: limit ? parseInt(limit, 10) : undefined,
    offset: offset ? parseInt(offset, 10) : undefined,
  });

  // Batch-fetch project IDs for all returned memories
  const memoryIds = memories.map((m) => m.id);
  const projectIdsMap = await getProjectIdsForMemories(memoryIds);
  const memoriesWithProjects = memories.map((m) => ({
    ...m,
    projectIds: projectIdsMap.get(m.id) ?? [],
  }));

  return json(memoriesWithProjects);
};

export const POST: RequestHandler = async ({ request, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const body = await request.json();
  const { content, category, confidence, projectId, projectIds: rawProjectIds } = body;

  if (!content || typeof content !== "string" || content.trim().length === 0) {
    return errorJson(400, "content is required and must be a non-empty string");
  }

  if (!category || !VALID_CATEGORIES.includes(category)) {
    return errorJson(400, `category must be one of: ${VALID_CATEGORIES.join(", ")}`);
  }

  if (confidence !== undefined && !VALID_CONFIDENCES.includes(confidence)) {
    return errorJson(400, `confidence must be one of: ${VALID_CONFIDENCES.join(", ")}`);
  }

  // Resolve projectIds: explicit array takes precedence, fall back to single projectId
  let projectIds: string[] | undefined;
  if (rawProjectIds !== undefined) {
    if (!Array.isArray(rawProjectIds) || rawProjectIds.length > 50 || !rawProjectIds.every((id: unknown) => typeof id === "string" && UUID_RE.test(id))) {
      return errorJson(400, "projectIds must be an array of up to 50 valid UUIDs");
    }
    projectIds = rawProjectIds;
  } else if (projectId) {
    projectIds = [projectId];
  }

  const memory = await insertMemory({
    content: content.trim(),
    category,
    confidence: confidence ?? "medium",
    userId: user.id,
    ...(projectId ? { projectId } : {}),
    ...(projectIds ? { projectIds } : {}),
  });

  // Generate embedding asynchronously (fire-and-forget)
  (async () => {
    try {
      const { generateEmbedding } = await import("$server/memory/embeddings");
      const embedding = await generateEmbedding(content.trim());
      await updateMemory(memory.id, { embedding });
    } catch (err) {
      console.error("[api/memories] Embedding failed:", err);
    }
  })();

  const memoryProjectIds = await getMemoryProjectIds(memory.id);
  return json({ ...memory, projectIds: memoryProjectIds }, { status: 201 });
};
