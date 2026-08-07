/**
 * Persistence for C3's `workflow_delegations` — the authority behind
 * `ctx.workflows.runFor`.
 *
 * ## Every owner read and write goes through the schema's keyed lookup
 *
 * `owner_kind` is a real discriminator with two arms today and room for
 * more, and `DELEGATION_OWNER_COLUMN` (`db/schema.ts:587-590`) is the one
 * place that says which column carries which. This module NEVER
 * `switch`es on the kind and never writes a second copy of that map: a
 * two-armed `switch` compiles today and falls silently through the day a
 * third kind exists, whereas the map is `as const satisfies
 * Record<DelegationOwnerKind, …>` and turns the same change into a
 * compile error. {@link ownerColumnValues} derives BOTH the populated and
 * the nulled columns from the map, so a third kind needs one new entry
 * there and nothing here.
 *
 * ## Exactly one owner column is populated, and that is enforced HERE
 *
 * The schema deliberately carries no CHECK constraint (`:583-585`),
 * consistent with the rest of this repo, which makes the query layer the
 * enforcement point rather than a convenience wrapper around one. A row
 * with NO owner is the exact state `-32106` exists to prevent — a live,
 * enabled delegation carrying a valid consent hash and naming nobody — so
 * {@link createWorkflowDelegation} refuses to write one.
 *
 * ## Revocation is a tombstone
 *
 * `revoked_at IS NULL` is the liveness predicate of every read here and
 * of the two partial indexes (`db/schema.ts:698-711`). Revoked rows stay
 * as history and fall out of all of them, so the default for anything
 * that misses the filter is "no authority".
 */
import { and, count, desc, eq, gte, isNull, isNotNull, sql, type SQL } from "drizzle-orm";
import { getDb } from "../connection";
import type { DbTransaction } from "../connection";
import {
  DELEGATION_OWNER_COLUMN,
  workflowDelegations,
  workflowRuns,
  type DelegationOwnerKind,
  type WorkflowDelegationRow,
} from "../schema";
import {
  DELEGATION_CONSENT_DENIALS,
  type DelegationConsentDenialCode,
} from "../../runtime/workflow-delegation-consent";

/** Every owner column the discriminator can name, derived from the map. */
const OWNER_COLUMNS = Object.values(DELEGATION_OWNER_COLUMN);

/**
 * The predicate that says a delegation still CARRIES AUTHORITY:
 * `revoked_at IS NULL AND enabled`.
 *
 * ## Why this is exported rather than written twice
 *
 * Two consumers ask the same question from different layers, and they
 * must never be able to disagree:
 *
 *  - the approvals **inbox** decides whether to SHOW a delegated run's
 *    parked decision to the human who consented to it
 *    (`workflow-approvals.ts`), and
 *  - `answerApproval` decides whether that human may ANSWER it
 *    (`runtime/workflow-answer-approval.ts`).
 *
 * A row the inbox shows and the chokepoint then refuses is the exact
 * "looks fixed" failure amended spec §6.3 names — worse than not
 * building the authority at all, because the user can see the decision
 * and cannot make it. One predicate, two call sites.
 *
 * ## Why `enabled`, when {@link findLiveWorkflowDelegation} omits it
 *
 * That reader is the FIRE path, and it deliberately sees disabled rows so
 * it can refuse with `disabled_reason` instead of an indistinguishable
 * "no such delegation". This one is the ANSWER path, where there is
 * nothing to explain to: a delegation is disabled precisely when the
 * platform has decided its authority is broken (a re-tiered workflow, five
 * consecutive failures — `extensions/schedule-daemon.ts:88`), and letting
 * its consenting human keep clearing consent gates on its behalf would be
 * exercising the authority that was just withdrawn. It fails CLOSED: an
 * admin (`kind: "user"`, `isAdmin`) still answers, and an `onTimeout:`
 * policy still applies, so a parked run is never stranded with nobody.
 */
export function delegationHoldsAuthority(): SQL | undefined {
  return and(
    isNull(workflowDelegations.revokedAt),
    eq(workflowDelegations.enabled, true),
  );
}

/**
 * The delegation with this id, **only if it still holds authority**.
 *
 * The re-read behind `answerApproval`'s `delegation` actor kind. Keyed by
 * id and filtered by {@link delegationHoldsAuthority}, so a revoked or
 * disabled row is not "found and then judged" — it is not found, and the
 * default for anything that misses the filter is "no authority".
 *
 * Distinct from {@link getWorkflowDelegation}, which returns history and
 * must: this one is asked at a decision point, where a tombstone that
 * came back as a row would be one `if` away from granting the authority
 * revocation exists to end.
 */
export async function findDelegationHoldingAuthority(
  id: string,
): Promise<WorkflowDelegationRow | undefined> {
  const rows = await getDb()
    .select()
    .from(workflowDelegations)
    .where(and(eq(workflowDelegations.id, id), delegationHoldsAuthority()));
  return rows[0];
}

/**
 * The owner columns for one `(kind, id)` pair: the mapped column carries
 * the id and **every other owner column is explicitly NULL**.
 *
 * Explicit rather than omitted, because {@link createWorkflowDelegation}
 * supersedes: a re-consent that SWITCHED arms would otherwise leave the
 * previous arm's value behind, and a row naming both a user and a service
 * account is exactly as ambiguous as one naming neither.
 */
function ownerColumnValues(
  ownerKind: DelegationOwnerKind,
  ownerId: string,
): Record<string, string | null> {
  const target = DELEGATION_OWNER_COLUMN[ownerKind];
  return Object.fromEntries(OWNER_COLUMNS.map((c) => [c, c === target ? ownerId : null]));
}

/**
 * The owner id a row actually carries, whichever arm it is on.
 *
 * The read half of {@link ownerColumnValues}, and the reason no caller
 * needs to know which column a kind uses.
 */
export function delegationOwnerId(row: WorkflowDelegationRow): string | null {
  return row[DELEGATION_OWNER_COLUMN[row.ownerKind]];
}

/**
 * The wire shape of a delegation.
 *
 * EXPLICIT field copies, not `...row`, for exactly the reason
 * `toServiceAccountView` states next door
 * (`db/queries/service-accounts.ts`): spreading a row makes the API shape
 * a function of the schema, so the day someone adds a column here it
 * ships to every client in the same commit. This table has more to lose
 * by that than most — `consent_hash` is the fingerprint a stale-consent
 * check compares, and publishing it would let a client assert its own
 * freshness rather than being told.
 *
 * It lives beside the row type rather than in `web/` because THREE route
 * handlers need it (the list, the consent, and the token-ceiling PATCH)
 * and none of them owns it. Before this, the consent route held a private
 * `toWire` and the PATCH would have been a second copy — which is how two
 * endpoints for the same object start disagreeing about its shape.
 */
export interface WorkflowDelegationView {
  id: string;
  extensionId: string;
  jobRef: string;
  ownerKind: DelegationOwnerKind;
  ownerId: string | null;
  workflowName: string;
  definitionVersionId: string | null;
  projectId: string | null;
  triggerKind: string;
  triggerSpec: Record<string, unknown> | null;
  capabilitySet: Array<{ kind: string; value: string | null }>;
  maxTokensPerRun: number;
  maxRunsPerDay: number;
  enabled: boolean;
  disabledReason: string | null;
  consentedAt: Date;
  consentedByUserId: string;
}

export function toWorkflowDelegationView(row: WorkflowDelegationRow): WorkflowDelegationView {
  return {
    id: row.id,
    extensionId: row.extensionId,
    jobRef: row.jobRef,
    ownerKind: row.ownerKind,
    // Read through the schema's keyed lookup, so a caller never has to
    // know which column an owner kind uses.
    ownerId: delegationOwnerId(row),
    workflowName: row.workflowName,
    definitionVersionId: row.definitionVersionId,
    projectId: row.projectId,
    triggerKind: row.triggerKind,
    triggerSpec: row.triggerSpec,
    capabilitySet: row.capabilitySet,
    maxTokensPerRun: row.maxTokensPerRun,
    maxRunsPerDay: row.maxRunsPerDay,
    enabled: row.enabled,
    disabledReason: row.disabledReason,
    consentedAt: row.consentedAt,
    consentedByUserId: row.consentedByUserId,
  };
}

export interface CreateWorkflowDelegationInput {
  /** Registry-resolved, never off the wire. */
  extensionId: string;
  jobRef: string;
  ownerKind: DelegationOwnerKind;
  /** The user id or the service-account id, per `ownerKind`. */
  ownerId: string;
  workflowName: string;
  /** NULL only for a YAML/extension workflow, which has no version row. */
  definitionVersionId: string | null;
  projectId: string | null;
  triggerKind: string;
  triggerSpec: Record<string, unknown> | null;
  /** The SEMANTIC digest. */
  consentHash: string;
  /**
   * The ADVISORY graph digest.
   *
   * REQUIRED rather than optional, even though the column is nullable.
   * NULL is reserved for rows written before the split, which is a fact
   * about history; a fresh consent always knows its graph, and letting a
   * caller omit it would mint a new row that immediately reads as "the
   * definition changed" on its first fire.
   */
  definitionHash: string;
  capabilitySet: Array<{ kind: string; value: string | null }>;
  maxTokensPerRun: number;
  maxRunsPerDay: number;
  /** The answering human. NOT NULL by schema (`db/schema.ts:688`). */
  consentedByUserId: string;
}

export type CreateWorkflowDelegationResult =
  | {
      ok: true;
      delegation: WorkflowDelegationRow;
      /** Id of the live row this consent superseded, when re-consenting. */
      supersededId: string | null;
    }
  | { ok: false; code: DelegationConsentDenialCode; message: string };

/**
 * Write a consent, superseding this caller's own live consent for the
 * same `(extension, job)`.
 *
 * ## Supersede rather than conflict
 *
 * `uniq_workflow_delegation` is PARTIAL — one live row per
 * `(extension_id, job_ref)`, revoked rows unconstrained
 * (`db/schema.ts:698-703`). Re-consent is the normal path (the consent
 * hash goes stale on any edit that mints a version — see
 * `workflow-capability-hash.ts:320-347`), so this tombstones the live row
 * and inserts a fresh one inside ONE transaction. Both halves in one
 * transaction because the intermediate state — no live consent — is a
 * window in which a concurrent fire finds no delegation and refuses, and
 * a crash in that window loses the authority with nothing to show for it.
 *
 * ## …but never somebody else's
 *
 * `consented_by_user_id` is not bookkeeping: it names the human who may
 * answer a service-account run's approvals (`db/schema.ts:659-668`).
 * Silently reassigning it on a supersede would move one user's answering
 * authority to another, so a live row consented by a different user is
 * refused and the caller is told to ask that person to revoke.
 */
export async function createWorkflowDelegation(
  input: CreateWorkflowDelegationInput,
): Promise<CreateWorkflowDelegationResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return getDb().transaction(async (tx: DbTransaction): Promise<CreateWorkflowDelegationResult> => {
    const live: WorkflowDelegationRow[] = await tx
      .select()
      .from(workflowDelegations)
      .where(
        and(
          eq(workflowDelegations.extensionId, input.extensionId),
          eq(workflowDelegations.jobRef, input.jobRef),
          isNull(workflowDelegations.revokedAt),
        ),
      );
    const existing = live[0];
    if (existing && existing.consentedByUserId !== input.consentedByUserId) {
      return {
        ok: false,
        code: DELEGATION_CONSENT_DENIALS.NOT_CONSENTER,
        message:
          `Another user already consented to this job. ` +
          `Ask them to revoke their delegation before consenting to it yourself.`,
      };
    }
    if (existing) {
      await tx
        .update(workflowDelegations)
        .set({ revokedAt: new Date(), updatedAt: new Date() })
        .where(eq(workflowDelegations.id, existing.id));
    }
    const [inserted]: WorkflowDelegationRow[] = await tx
      .insert(workflowDelegations)
      .values({
        extensionId: input.extensionId,
        jobRef: input.jobRef,
        ownerKind: input.ownerKind,
        ...ownerColumnValues(input.ownerKind, input.ownerId),
        workflowName: input.workflowName,
        definitionVersionId: input.definitionVersionId,
        projectId: input.projectId,
        triggerKind: input.triggerKind,
        triggerSpec: input.triggerSpec,
        consentHash: input.consentHash,
        definitionHash: input.definitionHash,
        capabilitySet: input.capabilitySet,
        maxTokensPerRun: input.maxTokensPerRun,
        maxRunsPerDay: input.maxRunsPerDay,
        consentedByUserId: input.consentedByUserId,
      })
      .returning();
    if (existing) {
      // ── Carry PARKED runs forward onto the new authority ────────────
      //
      // Without this both C3 resume rules are unsatisfiable and every
      // parked delegated run is stuck forever. Verified by execution,
      // not by reading:
      //
      //   - Re-consent is THIS function, and it tombstones. (Phase 8a
      //     later added {@link setDelegationRunBounds} and its
      //     `PATCH /api/workflows/delegations/:id` route, which raises
      //     the cap WITHOUT superseding — the other way out of the same
      //     deadlock, and deliberately not a replacement for this block:
      //     a re-consent still tombstones, and a `consent-stale` park
      //     can be resolved ONLY by re-consenting, which is this path.)
      //   - Both `RESUME_RULES` predicates go through
      //     `readWorkflowRunDelegationBudget`, which INNER-joins the
      //     RUN's own `delegation_id` and reports `live: false` for a
      //     revoked row. Both then refuse.
      //   - So the remedies those rules name in their own prose —
      //     "only raising that cap lets it continue" and "only a fresh
      //     consent on the delegation lets it continue" — were both
      //     unreachable, and a run parked by the budget ceiling or by a
      //     stale consent could never be continued by anyone.
      //
      // Only `suspended` rows move. A TERMINAL run's record must not:
      // it names the authority it actually executed under, and that is
      // history. A `running` run is not moved either — it belongs to the
      // process holding its lease, and its boundary check re-reads this
      // column mid-flight.
      //
      // Inside the SAME transaction as the tombstone and the insert, so
      // there is never an instant in which a parked run points at a
      // revoked delegation while a live one exists.
      //
      // Revocation deliberately does NOT do this ({@link
      // revokeWorkflowDelegation}): withdrawing authority must leave
      // parked runs parked, and there is no successor row to point them
      // at anyway.
      //
      // `run_as_kind` / `run_as` are untouched, and that is what keeps
      // the history honest — they are the audit SNAPSHOT of the
      // principal (`db/schema.ts:850-863`), while `delegation_id` is
      // documented there as the live FK that goes NULL. Re-pointing the
      // live FK is what that column is for.
      await tx
        .update(workflowRuns)
        .set({ delegationId: inserted!.id })
        .where(
          and(
            eq(workflowRuns.delegationId, existing.id),
            eq(workflowRuns.status, "suspended"),
          ),
        );
    }
    return { ok: true, delegation: inserted!, supersededId: existing?.id ?? null };
  });
}

/** The triple a carry-forward re-stamps onto a live delegation. */
export interface CarriedDelegationConsent {
  consentHash: string;
  definitionHash: string;
  capabilitySet: Array<{ kind: string; value: string | null }>;
}

/**
 * Re-stamp a live delegation's consent record when a release changed the
 * job WITHOUT widening what it may reach.
 *
 * The write half of `runtime/workflow-consent-reconcile.ts`'s `carry`
 * verdict, and it is not optional bookkeeping — two properties depend on
 * it:
 *
 *  1. **`capability_set` must follow a NARROWING.** If a release cuts the
 *     set from `{A,B}` to `{A}` and the row keeps `{A,B}`, the release
 *     that puts `B` back compares against the stale wider set, finds
 *     nothing added, and re-grants `B` with no human in the loop. Writing
 *     the narrowed set closes that.
 *  2. **The digests must follow, or every subsequent fire re-does the
 *     work.** Not merely wasteful: each one would write another
 *     "re-authorized by release" audit row for a release that happened
 *     once.
 *
 * ## What it deliberately does NOT touch
 *
 * `consented_at` — for the same reason {@link setDelegationRunBounds}
 * leaves it alone, and here it is load-bearing rather than tidy.
 * `RESUME_RULES["consent-stale"]` lets a parked run continue only once
 * `consented_at` is strictly after the run's `started_at`, i.e. only once
 * a HUMAN has looked at the diff. A carry-forward is the platform
 * observing that nothing widened; moving the stamp would resume runs a
 * human parked and never answered. Nor `enabled` / `disabled_reason`: a
 * delegation the platform switched off is not healed by a release.
 *
 * ## CAS on the OLD hash, not just on the id
 *
 * `consent_hash = fromConsentHash` in the predicate, so a re-consent that
 * lands between the fire's recompute and this write is never clobbered by
 * a verdict taken against the row it superseded. Returns false when the
 * CAS found nothing — an unknown id, a revoked or disabled row, or
 * exactly that race. The caller carries on either way: the verdict was
 * "nothing widened", and failing to record it is a bookkeeping loss, not
 * an authority one.
 */
export async function carryDelegationConsentForward(
  id: string,
  fromConsentHash: string,
  carried: CarriedDelegationConsent,
): Promise<boolean> {
  const rows = await getDb()
    .update(workflowDelegations)
    .set({
      consentHash: carried.consentHash,
      definitionHash: carried.definitionHash,
      capabilitySet: carried.capabilitySet,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(workflowDelegations.id, id),
        eq(workflowDelegations.consentHash, fromConsentHash),
        delegationHoldsAuthority(),
      ),
    )
    .returning({ id: workflowDelegations.id });
  return rows.length > 0;
}

/** One delegation by id, revoked or not — history is readable. */
export async function getWorkflowDelegation(
  id: string,
): Promise<WorkflowDelegationRow | undefined> {
  const rows = await getDb()
    .select()
    .from(workflowDelegations)
    .where(eq(workflowDelegations.id, id));
  return rows[0];
}

/**
 * The LIVE delegation for an `(extension, job)` pair, if any.
 *
 * The fire-time lookup. `enabled` is deliberately NOT part of the
 * predicate: a disabled delegation still exists and its
 * `disabled_reason` is the only thing that can tell a user why their job
 * stopped, so the caller reads the row and refuses with the reason rather
 * than getting an indistinguishable "no such delegation".
 */
export async function findLiveWorkflowDelegation(
  extensionId: string,
  jobRef: string,
): Promise<WorkflowDelegationRow | undefined> {
  const rows = await getDb()
    .select()
    .from(workflowDelegations)
    .where(
      and(
        eq(workflowDelegations.extensionId, extensionId),
        eq(workflowDelegations.jobRef, jobRef),
        isNull(workflowDelegations.revokedAt),
      ),
    );
  return rows[0];
}

/**
 * Every live delegation a user consented to, newest first.
 *
 * Keyed on `consented_by_user_id` and not on the owner columns, because
 * that is the question the consent UI asks ("what have I authorized?")
 * and it is the one arm that is answerable for BOTH owner kinds — a
 * service account has no session to list its own rows from. Backed by
 * `idx_workflow_delegations_consented_by` (`db/schema.ts:718`).
 */
export async function listWorkflowDelegationsConsentedBy(
  userId: string,
): Promise<WorkflowDelegationRow[]> {
  return getDb()
    .select()
    .from(workflowDelegations)
    .where(
      and(
        eq(workflowDelegations.consentedByUserId, userId),
        isNull(workflowDelegations.revokedAt),
      ),
    )
    .orderBy(desc(workflowDelegations.consentedAt));
}

/**
 * Tombstone a live delegation. Returns false when it was already revoked
 * or never existed — the two are the same fact to a caller, "there is no
 * authority here now".
 *
 * The `revoked_at IS NULL` term in the predicate is what makes this
 * idempotent AND honest: a second revoke must not move the timestamp,
 * because that timestamp is the history the tombstone exists to keep.
 */
export async function revokeWorkflowDelegation(id: string): Promise<boolean> {
  const revoked = await getDb()
    .update(workflowDelegations)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(workflowDelegations.id, id), isNull(workflowDelegations.revokedAt)))
    .returning({ id: workflowDelegations.id });
  return revoked.length > 0;
}

/**
 * How many runs this delegation has started since `since` — the D8 daily
 * quota's numerator.
 *
 * `since` is supplied by the caller (`startOfUtcDay(new Date())`) rather
 * than computed here, for the same reason every other predicate in this
 * file takes its facts as arguments: a query layer that reads the clock
 * cannot be tested at a boundary, and "per day" has to mean the same
 * thing here as it does in `webhook-store.ts`, which is where that helper
 * already lives.
 *
 * CALENDAR day, never a rolling window. A rolling window is gameable at
 * the edges (fire N at 23:59, N more at 00:01 costs nothing under a
 * calendar day either — but a rolling window lets a caller drip-feed
 * indefinitely and never refill), and two subsystems answering "per day"
 * differently is a permanent support burden.
 *
 * DURABLE, unlike the extension's in-memory hourly window
 * (`extensions/workflows-handler.ts`): a restart must not refund a spend
 * bound on an unattended job. Served by
 * `idx_workflow_runs_delegation` (`db/schema.ts:901`), whose leading
 * column is `delegation_id` and whose second is `started_at`.
 */
export async function countDelegationRunsSince(
  delegationId: string,
  since: Date,
): Promise<number> {
  const rows: Array<{ n: number }> = await getDb()
    .select({ n: count() })
    .from(workflowRuns)
    .where(
      and(eq(workflowRuns.delegationId, delegationId), gte(workflowRuns.startedAt, since)),
    );
  return rows[0]?.n ?? 0;
}

/**
 * Turn a delegation OFF with a stated reason, without revoking it.
 *
 * Disabling and revoking are different facts and the schema keeps them in
 * different columns: revocation is the human withdrawing the authority
 * (a tombstone, `revoked_at`), while `enabled = false` + `disabled_reason`
 * is the PLATFORM saying "this authority can no longer be exercised, and
 * here is why". Only the second is re-enablable, and only the second has
 * anything to tell the user.
 *
 * The reason is the whole point of the call. C3's D7 rung exists because
 * a workflow re-tiered out of the owner's reach must produce a visible
 * "this job stopped and here is why" rather than silently accruing
 * `consecutive_failures` toward the auto-disable threshold of 5
 * (`extensions/schedule-daemon.ts:88`), where the user would eventually
 * be told only that the job failed too often.
 *
 * Filtered on `enabled` so a repeat is a no-op rather than a rewrite: the
 * FIRST reason is the one that explains the stop, and a later, vaguer one
 * overwriting it would lose the diagnosis. Revoked rows are excluded
 * because a tombstone holds no authority to withdraw.
 */
export async function disableWorkflowDelegation(
  id: string,
  reason: string,
): Promise<boolean> {
  const rows = await getDb()
    .update(workflowDelegations)
    .set({ enabled: false, disabledReason: reason, updatedAt: new Date() })
    .where(
      and(
        eq(workflowDelegations.id, id),
        eq(workflowDelegations.enabled, true),
        isNull(workflowDelegations.revokedAt),
      ),
    )
    .returning({ id: workflowDelegations.id });
  return rows.length > 0;
}

/**
 * The two bounds this function may write, and at least one of them.
 *
 * A union rather than `{a?: number; b?: number}` so "call it with nothing"
 * is a COMPILE error instead of a silent `UPDATE` that moves only
 * `updated_at`. The route validates the same rule on the wire; this makes
 * the second caller — a CLI, a migration — unable to get it wrong either.
 */
export type DelegationRunBounds =
  | { maxTokensPerRun: number; maxRunsPerDay?: number }
  | { maxTokensPerRun?: number; maxRunsPerDay: number };

/**
 * Raise or lower a LIVE delegation's SPEND BOUNDS, IN PLACE —
 * `max_tokens_per_run`, `max_runs_per_day`, or both.
 *
 * ## Both, and why the second one belongs here
 *
 * This started as a token-ceiling writer, because the token ceiling was the
 * bound that had a deadlock. `max_runs_per_day` (rung D8) had no deadlock —
 * a job over its daily run quota is un-stuck by tomorrow — so it was left
 * out on the narrower argument that the surface should be no bigger than the
 * problem. That argument does not survive contact with the alternative:
 * adjusting D8's throttle meant a full re-consent, which mints a NEW row,
 * tombstones the old one and asks a human to re-approve a capability set
 * that did not change. Ruling 2 makes the consent hash the version id of
 * approved MATERIAL; neither of these numbers is material — they bound what
 * the approved thing may SPEND, not what it may DO — so both belong on the
 * in-place path for exactly the same reason, and putting one there while
 * routing the other through consent trains people to click through consent
 * dialogs.
 *
 * ## Why this exists at all — the deadlock it closes
 *
 * `RESUME_RULES["budget-exceeded"]` says in its own prose that "only
 * raising that cap lets it continue" (`runtime/workflow-resume-reasons.ts`).
 * Before this function there was no way to raise it. The only writer of
 * `max_tokens_per_run` was {@link createWorkflowDelegation}, which
 * TOMBSTONES the row it supersedes — so the naive remedy (re-consent)
 * revoked the very delegation the parked run's predicate then re-read,
 * and the predicate fails closed on a revoked row. Every parked run was
 * stuck forever: the permanent-denial-of-service shape.
 *
 * Phase 6 closed that on the re-consent path by carrying `suspended` runs
 * forward inside the supersede transaction (see the block in
 * {@link createWorkflowDelegation}). This closes it on the OTHER path —
 * the one where the human does not want to re-approve a capability set
 * they already approved, they just want the cap raised. Both are kept:
 * the supersede carry-forward is the safety net for a path that mints a
 * new row, and this is the intended adjustment for a live one.
 *
 * ## What it deliberately does NOT touch
 *
 * The `.set()` can name at most three columns and the third is
 * `updated_at`. `consent_hash`, `capability_set`, `workflow_name`,
 * `owner_kind`, both owner columns, `definition_version_id`, `project_id`,
 * the trigger pair, `enabled`, `disabled_reason`, `consented_at` and
 * `consented_by_user_id` are all untouched, and that is Ruling 2 expressed
 * as code rather than as a comment: the consent hash IS the version id of
 * what the human approved, so ANY edit to the approved material must go
 * back through consent. Neither spend bound is part of that material —
 * they bound what the approved thing may spend, not what it may do — which
 * is exactly why they are adjustable here and nothing else is.
 *
 * `consented_at` in particular is NOT re-stamped. It records when a human
 * last looked at the material; moving it because somebody changed a number
 * would make a grant look freshly reviewed when it was not, and the
 * consent-staleness answer is read off it.
 *
 * ## Live rows only, and the filter is the whole point
 *
 * `revoked_at IS NULL AND enabled` — the same predicate
 * {@link delegationHoldsAuthority} states for the answer path, and for
 * two separate reasons:
 *
 *  - A REVOKED row is a tombstone. Its authority was withdrawn; giving it
 *    a bigger budget is either meaningless or a resurrection, and the
 *    `budget-exceeded` predicate fails closed on it anyway, so a caller
 *    that "succeeded" here would have been lied to.
 *  - A DISABLED row was switched off BY THE PLATFORM with a stated reason
 *    (`disabled_reason` — {@link disableWorkflowDelegation}), and the two
 *    writers of that state are a workflow re-tiered out of the owner's
 *    reach (rung D7) and five consecutive failures. Neither is fixed by
 *    raising a token cap, and clearing the flag here would re-grant the
 *    answer-path authority `delegationHoldsAuthority` withdrew — BEFORE
 *    any fire re-asks D7's question. Re-consent is the re-enable path,
 *    and it is the correct one precisely because it re-asks that question
 *    (`authorizeDelegationConsent`) before writing an enabled row.
 *
 * Returns the updated row, or `undefined` when the CAS found nothing —
 * unknown id, revoked, or disabled. The caller has already read the row
 * (it has to, to authorize the actor) and reports the reason from that;
 * this filter is the belt for a revoke that lands between the two.
 */
export async function setDelegationRunBounds(
  id: string,
  bounds: DelegationRunBounds,
): Promise<WorkflowDelegationRow | undefined> {
  // Built key by key rather than spread: a spread of the argument would put
  // `maxRunsPerDay: undefined` into the `.set()` for a tokens-only patch, and
  // whether that writes NULL or is skipped is the driver's business, not a
  // thing this file should be betting a NOT NULL column on.
  const patch: Partial<Pick<WorkflowDelegationRow, "maxTokensPerRun" | "maxRunsPerDay">> & {
    updatedAt: Date;
  } = { updatedAt: new Date() };
  if (bounds.maxTokensPerRun !== undefined) patch.maxTokensPerRun = bounds.maxTokensPerRun;
  if (bounds.maxRunsPerDay !== undefined) patch.maxRunsPerDay = bounds.maxRunsPerDay;

  const rows = await getDb()
    .update(workflowDelegations)
    .set(patch)
    .where(
      and(
        eq(workflowDelegations.id, id),
        isNull(workflowDelegations.revokedAt),
        eq(workflowDelegations.enabled, true),
      ),
    )
    .returning();
  return rows[0];
}

/**
 * The auto-disable threshold: consecutive failed runs after which a
 * delegation switches itself off.
 *
 * Deliberately the SAME number as `AUTO_DISABLE_AFTER` in
 * `extensions/schedule-daemon.ts:88`. Reusing the value matters more than
 * the value: an operator who has learned what "disabled after 5 failures"
 * means for a schedule should not have to learn a second number for a
 * delegation.
 */
export const DELEGATION_AUTO_DISABLE_AFTER = 5;

/** What {@link recordDelegationRunOutcome} did, so a caller can log or
 *  audit the auto-disable without re-reading the row. */
export interface DelegationOutcomeResult {
  consecutiveFailures: number;
  autoDisabled: boolean;
}

/**
 * Fold one run outcome into the delegation's failure counter.
 *
 * Success RESETS to zero rather than decrementing: the counter answers
 * "is this job broken right now?", and a job that succeeds is not
 * partially broken. Failure increments, and at
 * {@link DELEGATION_AUTO_DISABLE_AFTER} the row disables itself with a
 * reason naming the count.
 *
 * `SET x = x + 1` in SQL rather than read-modify-write, so two fires
 * landing together cannot both read 4 and both write 5.
 *
 * Returns `{consecutiveFailures: 0, autoDisabled: false}` for a row that
 * no longer exists or is already revoked — there is no counter to move
 * and no authority to disable, which is the same fact a caller acts on
 * either way.
 */
export async function recordDelegationRunOutcome(
  id: string,
  success: boolean,
): Promise<DelegationOutcomeResult> {
  const rows: Array<{ consecutiveFailures: number }> = await getDb()
    .update(workflowDelegations)
    .set({
      consecutiveFailures: success ? 0 : sql`${workflowDelegations.consecutiveFailures} + 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(workflowDelegations.id, id), isNull(workflowDelegations.revokedAt)))
    .returning({ consecutiveFailures: workflowDelegations.consecutiveFailures });
  const consecutiveFailures = rows[0]?.consecutiveFailures ?? 0;
  if (consecutiveFailures < DELEGATION_AUTO_DISABLE_AFTER) {
    return { consecutiveFailures, autoDisabled: false };
  }
  const autoDisabled = await disableWorkflowDelegation(
    id,
    `Disabled automatically after ${consecutiveFailures} consecutive failed runs.`,
  );
  return { consecutiveFailures, autoDisabled };
}

/**
 * Every version id held by a live delegation — the argument
 * `VersionSweepOptions.pinnedVersionIds` demands.
 *
 * That field is REQUIRED rather than optional precisely so this call
 * cannot be forgotten (`db/queries/workflow-versions.ts:299-310`): the
 * one production caller is a daily sub-tick inside a `try/catch` that
 * logs `warn` and carries on, so a missing pin would turn the
 * `ON DELETE RESTRICT` on `definition_version_id` into a log line and
 * stop the sweep reaping — permanently, silently, from a line no test can
 * observe.
 *
 * Revoked rows are excluded on purpose. A tombstone holds no authority,
 * so it must not hold a snapshot hostage forever either; and the FK's
 * RESTRICT would still refuse a delete that mattered, which is the belt
 * to this braces.
 */
export async function listPinnedDelegationVersionIds(): Promise<string[]> {
  const rows: Array<{ id: string | null }> = await getDb()
    .selectDistinct({ id: workflowDelegations.definitionVersionId })
    .from(workflowDelegations)
    .where(
      and(
        isNull(workflowDelegations.revokedAt),
        isNotNull(workflowDelegations.definitionVersionId),
      ),
    );
  // The `IS NOT NULL` above already excludes them; the narrowing filter
  // is what makes that a TYPE fact rather than a promise about a
  // predicate written elsewhere in the same call.
  return rows.map((r) => r.id).filter((id): id is string => id !== null);
}
