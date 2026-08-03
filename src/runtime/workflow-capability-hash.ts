/**
 * C3's **consent hash** — the fingerprint of what a human agreed an
 * extension may run on their behalf.
 *
 * A delegation records this value at consent time. Every delegated fire
 * recomputes it from live state and compares; a mismatch suspends the run
 * with `suspended_reason='consent-stale'` and re-asks. The row stores what
 * the human agreed to; the handler computes what the world says now — the
 * stored value is never compared against itself.
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
 * (`workflow-executor.ts:629`, written `:642`). So a delegation can pin a
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
 * Folded into the digest so a shape change cannot silently produce a hash
 * that collides with an old one: every stored consent goes stale on the
 * upgrade and is re-asked, which is the only safe direction for a control
 * whose whole job is "the human saw this exact thing".
 */
export const CONSENT_HASH_MATERIAL_VERSION = 1;

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
 * (`workflow-executor.ts:602-608`), and `systemCachedWorkflow` sets
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

export interface ConsentHashResult {
  hash: string;
  material: ConsentHashMaterial;
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
    // as a side effect of the identity above.
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
 * order `web/src/lib/server/context.ts:537-541`, rule `:520-521`). So
 * installing an extension that ships a `deploy` asset RE-POINTS every
 * nested edge naming `deploy`, at every depth, without editing a single
 * definition the human read. Hashing the name would see nothing.
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
 * ## Ruling: hash the VERSION ID. Re-ask on ANY edit.
 *
 * *Deliberate.* We hash the version id, not the steps hash. Any edit that
 * mints a version — including an `inputSchema`-only edit that changes no
 * step body — invalidates consent and re-asks. `versionMaterialKey` folds
 * in `inputSchema` (`db/queries/workflow-versions.ts:117-119`) while
 * `versionStepsHash` does not (`:98-105`), so such an edit mints a new
 * version id under an IDENTICAL steps hash, and only the version id
 * notices.
 *
 * The reason is that the steps hash is a *predicate about what we think
 * matters*, and a consent control whose scope is decided by a predicate
 * fails in the direction of granting authority the human never saw. The
 * version id is the coarser, dumber, safer key.
 *
 * **The counter-argument, recorded honestly because it is real:** consent
 * fatigue is itself a failure mode. The exclusion list exists because a
 * consent dialog that fires on every typo fix stops being read, and then
 * the one that matters is not read either. We are trading a known,
 * bounded annoyance (schema edits re-ask) against an unknown, unbounded
 * one (a predicate that under-reports). If telemetry later shows
 * re-consent prompts are being click-through-accepted at a high rate,
 * that is evidence to revisit — **revisit with data, not by reasoning
 * that the steps hash is "obviously" sufficient.** `VersionMaterial`
 * (`workflow-versions.ts:70-84`) already excludes `name`/`description`
 * for exactly this reason, which is what keeps the re-ask rate bounded: a
 * typo fix in prose mints no version at all.
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
    // Key-order-insensitive at every depth: a jsonb round-trip and a YAML
    // loader do not agree on insertion order, and a digest that did would
    // re-ask for consent on a save that changed nothing.
    hash: createHash("sha256").update(stableStringify(material)).digest("hex"),
    material,
  };
}
