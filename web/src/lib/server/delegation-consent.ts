/**
 * The web-side assembly of a C3 consent record: everything that has to
 * touch the DB, the extension registry or the agent registry before
 * `computeWorkflowConsentHash` — which is pure — can be called.
 *
 * The route stays thin on purpose. Not for tidiness: `workflow-access.ts`
 * carries a grep contract (`workflow-route-ladder.server.test.ts`) that
 * no handler under `routes/api/workflows/**` may read the merged cache or
 * resolve a name itself, because *"reading it in a handler is how a
 * lookup ends up unauthorized"*. A consent route that assembled its own
 * closure would be doing exactly that, one indirection further down.
 *
 * ## The capability lookups are the registry as it is TODAY
 *
 * `ConsentHashSources` draws a hard line between "reached the subject and
 * it declares nothing" and "could not reach the subject", and it hashes
 * the two differently on purpose (T11). Both lookups below honour that
 * line, and both are exported so C3's fire-time recompute uses THESE and
 * not a second pair — a recompute whose sources differ from consent's by
 * one entry stales every fire of a delegation that nobody can then
 * re-consent, because the re-consent would compute the same stale value
 * again.
 */
import { ExtensionRegistry } from "$server/extensions/registry";
import { grantsToCapabilitySet } from "$server/extensions/capability-types";
import { getCachedWorkflows, getExecutor } from "$lib/server/context";
import { getWorkflowByName } from "$server/db/queries/workflows";
import { getLatestWorkflowVersion } from "$server/db/queries/workflow-versions";
import { errorJson } from "$lib/server/http-errors";
import {
  buildConsentHashSources,
  delegationPrincipal,
  delegationVersionIdentity,
  delegationWorkflowResolver,
  resolveDelegationVersionPin,
  type DelegationVersionCandidate,
} from "$server/runtime/workflow-delegation-consent";
import {
  computeWorkflowConsentHash,
  type ConsentCapability,
  type ConsentHashMaterial,
  type WorkflowVersionIdentity,
} from "$server/runtime/workflow-capability-hash";
import { collectWorkflowClosure } from "$server/runtime/workflow-closure";
import type { CachedWorkflow } from "$server/runtime/workflow-scope";
import type { DelegationOwnerKind } from "$server/db/schema";
import type { WorkflowDefinition } from "$server/types";

/**
 * An extension tool's declared capabilities, or `undefined` when the
 * registry cannot reach the tool at all.
 *
 * Reachability is `getRegisteredTool`, which is the SAME map the
 * dispatcher resolves a call through — so "the hash can see it" and "a
 * step could invoke it" are one fact rather than two that agree today.
 * An extension that narrows its manifest until a step's tool drops out of
 * that map has changed what the workflow does, and the `tool:unreachable`
 * marker the hash adds for `undefined` is what makes consent go stale
 * over a set that only SHRANK.
 *
 * The capabilities themselves are the extension's GRANTS flattened by
 * `grantsToCapabilitySet` — the same flattener the PDP's own
 * `grantedFromRegistry` uses (`permission-engine.ts:566-568`), so the
 * consent dialog shows the set the policy decision point will actually
 * hold and not a second rendering of it.
 */
export function capabilitiesForTool(tool: string): readonly ConsentCapability[] | undefined {
  const registry = ExtensionRegistry.getInstance();
  const registered = registry.getRegisteredTool(tool);
  if (registered === null) return undefined;
  // `actingUserId` is deliberately null: a `$USER` grant segment resolves
  // per DECISION, and a delegation has no single acting user (a `service`
  // delegation has none at all). Leaving it unexpanded hashes the grant
  // as written, which is what the human is shown.
  return grantsToCapabilitySet(registry.getGrantedPermissions(registered.extensionId), null).map(
    (cap) => ({ kind: cap.kind, value: cap.value ?? null }),
  );
}

/**
 * An agent's declared capabilities, or `undefined` when no agent of that
 * name is registered.
 *
 * `AgentDefinition.capabilities` (`types.ts:119`, values `types.ts:29`)
 * is the declaration an agent step's authority is bounded by, and an
 * unknown agent is genuinely unreachable rather than capability-free —
 * so it takes the `undefined` arm and the hash marks it
 * `agent:unreachable`.
 */
export function capabilitiesForAgent(agent: string): readonly ConsentCapability[] | undefined {
  const found = getExecutor()
    .listAgents()
    .find((a) => a.name === agent);
  if (found === undefined) return undefined;
  return found.capabilities.map((kind) => ({ kind, value: null }));
}

/** The latest pinnable snapshot of a workflow NAME, if it has one. */
async function latestVersionFor(name: string): Promise<DelegationVersionCandidate | undefined> {
  const definition = await getWorkflowByName(name);
  if (definition === undefined) return undefined;
  const version = await getLatestWorkflowVersion(definition.id);
  if (version === undefined) return undefined;
  return { id: version.id, version: version.version, stepsHash: version.stepsHash };
}

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
 * Split a `kind::value` key from {@link ConsentHashMaterial} back into the
 * pair the delegation row stores.
 *
 * Derived FROM the material rather than collected alongside it, so the
 * stored `capability_set` and the hashed set are the same object by
 * construction — the hash module returns its material for exactly this
 * ("so the consent dialog and the stale-consent diff read the same object
 * the hash was taken over, rather than deriving a second one"). A
 * separately-collected set would be a second opinion about what the human
 * agreed to, and the one the diff renders would be the one nobody
 * re-reads.
 *
 * `kind` never contains `::`, so the first occurrence is the separator. A
 * capability whose value was null hashed as the empty string and comes
 * back null; a capability whose value was genuinely `""` is
 * indistinguishable from it, which is accepted — no capability kind in
 * the tree issues an empty value.
 */
function splitCapabilityKey(key: string): { kind: string; value: string | null } {
  const at = key.indexOf("::");
  const kind = key.slice(0, at);
  const value = key.slice(at + 2);
  return { kind, value: value === "" ? null : value };
}

/**
 * Build the consent record for a delegation, or the Response the route
 * should send.
 *
 * Two DB-backed facts are gathered before the pure hash runs:
 *
 *  1. **The root's version pin.** Refused when the saved snapshot and the
 *     definition that would run have diverged — see
 *     `resolveDelegationVersionPin`, which explains at length why this is
 *     detected here rather than papered over by writing the pinned id
 *     onto the run regardless.
 *  2. **Every closure member's version identity.** The identity resolver
 *     the hash takes is synchronous, so the closure is walked once up
 *     front to learn which definitions to look up, and the walk is
 *     `collectWorkflowClosure` itself — the shared one the validator uses
 *     — not a second traversal. Running it twice over the same pure
 *     inputs yields the same definitions; running a DIFFERENT walk would
 *     eventually disagree about what is "inside" a workflow, and the
 *     direction that disagreement fails is a hash that misses a nested
 *     edit.
 */
export async function buildDelegationConsent(
  request: DelegationConsentRequest,
): Promise<DelegationConsentRecord | Response> {
  const rootVersion = await latestVersionFor(request.workflowName);
  const pin = resolveDelegationVersionPin(request.entry, rootVersion, request.workflowName);
  if (!pin.ok) return errorJson(409, pin.message);

  // ONE cache read, ONE principal, ONE resolver — shared by the pre-walk
  // and by the hash, so the two cannot see different graphs.
  const entries = getCachedWorkflows();
  const principal = delegationPrincipal(request.ownerKind, request.ownerId);
  const resolve = delegationWorkflowResolver(entries, principal);

  const closure = collectWorkflowClosure(request.entry.definition, resolve);
  const identities = new Map<string, WorkflowVersionIdentity>();
  for (const definition of closure.definitions) {
    identities.set(
      definition.name,
      delegationVersionIdentity(definition, await latestVersionFor(definition.name)),
    );
  }

  const result = computeWorkflowConsentHash(
    request.entry.definition,
    {
      extensionName: request.extensionName,
      workflowName: request.workflowName,
      projectId: request.projectId,
      runAs: { kind: request.ownerKind, id: request.ownerId },
      trigger: request.trigger,
    },
    buildConsentHashSources(entries, principal, {
      capabilitiesForTool,
      capabilitiesForAgent,
      // A definition the pre-walk did not see cannot appear in the walk
      // the hash does — same inputs, same pure walk — so the fallback is
      // unreachable rather than lenient. `unversioned` is nonetheless the
      // safe direction if it ever were reached: it fingerprints by
      // CONTENT, which never under-reports a change.
      identify: (def: WorkflowDefinition) =>
        identities.get(def.name) ?? { kind: "unversioned" as const },
    }),
  );

  return {
    definitionVersionId: pin.definitionVersionId,
    consentHash: result.hash,
    // De-duplicated as KEYS before splitting: two definitions in the
    // closure declaring the same capability authorize one thing, and the
    // dialog must not list it twice.
    capabilitySet: [...new Set(result.material.graph.flatMap((g) => g.capabilities))]
      .sort()
      .map(splitCapabilityKey),
    material: result.material,
  };
}
