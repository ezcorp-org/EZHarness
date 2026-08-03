/**
 * C3's **consent-time policy** — everything the consent route decides
 * before a `workflow_delegations` row exists, expressed once, purely, and
 * shared with the fire-time ladder that re-asks the same questions.
 *
 * Three separate decisions live here, and they are together on purpose:
 *
 *  1. {@link delegationPrincipal} — which {@link WorkflowCaller} a
 *     delegation's `owner_kind` actually carries.
 *  2. {@link authorizeDelegationConsent} — may that principal RUN the
 *     workflow being consented to, asked **as the principal the
 *     delegation will carry** rather than as the human clicking the
 *     button.
 *  3. {@link resolveDelegationVersionPin} — which
 *     `definition_version_id` the row may pin without the consent record
 *     and the audit trail disagreeing later.
 *
 * ## Why this is a module and not three route-local helpers
 *
 * Every one of these is asked twice: once at consent time (here, in
 * `web/`) and again at every fire (C3 phase 6, rung D7, in `src/`).
 * `workflow-scope.ts` states the hazard for its own list route —
 * *"Two independently-correct filters is how you get a workflow that a
 * caller can run but cannot find in the list"* — and the delegated
 * version of that bug is worse: a consent-time answer that disagrees
 * with the fire-time answer either grants authority the human never saw,
 * or stales every fire of a delegation nobody can fix. So the rule
 * exists once and both callers import it.
 *
 * ## PURE, deliberately
 *
 * No DB, no registry, no clock. The cache entries, the version identity
 * and the two capability lookups all arrive as arguments, which is what
 * makes the owner-kind matrix cheap enough to test exhaustively — and it
 * is also the seam where the most dangerous mistake in this feature is
 * made, so see {@link buildConsentHashSources}.
 */
import type { WorkflowDefinition } from "../types";
import type { DelegationOwnerKind } from "../db/schema";
import type {
  ConsentCapability,
  ConsentHashSources,
  WorkflowIdentityResolver,
} from "./workflow-capability-hash";
import type { WorkflowResolver } from "./workflow-closure";
import { workflowDefinitionHash } from "./workflow-definition-hash";
import {
  resolveWorkflowForCaller,
  type CachedWorkflow,
  type WorkflowCaller,
} from "./workflow-scope";

/**
 * Every way a delegation can be refused, named.
 *
 * A generic `DELEGATION_OWNER_UNAUTHORIZED` was considered and rejected:
 * two of these drive completely different human remedies, and one of
 * them has to survive into `workflow_delegations.disabled_reason` where
 * it is the only thing a user will ever see about why their cron job
 * stopped.
 */
export const DELEGATION_CONSENT_DENIALS = {
  /** The owner's view cannot resolve the name at all. */
  NOT_FOUND: "DELEGATION_WORKFLOW_NOT_FOUND",
  /**
   * The principal the delegation would carry may not run the workflow —
   * **asked at consent time, before the row is written.**
   *
   * The remedy is a choice the human makes now: pick "run as me", or ask
   * an admin to widen the workflow. Refusing here is the whole of
   * amended spec §6.1: a service account carries `userId: null` and so
   * satisfies `visibility: 'system'` only, while fork — C3's headline
   * use case — stamps `project`
   * (`web/src/routes/api/workflows/[name]/fork/+server.ts:65`). Without
   * this check the user discovers it at the first cron tick as a generic
   * fire-time denial, while `consecutive_failures` accrues silently to
   * the auto-disable threshold of 5 (`extensions/schedule-daemon.ts:88`).
   */
  OWNER_CANNOT_RUN: "DELEGATION_OWNER_CANNOT_RUN_WORKFLOW",
  /**
   * **RESERVED FOR PHASE 6 (rung D7). Emitted by the fire-time re-ask,
   * never by the consent route.**
   *
   * Visibility is mutable. A `system` workflow that was legitimately
   * consented to can be re-tiered to `project` afterwards, at which
   * point a `service`-kind delegation stops being authorized. That is
   * CORRECT behaviour and it is a different fact from
   * {@link DELEGATION_CONSENT_DENIALS.OWNER_CANNOT_RUN}: nothing the
   * human did was wrong, the world moved. It needs its own code because
   * it is what drives `disabled_reason` and a visible "this job stopped
   * and here is why" — folding it into the consent-time code would make
   * the two indistinguishable in the one place a user reads them.
   *
   * Declared here rather than in phase 6 so the two codes are minted
   * together and cannot collide, and so the distinction is reviewable in
   * the change that creates the first of them.
   */
  OWNER_LOST_ACCESS: "DELEGATION_OWNER_LOST_WORKFLOW_ACCESS",
  /**
   * The row would pin a `definition_version_id` that the run it
   * authorizes will then decline to record. See
   * {@link resolveDelegationVersionPin}.
   */
  VERSION_DIVERGENCE: "DELEGATION_VERSION_DIVERGENCE",
  /**
   * A LIVE delegation already exists for this (extension, job) and a
   * DIFFERENT human consented to it.
   *
   * Re-consent supersedes: the live row is tombstoned and a fresh one
   * written, because that is what "the workflow changed, approve it
   * again" means. But superseding somebody else's consent is not
   * re-consent, it is replacing their decision with yours — and
   * `consented_by_user_id` is load-bearing beyond bookkeeping (it is the
   * human who may answer a service-account run's approvals,
   * `db/schema.ts:659-668`), so quietly reassigning it would hand one
   * user's answering authority to another.
   */
  NOT_CONSENTER: "DELEGATION_CONSENT_NOT_YOURS",
} as const;

export type DelegationConsentDenialCode =
  (typeof DELEGATION_CONSENT_DENIALS)[keyof typeof DELEGATION_CONSENT_DENIALS];

/**
 * `owner_kind` → the principal a run under that kind carries.
 *
 * A KEYED LOOKUP, for the same reason `DELEGATION_OWNER_COLUMN`
 * (`db/schema.ts:587-590`) is one: a two-armed `switch` over a two-value
 * union compiles today and falls silently through the day a third
 * principal kind exists. `satisfies Record<DelegationOwnerKind, …>` makes
 * a new kind a compile error here instead.
 *
 * The `service` arm takes `userId: null` and DISCARDS the owner id it is
 * handed — that is not an oversight, it is the whole reach model. A
 * service account has no `users` row, so there is no user identity for
 * the ladder to admit; `authorizeWorkflow` grants it `system` and
 * nothing else (`workflow-scope.ts:302-313`, `:312` is the test it
 * fails).
 */
const DELEGATION_PRINCIPAL = {
  user: (ownerId: string | null): WorkflowCaller => ({ userId: ownerId, role: "member" }),
  service: (): WorkflowCaller => ({ userId: null, role: "member" }),
} as const satisfies Record<DelegationOwnerKind, (ownerId: string | null) => WorkflowCaller>;

/**
 * The {@link WorkflowCaller} a delegation of this kind will actually run
 * as.
 *
 * `role: "member"` for BOTH arms, deliberately and in both directions:
 * an admin's delegation must not carry admin authority into an unattended
 * cron tick (the human is not there to see what it reaches), and a
 * service account has no role to inherit in the first place.
 */
export function delegationPrincipal(
  ownerKind: DelegationOwnerKind,
  ownerUserId: string | null,
): WorkflowCaller {
  return DELEGATION_PRINCIPAL[ownerKind](ownerUserId);
}

export type DelegationConsentAuthorization =
  | { ok: true; entry: CachedWorkflow }
  | { ok: false; code: DelegationConsentDenialCode; message: string };

/**
 * Human-readable refusals, per owner kind, that name the REASON and the
 * REMEDY.
 *
 * Keyed rather than switched, same rule as everywhere else in this file.
 * A generic 403 was the alternative and it is the failure mode amended
 * spec §6.1 exists to prevent: the user's next action differs completely
 * between the two arms, so the message has to differ too.
 */
const OWNER_CANNOT_RUN_MESSAGE = {
  service: (workflowName: string) =>
    `A service account can only run system-visible workflows, and "${workflowName}" is not one. ` +
    `Choose "run as me", or ask an admin to make the workflow system-visible.`,
  user: (workflowName: string) =>
    `You cannot run "${workflowName}", so you cannot delegate it. ` +
    `Ask the workflow's owner or an admin for access first.`,
} as const satisfies Record<DelegationOwnerKind, (workflowName: string) => string>;

/**
 * **The load-bearing consent-time check (amended spec §6.1, BINDING).**
 *
 * Authorizes AS THE PRINCIPAL THE DELEGATION WILL CARRY, not as the human
 * consenting. Those are different principals whenever
 * `owner_kind = 'service'`, and the whole point of the check is that the
 * difference is invisible to the person clicking the button.
 *
 * ## This does NOT replace the fire-time check
 *
 * Visibility is mutable, so phase 6's rung D7 asks again on every fire
 * and refuses with
 * {@link DELEGATION_CONSENT_DENIALS.OWNER_LOST_ACCESS}. This check exists
 * so the HUMAN learns immediately, at the moment they can still choose
 * the other arm — not three days later, from an audit row, after the
 * scheduler has quietly auto-disabled the job.
 */
export function authorizeDelegationConsent(
  entries: readonly CachedWorkflow[],
  workflowName: string,
  ownerKind: DelegationOwnerKind,
  ownerUserId: string | null,
): DelegationConsentAuthorization {
  const resolution = resolveWorkflowForCaller(
    entries,
    workflowName,
    delegationPrincipal(ownerKind, ownerUserId),
    // "run", never "read". `workflow-scope.ts` splits the two precisely
    // so C3 cannot inherit a hole where SEEING a workflow implies being
    // able to fire it on someone else's behalf.
    "run",
  );
  if (resolution.ok) return { ok: true, entry: resolution.entry };
  if (resolution.reason === "not-found") {
    return {
      ok: false,
      code: DELEGATION_CONSENT_DENIALS.NOT_FOUND,
      message: `No workflow named "${workflowName}" is visible to this principal.`,
    };
  }
  return {
    ok: false,
    code: DELEGATION_CONSENT_DENIALS.OWNER_CANNOT_RUN,
    message: OWNER_CANNOT_RUN_MESSAGE[ownerKind](workflowName),
  };
}

/** The pinnable snapshot of the definition a delegation names. */
export interface DelegationVersionCandidate {
  id: string;
  stepsHash: string;
}

export type DelegationVersionPin =
  | { ok: true; definitionVersionId: string | null }
  | { ok: false; code: DelegationConsentDenialCode; message: string };

/**
 * ## The pinned-version divergence — RESOLVED BY DETECTION, at consent
 * time, and here is why that and not the other option.
 *
 * `workflow-capability-hash.ts:20-31` leaves an explicit obligation:
 * `definition_version_id` is written onto a run **only on an exact
 * content match** — `const ranVersion = version?.stepsHash === ranHash ?
 * version : undefined;` (`workflow-executor.ts:629`, written `:642`). So
 * a delegation can pin a version the run then does not record, and the
 * consent record and the audit trail disagree about which version
 * executed. The obligation is: *"Either write the pinned id onto the run
 * regardless, or assert the divergence is detected and surfaced."*
 *
 * **We detect, and we refuse the consent. We do NOT write the pinned id
 * onto the run regardless.** Three reasons, in order of weight:
 *
 *  1. Writing it regardless would make the column MEAN something else.
 *     Its documented meaning is "the snapshot this run executed"
 *     (`workflow-executor.ts:618-629`), NULL means "cannot name the
 *     snapshot this run executed", and the comment ends by forbidding
 *     exactly the widening we would be doing. That column is not
 *     decoration: `sweepWorkflowDefinitionVersions` excludes versions a
 *     surviving run references (`db/queries/workflow-versions.ts:320-331`)
 *     and `getRunVersionLabel` renders it to users. Making it a claim
 *     nobody verified corrupts a retention decision and an audit label to
 *     fix a reporting mismatch.
 *  2. Detection here is strictly EARLIER than detection at run time, and
 *     it is the same argument §6.1 makes for the visibility refusal: the
 *     human is present, and a divergence they are told about at consent
 *     is a divergence they can resolve (save the workflow, then consent)
 *     rather than a discrepancy they find in a trace weeks later.
 *  3. It is fully computable here. The executor's test is
 *     `version.stepsHash === workflowDefinitionHash(<the definition the
 *     cache served>)`, and both sides of that comparison are in hand at
 *     consent time — the cache entry we just authorized, and the latest
 *     version of the row that owns the name.
 *
 * The invariant this buys, which is the thing worth having: **a
 * delegation's `definition_version_id`, when non-null, is exactly the id
 * the run it authorizes will record.** A null pin is not a divergence —
 * it is the documented unversioned path for a YAML or extension
 * workflow, which has no `workflow_definitions` row to version
 * (`db/schema.ts:629-631`, `workflow-executor.ts:602-608`).
 *
 * The two divergent cases this refuses are the two the executor's own
 * comment names (`:614-628`): a YAML or extension entry winning the name
 * race against a DB row, and a definition whose content has run ahead of
 * its newest version because `updateWorkflow` and `ensureWorkflowVersion`
 * are two writes.
 */
export function resolveDelegationVersionPin(
  entry: CachedWorkflow,
  latestVersion: DelegationVersionCandidate | undefined,
  workflowName: string,
): DelegationVersionPin {
  // No row, no version, nothing to pin. The FK is nullable for exactly
  // this and the run will record NULL too, so the two agree.
  if (latestVersion === undefined) return { ok: true, definitionVersionId: null };
  const servedHash = workflowDefinitionHash(entry.definition);
  if (latestVersion.stepsHash === servedHash) {
    return { ok: true, definitionVersionId: latestVersion.id };
  }
  return {
    ok: false,
    code: DELEGATION_CONSENT_DENIALS.VERSION_DIVERGENCE,
    message:
      `The saved snapshot of "${workflowName}" does not match the definition that would run, ` +
      `so a run started from this delegation could not record which version it executed. ` +
      `Save the workflow again, then re-consent.`,
  };
}

/**
 * The two lookups {@link buildConsentHashSources} cannot answer purely.
 *
 * Both follow {@link ConsentHashSources}'s contract exactly: `undefined`
 * means the registry CANNOT REACH the subject, which is a different fact
 * from reaching it and finding it declares nothing, and the two must not
 * hash alike (T11 — an extension narrowing its manifest so a step's tool
 * becomes unreachable has changed the behaviour, so consent is stale even
 * though the set only shrank).
 */
export interface DelegationConsentLookups {
  capabilitiesForTool: (tool: string) => readonly ConsentCapability[] | undefined;
  capabilitiesForAgent: (agent: string) => readonly ConsentCapability[] | undefined;
  identify: WorkflowIdentityResolver;
}

/**
 * A {@link WorkflowResolver} that sees exactly what the delegation's
 * principal sees — **the single most dangerous seam in this feature**,
 * per `workflow-capability-hash.ts:138-148`.
 *
 * The closure walk authorizes as whatever principal its resolver closes
 * over. Handing it the flat merged cache would fingerprint a graph that
 * is NOT the one that runs: a `service` delegation's nested edge into a
 * `project`-visible child resolves for the flat cache and does not
 * resolve for the principal, so the hash would certify a step the run
 * will refuse — or, in the direction that actually matters, would keep
 * certifying after a child was re-tiered out of the principal's reach.
 *
 * Exported so phase 6's fire-time recompute uses this resolver and not a
 * second one. Two resolvers that disagree by one nested edge stale every
 * fire of a delegation nobody can then re-consent.
 */
export function delegationWorkflowResolver(
  entries: readonly CachedWorkflow[],
  principal: WorkflowCaller,
): WorkflowResolver {
  return (name: string): WorkflowDefinition | undefined => {
    const resolution = resolveWorkflowForCaller(entries, name, principal, "run");
    // A denial and a missing name collapse to the same `undefined`, and
    // that is right: the closure records both as `unresolved`, the hash
    // covers `unresolved` (`workflow-capability-hash.ts:349-356`), and
    // "the principal cannot reach this child" is precisely the fact
    // consent needs to pin. Distinguishing them here would leak the
    // existence of a workflow the principal may not see into a value the
    // consenting human is shown.
    return resolution.ok ? resolution.entry.definition : undefined;
  };
}

/**
 * Assemble the four sources `computeWorkflowConsentHash` needs, with the
 * owner's resolver already wired.
 *
 * One function so that consent time and fire time cannot drift on which
 * principal the graph was resolved for — the failure that would otherwise
 * be silent, permanent and unfixable from the UI.
 */
export function buildConsentHashSources(
  entries: readonly CachedWorkflow[],
  principal: WorkflowCaller,
  lookups: DelegationConsentLookups,
): ConsentHashSources {
  return {
    resolve: delegationWorkflowResolver(entries, principal),
    identify: lookups.identify,
    capabilitiesForTool: lookups.capabilitiesForTool,
    capabilitiesForAgent: lookups.capabilitiesForAgent,
  };
}
