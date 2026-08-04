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
import { delegationPrincipal } from "$server/runtime/workflow-delegation-consent";
import {
  computeDelegationConsentRecord,
  type DelegationConsentRecord as SharedConsentRecord,
} from "$server/runtime/workflow-delegation-record";
import type { ConsentHashMaterial } from "$server/runtime/workflow-capability-hash";
import type { CachedWorkflow } from "$server/runtime/workflow-scope";
import type { DelegationOwnerKind } from "$server/db/schema";

export interface DelegationConsentRequest {
  /** Already authorized for the delegation's principal by the caller. */
  entry: CachedWorkflow;
  /** Registry-resolved, never off the wire. */
  extensionName: string;
  workflowName: string;
  projectId: string | null;
  ownerKind: DelegationOwnerKind;
  ownerId: string;
  trigger: { kind: string; spec: unknown };
}

export interface DelegationConsentRecord {
  definitionVersionId: string | null;
  consentHash: string;
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
  const record: SharedConsentRecord = await computeDelegationConsentRecord({
    entry: request.entry,
    extensionName: request.extensionName,
    workflowName: request.workflowName,
    projectId: request.projectId,
    runAs: { kind: request.ownerKind, id: request.ownerId },
    trigger: request.trigger,
    principal: delegationPrincipal(request.ownerKind, request.ownerId),
    entries: getCachedWorkflows(),
    agents: getExecutor().listAgents(),
  });
  if (!record.pin.ok) return errorJson(409, record.pin.message);
  return {
    definitionVersionId: record.pin.definitionVersionId,
    consentHash: record.consentHash,
    capabilitySet: record.capabilitySet,
    material: record.material,
  };
}
