import { randomUUID } from "node:crypto";
import { getSandboxController } from "../../runtime/sandbox/controller";
import { getDb, type Database, type DbTransaction } from "../../db/connection";
import { sql } from "drizzle-orm";
import { releaseRows } from "../../db/queries/extension-releases";
import { exportSnapshotFromSandbox, importSnapshotToSandbox } from "./provider-transfer";
import type { ValidatedSnapshot } from "./snapshot";

export interface PersonalPrWorkspaceStatus {
  projectId: string;
  kind: "legacy" | "incus";
  bindingId: string;
  privateOwnerOnly?: boolean;
  initializationState?: "pending" | "importing" | "ready" | "failed";
  privateConversationId?: string | null;
  provider: { generation: number };
  resource: { resourceId: string; observedState: string } | null;
  operation: { id: string; action: string; state: string } | null;
  authority?: Readonly<Record<string, unknown>>;
}
export interface WorkspacePublicationIdentity {
  bindingId: string; generation: number; resourceId: string; workspaceRevision: number;
  conversationId: string; authority: Readonly<Record<string, unknown>>;
}

/** Only the workspace operations the existing personal PR service consumes. */
export interface PersonalPrWorkspace {
  status(): Promise<PersonalPrWorkspaceStatus>;
  forRun(conversationId: string): Promise<PersonalPrWorkspaceStatus>;
  assertPublication?(transaction: DbTransaction, identity: WorkspacePublicationIdentity): Promise<void>;
  importSnapshot(operationId: string, expected: PersonalPrWorkspaceStatus, snapshot: ValidatedSnapshot,
    imported: (status: PersonalPrWorkspaceStatus) => Promise<void>): Promise<void>;
  prepareReview(): Promise<PersonalPrWorkspaceStatus>;
  capture(conversationId: string): Promise<ValidatedSnapshot>;
  canReview(status: PersonalPrWorkspaceStatus): boolean;
}

/** Preserve the legacy private-resource lifecycle and transfer contract. */
export function legacyPersonalPrWorkspace(userId: string, projectId: string): PersonalPrWorkspace {
  const controller = getSandboxController();
  const status = async (): Promise<PersonalPrWorkspaceStatus> => ({ ...await controller.getProjectSandboxStatus(userId, projectId), kind: "legacy" });
  return {
    status,
    forRun: status,
    async importSnapshot(operationId, expected, snapshot, imported) {
      await controller.runPrivateWorkspaceImport(userId, projectId, operationId, async () => {
        const created = { ...await controller.executeAdmittedLocalSandboxOperation(userId, expected.operation!.id), kind: "legacy" as const };
        if (created.resource?.observedState !== "stopped" || created.bindingId !== expected.bindingId) throw new Error("Private sandbox could not be created");
        await importSnapshotToSandbox(controller, userId, projectId, snapshot);
        await imported(created);
      });
    },
    async prepareReview() {
      const current = await status();
      if (current.resource?.observedState !== "running") return current;
      const stop = await controller.requestSandboxAction(userId, projectId, { action: "stop", idempotencyKey: randomUUID() });
      return { ...await controller.executeAdmittedLocalSandboxOperation(userId, stop.id), kind: "legacy" };
    },
    capture: conversationId => exportSnapshotFromSandbox(controller, userId, projectId, conversationId),
    canReview: current => current.resource?.observedState === "stopped",
  };
}

export async function getPersonalPrWorkspace(userId: string, projectId: string, database: Database = getDb()): Promise<PersonalPrWorkspace> {
  const [source] = releaseRows<{ workspace_authority: unknown }>(await database.execute(sql`
    SELECT workspace_authority FROM github_personal_pr_imports WHERE project_id=${projectId}`));
  if (source?.workspace_authority != null) {
    const { incusPersonalPrWorkspace } = await import("./incus-workspace-service");
    return incusPersonalPrWorkspace(userId, projectId);
  }
  return legacyPersonalPrWorkspace(userId, projectId);
}
