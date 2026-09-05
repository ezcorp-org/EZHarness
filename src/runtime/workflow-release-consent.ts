import { canonicalJson } from "@ezcorp/extension-contract";
import type { CachedWorkflow } from "./workflow-scope";

export type WorkflowReleaseStamp = NonNullable<CachedWorkflow["extensionRelease"]>;
export interface WorkflowConsentOrigin {
  release: WorkflowReleaseStamp;
  workflowName: string;
  ownerKind: "user" | "service";
  ownerId: string;
  projectId: string | null;
}
export interface WorkflowConsentRelease { release: WorkflowReleaseStamp; workflows: string[] }
export type WorkflowReleaseConsent = { version: 1 } & WorkflowConsentRelease | { version: 2; origin: WorkflowConsentOrigin; releases: WorkflowConsentRelease[] };
export const MAX_WORKFLOW_CONSENT_BYTES = 65536;
export const MAX_WORKFLOW_CONSENT_RELEASES = 32;
export const MAX_WORKFLOW_CONSENT_NAMES = 256;

function record(value: unknown, keys: string[]): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("\0") === keys.sort().join("\0"));
}
function text(value: unknown, maximum = 256): value is string { return typeof value === "string" && value.length > 0 && value.length <= maximum; }
function stamp(value: unknown): value is WorkflowReleaseStamp {
  return record(value, ["installationId", "binding", "ownerId", "scope"]) && text(value.installationId) && text(value.binding, MAX_WORKFLOW_CONSENT_BYTES) && text(value.ownerId) && text(value.scope) && (value.scope === "global" || value.scope.startsWith("project:") && value.scope.length > 8);
}
function names(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_WORKFLOW_CONSENT_NAMES && value.every(name => text(name)) && JSON.stringify(value) === JSON.stringify([...new Set(value)].sort());
}
function release(value: unknown): value is WorkflowConsentRelease {
  return record(value, ["release", "workflows"]) && stamp(value.release) && names(value.workflows);
}

export function parseWorkflowReleaseConsent(binding: string | null | undefined): WorkflowReleaseConsent | null {
  if (!binding || new TextEncoder().encode(binding).byteLength > MAX_WORKFLOW_CONSENT_BYTES) return null;
  try {
    const value: unknown = JSON.parse(binding);
    if (canonicalJson(value) !== binding) return null;
    if (record(value, ["version", "release", "workflows"]) && value.version === 1 && stamp(value.release) && names(value.workflows)) return value as unknown as WorkflowReleaseConsent;
    if (!record(value, ["version", "origin", "releases"]) || value.version !== 2) return null;
    const origin = value.origin;
    if (!record(origin, ["release", "workflowName", "ownerKind", "ownerId", "projectId"]) || !stamp(origin.release) || !text(origin.workflowName) || !text(origin.ownerId) || origin.ownerKind !== "user" && origin.ownerKind !== "service" || origin.projectId !== null && !text(origin.projectId)) return null;
    if (!Array.isArray(value.releases) || value.releases.length > MAX_WORKFLOW_CONSENT_RELEASES || !value.releases.every(release)) return null;
    const identifiers = value.releases.map(entry => entry.release.installationId);
    const workflowNames = value.releases.flatMap(entry => entry.workflows);
    if (JSON.stringify(identifiers) !== JSON.stringify([...new Set(identifiers)].sort()) || workflowNames.length > MAX_WORKFLOW_CONSENT_NAMES || new Set(workflowNames).size !== workflowNames.length) return null;
    return value as unknown as WorkflowReleaseConsent;
  } catch { return null; }
}

function serialize(value: WorkflowReleaseConsent): string {
  const binding = canonicalJson(value);
  if (!parseWorkflowReleaseConsent(binding)) throw new Error("Workflow release consent is invalid or exceeds its bounds.");
  return binding;
}

export function buildWorkflowReleaseConsent(origin: WorkflowConsentOrigin, entries: readonly CachedWorkflow[]): string {
  const grouped = new Map<string, WorkflowConsentRelease>();
  for (const entry of entries) {
    if (entry.source !== "extension") continue;
    if (!entry.extensionRelease) throw new Error("Workflow release consent requires a sealed extension binding.");
    const previous = grouped.get(entry.extensionRelease.installationId);
    if (previous && canonicalJson(previous.release) !== canonicalJson(entry.extensionRelease)) throw new Error("Workflow release changed during consent.");
    const group = previous ?? { release: entry.extensionRelease, workflows: [] };
    group.workflows.push(entry.definition.name);
    grouped.set(entry.extensionRelease.installationId, group);
  }
  const releases = [...grouped.keys()].sort().map(identifier => grouped.get(identifier)!);
  for (const group of releases) group.workflows = [...new Set(group.workflows)].sort();
  return serialize({ version: 2, origin, releases });
}

export function workflowDelegationReleaseBinding(entry: CachedWorkflow, workflowNames: readonly string[] = [entry.definition.name]): string | null {
  return entry.extensionRelease ? serialize({ version: 1, release: entry.extensionRelease, workflows: [...new Set(workflowNames)].sort() }) : null;
}

export function workflowDelegationReleaseAllows(entry: CachedWorkflow, binding: string | null | undefined): boolean {
  if (entry.source !== "extension" || !entry.extensionRelease) return false;
  const consent = parseWorkflowReleaseConsent(binding);
  const releases = consent?.version === 1 ? [consent] : consent?.releases ?? [];
  return releases.some(group => group.workflows.includes(entry.definition.name) && canonicalJson(group.release) === canonicalJson(entry.extensionRelease));
}
