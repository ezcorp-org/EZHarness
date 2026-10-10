import { sql } from "drizzle-orm";
import type { MigrationDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";

/** Shared order: project, installation, run, then lifecycle/budget/journal rows.
 * Request the final installation lock mode immediately; never upgrade SHARE.
 */
export async function lockFactoryScope(transaction: MigrationDb, tenantId: string, projectId: string, installationMode: "read" | "write" = "read"): Promise<{ executionEpoch: number } | null> {
  const project = rows(await transaction.execute(sql`SELECT project_id FROM factory_projects WHERE tenant_id=${tenantId} AND project_id=${projectId} FOR SHARE`))[0];
  if (!project) return null;
  const installation = rows<{ execution_epoch: number }>(await transaction.execute(sql`SELECT execution_epoch FROM factory_installation WHERE tenant_id=${tenantId} ${installationMode === "write" ? sql`FOR UPDATE` : sql`FOR SHARE`}`))[0];
  return installation && Number.isSafeInteger(installation.execution_epoch) && installation.execution_epoch > 0 ? { executionEpoch: installation.execution_epoch } : null;
}
