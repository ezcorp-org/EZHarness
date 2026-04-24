import { json } from "@sveltejs/kit";
import { z } from "zod";
import type { RequestHandler } from "./$types";
import { getMemoryById, updateMemory, updateMemoryStatus, deleteMemory, getMemoryProjectIds, setMemoryProjects } from "$server/db/queries/memories";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Boundary validation for memory updates. The PUT handler reads
// `content`/`confidence`/`status`/`projectIds` and runs its own
// `projectIds` UUID + length check (which produces the specific 400
// "projectIds must be an array of up to 50 valid UUIDs" message). The
// schema permits `projectIds` as `unknown` so the inline check fires
// for non-array / over-50 / non-UUID inputs verbatim. Other fields
// stay strictly typed (string/number).
const updateMemorySchema = z.object({
  content: z.string().optional(),
  confidence: z.number().optional(),
  status: z.string().optional(),
  projectIds: z.unknown().optional(),
}).strict();

export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const memory = await getMemoryById(params.id);
  if (!memory) return errorJson(404, "Memory not found");
  // sec-H3: fail-closed — unowned rows (null userId) are admin-only
  if (memory.userId !== user.id && user.role !== "admin") return errorJson(404, "Memory not found");
  const projectIds = await getMemoryProjectIds(params.id);
  return json({ ...memory, projectIds });
};

export const PUT: RequestHandler = async ({ params, request, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const memory = await getMemoryById(params.id);
  if (!memory) return errorJson(404, "Memory not found");
  // sec-H3: fail-closed — unowned rows (null userId) are admin-only
  if (memory.userId !== user.id && user.role !== "admin") return errorJson(404, "Memory not found");

  const parsed = updateMemorySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return errorJson(400, "Invalid request body");
  }
  const { content, confidence, status, projectIds: rawProjectIds } = parsed.data;

  // Validate projectIds if provided
  if (rawProjectIds !== undefined) {
    if (!Array.isArray(rawProjectIds) || rawProjectIds.length > 50 || !rawProjectIds.every((id: unknown) => typeof id === "string" && UUID_RE.test(id))) {
      return errorJson(400, "projectIds must be an array of up to 50 valid UUIDs");
    }
  }

  // Handle status change separately (uses audit log)
  if (status && status !== memory.status) {
    await updateMemoryStatus(params.id, status as "active" | "stale" | "archived", `Status changed to ${status}`);
  }

  // Handle content/metadata updates
  const updates: Record<string, unknown> = {};
  if (content !== undefined && content !== memory.content) {
    updates.content = content;

    // Re-embed asynchronously when content changes
    (async () => {
      try {
        const { generateEmbedding } = await import("$server/memory/embeddings");
        const embedding = await generateEmbedding(content);
        await updateMemory(params.id, { embedding });
      } catch (err) {
        console.error("[api/memories] Re-embedding failed:", err);
      }
    })();
  }
  if (confidence !== undefined) updates.confidence = confidence;

  if (Object.keys(updates).length > 0) {
    await updateMemory(params.id, updates as any);
  }

  // Update project assignments if provided
  if (rawProjectIds !== undefined) {
    await setMemoryProjects(params.id, rawProjectIds);
  }

  const updated = await getMemoryById(params.id);
  const projectIds = await getMemoryProjectIds(params.id);
  return json({ ...updated, projectIds });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const memory = await getMemoryById(params.id);
  if (!memory) return errorJson(404, "Memory not found");
  // sec-H3: fail-closed — unowned rows (null userId) are admin-only
  if (memory.userId !== user.id && user.role !== "admin") return errorJson(404, "Memory not found");

  await deleteMemory(params.id);
  return new Response(null, { status: 204 });
};
