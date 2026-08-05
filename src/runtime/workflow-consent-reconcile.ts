/**
 * C3's **fire-time consent verdict** — the one place that decides whether
 * a recomputed consent record is still the thing the human approved.
 *
 * ## The defect this replaces
 *
 * `consent_hash` used to be a single digest over the delegation facts AND
 * the workflow definition AND the capability closure, and rung D6 parked
 * the run on ANY difference. `ez-factory` is a BUNDLED extension, so its
 * workflows ship inside the app image: every release that touched one of
 * its `*.workflow.yaml` files, its permissions block, or a referenced
 * agent's capabilities moved that digest and parked EVERY delegation
 * `consent-stale`. Unattended execution stopped after each deploy, and
 * the remedy was a human re-approving a capability set that had not
 * moved. A consent gate that fires on every deploy is a gate nobody
 * reads.
 *
 * ## The replacement is a WIDENING test, not a looser digest
 *
 * `workflow-capability-hash.ts` now emits two digests over two disjoint
 * projections — the SEMANTIC surface (`consent_hash`) and the ADVISORY
 * graph (`definition_hash`). This module reads both, plus the delegation
 * row's own `capability_set`, and returns exactly one of three verdicts:
 *
 *  - **`fresh`** — both digests match. Nothing happened.
 *  - **`carry`** — something moved, but the recomputed capability closure
 *    ADDS NOTHING to the consented one. Consent carries forward: the row
 *    is re-stamped and an audit row records *re-authorized by release*.
 *  - **`park`** — the recomputed closure adds at least one capability key
 *    the human never approved. The run is parked `consent-stale` and a
 *    human re-consents, exactly as before.
 *
 * ## Why the ADDED set, and only the added set, is the gate
 *
 * A consent control's job is to refuse authority the human did not see.
 * Authority is what the graph can REACH, and the capability closure is
 * that reach expressed as a set. So:
 *
 *  - **Growth is the only unsafe direction.** One new `kind::value` key is
 *    one thing the job may now do that nobody approved, whether it arrived
 *    from a new step, a widened extension grant, an agent that gained a
 *    capability, or a nested edge that used to be unresolved and now
 *    resolves. All four land in this set, which is why the test is over
 *    the SET and not over a list of suspected causes.
 *  - **Shrinking is safe by construction.** A narrower job is strictly
 *    inside what was approved. Parking on it would be the "consent dialog
 *    that fires on a typo fix" failure with extra steps, and worse: the
 *    remedy for a narrowing is to re-approve *less*, which teaches people
 *    that the dialog means nothing.
 *  - **Restructuring is not a change at all.** A capability that moves
 *    from one definition in the closure to another authorizes the same
 *    thing. The closure is flattened before comparison for exactly this.
 *
 * ## The narrow-then-re-widen hole, and why {@link carry} must WRITE
 *
 * The verdict is only half the fix. A `carry` MUST persist the recomputed
 * capability set over the consented one. If it did not, a release that
 * narrowed `{A,B}` to `{A}` would leave `{A,B}` stored, and the release
 * that put `B` back would compare against the stale wider set, find
 * nothing added, and re-grant `B` with no human in the loop. The caller
 * writes {@link DelegationConsentReconciliation.kind `carry`}'s inputs
 * back to the row; this module names the obligation because it is the one
 * place that can see why it exists.
 *
 * ## PURE
 *
 * No DB, no clock, no registry — the stored triple and the computed
 * triple arrive as arguments. That is what makes the matrix below
 * exhaustively testable, and it is what lets the fire path ask this
 * question without any chance of asking a different one.
 */

/** One capability as both sides carry it: the delegation row's
 *  `capability_set` jsonb, and the record the hash returns. */
export interface ReconcileCapability {
  kind: string;
  value: string | null;
}

/**
 * What the delegation row remembers.
 *
 * `definitionHash` is nullable because the column is: rows written before
 * the split have none, and a row that has none reads as "the definition
 * changed", which routes it through the widening test on its first fire
 * and heals it. That is the migration — there is deliberately no backfill,
 * because a backfill would have to invent the graph those rows were
 * consented against.
 */
export interface StoredDelegationConsent {
  consentHash: string;
  definitionHash: string | null;
  capabilitySet: ReadonlyArray<ReconcileCapability>;
}

/** What this build recomputes from live state. */
export interface ComputedDelegationConsent {
  consentHash: string;
  definitionHash: string;
  capabilitySet: ReadonlyArray<ReconcileCapability>;
}

export type DelegationConsentReconciliation =
  /** Both digests match. The row is already exactly right. */
  | { kind: "fresh" }
  /**
   * Something moved and NOTHING was added. The caller re-stamps the row
   * with the computed triple (see "the narrow-then-re-widen hole") and
   * writes one audit row.
   */
  | {
      kind: "carry";
      /** Capability keys the human approved that the job no longer
       *  reaches. Empty for a pure definition edit. */
      removed: string[];
      /** True when the SEMANTIC digest moved — a narrowing, a bounds
       *  change, or the v1→v2 material-version bump. */
      semanticChanged: boolean;
      /** True when the ADVISORY digest moved — a release edited the
       *  graph — or when the row predates the column. */
      definitionChanged: boolean;
    }
  /** The recomputed closure reaches something new. A human re-consents. */
  | { kind: "park"; added: string[] };

/**
 * The audit `reason` a carry-forward writes, verbatim.
 *
 * A constant rather than a literal at the call site because it is the
 * string an operator greps `audit_log` for when asking "why did this job
 * keep running across a deploy" — and a second spelling of it in a second
 * place is how that search starts missing rows.
 */
export const CONSENT_CARRIED_FORWARD_REASON = "re-authorized by release";

/** `kind::value`, the same key shape `capabilityKeys` hashes — a null
 *  value hashes as the empty string, and so does it here. */
export function reconcileCapabilityKey(cap: ReconcileCapability): string {
  return `${cap.kind}::${cap.value ?? ""}`;
}

/** Sorted, de-duplicated keys for one side of the comparison. */
function keySet(caps: ReadonlyArray<ReconcileCapability>): Set<string> {
  return new Set(caps.map(reconcileCapabilityKey));
}

/**
 * Decide what a delegated fire should do about its consent record.
 *
 * The order of the two questions is load-bearing. The widening test runs
 * BEFORE the "which digest moved" bookkeeping is reported, because a
 * closure that grew parks regardless of why it grew — a caller that
 * branched on `definitionChanged` first would have to decide what a
 * definition edit that ALSO widened means, and there is only one right
 * answer to that.
 */
export function reconcileDelegationConsent(
  stored: StoredDelegationConsent,
  computed: ComputedDelegationConsent,
): DelegationConsentReconciliation {
  const semanticChanged = stored.consentHash !== computed.consentHash;
  const definitionChanged = stored.definitionHash !== computed.definitionHash;
  if (!semanticChanged && !definitionChanged) return { kind: "fresh" };

  const before = keySet(stored.capabilitySet);
  const now = keySet(computed.capabilitySet);
  const added = [...now].filter((k) => !before.has(k)).sort();
  if (added.length > 0) return { kind: "park", added };

  return {
    kind: "carry",
    removed: [...before].filter((k) => !now.has(k)).sort(),
    semanticChanged,
    definitionChanged,
  };
}
