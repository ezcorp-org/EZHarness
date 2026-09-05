import { canonicalJson, sha256, validateArtifactFiles } from "@ezcorp/extension-contract";
import { getReleaseRuntime, releaseBinding, resolveActiveRelease, type ReleaseRuntimeDependencies } from "../extensions/release-process";
import type { ExtensionRegistry } from "../extensions/registry";
import { loadExtensionWorkflowFiles } from "./workflow-extension-loader";
import { workflowDelegationReleaseAllows, type CachedWorkflow } from "./workflow-scope";
export { workflowDelegationReleaseBinding } from "./workflow-scope";
import { readWorkflowAuthorityUser, readWorkflowAuthorityMembership } from "../db/queries/workflow-authority";
import { getWorkflowDelegation } from "../db/queries/workflow-delegations";
import { findLiveServiceAccount } from "../db/queries/service-accounts";
import type { MigrationDb } from "../db/migrations/types";
import { sql } from "drizzle-orm";
import { releaseRows } from "../db/queries/extension-releases";

async function canExecuteInProject(principalId: string, projectId: string | null | undefined, database?: MigrationDb): Promise<boolean> {
  if (!projectId) return true;
  const user = await readWorkflowAuthorityUser(principalId, database);
  return user?.status === "active" && (user.role === "admin" || await readWorkflowAuthorityMembership(user.id, projectId, database));
}

export async function workflowReleaseCanConsentService(entry: CachedWorkflow, serviceId: string, consenterId: string | null, projectId?: string | null, database?: MigrationDb): Promise<boolean> {
  if (entry.source !== "extension") return true;
  if (!entry.extensionRelease || consenterId !== entry.extensionRelease.ownerId) return false;
  const readService = async () => database ? releaseRows<{ projectId: string | null }>(await database.execute(sql`SELECT project_id AS "projectId" FROM service_accounts WHERE id=${serviceId} AND enabled=true FOR SHARE`))[0] : await findLiveServiceAccount(serviceId);
  const service = await readService();
  if (!service || (service.projectId !== null && service.projectId !== projectId)) return false;
  if (!await workflowReleaseCanAccess(entry, consenterId, projectId, database)) return false;
  if (!await canExecuteInProject(consenterId, projectId, database)) return false;
  const current = await readService();
  return Boolean(current && current.projectId === service.projectId && await workflowReleaseIsCurrent(entry, undefined, database));
}

export interface WorkflowExecutionAuthority {
  userId?: string | null;
  projectId?: string | null;
  delegationId?: string | null;
  runAsKind?: string | null;
  runAs?: string | null;
}

export async function workflowReleaseCanExecute(entry: CachedWorkflow, authority: WorkflowExecutionAuthority, database?: MigrationDb): Promise<boolean> {
  if (entry.source !== "extension") return true;
  if (authority.runAsKind !== "service") return await workflowReleaseCanAccess(entry, authority.userId ?? null, authority.projectId, database) && await canExecuteInProject(authority.userId!, authority.projectId, database) && await workflowReleaseIsCurrent(entry, undefined, database);
  if (!entry.extensionRelease || authority.userId || !authority.delegationId || !authority.runAs) return false;
  const readDelegation = async () => database ? releaseRows<Pick<NonNullable<Awaited<ReturnType<typeof getWorkflowDelegation>>>, "id" | "enabled" | "revokedAt" | "ownerKind" | "ownerServiceAccountId" | "workflowName" | "projectId" | "extensionId" | "extensionReleaseBinding" | "consentedByUserId">>(await database.execute(sql`SELECT id, enabled, revoked_at AS "revokedAt", owner_kind AS "ownerKind", owner_service_account_id AS "ownerServiceAccountId", workflow_name AS "workflowName", project_id AS "projectId", extension_id AS "extensionId", extension_release_binding AS "extensionReleaseBinding", consented_by_user_id AS "consentedByUserId" FROM workflow_delegations WHERE id=${authority.delegationId} FOR SHARE`))[0] : await getWorkflowDelegation(authority.delegationId!);
  const delegation = await readDelegation();
  const matches = (row: Awaited<ReturnType<typeof readDelegation>>) => row?.enabled && !row.revokedAt && row.ownerKind === "service" && row.ownerServiceAccountId === authority.runAs && row.projectId === (authority.projectId ?? null) && row.extensionId === entry.extensionRelease!.installationId && workflowDelegationReleaseAllows(entry, row.extensionReleaseBinding);
  if (!delegation || !matches(delegation)) return false;
  if (!await workflowReleaseCanConsentService(entry, authority.runAs, delegation.consentedByUserId, authority.projectId, database)) return false;
  const current = await readDelegation();
  return Boolean(current && matches(current) && current.extensionReleaseBinding === delegation.extensionReleaseBinding && current.consentedByUserId === delegation.consentedByUserId && current.workflowName === delegation.workflowName && await workflowReleaseIsCurrent(entry, undefined, database));
}

async function readReleaseArtifacts(installationId: string, releaseId: string) {
  const { getExtensionReleaseArtifacts } = await import("../extensions/extension-lifecycle-service");
  return getExtensionReleaseArtifacts(installationId, releaseId);
}

export async function loadReleaseWorkflowEntries(registry: Pick<ExtensionRegistry, "getAllManifests">, runtime = getReleaseRuntime(), readArtifacts = readReleaseArtifacts): Promise<CachedWorkflow[]> {
  const entries: CachedWorkflow[] = [];
  for (const [installationId, manifest] of registry.getAllManifests()) {
    if (Number(manifest.schemaVersion) !== 4) continue;
    const snapshot = await runtime.resolve(installationId);
    if (!snapshot?.installation.enabled || snapshot.installation.uninstalled || snapshot.installation.id !== installationId || snapshot.release.installationId !== installationId || snapshot.installation.activeReleaseId !== snapshot.release.id) continue;
    if (canonicalJson(snapshot.release.manifest) !== canonicalJson(manifest)) continue;
    const binding = releaseBinding(snapshot);
    const files = validateArtifactFiles(await readArtifacts(installationId, snapshot.release.id));
    if (await sha256(canonicalJson(files)) !== snapshot.release.artifactDigest) throw new Error("Workflow release artifact digest mismatch.");
    const source: Record<string, string> = Object.create(null);
    for (const [path, content] of Object.entries(files)) {
      if (path.includes("/") || !path.endsWith(".workflow.yaml")) continue;
      if (typeof content !== "string") throw new Error("Workflow assets must be text.");
      source[path] = content;
    }
    const current = await runtime.resolve(installationId);
    if (!current || releaseBinding(current) !== binding || !current.installation.enabled || current.installation.uninstalled) throw new Error("Workflow release changed during discovery.");
    const installation = snapshot.installation;
    for (const definition of loadExtensionWorkflowFiles(manifest.name, source)) {
      entries.push({ definition, source: "extension", id: null, userId: installation.ownerId, projectId: installation.scope.startsWith("project:") ? installation.scope.slice(8) : null, visibility: "private", forkedFrom: null, extensionRelease: { installationId, binding, ownerId: installation.ownerId, scope: installation.scope } });
    }
  }
  return entries;
}

export async function workflowReleaseIsCurrent(entry: CachedWorkflow, runtime?: ReleaseRuntimeDependencies, database?: MigrationDb): Promise<boolean> {
  if (entry.source !== "extension") return true;
  const bound = entry.extensionRelease;
  if (!bound) return false;
  try {
    const snapshot = await resolveActiveRelease(bound.installationId, runtime ?? getReleaseRuntime(), database);
    return releaseBinding(snapshot) === bound.binding && snapshot.installation.ownerId === bound.ownerId && snapshot.installation.scope === bound.scope;
  } catch {
    return false;
  }
}

export async function workflowReleaseCanAccess(entry: CachedWorkflow, principalId: string | null, projectId?: string | null, database?: MigrationDb): Promise<boolean> {
  if (!entry.extensionRelease) return entry.source !== "extension";
  if (!principalId || !await workflowReleaseIsCurrent(entry, undefined, database)) return false;
  const bound = entry.extensionRelease;
  const [owner, caller] = await Promise.all([readWorkflowAuthorityUser(bound.ownerId, database), readWorkflowAuthorityUser(principalId, database)]);
  if (owner?.status !== "active" || caller?.status !== "active" || (caller.id !== owner.id && caller.role !== "admin")) return false;
  if (bound.scope === "global") return workflowReleaseIsCurrent(entry, undefined, database);
  if (!bound.scope.startsWith("project:") || bound.scope.slice(8) !== projectId) return false;
  if (owner.role !== "admin" && !await readWorkflowAuthorityMembership(owner.id, projectId!, database)) return false;
  if (caller.role !== "admin" && !await readWorkflowAuthorityMembership(caller.id, projectId!, database)) return false;
  return workflowReleaseIsCurrent(entry, undefined, database);
}

export async function filterAccessibleWorkflowEntries(entries: readonly CachedWorkflow[], principalId: string | null, projectId?: string | null): Promise<CachedWorkflow[]> {
  const allowed = await Promise.all(entries.map(entry => entry.source !== "extension" || workflowReleaseCanAccess(entry, principalId, projectId)));
  return entries.filter((_entry, index) => allowed[index]);
}
