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
import { and, desc, eq, isNull, isNotNull } from "drizzle-orm";
import { getDb } from "../connection";
import {
  DELEGATION_OWNER_COLUMN,
  serviceAccounts,
  workflowDelegations,
  type DelegationOwnerKind,
  type ServiceAccountRow,
  type WorkflowDelegationRow,
} from "../schema";
import {
  DELEGATION_CONSENT_DENIALS,
  type DelegationConsentDenialCode,
} from "../../runtime/workflow-delegation-consent";

/** Every owner column the discriminator can name, derived from the map. */
const OWNER_COLUMNS = Object.values(DELEGATION_OWNER_COLUMN);

/**
 * The owner columns for one `(kind, id)` pair: the mapped column carries
 * the id and **every other owner column is explicitly NULL**.
 *
 * Explicit rather than omitted, because this shape is also used by
 * {@link supersedeAndCreate}'s insert where a missing key would leave a
 * stale value on a re-consent that switched arms — a row that names both
 * a user and a service account is exactly as ambiguous as one that names
 * neither.
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
 * The one service-account read the consent gate needs: does this account
 * exist, and is it live?
 *
 * **Narrow on purpose, and it is not the service-account CRUD module.**
 * That module (`db/queries/service-accounts.ts`) is a separate phase and
 * a separate owner; this is a single existence-and-liveness read that the
 * consent path cannot do without, because the alternative is letting the
 * `owner_service_account_id` FK reject a bogus id at INSERT time. Catching
 * that violation would make the database error the control — the same
 * inversion `VersionSweepOptions.pinnedVersionIds` refuses
 * (`workflow-versions.ts:299-306`) — and it would surface as a 500 where
 * the caller deserves a named 400. Fold this into the CRUD module when it
 * lands; nothing outside this file calls it.
 */
export async function findLiveServiceAccount(
  id: string,
): Promise<ServiceAccountRow | undefined> {
  const rows = await getDb()
    .select()
    .from(serviceAccounts)
    .where(and(eq(serviceAccounts.id, id), eq(serviceAccounts.enabled, true)));
  return rows[0];
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
  consentHash: string;
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
  return getDb().transaction(async (tx: any): Promise<CreateWorkflowDelegationResult> => {
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
        capabilitySet: input.capabilitySet,
        maxTokensPerRun: input.maxTokensPerRun,
        maxRunsPerDay: input.maxRunsPerDay,
        consentedByUserId: input.consentedByUserId,
      })
      .returning();
    return { ok: true, delegation: inserted!, supersededId: existing?.id ?? null };
  });
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
