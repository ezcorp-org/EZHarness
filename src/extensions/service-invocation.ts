import type { MigrationDb } from "../db/migrations/types";
import type { CachedWorkflow } from "../runtime/workflow-scope";
import { resolveWorkflowServiceOrigin, workflowReleaseCanExecute, type WorkflowExecutionAuthority } from "../runtime/workflow-release-assets";
import type { InvocationGuard } from "./runtime-locks";
import { readWorkflowAuthorityRun } from "../db/queries/workflow-authority";
import { workflowExecutionHash } from "../runtime/workflow-definition-hash";

interface ServiceInvocationBase {
  readonly serviceId: string;
  readonly delegationId: string;
  readonly workflowRunId: string;
  readonly projectId: string | null;
  assertActive(database?: MigrationDb): Promise<void>;
  close(): void;
}

export interface SealedServiceInvocation extends ServiceInvocationBase {
  readonly kind: "sealed";
  readonly sourceInstallationId: string;
  readonly sourceReleaseBinding: string;
  readonly consenterId: string;
}

export interface HostServiceInvocation extends ServiceInvocationBase {
  readonly kind: "host";
}

export type ServiceInvocation = SealedServiceInvocation | HostServiceInvocation;

const issued = new WeakSet<object>();

export function isServiceInvocation(value: unknown): value is ServiceInvocation {
  return typeof value === "object" && value !== null && issued.has(value);
}

export function isSealedServiceInvocation(value: unknown): value is SealedServiceInvocation {
  return isServiceInvocation(value) && value.kind === "sealed";
}

async function createInvocation(entry: CachedWorkflow, authority: WorkflowExecutionAuthority, workflowRunId: string, guard: InvocationGuard | undefined, kind: "sealed" | "host"): Promise<ServiceInvocation> {
  if (authority.runAsKind !== "service" || authority.userId || !authority.runAs || !authority.delegationId) throw new Error("A service invocation requires a sealed service delegation");
  const captured = Object.freeze({ ...authority });
  const origin = await resolveWorkflowServiceOrigin(captured);
  if (kind === "sealed" ? !origin : origin || entry.source === "extension" || !await workflowReleaseCanExecute(entry, captured)) throw new Error("A service invocation requires a sealed service delegation");
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
    const currentOrigin = await resolveWorkflowServiceOrigin(captured, database);
    if (origin ? !currentOrigin || currentOrigin.consenterId !== origin.consenterId || currentOrigin.sourceInstallationId !== origin.sourceInstallationId || currentOrigin.sourceReleaseBinding !== origin.sourceReleaseBinding : currentOrigin) throw new Error("Service delegation origin is no longer available");
    if (!database) await assertRun();
    if (closed) throw new Error("Service invocation is closed");
  };
  await assertActive();
  const common = { serviceId: authority.runAs, delegationId: authority.delegationId, workflowRunId, projectId: authority.projectId ?? null, assertActive, close() { closed = true; } };
  const proof: ServiceInvocation = Object.freeze(origin ? { kind: "sealed", ...common, ...origin } : { kind: "host", ...common });
  issued.add(proof);
  return proof;
}


export async function createServiceInvocation(entry: CachedWorkflow, authority: WorkflowExecutionAuthority, workflowRunId: string, guard?: InvocationGuard): Promise<SealedServiceInvocation> {
  return await createInvocation(entry, authority, workflowRunId, guard, "sealed") as SealedServiceInvocation;
}

export async function createHostServiceInvocation(entry: CachedWorkflow, authority: WorkflowExecutionAuthority, workflowRunId: string, guard?: InvocationGuard): Promise<HostServiceInvocation> {
  return await createInvocation(entry, authority, workflowRunId, guard, "host") as HostServiceInvocation;
}
