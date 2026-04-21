import { eq } from "drizzle-orm";
import { getDb } from "../connection";
import { projects } from "../schema";

export type Project = typeof projects.$inferSelect;
export type NewProject = { name: string; path: string; icon?: string | null; variables?: Record<string, unknown> };

export async function listProjects(): Promise<Project[]> {
  return getDb().select().from(projects);
}

export async function getProject(id: string): Promise<Project | undefined> {
  const rows = await getDb().select().from(projects).where(eq(projects.id, id));
  return rows[0];
}

export async function createProject(data: NewProject): Promise<Project> {
  const now = new Date();
  const row = {
    id: crypto.randomUUID(),
    name: data.name,
    path: data.path,
    icon: data.icon ?? null,
    variables: data.variables ?? {},
    createdAt: now,
    updatedAt: now,
  };
  await getDb().insert(projects).values(row);
  return row;
}

export async function updateProject(id: string, data: Partial<NewProject>): Promise<Project | undefined> {
  const existing = await getProject(id);
  if (!existing) return undefined;

  const updates: Partial<typeof existing> = { updatedAt: new Date() };
  if (data.name !== undefined) updates.name = data.name;
  if (data.path !== undefined) updates.path = data.path;
  if (data.variables !== undefined) updates.variables = data.variables;
  if (data.icon !== undefined) updates.icon = data.icon;

  await getDb().update(projects).set(updates).where(eq(projects.id, id));
  return getProject(id);
}

export async function deleteProject(id: string): Promise<boolean> {
  const existing = await getProject(id);
  if (!existing) return false;
  await getDb().delete(projects).where(eq(projects.id, id));
  return true;
}

export async function getProjectByName(name: string): Promise<Project | undefined> {
  const rows = await getDb().select().from(projects).where(eq(projects.name, name));
  return rows[0];
}
