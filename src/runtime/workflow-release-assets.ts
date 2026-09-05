import { canonicalJson, sha256, validateArtifactFiles } from "@ezcorp/extension-contract";
import { getReleaseRuntime, releaseBinding, resolveActiveRelease, type ReleaseRuntimeDependencies } from "../extensions/release-process";
import type { ExtensionRegistry } from "../extensions/registry";
import { loadExtensionWorkflowFiles } from "./workflow-extension-loader";
import type { CachedWorkflow } from "./workflow-scope";
import { getUserById } from "../db/queries/users";
import { getProjectMembership } from "../db/queries/project-members";

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

export async function workflowReleaseIsCurrent(entry: CachedWorkflow, runtime?: ReleaseRuntimeDependencies): Promise<boolean> {
  if (entry.source !== "extension") return true;
  const bound = entry.extensionRelease;
  if (!bound) return false;
  try {
    const snapshot = await resolveActiveRelease(bound.installationId, runtime ?? getReleaseRuntime());
    return releaseBinding(snapshot) === bound.binding && snapshot.installation.ownerId === bound.ownerId && snapshot.installation.scope === bound.scope;
  } catch {
    return false;
  }
}

export async function workflowReleaseCanAccess(entry: CachedWorkflow, principalId: string | null, projectId?: string | null): Promise<boolean> {
  if (!entry.extensionRelease) return entry.source !== "extension";
  if (!principalId || !await workflowReleaseIsCurrent(entry)) return false;
  const bound = entry.extensionRelease;
  const [owner, caller] = await Promise.all([getUserById(bound.ownerId), getUserById(principalId)]);
  if (owner?.status !== "active" || caller?.status !== "active" || (caller.id !== owner.id && caller.role !== "admin")) return false;
  if (bound.scope === "global") return workflowReleaseIsCurrent(entry);
  if (!bound.scope.startsWith("project:") || bound.scope.slice(8) !== projectId) return false;
  if (owner.role !== "admin" && !await getProjectMembership(owner.id, projectId!)) return false;
  if (caller.role !== "admin" && !await getProjectMembership(caller.id, projectId!)) return false;
  return workflowReleaseIsCurrent(entry);
}

export async function filterAccessibleWorkflowEntries(entries: readonly CachedWorkflow[], principalId: string | null, projectId?: string | null): Promise<CachedWorkflow[]> {
  const allowed = await Promise.all(entries.map(entry => entry.source !== "extension" || workflowReleaseCanAccess(entry, principalId, projectId)));
  return entries.filter((_entry, index) => allowed[index]);
}
