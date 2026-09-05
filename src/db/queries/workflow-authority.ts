import { sql } from "drizzle-orm";
import type { MigrationDb } from "../migrations/types";
import type { User } from "../schema";
import { releaseRows } from "./extension-releases";
import { getUserById } from "./users";
import { getProjectMembership } from "./project-members";

export async function readWorkflowAuthorityUser(id: string, database?: MigrationDb): Promise<Pick<User, "id" | "status" | "role"> | undefined> {
  if (!database) return getUserById(id);
  return releaseRows<Pick<User, "id" | "status" | "role">>(await database.execute(sql`SELECT id, status, role FROM users WHERE id = ${id} FOR SHARE`))[0];
}

export async function readWorkflowAuthorityMembership(userId: string, projectId: string, database?: MigrationDb): Promise<boolean> {
  if (!database) return Boolean(await getProjectMembership(userId, projectId));
  return releaseRows(await database.execute(sql`SELECT 1 FROM project_members WHERE user_id = ${userId} AND project_id = ${projectId} FOR SHARE`)).length > 0;
}
