import { eq, sql } from "drizzle-orm";
import { getDb } from "../connection";
import { projects } from "../schema";
import { upsertProjectMember } from "./project-members";
import { SELF_PROJECT_ID } from "../seed-self-project";

export type Project = typeof projects.$inferSelect;
export type NewProject = {
  name: string;
  path: string;
  icon?: string | null;
  variables?: Record<string, unknown>;
};

export async function listProjects(): Promise<Project[]> {
  // The seeded self project (dev-mode dogfooding workspace) is pinned first
  // so it's the top pick in every project surface; the rest keep the
  // previous de-facto insertion order (created_at). No-op outside dev —
  // the row only exists when EZCORP_SELF_PROJECT_PATH seeded it.
  return getDb()
    .select()
    .from(projects)
    .orderBy(
      sql`CASE WHEN ${projects.id} = ${SELF_PROJECT_ID} THEN 0 ELSE 1 END`,
      projects.createdAt,
    );
}

export async function getProject(id: string): Promise<Project | undefined> {
  const rows = await getDb().select().from(projects).where(eq(projects.id, id));
  return rows[0];
}

/**
 * Create a project and, when a creator is known, make them its `owner`.
 *
 * The stamp is what makes the `owner` rung of `project_members` reachable at
 * all, and it is what fixes the case PR #82's admin-only stop-gap broke: the
 * non-admin who just created a project can rename and delete it.
 *
 * `ownerUserId` is OPTIONAL rather than required, deliberately. Several
 * callers genuinely have no user — the `/api/__test/seed` fixture route and
 * ~30 backend tests build projects with no principal at all — and forcing a
 * placeholder id on them would either invent a member or need a sentinel
 * user. Omitting it is SAFE rather than a hole: a project with no members is
 * still mutable through the instance-admin override, and `migrate()`'s
 * ownerless backfill attributes it to the first admin on the next boot. The
 * one path that matters, `POST /api/projects`, always passes it.
 *
 * The membership insert is not wrapped in a transaction with the project
 * insert, because the two drivers (PGlite / Bun.sql) expose different
 * transaction handles and every other multi-write path in this layer is
 * written the same way. The failure mode is a project with no members, which
 * is precisely the state the backfill already repairs.
 */
export async function createProject(
  data: NewProject,
  ownerUserId?: string | null,
): Promise<Project> {
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
  if (ownerUserId) await upsertProjectMember(row.id, ownerUserId, "owner");
  return row;
}

export async function updateProject(
  id: string,
  data: Partial<NewProject>,
): Promise<Project | undefined> {
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

/**
 * Resolve a project by its absolute filesystem `path` (exact match). Used by
 * the extension events route to turn a gate push's shape-validated
 * `payload.projectRoot` into the REAL project — the fail-closed host-side
 * trust boundary: an unregistered path returns `undefined`, so the caller
 * mints a null-scope token and the spawn keeps rejecting (never borrow ambient
 * scope). `path` is unique per project in practice (one checkout → one
 * project); the first match wins if a path were ever duplicated.
 */
export async function getProjectByPath(path: string): Promise<Project | undefined> {
  if (!path) return undefined;
  const rows = await getDb().select().from(projects).where(eq(projects.path, path));
  return rows[0];
}
