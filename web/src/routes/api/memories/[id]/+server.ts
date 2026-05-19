import { json } from "@sveltejs/kit";
import { z } from "zod";
import type { RequestHandler } from "./$types";
import { getMemoryById, updateMemory, updateMemoryStatus, deleteMemory, getMemoryProjectIds, setMemoryProjects, updateMemoryInjectionEligibility } from "$server/db/queries/memories";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { EXT_AUDIT_ACTIONS } from "$server/extensions/audit-actions";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import { logger } from "$server/logger";
import { patchMemorySchema } from "../schema";

const log = logger.child("api.memories");

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
        log.error("re-embedding failed", {
          error: err instanceof Error ? err.message : String(err),
          memoryId: params.id,
        });
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

/**
 * v1.4 — PATCH /api/memories/[id]
 *
 * Body: `{ injectionEligible: boolean }` (validated via
 * `patchMemorySchema`; unknown keys 400, missing field 400).
 *
 * Auth mirrors GET/PUT: must hold the `read` scope on an API key
 * (cookie auth bypasses), must be authenticated, must own the row
 * (or be admin) — ownership-mismatch and missing-row both 404 to
 * prevent id enumeration (sec-H3 fail-closed).
 *
 * Behavior:
 *   - If `injectionEligible` is already the requested value, return
 *     200 with the unchanged row. No audit row.
 *   - Otherwise, flip the column and write an audit row to the
 *     shared `audit_log` table with action
 *     `MEMORY_INJECTION_ELIGIBILITY_CHANGED` and metadata
 *     `{memoryId, oldValue, newValue, actor: <userId>}`.
 *   - Return the updated row (full shape, including `projectIds`)
 *     so the client can confirm without a second round-trip.
 */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const memory = await getMemoryById(params.id);
  if (!memory) return errorJson(404, "Memory not found");
  // sec-H3: fail-closed — unowned rows (null userId) are admin-only,
  // and cross-user access is collapsed into 404 to prevent id
  // enumeration (matches GET/PUT/DELETE on this same route).
  if (memory.userId !== user.id && user.role !== "admin") {
    return errorJson(404, "Memory not found");
  }

  const parsed = patchMemorySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return errorJson(400, "Invalid request body");
  }
  const { injectionEligible } = parsed.data;

  // Idempotent same-value PATCH: 200 with the unchanged row, no
  // audit row written. Privacy-relevant actions only audit on
  // actual state transitions to avoid noise.
  if (memory.injectionEligible === injectionEligible) {
    const projectIds = await getMemoryProjectIds(params.id);
    return json({ ...memory, projectIds });
  }

  const oldValue = memory.injectionEligible;
  const updated = await updateMemoryInjectionEligibility(params.id, injectionEligible);
  if (!updated) {
    log.error("memory disappeared between read and write", { memoryId: params.id });
    return errorJson(404, "Memory not found");
  }

  // Source the project list for cross-project audit reconstruction.
  // Memories belong to N projects (M2M via `memory_projects`), so
  // `projectIds: string[]` — never a single id.
  const projectIds = await getMemoryProjectIds(params.id);

  // Audit write is intentionally OUTSIDE a transaction — audit-log
  // failures must not abort the caller's column update; see
  // `src/db/queries/audit-log.ts:42-74` (Pitfall #2) for the project
  // pattern. The PATCH is idempotent, so a partial-write recovery is
  // at worst a missed audit row, not data corruption. Spec § Phase
  // 1.3 step 4 said "SAME transaction" but that would break the
  // established audit-decoupling invariant.
  await insertAuditEntry(
    user.id,
    EXT_AUDIT_ACTIONS.MEMORY_INJECTION_ELIGIBILITY_CHANGED,
    params.id,
    {
      memoryId: params.id,
      oldValue,
      newValue: injectionEligible,
      actor: user.id,
      projectIds,
    },
  );

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
