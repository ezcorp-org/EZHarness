import { eq } from "drizzle-orm";
import { getDb } from "../connection";
import { pipelineDefinitions } from "../schema";
import type { PipelineDefinition, PipelineStep, InputSchema } from "../../types";

export type DbPipeline = typeof pipelineDefinitions.$inferSelect;

export async function listPipelines(): Promise<DbPipeline[]> {
  return getDb().select().from(pipelineDefinitions);
}

export async function getPipeline(id: string): Promise<DbPipeline | undefined> {
  const rows = await getDb().select().from(pipelineDefinitions).where(eq(pipelineDefinitions.id, id));
  return rows[0];
}

export async function getPipelineByName(name: string): Promise<DbPipeline | undefined> {
  const rows = await getDb().select().from(pipelineDefinitions).where(eq(pipelineDefinitions.name, name));
  return rows[0];
}

export async function createPipeline(data: PipelineDefinition): Promise<DbPipeline> {
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
  await getDb().insert(pipelineDefinitions).values(row);
  return row;
}

export async function updatePipeline(id: string, data: Partial<PipelineDefinition>): Promise<DbPipeline | undefined> {
  const existing = await getPipeline(id);
  if (!existing) return undefined;

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (data.name !== undefined) updates.name = data.name;
  if (data.description !== undefined) updates.description = data.description;
  if (data.inputSchema !== undefined) updates.inputSchema = data.inputSchema;
  if (data.steps !== undefined) updates.steps = data.steps;

  await getDb().update(pipelineDefinitions).set(updates).where(eq(pipelineDefinitions.id, id));
  return getPipeline(id);
}

export async function deletePipeline(id: string): Promise<boolean> {
  const existing = await getPipeline(id);
  if (!existing) return false;
  await getDb().delete(pipelineDefinitions).where(eq(pipelineDefinitions.id, id));
  return true;
}

export async function loadDbPipelines(): Promise<PipelineDefinition[]> {
  const rows = await listPipelines();
  return rows.map((row) => ({
    name: row.name,
    description: row.description,
    inputSchema: row.inputSchema as InputSchema | undefined,
    steps: row.steps as PipelineStep[],
  }));
}
