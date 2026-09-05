import type { MigrationDb } from "../db/migrations/types";
import type { CachedWorkflow } from "../runtime/workflow-scope";
import { workflowReleaseCanExecute, type WorkflowExecutionAuthority } from "../runtime/workflow-release-assets";
import type { InvocationGuard } from "./runtime-locks";
import { readWorkflowAuthorityRun } from "../db/queries/workflow-authority";
import { workflowExecutionHash } from "../runtime/workflow-definition-hash";

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
  const captured = Object.freeze({ ...authority });
  const definitionHash = workflowExecutionHash(entry.definition, entry.extensionRelease);
  const assertRun = async (database?: MigrationDb) => {
    const row = await readWorkflowAuthorityRun(workflowRunId, database);
    const parentRunId = "parentRunId" in captured ? captured.parentRunId : null;
    if (row?.status !== "running" || row.userId || row.runAsKind !== "service" || row.runAs !== captured.runAs || row.delegationId !== captured.delegationId || row.projectId !== (captured.projectId ?? null) || row.workflowName !== entry.definition.name || row.definitionHash !== definitionHash || row.parentRunId !== (parentRunId ?? null)) throw new Error("Service invocation does not match its persisted workflow run");
  };
  let closed = false;
  const assertActive = async (database?: MigrationDb) => {
    if (closed) throw new Error("Service invocation is closed");
    await assertRun(database);
    await guard?.(database);
    if (!await workflowReleaseCanExecute(entry, captured, database)) throw new Error("Service delegation authority is no longer available");
    if (!database) await assertRun();
    if (closed) throw new Error("Service invocation is closed");
  };
  await assertActive();
  const proof: ServiceInvocation = Object.freeze({ serviceId: authority.runAs, delegationId: authority.delegationId, workflowRunId, projectId: authority.projectId ?? null, sourceInstallationId: entry.extensionRelease.installationId, sourceReleaseBinding: entry.extensionRelease.binding, consenterId: entry.extensionRelease.ownerId, assertActive, close() { closed = true; } });
  issued.add(proof);
  return proof;
}
