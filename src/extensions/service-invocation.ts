import type { MigrationDb } from "../db/migrations/types";
import type { CachedWorkflow } from "../runtime/workflow-scope";
import { workflowReleaseCanExecute, type WorkflowExecutionAuthority } from "../runtime/workflow-release-assets";
import type { InvocationGuard } from "./runtime-locks";

export interface ServiceInvocation {
  readonly serviceId: string;
  readonly delegationId: string;
  readonly workflowRunId: string;
  readonly projectId: string | null;
  readonly sourceInstallationId: string;
  readonly sourceReleaseBinding: string;
  readonly consenterId: string;
  assertActive(database?: MigrationDb): Promise<void>;
  close(): void;
}

const issued = new WeakSet<object>();

export function isServiceInvocation(value: unknown): value is ServiceInvocation {
  return typeof value === "object" && value !== null && issued.has(value);
}

export async function createServiceInvocation(entry: CachedWorkflow, authority: WorkflowExecutionAuthority, workflowRunId: string, guard?: InvocationGuard): Promise<ServiceInvocation> {
  if (authority.runAsKind !== "service" || authority.userId || !authority.runAs || !authority.delegationId || !entry.extensionRelease) throw new Error("A service invocation requires a sealed service delegation");
  const { getWorkflowRunRow } = await import("../db/queries/workflow-runs");
  const row = await getWorkflowRunRow(workflowRunId);
  if (row?.status !== "running" || row.userId || row.runAsKind !== "service" || row.runAs !== authority.runAs || row.delegationId !== authority.delegationId || row.projectId !== (authority.projectId ?? null) || row.workflowName !== entry.definition.name) throw new Error("Service invocation does not match its persisted workflow run");
  const captured = Object.freeze({ ...authority });
  let closed = false;
  const assertActive = async (database?: MigrationDb) => {
    if (closed) throw new Error("Service invocation is closed");
    await guard?.(database);
    if (!await workflowReleaseCanExecute(entry, captured, database)) throw new Error("Service delegation authority is no longer available");
    if (closed) throw new Error("Service invocation is closed");
  };
  await assertActive();
  const proof: ServiceInvocation = Object.freeze({ serviceId: authority.runAs, delegationId: authority.delegationId, workflowRunId, projectId: authority.projectId ?? null, sourceInstallationId: entry.extensionRelease.installationId, sourceReleaseBinding: entry.extensionRelease.binding, consenterId: entry.extensionRelease.ownerId, assertActive, close() { closed = true; } });
  issued.add(proof);
  return proof;
}
