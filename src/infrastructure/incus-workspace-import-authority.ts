import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import { getDb, type Database } from "../db/connection";
import { releaseRows } from "../db/queries/extension-releases";
import type { WorkspaceGuestAction } from "../runtime/workspaces/provider-backend";

interface ImportIdentity {
  ownerId: string;
  projectId: string;
  operationId: string;
}
interface ImportContext extends ImportIdentity {
  active: boolean;
  permits: (action: WorkspaceGuestAction, payload: Readonly<Record<string, unknown>>) => boolean;
  observed?: (action: WorkspaceGuestAction, payload: Readonly<Record<string, unknown>>, result: unknown) => void;
}
const admittedImport = new AsyncLocalStorage<ImportContext>();

/** Host transfer code only. The predicate admits its fixed import commands, never model callbacks. */
export async function withIncusWorkspaceImportAuthority<T>(
  identity: ImportIdentity,
  permits: ImportContext["permits"],
  work: () => Promise<T>,
  observed?: ImportContext["observed"],
): Promise<T> {
  const context: ImportContext = { ...identity, permits, observed, active: true };
  try { return await admittedImport.run(context, work); }
  finally { context.active = false; }
}

/** Rechecked at actual provider dispatch, including calls that waited during admission. */
export async function assertIncusWorkspaceImportAuthority(input: {
  projectId: string;
  userId?: string;
  action: WorkspaceGuestAction;
  payload: Readonly<Record<string, unknown>>;
}, database: Database = getDb()): Promise<void> {
  const result = await database.execute(sql`SELECT source.owner_id,source.state,source.operation_id,source.workspace_authority,
    (SELECT count(*) FROM project_members member WHERE member.project_id=source.project_id) AS member_count,
    EXISTS (SELECT 1 FROM project_members member WHERE member.project_id=source.project_id
      AND member.user_id=source.owner_id AND member.role='owner') AS owner_member
    FROM github_personal_pr_imports source WHERE source.project_id=${input.projectId}`);
  const found = releaseRows<Record<string, unknown>>(result);
  if (found.length > 1) throw new Error("Repository workspace authority is ambiguous");
  const row = found[0];
  // Legacy private workspaces have their own admission controller.
  if (!row || row.workspace_authority == null) return;
  if (!input.userId || input.userId !== row.owner_id) throw new Error("Private repository workspace belongs to another user");
  if (Number(row.member_count) !== 1 || row.owner_member !== true) {
    throw new Error("Private repository workspace membership changed");
  }
  if (row.state === "ready") return;
  const current = admittedImport.getStore();
  if (row.state !== "importing" || !current?.active || current.ownerId !== input.userId
    || current.projectId !== input.projectId || current.operationId !== row.operation_id
    || !current.permits(input.action, input.payload)) {
    throw new Error("Repository import must finish before using this workspace");
  }
}

/** Validated provider replies only; records process identity inside the still-active host import scope. */
export function recordIncusWorkspaceImportResult(input: {
  projectId: string; userId?: string; action: WorkspaceGuestAction; payload: Readonly<Record<string, unknown>>;
}, result: unknown): void {
  const current = admittedImport.getStore();
  if (current?.active && current.ownerId === input.userId && current.projectId === input.projectId
    && current.permits(input.action, input.payload)) current.observed?.(input.action, input.payload, result);
}
