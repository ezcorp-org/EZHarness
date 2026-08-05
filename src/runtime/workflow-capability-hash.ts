/**
 * C3's **consent hash** — the fingerprint of what a human agreed an
 * extension may run on their behalf.
 *
 * A delegation records this value at consent time. Every delegated fire
 * recomputes it from live state and compares. The row stores what the
 * human agreed to; the handler computes what the world says now — the
 * stored value is never compared against itself.
 *
 * ## TWO digests, and the split is the whole point
 *
 * This module returns `hash` (the **semantic** surface) and
 * `definitionHash` (the **advisory** one), taken over two DISJOINT
 * projections of one material object.
 *
 *  - **`hash` — the semantic surface.** The delegation-level facts
 *    (extension, workflow name, project, principal, trigger), the FLAT
 *    capability closure over every definition the walk reached, and the
 *    walk's own bounds (`unresolved`, `cycles`, `tooDeep`). This is
 *    *what the job may reach*.
 *  - **`definitionHash` — the graph as written.** Each definition's name,
 *    resolved version identity, default model binding and step list. This
 *    is *how the job is spelled*, and it is ADVISORY: a change to it alone
 *    never parks a run.
 *
 * The split exists because the combined digest made every release a
 * consent event. `ez-factory` is a BUNDLED extension — its workflows ship
 * inside the app image — so any release that edited one of its
 * `*.workflow.yaml` files, or its permissions block, or a referenced
 * agent's capabilities, changed the digest and parked EVERY delegation
 * `consent-stale`. Unattended execution stopped after each deploy, and
 * the only remedy was a human clicking through a dialog whose capability
 * set had not moved. A consent control that fires on every deploy stops
 * being read, which is the same failure the exclusion list at §3.2 exists
 * to prevent — one rung up.
 *
 * What replaces "any change re-asks" is a **widening** test, not a looser
 * digest: `workflow-consent-reconcile.ts` compares the CONSENTED capability
 * set against the recomputed one and parks only when the recomputed set
 * ADDS something. A definition edit whose closure is unchanged or narrower
 * carries consent forward and leaves an audit row. Nothing that adds reach
 * is admitted without a human, which is the property the combined digest
 * was bought for in the first place.
 *
 * ## Pure on purpose
 *
 * No I/O, no clock, no registry, no DB. Everything the world has to answer
 * arrives through {@link ConsentHashSources}: the workflow resolver, the
 * version-identity lookup, and the two capability lookups. That is what
 * makes the matrix below exhaustively testable, and it is also the seam
 * where the single most dangerous mistake in this feature is made — see
 * "the resolver is the owner's" below.
 *
 * ## What this does NOT close
 *
 * `definition_version_id` is written onto a run only when the graph the run
 * was HANDED matches that version's `steps_hash`
 * (`workflow-executor.ts:803`, written `:816`). So a delegation can pin a
 * version that the run it authorizes then declines to record, and the
 * consent record and the audit trail can disagree about which version
 * actually executed. This hash does not fix that and does not pretend to:
 * it fingerprints the graph the OWNER's view resolves at consent time, and
 * the run's own version claim is a separate, deliberately conservative
 * fact. Whoever wires the run row owes either "write the pinned id
 * regardless" or "detect and surface the divergence".
 */
import { createHash } from "node:crypto";
import type { WorkflowDefinition, WorkflowStep } from "../types";
import { collectWorkflowClosure } from "./workflow-closure";
import type { WorkflowResolver } from "./workflow-closure";
import { stableStringify, workflowDefinitionHash } from "./workflow-definition-hash";

/**
 * Bumped when the MATERIAL below changes shape.
 *
 * Folded into BOTH digests so a shape change cannot silently produce a
 * hash that collides with an old one.
 *
 * `2` is the semantic/definition split. Every row written under `1`
 * carries a combined digest that neither of the two projections can
 * reproduce, so every stored consent reads as changed on the first fire
 * after the upgrade — which is safe rather than disruptive precisely
 * because of the widening test: `workflow-consent-reconcile.ts` compares
 * the row's own `capability_set` (still exactly what the human approved,
 * and untouched by this change) against the recomputed closure, so an
 * upgraded row carries forward unless its reach actually grew. No
 * backfill is needed and none is performed: the first fire re-derives
 * both digests and writes them.
 */
export const CONSENT_HASH_MATERIAL_VERSION = 2;

/**
 * One capability as the consent dialog will show it. Deliberately a loose
 * `{kind, value}` pair rather than the PDP's `Capability`: the set also
 * carries entries the PDP has no kind for (`llm`, `tool`, and the two
 * `:unreachable` markers), and narrowing it to `CapabilityKind` would
 * force those through a string that lies about what it is.
 */
export interface ConsentCapability {
  kind: string;
  value?: string | null;
}

/**
 * Whether a resolved definition has a `workflow_definition_versions` row.
 *
 * `unversioned` is NOT an error path. A YAML or extension-shipped workflow
 * has no `workflow_definitions` row to version at all
 * (`workflow-executor.ts:776-779`), and `systemCachedWorkflow` sets
 * `id: null` for exactly those (`workflow-scope.ts:93`, `:100`) — so the
 * fallback is the common case for the very entries most able to shadow a
 * nested name.
 */
export type WorkflowVersionIdentity =
  | { kind: "version"; versionId: string; version: number }
  | { kind: "unversioned" };

/** Version identity of a definition the resolver produced. */
export type WorkflowIdentityResolver = (def: WorkflowDefinition) => WorkflowVersionIdentity;

/**
 * The capabilities a `tool` step's tool declares, per the registry as the
 * OWNER sees it. `undefined` means the registry cannot reach that tool —
 * which is a different fact from "reaches it and it declares nothing", and
 * the two must not hash alike (T11: an extension narrowing its manifest so
 * a step's tool becomes unreachable has changed the behaviour, so consent
 * is stale even though the set only shrank).
 */
export type ToolCapabilityResolver = (tool: string) => readonly ConsentCapability[] | undefined;

/** Same contract as {@link ToolCapabilityResolver}, for an `agent` step's
 *  agent and its tool scope. */
export type AgentCapabilityResolver = (agent: string) => readonly ConsentCapability[] | undefined;

/**
 * The delegation-level facts. Everything here is read from the DELEGATION
 * ROW or the registry, never from the wire — a delegation that could be
 * presented under a different extension, project or principal than the one
 * consented to is the confused deputy this hash exists to refuse.
 */
export interface ConsentDelegation {
  /** Registry-resolved, never the wire. */
  extensionName: string;
  /** Fully qualified: `<ext>:<name>`, or the bare DB name. */
  workflowName: string;
  projectId: string | null;
  /**
   * The principal the run carries — the delegation's `owner_kind` plus the
   * populated owner column, which is also what `workflow_runs.run_as_kind`
   * / `run_as` record. `kind` is load-bearing twice over: it changes what
   * the closure resolver can see (a `service` principal reads `system`
   * visibility only), and it changes who is answerable for the run.
   */
  runAs: { kind: string; id: string | null };
  /** Trigger kind plus its canonical spec — the cron expression and
   *  timezone, or the webhook key, or the event name and filter. "Runs on
   *  every push to `main`" is part of what was authorized. */
  trigger: { kind: string; spec: unknown };

  // ── Accepted and DELIBERATELY NOT HASHED (§3.2) ──
  //
  // Present on the type so the exclusion is visible at every call site and
  // testable here, rather than being an absence nobody can point at.
  //
  // These change routinely and change nothing about authority. Hashing
  // them would train users to click through re-consent, which is its own
  // vulnerability: a dialog that fires on every typo fix stops being read,
  // and then the one that matters is not read either.

  /** Run input values. */
  input?: Record<string, unknown> | null;
  /** Human label on the delegation. */
  displayName?: string | null;
  /** Concurrency policy. */
  concurrency?: unknown;
}

/**
 * Everything the world has to answer.
 *
 * ### The resolver is the OWNER's, never the flat cache
 *
 * `resolve` is caller-supplied and authorizes as whatever principal it
 * closes over (`workflow-closure.ts:38`, `:93`). Two principals yield two
 * definition sets, so hashing the flat merged cache certifies a graph that
 * is NOT the one that will run — and no type here can stop you, which is
 * precisely why it is called out. Build it from
 * `resolveWorkflowForCaller(entries, name, principalFor(owner_kind), "run")`
 * (`workflow-scope.ts:371-380`) so the view matches the principal in
 * {@link ConsentDelegation.runAs}. A `service` delegation sees a strictly
 * smaller graph and must hash to a different value; that is correct.
 */
export interface ConsentHashSources {
  resolve: WorkflowResolver;
  identify: WorkflowIdentityResolver;
  capabilitiesForTool: ToolCapabilityResolver;
  capabilitiesForAgent: AgentCapabilityResolver;
}

/** Per-step control flow and model binding, in DECLARATION ORDER. */
export interface ConsentStepMaterial {
  name: string;
  kind: string;
  /** Canonical `when` guard, `null` when the step declares none. */
  when: string;
  /** Resolved, defaulted to `true` (`types.ts:515-526`). */
  skipDependents: boolean;
  /** Canonical per-step model binding, `null` when absent. */
  model: string;
}

/** One definition of the closure, as the hash sees it. */
export interface ConsentGraphMaterial {
  name: string;
  /** `version:<id>@<n>` or `unversioned:<sha256 of steps+defaultModel>`. */
  identity: string;
  /** Canonical definition-level model binding, `null` when absent. */
  defaultModel: string;
  steps: ConsentStepMaterial[];
  /** Sorted, de-duplicated `kind::value`. */
  capabilities: string[];
}

/** The exact tuple that is serialized and digested. Returned so the
 *  consent dialog and the stale-consent diff read the same object the
 *  hash was taken over, rather than deriving a second one. */
export interface ConsentHashMaterial {
  v: number;
  extensionName: string;
  workflowName: string;
  projectId: string | null;
  runAs: { kind: string; id: string | null };
  trigger: { kind: string; spec: unknown };
  /** Every definition in the closure, sorted by name. */
  graph: ConsentGraphMaterial[];
  /** Nested names the owner's resolver could not answer. */
  unresolved: string[];
  /** Cycle paths, each joined with `" -> "`. */
  cycles: string[];
  /** Nested names below the depth cap. */
  tooDeep: string[];
}

/**
 * The SEMANTIC projection — what the job may reach, and on whose behalf.
 *
 * `capabilities` is the closure FLATTENED: the union of every definition's
 * capability keys, sorted and de-duplicated. Per-definition attribution is
 * deliberately dropped here and kept in the definition projection instead,
 * because reach is reach — a capability that MOVES from one definition in
 * the closure to another authorizes exactly the same thing, and re-asking
 * a human about it is the consent fatigue this split exists to end.
 *
 * The walk's bounds ride along for the reason `computeWorkflowConsentHash`
 * already records: an edge pointing nowhere at consent time can resolve
 * later, and the graph silently gains a live step. They are also the one
 * part of this projection that is *belt* to the capability set's *braces* —
 * a newly-resolved child normally shows up as new capability keys anyway.
 */
export interface ConsentSemanticMaterial {
  v: number;
  extensionName: string;
  workflowName: string;
  projectId: string | null;
  runAs: { kind: string; id: string | null };
  trigger: { kind: string; spec: unknown };
  /** Sorted, de-duplicated `kind::value` across the WHOLE closure. */
  capabilities: string[];
  unresolved: string[];
  cycles: string[];
  tooDeep: string[];
}

/**
 * The ADVISORY projection — the graph as written.
 *
 * Disjoint from {@link ConsentSemanticMaterial} on purpose: each digest
 * answers exactly one question, so a fire that finds them different can
 * say WHICH changed rather than "something did". That is what lets the
 * carry-forward audit row be specific about a release having edited a
 * workflow without claiming the human's grant moved.
 *
 * Per-definition `capabilities` are NOT here — they belong to the semantic
 * half, and duplicating them would make a narrowing show up as a
 * "definition change" too.
 */
export interface ConsentDefinitionMaterial {
  v: number;
  graph: Array<Omit<ConsentGraphMaterial, "capabilities">>;
}

export interface ConsentHashResult {
  /** The SEMANTIC digest — the value `workflow_delegations.consent_hash`
   *  stores and the widening test judges. */
  hash: string;
  /** The ADVISORY digest — `workflow_delegations.definition_hash`. A
   *  change to this alone never parks a run. */
  definitionHash: string;
  material: ConsentHashMaterial;
}

/**
 * The flat capability closure: every definition's keys, de-duplicated and
 * sorted.
 *
 * Exported because THREE readers need the identical set — the semantic
 * digest here, the `capability_set` the delegation row stores
 * (`workflow-delegation-record.ts`), and the widening test that compares
 * the two (`workflow-consent-reconcile.ts`). Deriving it three times is
 * how the stored set and the hashed set would eventually disagree, at
 * which point the widening test would be judging a set nobody hashed.
 */
export function consentCapabilityClosure(material: ConsentHashMaterial): string[] {
  return [...new Set(material.graph.flatMap((g) => g.capabilities))].sort();
}

/** {@link ConsentSemanticMaterial} for a material. Pure projection — it
 *  reads, it never recomputes. */
export function consentSemanticMaterial(
  material: ConsentHashMaterial,
): ConsentSemanticMaterial {
  return {
    v: material.v,
    extensionName: material.extensionName,
    workflowName: material.workflowName,
    projectId: material.projectId,
    runAs: material.runAs,
    trigger: material.trigger,
    capabilities: consentCapabilityClosure(material),
    unresolved: material.unresolved,
    cycles: material.cycles,
    tooDeep: material.tooDeep,
  };
}

/** {@link ConsentDefinitionMaterial} for a material. */
export function consentDefinitionMaterial(
  material: ConsentHashMaterial,
): ConsentDefinitionMaterial {
  return {
    v: material.v,
    graph: material.graph.map((g) => ({
      name: g.name,
      identity: g.identity,
      defaultModel: g.defaultModel,
      steps: g.steps,
    })),
  };
}

/** The `llm` capability value when neither the step nor the definition
 *  pins a provider, so the agent's own binding decides. */
const AGENT_OWN_BINDING = "<agent-binding>";

/** Sorted, de-duplicated `kind::value` keys. Sorting is what makes the
 *  set a SET: two definitions that declare the same capabilities in a
 *  different order authorize the same thing. */
function capabilityKeys(caps: readonly ConsentCapability[]): string[] {
  return [...new Set(caps.map((c) => `${c.kind}::${c.value ?? ""}`))].sort();
}

/**
 * A step's contribution to its definition's capability set.
 *
 * `transform`, `gate`, `approval` and `workflow` contribute nothing:
 * the first three reach no capability at all, and a `workflow` step's
 * authority is the CHILD's, which the closure adds under the child's own
 * name rather than smearing it onto the parent.
 */
function stepCapabilities(
  step: WorkflowStep,
  def: WorkflowDefinition,
  sources: ConsentHashSources,
): ConsentCapability[] {
  const kind = step.kind ?? "agent";
  if (kind === "tool") {
    const tool = step.tool ?? "";
    const declared = sources.capabilitiesForTool(tool);
    return [
      { kind: "tool", value: tool },
      // Reaching the tool and finding it declares nothing is NOT the same
      // fact as not reaching it, so the unreachable case gets its own
      // entry instead of collapsing to an empty list.
      ...(declared === undefined ? [{ kind: "tool:unreachable", value: tool }] : declared),
    ];
  }
  if (kind === "agent") {
    const agent = step.agent ?? "";
    const declared = sources.capabilitiesForAgent(agent);
    // A step's `model` REPLACES the definition's `defaultModel` whole
    // rather than merging field-by-field (`types.ts:537-542`), so a step
    // that names a binding without a provider falls back to the AGENT's
    // own binding — not to `defaultModel.provider`.
    const binding = step.model ?? def.defaultModel;
    return [
      { kind: "agent", value: agent },
      { kind: "llm", value: binding?.provider ?? AGENT_OWN_BINDING },
      ...(declared === undefined ? [{ kind: "agent:unreachable", value: agent }] : declared),
    ];
  }
  return [];
}

/** Control flow + model binding for one step. */
function stepMaterial(step: WorkflowStep): ConsentStepMaterial {
  return {
    name: step.name,
    kind: step.kind ?? "agent",
    // `when` and `skipDependents` are hash inputs IN THEIR OWN RIGHT, not
    // as a side effect of {@link identityKey}.
    //
    // `skipDependents` is the sharp one. It defaults to `true`
    // (`types.ts:515-526`), and flipping it `true → false` UN-SKIPS
    // downstream steps: an edit that changes no step body, no tool, no
    // agent and no capability declaration can make a previously
    // unreachable `tool` step execute. A capability-set-only hash sees
    // nothing, because the set was always there — only reachability
    // changed. Stating both directly is also what covers a YAML or
    // extension workflow, which has no version row for the identity to
    // pin, and what stops a future narrowing of the identity from
    // silently dropping reachability out of consent.
    when: stableStringify(step.when ?? null),
    skipDependents: step.skipDependents !== false,
    model: stableStringify(step.model ?? null),
  };
}

/**
 * A child's RESOLVED IDENTITY, never its name.
 *
 * The merged cache is extension → YAML → DB and the lookup is
 * FIRST-MATCH-WINS (`workflow-scope.ts:364-366`, lookup `:377`; build
 * order `web/src/lib/server/context.ts:537-541`, rule `:544-545`). So a
 * name can be RE-POINTED at a different graph, at every depth, without
 * editing a single definition the human read. Hashing the name would see
 * nothing. Two vectors exist, and it is worth being precise about which,
 * because the loose version of this claim is false:
 *
 *   1. A YAML asset dropped into the agents dir shadows a DB row of the
 *      same bare name — YAML is concatenated ahead of DB
 *      (`context.ts:557-559`). The executor names exactly this case
 *      (`workflow-executor.ts:789-792`).
 *   2. An extension asset shadows a DB row whose name was deliberately
 *      written `<ext>:<name>` (`context.ts:540-541`).
 *
 * An extension CANNOT shadow a bare host name: every extension workflow
 * is renamed `<extensionName>:<declaredName>` before it enters the cache
 * and a declared name containing `:` is rejected
 * (`workflow-extension-loader.ts:17-35`, rename `:150`, refusal `:142-148`).
 * The consent hash does not depend on which vector it was.
 *
 * `definition_version_id` alone cannot catch it either: the shadowing
 * entry has no version row at all (`systemCachedWorkflow` sets `id: null`,
 * `workflow-scope.ts:93`, `:100`), so the discriminant is part of the
 * value — a versioned and an unversioned definition never collide even
 * when their steps are byte-identical.
 */
function identityKey(def: WorkflowDefinition, identify: WorkflowIdentityResolver): string {
  const identity = identify(def);
  return identity.kind === "version"
    ? `version:${identity.versionId}@${identity.version}`
    : `unversioned:${workflowDefinitionHash(def)}`;
}

/**
 * ## Ruling: hash the VERSION ID — into the ADVISORY digest.
 *
 * *Deliberate, and now scoped.* We still fingerprint by version id rather
 * than by steps hash: any edit that mints a version — including an
 * `inputSchema`-only edit that changes no step body — moves the value.
 * `versionMaterialKey` folds in `inputSchema`
 * (`db/queries/workflow-versions.ts:117-119`) while `versionStepsHash`
 * does not (`:98-105`), so such an edit mints a new version id under an
 * IDENTICAL steps hash, and only the version id notices. The steps hash
 * is a *predicate about what we think matters*, and a control whose scope
 * is decided by a predicate fails in the direction of missing something.
 * The version id is the coarser, dumber, safer key.
 *
 * **What changed is what that fingerprint DRIVES.** It lands in
 * `definitionHash`, not in the consent digest, so an edit no longer
 * re-asks by itself — it carries consent forward and leaves an audit row.
 * The counter-argument this ruling used to record as a risk stopped being
 * hypothetical: consent fatigue *is* itself a failure mode, and a bundled
 * extension shipping its workflows in the app image turned "any edit
 * re-asks" into "every deploy parks every job". Re-asking now keys on the
 * one predicate that cannot under-report a grant — *did the capability
 * closure GROW* — and every other edit is recorded rather than gated.
 * `VersionMaterial` (`workflow-versions.ts:70-84`) still excludes
 * `name`/`description`, so a typo fix in prose mints no version and moves
 * neither digest.
 *
 * ## Why `unresolved`, `cycles` and `tooDeep` are hashed
 *
 * An edge pointing nowhere at consent time can resolve LATER — the
 * workflow gets shared, or a new row takes the name — and the graph
 * silently gains a live step with no consent change to show for it. The
 * closure reports all three rather than throwing
 * (`workflow-closure.ts:76-90`) precisely so a caller like this one can
 * treat them as facts about the authorized graph.
 */
export function computeWorkflowConsentHash(
  root: WorkflowDefinition,
  delegation: ConsentDelegation,
  sources: ConsentHashSources,
): ConsentHashResult {
  // ONE walk, shared with the validator (`workflow-closure.ts:6` names C3
  // outright). Two walks would eventually disagree about what is "inside"
  // a workflow, and the direction that disagreement fails is a hash that
  // misses a nested edit the validator happily accepted. The depth cap is
  // deliberately not a parameter: consent must be taken over the same
  // graph the validator bounded.
  const closure = collectWorkflowClosure(root, sources.resolve);

  const graph = closure.definitions
    .map((def) => ({
      name: def.name,
      identity: identityKey(def, sources.identify),
      defaultModel: stableStringify(def.defaultModel ?? null),
      // Declaration order is preserved: step order decides batch
      // composition, so it is semantic here rather than incidental
      // (`workflow-definition-hash.ts:40-44`).
      steps: (def.steps ?? []).map(stepMaterial),
      capabilities: capabilityKeys(
        (def.steps ?? []).flatMap((step) => stepCapabilities(step, def, sources)),
      ),
    }))
    // Sorted by name so the digest depends on the SET of definitions and
    // their identities, not on the order the walk happened to encounter
    // them. Nothing is lost: encounter order is a function of the step
    // arrays, and every definition's own identity already covers those.
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const material: ConsentHashMaterial = {
    v: CONSENT_HASH_MATERIAL_VERSION,
    extensionName: delegation.extensionName,
    workflowName: delegation.workflowName,
    projectId: delegation.projectId,
    runAs: { kind: delegation.runAs.kind, id: delegation.runAs.id },
    trigger: { kind: delegation.trigger.kind, spec: delegation.trigger.spec },
    graph,
    unresolved: [...new Set(closure.unresolved)].sort(),
    cycles: [...new Set(closure.cycles.map((c) => c.join(" -> ")))].sort(),
    tooDeep: [...new Set(closure.tooDeep)].sort(),
  };

  return {
    hash: digest(consentSemanticMaterial(material)),
    definitionHash: digest(consentDefinitionMaterial(material)),
    material,
  };
}

/**
 * SHA-256 over a canonical serialization.
 *
 * Key-order-insensitive at every depth: a jsonb round-trip and a YAML
 * loader do not agree on insertion order, and a digest that did would
 * re-ask for consent on a save that changed nothing.
 */
function digest(projection: ConsentSemanticMaterial | ConsentDefinitionMaterial): string {
  return createHash("sha256").update(stableStringify(projection)).digest("hex");
}
