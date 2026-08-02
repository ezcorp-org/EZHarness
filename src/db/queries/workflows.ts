import { eq } from "drizzle-orm";
import { getDb } from "../connection";
import { workflowDefinitions } from "../schema";
import type { WorkflowDefinition, WorkflowStep, InputSchema } from "../../types";

export type DbWorkflow = typeof workflowDefinitions.$inferSelect;

export async function listWorkflows(): Promise<DbWorkflow[]> {
  return getDb().select().from(workflowDefinitions);
}

export async function getWorkflow(id: string): Promise<DbWorkflow | undefined> {
  const rows = await getDb().select().from(workflowDefinitions).where(eq(workflowDefinitions.id, id));
  return rows[0];
}

export async function getWorkflowByName(name: string): Promise<DbWorkflow | undefined> {
  const rows = await getDb().select().from(workflowDefinitions).where(eq(workflowDefinitions.name, name));
  return rows[0];
}

/**
 * Every DB workflow's owner, keyed by name, in ONE query.
 *
 * Exists so `GET /api/workflows` can stamp `canManage` onto a merged cache
 * of N definitions without N `getWorkflowByName` round-trips. Deliberately
 * NOT folded into `loadDbWorkflows`: that projection stays owner-free (see
 * its doc) because the cache it feeds is served verbatim to every
 * read-scoped caller. Here the owner is consumed server-side and only the
 * resulting boolean is serialized, so no user id leaves the process.
 */
export async function getWorkflowOwnersByName(): Promise<Map<string, string | null>> {
  // Annotated explicitly: the drizzle handle is held as broadly-typed `any`
  // (see `getDb`), so a projected select infers nothing on its own — the
  // same reason `audit-global.ts` annotates its projected rows.
  const rows: Array<{ name: string; createdBy: string | null }> = await getDb()
    .select({ name: workflowDefinitions.name, createdBy: workflowDefinitions.createdBy })
    .from(workflowDefinitions);
  return new Map(rows.map((row) => [row.name, row.createdBy]));
}

/**
 * Insert a workflow definition. `createdBy` records the authoring user and
 * is what `canRunWorkflow` / `canActOnWorkflow` gate run, update and delete
 * on. It is optional and defaults to NULL: rows created before the column
 * existed — and any caller with no principal (the CLI) — stay unowned, i.e.
 * runnable and editable by anyone, exactly as before.
 */
export async function createWorkflow(
  data: WorkflowDefinition,
  createdBy?: string,
): Promise<DbWorkflow> {
  const now = new Date();
  const row = {
    id: crypto.randomUUID(),
    name: data.name,
    description: data.description ?? "",
    inputSchema: (data.inputSchema as Record<string, unknown>) ?? null,
    steps: data.steps,
    createdBy: createdBy ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await getDb().insert(workflowDefinitions).values(row);
  return row;
}

export async function updateWorkflow(id: string, data: Partial<WorkflowDefinition>): Promise<DbWorkflow | undefined> {
  const existing = await getWorkflow(id);
  if (!existing) return undefined;

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (data.name !== undefined) updates.name = data.name;
  if (data.description !== undefined) updates.description = data.description;
  if (data.inputSchema !== undefined) updates.inputSchema = data.inputSchema;
  if (data.steps !== undefined) updates.steps = data.steps;

  await getDb().update(workflowDefinitions).set(updates).where(eq(workflowDefinitions.id, id));
  return getWorkflow(id);
}

export async function deleteWorkflow(id: string): Promise<boolean> {
  const existing = await getWorkflow(id);
  if (!existing) return false;
  await getDb().delete(workflowDefinitions).where(eq(workflowDefinitions.id, id));
  return true;
}

/**
 * Project DB rows into the merged workflow cache.
 *
 * `createdBy` is deliberately NOT projected: the cache is served verbatim
 * by `GET /api/workflows`, and a user id has no business reaching every
 * read-scoped caller. `canRunWorkflow` re-reads the owner from the row,
 * which is also the fresher answer. `source` is what tells it to.
 */
export async function loadDbWorkflows(): Promise<WorkflowDefinition[]> {
  const rows = await listWorkflows();
  return rows.map((row) => ({
    name: row.name,
    description: row.description,
    inputSchema: row.inputSchema as InputSchema | undefined,
    steps: row.steps as WorkflowStep[],
    source: "db" as const,
  }));
}
