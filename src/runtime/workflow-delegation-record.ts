/**
 * The IMPURE half of a C3 consent record — everything that has to touch
 * the extension registry, the agent list or the database before
 * `computeWorkflowConsentHash` (which is pure) can be called.
 *
 * ## Why this is in `src/` and not in the consent route
 *
 * The hash is computed TWICE in this feature's life:
 *
 *  1. at CONSENT time, by `POST /api/workflows/delegations` (in `web/`), and
 *  2. at every FIRE, by the delegated `runFor` ladder (in `src/`), which
 *     compares the recompute against the stored value and parks the run
 *     with `suspended_reason='consent-stale'` when they differ.
 *
 * `workflow-capability-hash.ts` is pure precisely so those two callers
 * share it — but the four SOURCES it takes are where the drift would
 * actually happen, and a fire-time source set that differs from consent's
 * by one entry stales every fire of a delegation that nobody can then
 * re-consent, because the re-consent recomputes the same stale value
 * again. That failure is silent, permanent and unfixable from the UI, so
 * the sources are assembled ONCE, here, and both callers import this.
 *
 * The web layer keeps only the parts that are genuinely route-shaped —
 * turning a version divergence into a 409 body.
 *
 * ## The agent list arrives through the runtime registry
 *
 * `capabilitiesForTool` reads the extension registry, which is a `src/`
 * singleton. The agent list is not: it lives on the `AgentExecutor` the
 * web layer constructs, so it arrives as an argument and the fire path
 * reads it from `WorkflowRuntime.listAgents` — a thunk registered
 * alongside `getCachedWorkflows`, with the same fail-closed rule. Passing
 * it in rather than reaching for a second singleton is also what keeps
 * this module testable without standing up an executor.
 */
import { ExtensionRegistry } from "../extensions/registry";
import { grantsToCapabilitySet } from "../extensions/capability-types";
import { getWorkflowByName } from "../db/queries/workflows";
import { getLatestWorkflowVersion } from "../db/queries/workflow-versions";
import {
  buildConsentHashSources,
  delegationVersionIdentity,
  delegationWorkflowResolver,
  resolveDelegationVersionPin,
  type DelegationVersionCandidate,
  type DelegationVersionPin,
} from "./workflow-delegation-consent";
import {
  computeWorkflowConsentHash,
  consentCapabilityClosure,
  type ConsentCapability,
  type ConsentHashMaterial,
  type WorkflowVersionIdentity,
} from "./workflow-capability-hash";
import { collectWorkflowClosure, type WorkflowResolver } from "./workflow-closure";
import type { CachedWorkflow, WorkflowCaller } from "./workflow-scope";
import type { AgentDefinition, WorkflowDefinition } from "../types";

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
 * `grantedFromRegistry` uses — so the consent dialog shows the set the
 * policy decision point will actually hold and not a second rendering of
 * it.
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
 * `AgentDefinition.capabilities` is the declaration an agent step's
 * authority is bounded by, and an unknown agent is genuinely unreachable
 * rather than capability-free — so it takes the `undefined` arm and the
 * hash marks it `agent:unreachable`.
 *
 * Curried over the agent list rather than reading a registry, because the
 * list lives on the web layer's `AgentExecutor`. Both callers hand it the
 * same list: the route reads it from `getExecutor()`, the fire path from
 * `WorkflowRuntime.listAgents`, and both of those are the same instance in
 * a running process.
 */
export function agentCapabilityLookup(
  agents: readonly AgentDefinition[],
): (agent: string) => readonly ConsentCapability[] | undefined {
  return (agent: string) => {
    const found = agents.find((a) => a.name === agent);
    if (found === undefined) return undefined;
    return found.capabilities.map((kind) => ({ kind, value: null }));
  };
}

/** The latest pinnable snapshot of a workflow NAME, if it has one. */
export async function latestWorkflowVersionFor(
  name: string,
): Promise<DelegationVersionCandidate | undefined> {
  const definition = await getWorkflowByName(name);
  if (definition === undefined) return undefined;
  const version = await getLatestWorkflowVersion(definition.id);
  if (version === undefined) return undefined;
  return { id: version.id, version: version.version, stepsHash: version.stepsHash };
}

export interface DelegationConsentInput {
  workflowResolver?: WorkflowResolver;
  /** Already authorized for the delegation's principal by the caller. */
  entry: CachedWorkflow;
  /** Registry-resolved, never off the wire. */
  extensionName: string;
  workflowName: string;
  projectId: string | null;
  /** Recorded verbatim into the hash material as `runAs`. */
  runAs: { kind: string; id: string | null };
  trigger: { kind: string; spec: unknown };
  /** The `WorkflowCaller` the delegation's `owner_kind` carries — the ONE
   *  input that makes a `service` delegation hash a smaller graph. */
  principal: WorkflowCaller;
  /** The merged cache, read ONCE by the caller so the pre-walk and the
   *  hash cannot see two different caches. */
  entries: readonly CachedWorkflow[];
  /** The live agent list. See {@link agentCapabilityLookup}. */
  agents: readonly AgentDefinition[];
}

export interface DelegationConsentRecord {
  /** `ok: false` only when the root's saved snapshot and the definition
   *  that would run have diverged — see `resolveDelegationVersionPin`. */
  pin: DelegationVersionPin;
  /** The SEMANTIC digest — `workflow_delegations.consent_hash`. */
  consentHash: string;
  /** The ADVISORY digest — `workflow_delegations.definition_hash`. Moves
   *  on any release that edits the graph; a move on its own never parks a
   *  run (`workflow-consent-reconcile.ts`). */
  definitionHash: string;
  capabilitySet: Array<{ kind: string; value: string | null }>;
  material: ConsentHashMaterial;
}

/**
 * Split a `kind::value` key from `ConsentHashMaterial` back into the pair
 * the delegation row stores.
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
 * Compute a delegation's consent record: the version pin, the hash, the
 * capability set and the material the dialog renders.
 *
 * Two DB-backed facts are gathered before the pure hash runs:
 *
 *  1. **The root's version pin.** Refused when the saved snapshot and the
 *     definition that would run have diverged — see
 *     `resolveDelegationVersionPin`, which explains at length why this is
 *     DETECTED rather than papered over by writing the pinned id onto the
 *     run regardless. Returned rather than thrown, because the two
 *     callers render it differently (a 409 body at consent time, a typed
 *     RPC denial at fire time) and neither may invent a second rule.
 *  2. **Every closure member's version identity.** The identity resolver
 *     the hash takes is synchronous, so the closure is walked once up
 *     front to learn which definitions to look up, and the walk is
 *     `collectWorkflowClosure` itself — the shared one the validator uses
 *     — not a second traversal. Running it twice over the same pure
 *     inputs yields the same definitions; running a DIFFERENT walk would
 *     eventually disagree about what is "inside" a workflow, and the
 *     direction that disagreement fails is a hash that misses a nested
 *     edit.
 *
 * The PRINCIPAL is the caller's, and it is the whole reason this takes
 * one: `delegationWorkflowResolver` closes over it, so a `service`
 * delegation walks a strictly smaller graph than a `user` one and hashes
 * to a different value. That is correct, and hashing the flat merged
 * cache instead would certify a graph that is not the one that runs.
 */
export async function computeDelegationConsentRecord(
  input: DelegationConsentInput,
): Promise<DelegationConsentRecord> {
  const rootVersion = await latestWorkflowVersionFor(input.workflowName);
  const pin = resolveDelegationVersionPin(input.entry, rootVersion, input.workflowName);

  // ONE cache, ONE principal, ONE resolver — shared by the pre-walk and by
  // the hash, so the two cannot see different graphs.
  const resolve = input.workflowResolver ?? delegationWorkflowResolver(input.entries, input.principal);
  const closure = collectWorkflowClosure(input.entry.definition, resolve);
  const identities = new Map<string, WorkflowVersionIdentity>();
  for (const definition of closure.definitions) {
    identities.set(
      definition.name,
      delegationVersionIdentity(definition, await latestWorkflowVersionFor(definition.name)),
    );
  }

  const result = computeWorkflowConsentHash(
    input.entry.definition,
    {
      extensionName: input.extensionName,
      workflowName: input.workflowName,
      projectId: input.projectId,
      runAs: input.runAs,
      trigger: input.trigger,
    },
    { ...buildConsentHashSources(input.entries, input.principal, {
      capabilitiesForTool,
      capabilitiesForAgent: agentCapabilityLookup(input.agents),
      // A definition the pre-walk did not see cannot appear in the walk
      // the hash does — same inputs, same pure walk — so the fallback is
      // unreachable rather than lenient. `unversioned` is nonetheless the
      // safe direction if it ever were reached: it fingerprints by
      // CONTENT, which never under-reports a change.
      identify: (def: WorkflowDefinition) =>
        identities.get(def.name) ?? { kind: "unversioned" as const },
    }), resolve },
  );

  return {
    pin,
    consentHash: result.hash,
    definitionHash: result.definitionHash,
    // The SAME flattener the semantic digest takes, imported rather than
    // written again: the widening test compares this stored set against a
    // recomputed one, so a second derivation here would eventually judge a
    // set nobody hashed. De-duplicated as KEYS before splitting — two
    // definitions in the closure declaring the same capability authorize
    // one thing, and the dialog must not list it twice.
    capabilitySet: consentCapabilityClosure(result.material).map(splitCapabilityKey),
    material: result.material,
  };
}
