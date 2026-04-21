import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getMemoryById, updateMemory, updateMemoryStatus, deleteMemory, getMemoryProjectIds, setMemoryProjects } from "$server/db/queries/memories";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const memory = await getMemoryById(params.id);
  if (!memory) return json({ error: "Memory not found" }, { status: 404 });
  // sec-H3: fail-closed — unowned rows (null userId) are admin-only
  if (memory.userId !== user.id && user.role !== "admin") return json({ error: "Memory not found" }, { status: 404 });
  const projectIds = await getMemoryProjectIds(params.id);
  return json({ ...memory, projectIds });
};

export const PUT: RequestHandler = async ({ params, request, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const memory = await getMemoryById(params.id);
  if (!memory) return json({ error: "Memory not found" }, { status: 404 });
  // sec-H3: fail-closed — unowned rows (null userId) are admin-only
  if (memory.userId !== user.id && user.role !== "admin") return json({ error: "Memory not found" }, { status: 404 });

  const body = await request.json();
  const { content, confidence, status, projectIds: rawProjectIds } = body;

  // Validate projectIds if provided
  if (rawProjectIds !== undefined) {
    if (!Array.isArray(rawProjectIds) || rawProjectIds.length > 50 || !rawProjectIds.every((id: unknown) => typeof id === "string" && UUID_RE.test(id))) {
      return json({ error: "projectIds must be an array of up to 50 valid UUIDs" }, { status: 400 });
    }
  }

  // Handle status change separately (uses audit log)
  if (status && status !== memory.status) {
    await updateMemoryStatus(params.id, status, `Status changed to ${status}`);
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
  if (!memory) return json({ error: "Memory not found" }, { status: 404 });
  // sec-H3: fail-closed — unowned rows (null userId) are admin-only
  if (memory.userId !== user.id && user.role !== "admin") return json({ error: "Memory not found" }, { status: 404 });

  await deleteMemory(params.id);
  return new Response(null, { status: 204 });
};
