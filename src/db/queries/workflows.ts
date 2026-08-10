import { eq, ne, and } from "drizzle-orm";
import { getDb } from "../connection";
import { workflowDefinitions } from "../schema";
import { isUniqueViolation } from "../unique-violation";
import type {
  WorkflowDefinition,
  WorkflowStep,
  InputSchema,
  WorkflowVisibility,
} from "../../types";
import type { CachedWorkflow } from "../../runtime/workflow-scope";

export type DbWorkflow = typeof workflowDefinitions.$inferSelect;

/**
 * A create or rename collided with the GLOBAL unique index on
 * `workflow_definitions.name`.
 *
 * Its own error type so both routes map it to a **409**, not a 500.
 * Before the editor this was effectively unreachable — nothing renamed a
 * workflow — and `updateWorkflow` simply copied the new name into the
 * update set and let the unique index reject it, which surfaced as an
 * unhandled 500. The editor makes renaming ordinary, so it needs an
 * ordinary answer.
 */
export class WorkflowNameConflictError extends Error {
  constructor(readonly workflowName: string) {
    super(`A workflow named "${workflowName}" already exists`);
    this.name = "WorkflowNameConflictError";
  }
}

/** Ownership stamped on a newly created row. Absent ⇒ `system`, which is
 *  what every pre-C6 row is and what the create route's legacy callers
 *  keep producing. */
export interface WorkflowOwnership {
  projectId?: string | null;
  userId?: string | null;
  visibility?: WorkflowVisibility;
  forkedFrom?: string | null;
}

export async function listWorkflows(): Promise<DbWorkflow[]> {
  return getDb().select().from(workflowDefinitions);
}

export async function getWorkflow(id: string): Promise<DbWorkflow | undefined> {
  const rows = await getDb()
    .select()
    .from(workflowDefinitions)
    .where(eq(workflowDefinitions.id, id));
  return rows[0];
}

export async function getWorkflowByName(name: string): Promise<DbWorkflow | undefined> {
  const rows = await getDb()
    .select()
    .from(workflowDefinitions)
    .where(eq(workflowDefinitions.name, name));
  return rows[0];
}

/**
 * True when some OTHER row already holds `name`.
 *
 * `exceptId` is what makes a no-op rename (saving a workflow without
 * changing its name) not collide with itself.
 */
export async function isWorkflowNameTaken(name: string, exceptId?: string): Promise<boolean> {
  const where = exceptId
    ? and(eq(workflowDefinitions.name, name), ne(workflowDefinitions.id, exceptId))
    : eq(workflowDefinitions.name, name);
  const rows = await getDb()
    .select({ id: workflowDefinitions.id })
    .from(workflowDefinitions)
    .where(where)
    .limit(1);
  return rows.length > 0;
}

/**
 * Re-throw a driver-level unique violation as {@link WorkflowNameConflictError}.
 *
 * The pre-checks above answer the ordinary case with a clear message; this
 * closes the TOCTOU window where two concurrent creates both pass their
 * check and the index decides. One error type either way, so the routes
 * have exactly one thing to map.
 *
 * Classification is delegated to the shared {@link isUniqueViolation},
 * which reads the SQLSTATE off `.cause` under both drivers. This used to
 * match `err.message` for "23505" or the index name — and drizzle's
 * wrapper message is the QUERY, so it contains neither: the window this
 * function exists to close was open the whole time and the route 500'd.
 * A second copy of the rule is how that happened, so there is now one.
 */
function asNameConflict(err: unknown, name: string): never {
  if (isUniqueViolation(err)) throw new WorkflowNameConflictError(name);
  throw err;
}

export async function createWorkflow(
  data: WorkflowDefinition,
  ownership: WorkflowOwnership = {},
): Promise<DbWorkflow> {
  const now = new Date();
  const row = {
    id: crypto.randomUUID(),
    name: data.name,
    description: data.description ?? "",
    inputSchema: (data.inputSchema as Record<string, unknown>) ?? null,
    defaultModel: data.defaultModel ?? null,
    steps: data.steps,
    projectId: ownership.projectId ?? null,
    userId: ownership.userId ?? null,
    // Defaults to `system`, matching the column default, so a caller that
    // does not care about ownership produces exactly a pre-C6 row.
    visibility: ownership.visibility ?? ("system" as WorkflowVisibility),
    forkedFrom: ownership.forkedFrom ?? null,
    createdAt: now,
    updatedAt: now,
  };
  if (await isWorkflowNameTaken(data.name)) {
    throw new WorkflowNameConflictError(data.name);
  }
  try {
    await getDb().insert(workflowDefinitions).values(row);
  } catch (err) {
    asNameConflict(err, data.name);
  }
  return row;
}

export async function updateWorkflow(
  id: string,
  data: Partial<WorkflowDefinition> & {
    visibility?: WorkflowVisibility;
    projectId?: string | null;
  },
): Promise<DbWorkflow | undefined> {
  const existing = await getWorkflow(id);
  if (!existing) return undefined;

  // The rename guard. Checked BEFORE the update set is built so a
  // colliding rename never reaches the index — see
  // WorkflowNameConflictError for why this used to be a 500.
  if (data.name !== undefined && data.name !== existing.name) {
    if (await isWorkflowNameTaken(data.name, id)) {
      throw new WorkflowNameConflictError(data.name);
    }
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (data.name !== undefined) updates.name = data.name;
  if (data.description !== undefined) updates.description = data.description;
  if (data.inputSchema !== undefined) updates.inputSchema = data.inputSchema;
  if (data.defaultModel !== undefined) updates.defaultModel = data.defaultModel;
  if (data.steps !== undefined) updates.steps = data.steps;
  // An OWNER (`userId`) moves only through the admin claim action and the
  // fork route, never through an ordinary definition edit — and both go
  // through this one writer rather than a second UPDATE path.
  //
  // The TIER does move through an ordinary edit: an author may
  // re-classify their own workflow, so `PUT /api/workflows/[name]` passes
  // a `visibility` straight through to here. That route gates the value
  // first — `edit` on the row as it stands, then
  // `denyVisibilityAssignment` for the one tier (`system`) the edit right
  // does not imply. This writer is not the gate and must not be mistaken
  // for one; it writes what it is given.
  if (data.visibility !== undefined) updates.visibility = data.visibility;
  if (data.projectId !== undefined) updates.projectId = data.projectId;

  try {
    await getDb().update(workflowDefinitions).set(updates).where(eq(workflowDefinitions.id, id));
  } catch (err) {
    asNameConflict(err, data.name ?? existing.name);
  }
  return getWorkflow(id);
}

/**
 * Claim a `system` workflow into a project.
 *
 * The deliberate, audited answer to the one real regression this phase
 * ships: every pre-existing row becomes `system`, so a non-admin loses
 * edit access to workflows they created. The alternative — inferring
 * ownership from `workflow_runs.user_id` — is a GUESS, and guessing
 * ownership is how you hand someone's workflow to the wrong person. An
 * admin states the owner explicitly instead.
 */
export async function claimWorkflow(
  id: string,
  ownerUserId: string,
  projectId: string | null,
): Promise<DbWorkflow | undefined> {
  const existing = await getWorkflow(id);
  if (!existing) return undefined;
  await getDb()
    .update(workflowDefinitions)
    .set({
      visibility: "project" as WorkflowVisibility,
      userId: ownerUserId,
      projectId,
      updatedAt: new Date(),
    })
    .where(eq(workflowDefinitions.id, id));
  return getWorkflow(id);
}

export async function deleteWorkflow(id: string): Promise<boolean> {
  const existing = await getWorkflow(id);
  if (!existing) return false;
  await getDb().delete(workflowDefinitions).where(eq(workflowDefinitions.id, id));
  return true;
}

/**
 * Project one row into the graph shape the executor consumes.
 *
 * No OWNER column is projected — not `user_id`, not `created_by`. The
 * definition feeds the merged cache, which `GET /api/workflows` serves
 * verbatim to every read-scoped caller, and a user id has no business
 * reaching all of them. Ownership travels beside the definition on
 * {@link CachedWorkflow} instead, where only the server reads it.
 */
function toDefinition(row: DbWorkflow): WorkflowDefinition {
  return {
    name: row.name,
    description: row.description,
    inputSchema: row.inputSchema as InputSchema | undefined,
    // `?? undefined` (not the raw NULL): the cache holds `WorkflowDefinition`
    // objects, where the field is optional — a literal null would defeat the
    // `step.model ?? workflow.defaultModel` fallback's `??`.
    defaultModel: row.defaultModel ?? undefined,
    steps: row.steps as WorkflowStep[],
    // Server-derived provenance, never accepted on a write (the body
    // schema is `.strict()` and has no `source` key). Stamped on the
    // DEFINITION as well as on the cache entry because the authz helpers
    // and the UI's `canManage` both ask `workflow.source === "db"` — a
    // YAML or extension-shipped graph has no row to update.
    source: "db" as const,
  };
}

/**
 * DB workflows WITH their provenance.
 *
 * The shape `buildWorkflowCache` actually needs: `loadDbWorkflows` below
 * drops `id`, `project_id`, `user_id` and `visibility` on the floor, which
 * is why route-level authorization was impossible before this phase.
 */
export async function loadDbCachedWorkflows(): Promise<CachedWorkflow[]> {
  const rows = await listWorkflows();
  return rows.map((row) => ({
    definition: toDefinition(row),
    source: "db" as const,
    id: row.id,
    projectId: row.projectId,
    userId: row.userId,
    visibility: row.visibility,
    forkedFrom: row.forkedFrom,
  }));
}

/**
 * DB workflows as bare definitions.
 *
 * Retained for the CLI, which has no auth context at all (a local
 * operator tool) and resolves against YAML + DB directly, bypassing the
 * routes. Defined in terms of {@link loadDbCachedWorkflows} so there is
 * one row→definition projection, not two that can disagree.
 */
export async function loadDbWorkflows(): Promise<WorkflowDefinition[]> {
  return (await loadDbCachedWorkflows()).map((entry) => entry.definition);
}
