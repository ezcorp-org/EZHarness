import { sql } from "drizzle-orm";
import type { MigrationDb } from "../migrations/types";
import type { User } from "../schema";
import { releaseRows } from "./extension-releases";
import { getUserById } from "./users";
import { getProjectMembership } from "./project-members";
import { getWorkflowRunRow } from "./workflow-runs";

type WorkflowAuthorityRun = Pick<NonNullable<Awaited<ReturnType<typeof getWorkflowRunRow>>>, "id" | "status" | "userId" | "runAsKind" | "runAs" | "delegationId" | "projectId" | "workflowName" | "definitionHash" | "parentRunId">;

export async function readWorkflowAuthorityRun(id: string, database?: MigrationDb): Promise<WorkflowAuthorityRun | undefined> {
  if (!database) return getWorkflowRunRow(id);
  return releaseRows<WorkflowAuthorityRun>(await database.execute(sql`SELECT id, status, user_id AS "userId", run_as_kind AS "runAsKind", run_as AS "runAs", delegation_id AS "delegationId", project_id AS "projectId", workflow_name AS "workflowName", definition_hash AS "definitionHash", parent_run_id AS "parentRunId" FROM workflow_runs WHERE id=${id} FOR SHARE`))[0];
}

export async function readWorkflowAuthorityUser(id: string, database?: MigrationDb): Promise<Pick<User, "id" | "status" | "role"> | undefined> {
  if (!database) return getUserById(id);
  return releaseRows<Pick<User, "id" | "status" | "role">>(await database.execute(sql`SELECT id, status, role FROM users WHERE id = ${id} FOR SHARE`))[0];
}

export async function readWorkflowAuthorityMembership(userId: string, projectId: string, database?: MigrationDb): Promise<boolean> {
  if (!database) return Boolean(await getProjectMembership(userId, projectId));
  return releaseRows(await database.execute(sql`SELECT 1 FROM project_members WHERE user_id = ${userId} AND project_id = ${projectId} FOR SHARE`)).length > 0;
}
