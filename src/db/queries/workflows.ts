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

export async function createWorkflow(data: WorkflowDefinition): Promise<DbWorkflow> {
  const now = new Date();
  const row = {
    id: crypto.randomUUID(),
    name: data.name,
    description: data.description ?? "",
    inputSchema: (data.inputSchema as Record<string, unknown>) ?? null,
    steps: data.steps,
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

export async function loadDbWorkflows(): Promise<WorkflowDefinition[]> {
  const rows = await listWorkflows();
  return rows.map((row) => ({
    name: row.name,
    description: row.description,
    inputSchema: row.inputSchema as InputSchema | undefined,
    steps: row.steps as WorkflowStep[],
  }));
}
