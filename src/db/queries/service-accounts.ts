/**
 * C3 — the `service_accounts` query layer.
 *
 * A service account is an admin-created, NON-HUMAN principal that exists
 * solely as a `run_as` target for a delegated workflow. The table's own
 * rationale lives on the schema (`src/db/schema.ts:505-562`); this module is
 * where the two rules that cannot be expressed as columns are ENFORCED:
 *
 *  1. **Scopes are clamped to the creating admin.** {@link createServiceAccount}
 *     takes the creator as a principal and resolves their effective scope set
 *     itself, so "mint a principal broader than yourself" has no expressible
 *     form — a caller cannot skip the clamp by not calling it. Admins resolve
 *     to the `RBAC_ALL_SCOPES` sentinel today (`src/auth/extension-rbac.ts:69`,
 *     `:97`), so the clamp is a no-op until narrower admin roles exist; it is
 *     written now because retrofitting it later means auditing every row that
 *     was created without it.
 *
 *  2. **Deletion is loud, never silent.** `workflow_delegations
 *     .owner_service_account_id` is `ON DELETE CASCADE` (`schema.ts:617`), so
 *     dropping an account would take every authority granted to it with no
 *     trace. {@link deleteServiceAccount} refuses while live delegations name
 *     it — the same argument `created_by_user_id`'s `ON DELETE RESTRICT`
 *     (`schema.ts:539`) makes one level up.
 *
 * ## Owner-kind resolution is a KEYED LOOKUP
 *
 * Anywhere this module has to ask "which column carries the owner for this
 * kind?", it indexes {@link DELEGATION_OWNER_COLUMN} — the map the schema
 * already ships (`schema.ts:587-590`) — and never a two-armed `switch`. A
 * `switch` over a two-value union compiles today and falls through silently
 * the day a third principal kind exists. {@link DELEGATION_OWNER_CALLER} is
 * the one other keyed map C3 needs (kind → the ladder principal that kind
 * carries); it is a DIFFERENT question with a different codomain, not a second
 * copy of the column map, and `service-accounts.test.ts` pins that the two
 * carry identical key sets so extending one without the other fails loudly.
 *
 * ## What is NOT here
 *
 * Delegation CRUD and the consent route (`workflow_delegations` writes) are a
 * separate module. The only delegation access below is the read
 * {@link countLiveDelegationsOwnedBy}, which exists for rule 2.
 */
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../connection";
import {
  DELEGATION_OWNER_COLUMN,
  serviceAccounts,
  workflowDelegations,
  type DelegationOwnerKind,
  type ServiceAccountRow,
} from "../schema";
import { resolveEffectiveScopes, type RbacUser } from "../../auth/extension-rbac";
import { isValidRbacScopeName } from "../../extensions/rbac-scopes";
import { delegationPrincipal } from "../../runtime/workflow-delegation-consent";
import {
  authorizeWorkflow,
  systemCachedWorkflow,
  type CachedWorkflow,
  type WorkflowCaller,
} from "../../runtime/workflow-scope";
import type { WorkflowVisibility } from "../../types";

export type { ServiceAccountRow };

/** The principal {@link createServiceAccount} clamps against — `RbacUser`
 *  (`src/auth/extension-rbac.ts:37`), NOT a local copy of it: the ceiling is
 *  whatever the RBAC resolver says it is, so the type that names the input
 *  must be the one the resolver accepts. Structurally satisfied by `AuthUser`
 *  and by a full `users` row. */
export type { RbacUser };

// ── owner-kind resolution ──────────────────────────────────────────────────

/**
 * `owner_kind` → the ladder principal a delegation of that kind CARRIES.
 *
 * The second half of `DELEGATION_OWNER_COLUMN`: that map says which column
 * holds the owner, this one says what the owner means to
 * {@link authorizeWorkflow}. Keyed and `satisfies Record<DelegationOwnerKind,
 * …>` for the same reason — a third principal kind is one new entry, and
 * omitting it is a compile error rather than a fallthrough.
 *
 * ## Every arm DELEGATES to `delegationPrincipal`, and that is the point
 *
 * This map is what the reach warning is DERIVED from; `delegationPrincipal`
 * (`runtime/workflow-delegation-consent.ts`) is what the §6.1 consent gate
 * actually refuses with. Two hand-written maps from the same union to the
 * same codomain is precisely the shape both modules' docblocks argue
 * against — and the direction it fails is the worst one available here: the
 * admin is SHOWN one reach at creation time while the gate ENFORCES another,
 * which is the "looks fixed" failure amended spec §6.3 names. So there is one
 * definition of what a kind carries, and this is the keyed view of it.
 *
 * `service` ignores the owner id on purpose: a service account has no `users`
 * row, so the principal it carries is `userId: null`. That single `null` is
 * the whole of the reach warning below — see {@link SERVICE_ACCOUNT_CALLER}.
 */
export const DELEGATION_OWNER_CALLER = {
  user: (ownerId: string): WorkflowCaller => delegationPrincipal("user", ownerId),
  service: (ownerId: string): WorkflowCaller => delegationPrincipal("service", ownerId),
} as const satisfies Record<DelegationOwnerKind, (ownerId: string) => WorkflowCaller>;

/**
 * The principal EVERY service account carries, whichever account it is.
 *
 * `role: "member"` and not `"admin"`: the account is created by an admin, it
 * is not one. `userId: null` because there is no `users` row to point at —
 * and that is not a gap to be filled later, it is the identity's defining
 * property (it cannot authenticate, so it cannot have a login).
 *
 * Asked of `delegationPrincipal` rather than written out, so the caller
 * {@link serviceAccountReach} probes the ladder with is BY CONSTRUCTION the
 * caller the consent gate authorizes with. A literal here would agree today
 * and would stop agreeing silently — and the reach warning's whole job is to
 * tell an admin, at creation time, what the gate will do at consent time.
 *
 * `null` for the id because the `service` arm discards it (there is no id to
 * carry); passing an account id would suggest the principal varies per
 * account, which is the misreading this constant exists to prevent.
 */
export const SERVICE_ACCOUNT_CALLER: WorkflowCaller = delegationPrincipal("service", null);

/**
 * Every workflow visibility tier, probed one by one below.
 *
 * `WorkflowVisibility` (`src/types.ts:596`) is a bare union with no runtime
 * enumeration, so this list is written out — and `satisfies` does NOT make it
 * exhaustive: it checks each entry is a valid tier, not that every tier is an
 * entry. A fourth tier would compile fine here and silently never be probed,
 * so exhaustiveness is pinned at TEST time instead, by parsing the union out
 * of `src/types.ts` and comparing (`service-accounts-queries.test.ts`).
 * Exported for exactly that test — there is nothing else to compare against.
 */
export const ALL_VISIBILITIES = ["system", "project", "private"] as const satisfies readonly WorkflowVisibility[];

/** A workflow the caller does NOT own, at `visibility`. `systemCachedWorkflow`
 *  builds the ownerless shape (`workflow-scope.ts:88-106`); the visibility is
 *  then varied, which is exactly the axis being probed. */
function probeEntry(visibility: WorkflowVisibility): CachedWorkflow {
  return {
    ...systemCachedWorkflow({ name: "__reach_probe__", description: "", steps: [] }, "yaml"),
    visibility,
  };
}

/** The machine-readable reason a service account is narrower than a user.
 *  Distinct from `DELEGATION_OWNER_UNAUTHORIZED`, which is the generic
 *  fire-time denial — this one names WHY and can drive a specific message. */
export const SERVICE_ACCOUNT_REACH_CODE = "SERVICE_ACCOUNT_SYSTEM_ONLY" as const;

export interface ServiceAccountReach {
  code: typeof SERVICE_ACCOUNT_REACH_CODE;
  /** The visibility tiers a service account may RUN, derived from the ladder. */
  runnableVisibilities: WorkflowVisibility[];
  /** Human-facing sentence for the creation UI and the consent refusal. */
  message: string;
}

/**
 * What a service account can reach — DERIVED from the ladder, never asserted.
 *
 * The spec states the answer ("`system` and nothing else") and it is right
 * today, but a constant that agrees with the ladder by coincidence stops
 * agreeing the moment the ladder moves, and nothing fails. So this runs the
 * real {@link authorizeWorkflow} against the real
 * {@link SERVICE_ACCOUNT_CALLER} once per tier and reports what came back.
 *
 * The probe uses an OWNERLESS workflow, and for this caller that is not a
 * simplification: `isOwner` is `entry.userId !== null && entry.userId ===
 * caller.userId` (`workflow-scope.ts:269`), and `caller.userId` is `null`, so
 * a service account can never own anything. The probe is therefore exact.
 *
 * Surfaced at CREATION time (spec §6.5) and not only at consent time: an admin
 * who is not told here learns it when a user picks the account for a forked
 * workflow — fork stamps `visibility: "project"`
 * (`web/src/routes/api/workflows/[name]/fork/+server.ts:65`) — and files a bug
 * against the consent refusal instead.
 */
export function serviceAccountReach(): ServiceAccountReach {
  const runnable = ALL_VISIBILITIES.filter(
    (visibility) => authorizeWorkflow(probeEntry(visibility), SERVICE_ACCOUNT_CALLER, "run").ok,
  );
  return {
    code: SERVICE_ACCOUNT_REACH_CODE,
    runnableVisibilities: [...runnable],
    message:
      `A service account has no user identity, so it can only be delegated workflows whose visibility is one of: ${runnable.join(", ")}. ` +
      "Forking a workflow stamps it `project`-visible, so a service account cannot run a forked workflow — delegate those with \"run as me\" instead, " +
      "or ask an admin to make the workflow system-visible.",
  };
}

// ── wire view + audit vocabulary (shared by both route files) ──────────────

/**
 * The wire shape of an account.
 *
 * EXPLICIT field copies, not `...row`, and the reason is not that this table
 * has a secret column — it has none. It is that spreading a row makes the API
 * shape a function of the schema, so the day someone adds `apiKeyHash` here
 * to make service accounts loggable-in after all, it ships to every client in
 * the same commit. Same discipline as `toPublicGrantView`
 * (`web/src/lib/rbac-grants-view.ts`); it lives beside the row type rather
 * than in `web/` because both route files need it and neither owns it.
 */
export interface ServiceAccountView {
  id: string;
  name: string;
  description: string;
  createdByUserId: string;
  projectId: string | null;
  scopes: string[];
  maxTokensPerDay: number;
  enabled: boolean;
  disabledReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toServiceAccountView(row: ServiceAccountRow): ServiceAccountView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdByUserId: row.createdByUserId,
    projectId: row.projectId,
    scopes: row.scopes,
    maxTokensPerDay: row.maxTokensPerDay,
    enabled: row.enabled,
    disabledReason: row.disabledReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Audit actions for the admin surface. Free-form strings rather than entries
 *  in `EXT_AUDIT_ACTIONS` (`src/extensions/audit-actions.ts`) on purpose: that
 *  namespace is `ext:*` and is filtered by the per-extension audit view
 *  (`action LIKE 'ext:%'`), and a service account is not an extension. */
export const SERVICE_ACCOUNT_AUDIT_ACTIONS = {
  CREATED: "service-account:created",
  ENABLED: "service-account:enabled",
  DISABLED: "service-account:disabled",
  DELETED: "service-account:deleted",
} as const;

// ── scope clamping ─────────────────────────────────────────────────────────

/** Requested scopes minus everything the creator does not hold. Pure, so the
 *  clamp can be asserted without a database. Order and duplicates come from
 *  the caller's list; de-duplication happens in {@link createServiceAccount}. */
export function clampScopesToCreator(
  requested: readonly string[],
  creatorScopes: ReadonlySet<string>,
): string[] {
  return requested.filter((scope) => creatorScopes.has(scope));
}

/** Thrown by {@link createServiceAccount} for input a route must answer 400
 *  to. Carries no row state — every check below runs before the insert. */
export class InvalidServiceAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidServiceAccountError";
  }
}

export interface CreateServiceAccountInput {
  name: string;
  description?: string;
  /** The admin minting the account. Their effective scopes are the ceiling. */
  createdBy: RbacUser;
  projectId?: string | null;
  /** Requested scopes. Silently CLAMPED, and what was dropped is reported. */
  scopes?: readonly string[];
  /**
   * TOKENS per day, and mandatory — there is deliberately no "unlimited".
   * Never cents: an OAuth-subscription model reports a null price, so a cost
   * cap would let such a model spend without bound (schema.ts:548-551).
   */
  maxTokensPerDay: number;
}

export interface CreateServiceAccountResult {
  account: ServiceAccountRow;
  /** Requested scopes the creator does not hold. Empty for every admin today
   *  (the sentinel holds everything); surfaced so the route can say so. */
  droppedScopes: string[];
  /** Shown at creation, per spec §6.5. */
  reach: ServiceAccountReach;
}

/**
 * Mint a service account, clamped to its creator.
 *
 * The clamp is INSIDE this function rather than in the route because a second
 * call site (a CLI, a seeder, the marketplace) must not be able to reach the
 * insert without it. `resolveEffectiveScopes` is asked at the account's own
 * project coordinate with a NULL extension — the covers-all axis — because a
 * service account's scope list is flat and is not per-extension.
 */
export async function createServiceAccount(
  input: CreateServiceAccountInput,
): Promise<CreateServiceAccountResult> {
  const name = input.name.trim();
  if (name.length === 0) {
    throw new InvalidServiceAccountError("name is required");
  }
  if (!Number.isInteger(input.maxTokensPerDay) || input.maxTokensPerDay <= 0) {
    throw new InvalidServiceAccountError("maxTokensPerDay must be a positive integer");
  }
  const requested = [...new Set(input.scopes ?? [])];
  for (const scope of requested) {
    if (!isValidRbacScopeName(scope)) {
      throw new InvalidServiceAccountError(`invalid scope name ${JSON.stringify(scope)}`);
    }
  }

  const projectId = input.projectId ?? null;
  const creatorScopes = await resolveEffectiveScopes(input.createdBy, projectId, null);
  const scopes = clampScopesToCreator(requested, creatorScopes);
  const droppedScopes = requested.filter((scope) => !scopes.includes(scope));

  const rows = await getDb()
    .insert(serviceAccounts)
    .values({
      name,
      description: input.description ?? "",
      createdByUserId: input.createdBy.id,
      projectId,
      scopes,
      maxTokensPerDay: input.maxTokensPerDay,
    })
    .returning();

  return { account: rows[0]!, droppedScopes, reach: serviceAccountReach() };
}

// ── reads ──────────────────────────────────────────────────────────────────

export async function getServiceAccount(id: string): Promise<ServiceAccountRow | undefined> {
  const rows = await getDb().select().from(serviceAccounts).where(eq(serviceAccounts.id, id));
  return rows[0];
}

/** By the globally-unique handle an admin picks the account by
 *  (`uniq_service_account_name`, schema.ts:558). */
export async function getServiceAccountByName(
  name: string,
): Promise<ServiceAccountRow | undefined> {
  const rows = await getDb().select().from(serviceAccounts).where(eq(serviceAccounts.name, name));
  return rows[0];
}

/**
 * This account, **only if it is still live** — the one read the delegation
 * consent gate needs.
 *
 * Distinct from {@link getServiceAccount}, which returns the row whatever
 * state it is in, and that distinction is the point: consent is a decision
 * point, and a disabled account that came back as a row would be one `if`
 * away from minting standing authority for a principal an admin has already
 * switched off. Filtered rather than "found and then judged", so the default
 * for anything that misses the predicate is "no such principal".
 *
 * It exists so the consent route does NOT let the `owner_service_account_id`
 * FK reject a bogus id at INSERT time. Catching that violation would make the
 * database error the control — the same inversion
 * `VersionSweepOptions.pinnedVersionIds` refuses
 * (`workflow-versions.ts:299-306`) — and it would surface as a 500 where the
 * caller deserves a named 400.
 *
 * Liveness here is `enabled` alone. `service_accounts` has no `revoked_at`:
 * an account is retired by {@link deleteServiceAccount}, which refuses while
 * live delegations name it, so there is no tombstone state for this predicate
 * to exclude the way {@link countLiveDelegationsOwnedBy} excludes one.
 */
export async function findLiveServiceAccount(id: string): Promise<ServiceAccountRow | undefined> {
  const rows = await getDb()
    .select()
    .from(serviceAccounts)
    .where(and(eq(serviceAccounts.id, id), eq(serviceAccounts.enabled, true)));
  return rows[0];
}

/** Every account, or only those scoped to `projectId`. A NULL-project account
 *  is instance-wide and is deliberately NOT folded into a project's list —
 *  the caller decides which question it is asking. */
export async function listServiceAccounts(projectId?: string): Promise<ServiceAccountRow[]> {
  if (projectId === undefined) {
    return getDb().select().from(serviceAccounts);
  }
  return getDb().select().from(serviceAccounts).where(eq(serviceAccounts.projectId, projectId));
}

// ── delegation reach-back (rule 2) ─────────────────────────────────────────

/** A delegation owner, discriminated. The `id` is read through
 *  {@link DELEGATION_OWNER_COLUMN}, never through a per-kind branch. */
export interface DelegationOwnerRef {
  kind: DelegationOwnerKind;
  id: string;
}

/**
 * How many LIVE (un-revoked) delegations name this owner.
 *
 * The keyed lookup in one line: `DELEGATION_OWNER_COLUMN[owner.kind]` picks
 * the column, so a third principal kind needs one schema entry and nothing
 * here. `owner_kind` is ALSO matched, not just the column — the schema states
 * that exactly one owner column is populated per row but does not enforce it
 * with a CHECK constraint (schema.ts:583-585), so a query that trusted the
 * column alone would count a malformed row for both kinds.
 *
 * Revocation is a tombstone (`revoked_at`, schema.ts:691-695), so "live" is
 * `revoked_at IS NULL` — a revoked row carries no authority and must not
 * block a delete.
 */
export async function countLiveDelegationsOwnedBy(owner: DelegationOwnerRef): Promise<number> {
  const ownerColumn = workflowDelegations[DELEGATION_OWNER_COLUMN[owner.kind]];
  const rows = await getDb()
    .select({ id: workflowDelegations.id })
    .from(workflowDelegations)
    .where(
      and(
        eq(workflowDelegations.ownerKind, owner.kind),
        eq(ownerColumn, owner.id),
        isNull(workflowDelegations.revokedAt),
      ),
    );
  return rows.length;
}

// ── writes ─────────────────────────────────────────────────────────────────

/** Flip `enabled`, recording WHY when disabling. Returns the updated row, or
 *  `undefined` when no such account exists. A re-enable clears the reason —
 *  a live account carrying a stale "disabled because…" is worse than none. */
export async function setServiceAccountEnabled(
  id: string,
  enabled: boolean,
  disabledReason?: string,
): Promise<ServiceAccountRow | undefined> {
  const rows = await getDb()
    .update(serviceAccounts)
    .set({
      enabled,
      disabledReason: enabled ? null : (disabledReason ?? null),
      updatedAt: new Date(),
    })
    .where(eq(serviceAccounts.id, id))
    .returning();
  return rows[0];
}

export type DeleteServiceAccountResult =
  | { ok: true }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "has-live-delegations"; delegationCount: number };

/**
 * Remove a service account, or refuse and say why.
 *
 * REFUSES while live delegations name it. The FK is `ON DELETE CASCADE`
 * (schema.ts:617), so the database would happily accept the delete and take
 * every one of those authorities with it — silently, and with no way to tell
 * afterwards what was destroyed. The schema makes the identical argument for
 * `created_by_user_id` one level up (`ON DELETE RESTRICT`, schema.ts:528-538):
 * removing a principal that still holds authority must be a loud, explicit
 * act — revoke the delegations first.
 */
export async function deleteServiceAccount(id: string): Promise<DeleteServiceAccountResult> {
  const existing = await getServiceAccount(id);
  if (!existing) return { ok: false, reason: "not-found" };

  const delegationCount = await countLiveDelegationsOwnedBy({ kind: "service", id });
  if (delegationCount > 0) {
    return { ok: false, reason: "has-live-delegations", delegationCount };
  }

  await getDb().delete(serviceAccounts).where(eq(serviceAccounts.id, id));
  return { ok: true };
}
