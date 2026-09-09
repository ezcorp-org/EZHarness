/**
 * The ROUTE-SHAPED half of a C3 consent record.
 *
 * The route stays thin on purpose. Not for tidiness: `workflow-access.ts`
 * carries a grep contract (`workflow-route-ladder.server.test.ts`) that
 * no handler under `routes/api/workflows/**` may read the merged cache or
 * resolve a name itself, because *"reading it in a handler is how a
 * lookup ends up unauthorized"*. A consent route that assembled its own
 * closure would be doing exactly that, one indirection further down.
 *
 * ## Everything substantive moved to `src/`
 *
 * The four `ConsentHashSources` and the assembly around them now live in
 * `$server/runtime/workflow-delegation-record`, because the hash is
 * computed twice — here at consent time, and again at every fire by the
 * delegated `runFor` ladder, which runs in `src/` and cannot import this
 * file. A fire-time source set that differed from consent's by one entry
 * would stale every fire of a delegation that nobody could then
 * re-consent, because the re-consent would recompute the same stale
 * value. So there is ONE assembly and both callers import it.
 *
 * What is left here is the part that is genuinely a route's business:
 * turning a version divergence into a 409, and reading the live agent
 * list off this layer's executor.
 */
import { getCachedWorkflows, getExecutor } from "$lib/server/context";
import { errorJson } from "$lib/server/http-errors";
import { delegationPrincipal, delegationWorkflowResolver } from "$server/runtime/workflow-delegation-consent";
import {
  computeDelegationConsentRecord,
  type DelegationConsentRecord as SharedConsentRecord,
} from "$server/runtime/workflow-delegation-record";
import type { ConsentHashMaterial } from "$server/runtime/workflow-capability-hash";
import type { CachedWorkflow } from "$server/runtime/workflow-scope";
import type { DelegationOwnerKind } from "$server/db/schema";
import { captureWorkflowConsentOrigin, filterAccessibleWorkflowEntries, workflowReleaseCanAccess, workflowReleaseCanConsentService } from "$server/runtime/workflow-release-assets";
import { buildWorkflowReleaseConsent, type WorkflowConsentOrigin } from "$server/runtime/workflow-release-consent";
import { canonicalJson } from "@ezcorp/extension-contract";

export interface DelegationConsentRequest {
  originInstallationId: string;
  /** Already authorized for the delegation's principal by the caller. */
  entry: CachedWorkflow;
  /** Registry-resolved, never off the wire. */
  extensionName: string;
  workflowName: string;
  projectId: string | null;
  ownerKind: DelegationOwnerKind;
  ownerId: string;
  consenterId?: string;
  trigger: { kind: string; spec: unknown };
}

export interface DelegationConsentRecord {
  extensionReleaseBinding: string | null;
  definitionVersionId: string | null;
  /** The SEMANTIC digest — `workflow_delegations.consent_hash`. */
  consentHash: string;
  /** The ADVISORY graph digest — `workflow_delegations.definition_hash`.
   *  Written at consent time so the first delegated fire has something to
   *  compare against; a change to it alone never parks a run. */
  definitionHash: string;
  capabilitySet: Array<{ kind: string; value: string | null }>;
  material: ConsentHashMaterial;
}

/**
 * Build the consent record for a delegation, or the Response the route
 * should send.
 *
 * The one decision made here rather than in the shared assembly is what a
 * version divergence MEANS to an HTTP caller: a 409 naming the remedy
 * ("save the workflow again, then re-consent"). The fire-time caller
 * renders the same `pin` failure as a typed RPC denial instead, and
 * neither may invent a second rule about when a pin is legal.
 */
export async function buildDelegationConsent(
  request: DelegationConsentRequest,
): Promise<DelegationConsentRecord | Response> {
  const principalId = request.ownerKind === "user" ? request.ownerId : request.consenterId ?? null;
  if (!principalId) return errorJson(404, "Workflow is not available to this principal.");
  let origin: WorkflowConsentOrigin;
  try {
    origin = await captureWorkflowConsentOrigin(request.originInstallationId, request.workflowName, request.ownerKind, request.ownerId, principalId, request.projectId);
  } catch { return errorJson(404, "Workflow is not available to this principal."); }
  if (request.ownerKind === "service" && !await workflowReleaseCanConsentService(request.entry, request.ownerId, principalId, request.projectId)) return errorJson(404, "Workflow is not available to this principal.");
  if (!await workflowReleaseCanAccess(request.entry, principalId, request.projectId)) return errorJson(404, "Workflow is not available to this principal.");
  const accessible = await filterAccessibleWorkflowEntries(getCachedWorkflows(), principalId, request.projectId);
  const entries: CachedWorkflow[] = [];
  for (const entry of accessible) if (request.ownerKind !== "service" || await workflowReleaseCanConsentService(entry, request.ownerId, principalId, request.projectId)) entries.push(entry);
  const principal = delegationPrincipal(request.ownerKind, request.ownerId);
  const resolve = delegationWorkflowResolver(entries, principal);
  const record: SharedConsentRecord = await computeDelegationConsentRecord({
    entry: request.entry,
    extensionName: request.extensionName,
    workflowName: request.workflowName,
    projectId: request.projectId,
    runAs: { kind: request.ownerKind, id: request.ownerId },
    trigger: request.trigger,
    principal,
    workflowResolver: name => request.ownerKind === "service" ? entries.find(entry => entry.source === "extension" && entry.definition.name === name)?.definition ?? resolve(name) : resolve(name),
    entries,
    agents: getExecutor().listAgents(),
  });
  const includedNames = new Set(record.material.graph.map(entry => entry.name));
  const usedEntries = new Set([request.entry, ...entries.filter(entry => includedNames.has(entry.definition.name))]);
  for (const entry of usedEntries) if (!await workflowReleaseCanAccess(entry, principalId, request.projectId) || request.ownerKind === "service" && !await workflowReleaseCanConsentService(entry, request.ownerId, principalId, request.projectId)) return errorJson(404, "Workflow is not available to this principal.");
  if (request.ownerKind === "service" && !await workflowReleaseCanConsentService(request.entry, request.ownerId, principalId, request.projectId)) return errorJson(404, "Workflow is not available to this principal.");
  if (!record.pin.ok) return errorJson(409, record.pin.message);
  try {
    const currentOrigin = await captureWorkflowConsentOrigin(request.originInstallationId, request.workflowName, request.ownerKind, request.ownerId, principalId, request.projectId);
    if (canonicalJson(currentOrigin) !== canonicalJson(origin)) return errorJson(404, "Workflow is not available to this principal.");
  } catch { return errorJson(404, "Workflow is not available to this principal."); }
  let extensionReleaseBinding: string;
  try { extensionReleaseBinding = buildWorkflowReleaseConsent(origin, [...usedEntries]); }
  catch { return errorJson(400, "Workflow release consent exceeds its bounds or changed during review."); }
  return {
    extensionReleaseBinding,
    definitionVersionId: record.pin.definitionVersionId,
    consentHash: record.consentHash,
    definitionHash: record.definitionHash,
    capabilitySet: record.capabilitySet,
    material: record.material,
  };
}
