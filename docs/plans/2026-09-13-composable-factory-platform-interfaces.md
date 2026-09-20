# Composable factory platform shared interface freeze

Date: 2026-09-13. Status: frozen by the W00 coordinator for wave 1 (sections 6 and 7 bind W01 and W04; sections 1, 2, 5, 9, 10 bind W05's type checkpoints; sections 3, 4, 8 bind W03; section 11 binds W07). Each surface has one writer. A consumer that finds a surface wrong reports it to the coordinator; it does not fork it. Later corrections are appended as dated notes, never silent edits.

Source: the W00 interface-freeze agent's proposal at `/tmp/factory-platform-evidence/w00/shared-interfaces.md`, reviewed by the coordinator against `33cab8657`. Section numbering and text below are unchanged from the proposal.

---

Integration baseline: `feat/composable-factory-platform` at `33cab8657`, worktree
`/home/dev/work/EZCorp/EZHarness-worktrees/composable-factory-platform`.

This document freezes eleven shared surfaces before W01–W08 fan out. Every sketch is
grounded in code that exists at `33cab8657` or in a named unmerged source. Line numbers
refer to the integration baseline unless a different commit is named.

Sources read: `docs/plans/2026-09-13-composable-factory-platform-completion.md` sections
3–5; `docs/plans/2026-09-12-composable-factory-platform-contracts.md` C02, C03, C04, C05,
C07, C08, C13; the factory source tree; the SDK; `scripts/check-factory-boundaries.ts`;
`src/db/migrate.ts`; `src/db/schema.ts`; `src/db/factory-schema.ts`; and four unmerged
sources named in section 13.

## 0. Method and three facts that constrain every sketch

**No zod.** `grep -rn "zod"` over `src/factory/` and `packages/@ezcorp/factory-sdk/src/`
returns zero hits. Validation is hand-written predicates plus eight committed JSON Schema
documents walked by a 39-line validator at `packages/@ezcorp/factory-sdk/src/schema.ts:46-84`.
No sketch below may assume a schema library.

**No migration ledger.** `src/db/migrate.ts:63` is one 3031-line async function; ordering is
source-statement order. There is no `schema_migrations` table. Every step reruns on every
boot, so every step must be self-idempotent. `src/__tests__/helpers/factory-migration-restart-suite.ts`
is the only gate that catches a mis-splice.

**Two schema files.** 24 factory tables live in `src/db/factory-schema.ts` behind
`buildFactorySchema({ projects, users, serviceAccounts })`, destructured at
`src/db/schema.ts:2899-2924`. The other 30 are inline in `src/db/schema.ts:2926-3135`.
54 factory tables total. A grep of `schema.ts` alone misses `factory_runs`,
`factory_executions`, `factory_grants`, and 21 more.

---

## 1. Typed validator origin for shared admission (W05)

### Owner and consumers
Single writer: **Sol assurance (W05)**, under the plan's row "Protected candidate/validator
binding and async release-profile interface". Consumers: Sol lifecycle (W03 stop and
settlement), Terra runtime (W01 attempt dispatcher), Sol controls (W06), coordinator (W09
startup composition).

### Files
- New: `src/factory/admission-origin.ts` (the union and its two pure functions).
- Extended: `src/factory/task-admission.ts`, `src/factory/task-execution-admission.ts`,
  `src/factory/compute-admissions.ts`, `src/factory/validator-materials.ts`.
- New migration: `src/db/migrations/add-factory-admission-origin.ts`.

### What exists today
There is no origin concept. `grep -rn "origin" src/factory --include="*.ts"` over non-test
sources returns only `url.origin` at `src/factory/pool/service-routes.ts:82`. Command kind is
proved by three runtime guards, not by a stored field:

```ts
// src/factory/task-admission.ts:52
if (context.command.kind !== "request-admission") throw new FactoryCommandAuthorityError("factory_command_forbidden");
// src/factory/task-execution-admission.ts:130
if (context.command.kind !== "dispatch-node") throw new FactoryTaskExecutionAdmissionError("factory_task_execution_forbidden");
// src/factory/compute-admissions.ts:298 (abridged)
if (context.command.kind !== "request-admission" || factoryTaskReservationId(input.reference, context) !== input.request.reservationId) throw new FactoryComputeAdmissionError("factory_compute_admission_stale");
```

The reservation key is derived, never supplied:

```ts
// src/factory/task-admission.ts:35-38
export function factoryTaskReservationId(reference: TrustedFactoryCommandReference, context: FactoryAuthorizedCommand): string {
  const attempt = context.state.nodes[context.command.nodeId]!.attempts.at(-1)!;
  return `factory-reservation:${digestObject({ tenantId: reference.tenantId, projectId: reference.projectId, logicalRunId: reference.logicalRunId, interpreterId: reference.interpreterId, nodeId: context.command.nodeId, candidateGeneration: context.command.candidateGeneration, attempt: attempt.attempt }).slice(7)}`;
}
```

Seven fields, none of which distinguishes a validator claimant from ordinary task work.

### Frozen type

```ts
// src/factory/admission-origin.ts — NEW. Single writer: W05.

export const FACTORY_ADMISSION_ORIGIN_SCHEMA_VERSION = "factory.admission-origin.v1" as const;

export interface FactoryAdmissionOriginBase {
  readonly schemaVersion: "factory.admission-origin.v1";
}

/** Ordinary task work. A committed dispatch-node command is the only authority. */
export interface FactoryDispatchNodeOrigin extends FactoryAdmissionOriginBase {
  readonly kind: "dispatch-node";
  /** Exact committed kernel command id. Equals the attempt id (task-execution-admission.ts:57). */
  readonly commandId: string;
  readonly nodeInstanceId: string;
  readonly candidateGeneration: number;
  readonly attemptNumber: number;
}

/** Protected validator work. No transition command exists, and none may be forged. */
export interface FactoryProtectedValidatorOrigin extends FactoryAdmissionOriginBase {
  readonly kind: "protected-validator";
  /** The acceptance command that revealed the need. NEVER usable as an attempt id. */
  readonly acceptanceCommandId: string;
  /** The candidate under evaluation. src/factory/assurance.ts:14. */
  readonly candidate: FactoryCandidateKey;
  /** Sorted, deduplicated claim identities this one runtime will satisfy. */
  readonly validatorIds: readonly string[];
  /** Pinned lock every listed claim shares. */
  readonly validatorLockDigest: string;
  /** Digest of the execution profile every listed claim shares. */
  readonly executionProfileDigest: string;
}

export type FactoryAdmissionOrigin = FactoryDispatchNodeOrigin | FactoryProtectedValidatorOrigin;

/** `sha256:` + 64 lowercase hex over the canonical origin. */
export function factoryAdmissionOriginDigest(origin: FactoryAdmissionOrigin): string;

/** Deterministic reservation identity. Byte-identical to factoryTaskReservationId for dispatch-node. */
export function factoryReservationIdForOrigin(
  reference: TrustedFactoryCommandReference,
  origin: FactoryAdmissionOrigin,
): string;
```

The admission request gains one optional field. Absent means `dispatch-node`:

```ts
// src/factory/task-admission.ts:20-27 — CHANGED
export interface FactoryComputeAdmissionRequest {
  readonly schemaVersion: "factory.compute-admission.v1";
  readonly reference: TrustedFactoryCommandReference;
  readonly fence: FactoryExecutionFence;
  readonly budget: FactoryBudgetAmount;
  readonly memoryBytes: number;
  readonly request: PoolAdmissionRequest;
  readonly origin?: FactoryAdmissionOrigin;
}
```

### Identities and invariants
- For `dispatch-node`, `factoryReservationIdForOrigin` must return exactly what
  `factoryTaskReservationId` returns today. Live runs must not be re-keyed.
- For `protected-validator`, the key is `factory-reservation:` plus a digest over
  `{ tenantId, projectId, logicalRunId, interpreterId, kind, acceptanceCommandId, candidate, validatorIds }`.
- Exactly one budget reservation and exactly one compute admission per validator identity.
  Repeated polls, restart, and lost responses all resolve to the same reservation id.
- An origin never authorizes a kernel state change. A `protected-validator` origin must fail
  every check that requires `command.kind === "dispatch-node"`.
- An acceptance command id is never an attempt id. Equating them is the specific forgery the
  plan names.

### Schema and migration
`src/db/migrations/add-factory-admission-origin.ts`, appended after
`add-factory-protected-command-effects` (currently the last statement, `migrate.ts:3093`):

```sql
ALTER TABLE factory_budget_reservations  ADD COLUMN IF NOT EXISTS origin_kind TEXT NOT NULL DEFAULT 'dispatch-node';
ALTER TABLE factory_compute_admissions   ADD COLUMN IF NOT EXISTS origin_kind TEXT NOT NULL DEFAULT 'dispatch-node';
ALTER TABLE factory_compute_admissions   ADD COLUMN IF NOT EXISTS origin_json JSONB;
ALTER TABLE factory_compute_admissions   ADD COLUMN IF NOT EXISTS origin_digest TEXT;
-- CHECK additions go through a catalog-driven DO $$ block because a CHECK cannot be altered in place.
--   factory_compute_admissions_origin_kind_check: origin_kind IN ('dispatch-node','protected-validator')
--   factory_compute_admissions_origin_digest_check: origin_digest IS NULL OR origin_digest ~ '^sha256:[0-9a-f]{64}$'
--   factory_compute_admissions_origin_body_check: (origin_kind = 'protected-validator') = (origin_json IS NOT NULL)
CREATE UNIQUE INDEX IF NOT EXISTS uq_factory_validator_admission_identity
  ON factory_compute_admissions (tenant_id, project_id, run_id, origin_digest)
  WHERE origin_kind = 'protected-validator';
```

Primary keys are unchanged: `(tenant_id, project_id, run_id, reservation_id)` on both tables
(`factory-schema.ts:251`, `:268`). No foreign key to `factory_transition_commands` for the
validator variant, because no transition command exists for it.

### Validation rules — what is rejected
- Unknown `kind`, missing `schemaVersion`, or any extra key.
- A `protected-validator` origin whose `acceptanceCommandId` matches a row in
  `factory_executions.attempt_id`, or names a `dispatch-node` command.
- Empty `validatorIds`, duplicates, unsorted order, more than 1000 entries, or any id outside
  the current material's `mandatoryClaims`.
- Claims whose execution profiles differ. Reuse the existing equality rule, which strips only
  `validatorId` and `freshnessMs` (`validator-materials.ts`, `executionProfile` helper).
- A `dispatch-node` origin whose recomputed reservation id differs from the stored one:
  `factory_compute_admission_stale`, the existing code at `compute-admissions.ts:298`.
- Any attempt to construct a `cancel-node` or other transition command from a validator origin.

### Minimal type checkpoint
`feat(factory): type validator admission origin`. Adds `src/factory/admission-origin.ts` with
the union, the constant, and the two pure functions plus unit tests. Adds the migration above.
Adds the optional `origin` field to `FactoryComputeAdmissionRequest`. No behavior change:
ordinary admission keeps its current path and its current reservation id.

### What it extends (C13)
No C13 row covers admission origin directly. The surrounding record and queue paths already
reuse the shared modules: `src/factory/outbox.ts` requires
`src/delivery-queue/durable-delivery-queue.ts` and `src/factory/records.ts` requires
`src/db/queries/audit-log.ts` (`scripts/check-factory-boundaries.ts:49-50`). Add no second
queue and no second audit path. `src/factory/admission-origin.ts` is factory-local and needs
no `REQUIRED_SHARED_IMPORTS` row.

### Open questions and recommended defaults
1. **Which budget envelope funds a validator reservation?** Default: the same envelope as the
   candidate's node instance. Parent bounds then hold with no new envelope row and no change to
   `factory_budget_envelopes`.
2. **Does a validator origin need its own pool resource class?** Default: no. Reuse `cpu` and
   `memory` from the validator's `ResourceBounds`. `POOL_RESOURCE_CLASSES` stays at four members
   (`src/factory/pool/ledger.ts:4`).
3. **Should the origin be sealed into the attempt token?** Default: no.
   `src/factory/attempt-token.ts:34-41` rejects a token whose claim set is not exactly the 17
   frozen claims. Bind the origin in the durable admission row instead and keep the claim set frozen.

---

## 2. Multi-claim result identity (W05)

### Owner and consumers
Single writer: **Sol assurance (W05)**. Consumers: Sol controls (W06 rejection path), Sol
product (W14 console), coordinator (migration ordering).

### Files
- `src/db/migrations/allow-factory-validator-multiclaim.ts` — exists, **untracked**, in worktree
  `/home/dev/work/EZCorp/EZHarness-worktrees/factory-validator-binding`.
- `src/db/migrations/add-factory-validator-materials.ts` — fresh-database DDL, modified there.
- `src/db/schema.ts` — `factoryValidatorAssignments`, `factoryValidatorResults`.
- `src/factory/validator-materials.ts` — the binder.

### What exists today
Old identity: `factory_validator_results` PK `(tenant_id, project_id, validator_attempt_id)`;
`factory_validator_assignments` `UNIQUE (validator_attempt_id)`; and the code enforces exactly
one claim (`validator-materials.ts:169`, `value.claims.length !== 1`).

New identity in the unmerged worktree: PK
`(tenant_id, project_id, validator_attempt_id, validator_id)`; assignments unique on
`(tenant_id, project_id, validator_attempt_id, validator_id)`; `strictClaims` accepts 1..1000
claims and selects the bound one.

### Frozen type

```ts
// src/factory/validator-materials.ts — exists in the unmerged worktree, lines 75-81
export interface FactoryValidatorTaskAssignmentRequest {
  readonly candidate: FactoryCandidateKey;
  readonly validatorIds: readonly string[];
  readonly authority: FactoryAttemptAuthority;
  /** Exact inline input re-derived from the current compiled task command. */
  readonly expectedInput: JsonValue;
}

// NEW in the same file. Makes the result identity explicit rather than implied by SQL.
export interface FactoryValidatorResultKey {
  readonly tenantId: string;
  readonly projectId: string;
  readonly validatorAttemptId: string;
  readonly validatorId: string;
}

export interface FactoryValidatorResultRecord extends FactoryValidatorResultKey {
  readonly schemaVersion: "factory.validator-result-record.v1";
  readonly terminalFactDigest: string;
  readonly artifact: FactoryArtifactReference;
  readonly claims: readonly FactoryValidatorClaimOutcome[];   // surface 9
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly evidenceDigest: string;
  readonly resultDigest: string;
}
```

Public binders, both already written in the worktree:

```ts
// validator-materials.ts:255 and :260
async bindAttemptInTransaction(transaction: MigrationDb, request: FactoryValidatorAssignmentRequest): Promise<void>;
/** Binds one ordinary protected task to every exact claim that its pinned runner reports. */
async bindTaskAttemptInTransaction(transaction: MigrationDb, request: FactoryValidatorTaskAssignmentRequest): Promise<void>;
```

### Identities and invariants
- One result row per `(tenantId, projectId, validatorAttemptId, validatorId)`.
- Every claim bound to one attempt shares one execution profile. Only `validatorId` and
  `freshnessMs` may differ; runner, runner digest, resources, model, broker audience,
  environment digest, configuration digest, and max evidence age must be byte-identical, or
  `factory_validator_attempt_untrusted`.
- The assignments primary key is unchanged:
  `(tenant_id, project_id, run_id, candidate_node_instance_id, candidate_generation, validator_id)`.
  Only the attempt column stops being globally unique.
- Repeat migration is a no-op. The accompanying test runs `up` twice.
- Backfill is fail-closed. An orphan result row aborts the migration; it is never defaulted.

### Schema and migration
The migration is nine statements. It is unambiguous because the pre-migration schema enforced
`UNIQUE (validator_attempt_id)`, so the backfill join yields at most one row per result.

```sql
ALTER TABLE factory_validator_results ADD COLUMN IF NOT EXISTS validator_id TEXT;
UPDATE factory_validator_results result SET validator_id = assignment.validator_id
  FROM factory_validator_assignments assignment
  WHERE result.validator_id IS NULL AND assignment.tenant_id = result.tenant_id
    AND assignment.project_id = result.project_id
    AND assignment.validator_attempt_id = result.validator_attempt_id;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM factory_validator_results WHERE validator_id IS NULL) THEN
    RAISE EXCEPTION 'factory validator result requires an unambiguous claim identity';
  END IF;
END $$;
ALTER TABLE factory_validator_results ALTER COLUMN validator_id SET NOT NULL;
-- catalog-driven drop of the results->assignments FK, then of the old PK,
-- then of the assignments UNIQUE (validator_attempt_id) constraint,
CREATE UNIQUE INDEX IF NOT EXISTS uq_factory_validator_assignment_attempt_claim
  ON factory_validator_assignments (tenant_id, project_id, validator_attempt_id, validator_id);
ALTER TABLE factory_validator_results ADD CONSTRAINT factory_validator_results_pkey
  PRIMARY KEY (tenant_id, project_id, validator_attempt_id, validator_id);
ALTER TABLE factory_validator_results ADD CONSTRAINT factory_validator_results_assignment_fkey
  FOREIGN KEY (tenant_id, project_id, validator_attempt_id, validator_id)
  REFERENCES factory_validator_assignments (tenant_id, project_id, validator_attempt_id, validator_id) ON DELETE RESTRICT;
```

Registry position: between `add-factory-validator-materials` (`migrate.ts:3089`) and
`add-factory-package-preparations` (`migrate.ts:3091`). Any later validator migration must
follow it.

**One parity defect to correct before integration.** On a fresh database
`add-factory-validator-materials.ts` creates the uniqueness as a table CONSTRAINT named
`uq_factory_validator_assignment_attempt_claim`; on an upgraded database the migration creates
it as a bare unique INDEX with the same name. A real-PostgreSQL parity check that reads
`information_schema.table_constraints` will see a difference. Recommended default: make the
fresh path create a unique INDEX as well, so both paths converge on one catalog shape.

### Validation rules — what is rejected
- More than 1000 claims, fewer than one, or a duplicate claim id inside one report.
- A claim id absent from the bound assignment set.
- A saved row whose `validator_id` differs from the requested one:
  `factory_validator_assignment_conflict`.
- A result whose `terminal_fact_digest` or `result_digest` does not match the recomputed value.
- A migration run where any result row cannot resolve a claim id.

### Minimal type checkpoint
`feat(factory): key validator results by claim`. Lands the migration, the `schema.ts` change,
`FactoryValidatorTaskAssignmentRequest`, `bindTaskAttemptInTransaction`, and the multi-claim
`strictClaims`. Verdicts are unchanged in this commit; surface 9 handles those.

### What it extends (C13)
`src/factory/validator-materials.ts`. No new C13 row. The artifact side already requires
`src/extensions/v4/blobs.ts` through `src/factory/artifacts.ts`
(`check-factory-boundaries.ts:60`).

### Open questions and recommended defaults
1. **Claim cap per attempt.** Default 1000, matching `@maxItems 1000` on
   `FactoryReleaseContractBody.mandatoryClaims` (`factory-sdk/src/types.ts`).
2. **Does one failed claim void the whole attempt's rows?** Default: no. Persist every claim
   outcome; let `src/factory/assurance.ts` evaluation decide the acceptance result.
3. **Constraint or index for the new uniqueness.** Default: index on both paths, as above.
4. **No production caller exists yet.** `bindTaskAttemptInTransaction` is called only from a test
   helper today, and `FactoryTrustedValidatorGateway` (`src/factory/assurance.ts:20-23`) still
   declares only `assertContractInTransaction` and `resolveValidatorInTransaction`. W05 must widen
   that gateway interface; that is a second, separate checkpoint.

---

## 3. Live cancellation source (W03)

### Owner and consumers
Single writer: **Sol lifecycle (W03)**, under the plan's row "Journal outcome/stop/usage
validation". Consumers: Terra runtime (W01/W02), coordinator (W09 startup), Sol controls (W06).

### Files
- `src/factory/task-stops.ts` — exists only in the stash parent `bae1bec2d`; the finished form
  is `5e017a9c7` on `feat/factory-attempt-dispatcher`.
- `src/factory/command-authority.ts` — `withCurrentCancellation`.
- `src/factory/executions.ts` — `acceptCancellationInTransaction`, `confirmStoppedInTransaction`.
- `src/factory/compute-admissions.ts` — `readRetainedAdmittedInTransaction`.
- `src/factory/runner/attempt-runtime.ts` — unmerged, commit `599e49e73`.
- `src/db/migrations/add-factory-task-stops.ts` — unmerged.

### The defect, quoted
A stop today requires a pre-existing **non-success terminal outcome**. Four independent gates
enforce it.

```ts
// src/factory/task-stops.ts, private accept(), line 178 (from bae1bec2d)
const outcome = await this.outcomes.readVerifiedInTransaction(transaction, service, attemptReference);
if (!outcome || outcome.authority.nodeInstanceId !== context.command.nodeId || outcome.authority.candidateGeneration !== context.command.candidateGeneration || outcome.authority.attemptNumber !== context.command.attempt) throw new FactoryTaskStopError("factory_task_stop_stale");
```

`readVerifiedInTransaction` reads only `factory_task_outcomes`, whose `result_json` is typed
`FactoryNonSuccessfulRunnerResult = Exclude<FactoryRunnerResult, { status: "completed" }>`
(`src/factory/task-outcomes.ts:20`). The other three gates:

- `command-authority.ts` `withCurrentCancellation` requires `runtime.status === "stopping"` and
  `!attempt.stopped`.
- `add-factory-task-stops.ts`: `FOREIGN KEY (tenant_id, project_id, run_id, interpreter_id, attempt_command_id) REFERENCES factory_task_outcomes(...) ON DELETE RESTRICT`.
- `executions.ts` `acceptCancellationInTransaction` accepts only `status IN ('admitted','running')`
  or an already `cancel_accepted` row.

Result: a still-running attempt with no terminal result cannot be stopped. Fabricating an
outcome to satisfy the store precondition is explicitly forbidden by the plan.

### Frozen type

```ts
// src/factory/task-stops.ts — CHANGED. Single writer: W03.

export const FACTORY_STOP_ABORT_GRACE_MS = 10_000;        // C02: abort, 10 s cleanup, then kill
export const FACTORY_PHYSICAL_STOP_TIMEOUT_MS = 20_000;   // existing constant, unchanged

/** Where the stop authority came from. */
export type FactoryStopSource = "terminal-outcome" | "sealed-launch";

/** Stop authority derived from the exact sealed admission plus the durable launch record. */
export interface FactoryLiveStopAuthority {
  readonly schemaVersion: "factory.stop-authority.v1";
  readonly attemptId: string;
  readonly authority: FactoryAttemptAuthority;          // src/factory/executions.ts:15-30
  readonly reservationId: string;
  readonly workerId: string;
  readonly invocationId: string;                        // surface 6
  readonly hostId: string;
  readonly holderGeneration: number;
  readonly allocationGeneration: number;
  readonly allocationToken: string;
  readonly requestDigest: string;
  readonly launchState: FactoryAttemptLaunchState;      // attempt-runtime.ts:19
  /** Present only when a terminal result already exists. */
  readonly terminalOutcome?: FactoryVerifiedTaskOutcome;
}

export interface FactoryTaskStopRequest {
  readonly cancelReference: TrustedFactoryCommandReference;
  /** Absent when the attempt is still running and has no outcome row. */
  readonly attemptReference?: TrustedFactoryCommandReference;
  readonly attemptId: string;
  readonly reservationId: string;
  readonly workerId: string;
  readonly holderGeneration: number;
  readonly allocationGeneration: number;
  readonly hostId: string;
  readonly reason: FactoryPhysicalStopReason;           // "completed"|"failed"|"cancelled"|"lease-revoked"
  readonly source: FactoryStopSource;
}

export interface FactoryPhysicalStopper {
  stop(request: FactoryTaskStopRequest, signal: AbortSignal): Promise<FactoryPhysicalStopReceipt>;
}

export interface FactoryTaskStopReceipt {
  readonly state: "uncertain" | "stopped";
  readonly event: Extract<KernelEvent, { readonly kind: "attempt-stopped" }>;
  readonly stopReceipt?: FactoryPhysicalStopReceipt;
}

/** Widened from `string`. Mapped to HTTP status codes by W14. */
export type FactoryTaskStopCode =
  | "factory_task_stop_scope" | "factory_task_stop_key_invalid" | "factory_task_stop_invalid"
  | "factory_task_stop_corrupt" | "factory_task_stop_not_found" | "factory_task_stop_conflict"
  | "factory_task_stop_stale" | "factory_task_stop_pool_mismatch" | "factory_task_stop_proof_invalid"
  | "factory_task_stop_clock_invalid" | "factory_task_stop_timeout";
```

The signed receipt is already correct and does not change:

```ts
// src/factory/runner/attempt-runtime.ts:33-49 (599e49e73)
export interface FactoryPhysicalStopReceipt {
  readonly schemaVersion: "factory.physical-stop.v1";
  readonly attemptId: string;
  readonly reservationId: string;
  readonly workerId: string;
  readonly holderGeneration: number;
  readonly allocationGeneration: number;
  readonly processGroupAbsent: true;
  readonly stoppedAtMs: number;
  readonly reason: FactoryPhysicalStopReason;
  readonly hostId: string;
  readonly hostKeyId: string;
  readonly hostSignature: string;
  readonly receiptDigest: string;
}
export type FactoryUnsignedPhysicalStopReceipt = Omit<FactoryPhysicalStopReceipt, "hostKeyId" | "hostSignature" | "receiptDigest">;
```

### Identities and invariants
- Stop authority comes from the sealed compute admission and the `factory_attempt_launches` row,
  never from a result. `source: "sealed-launch"` is the live path.
- No fabricated outcome. The precondition is relaxed, not satisfied by writing a fake
  `node-failed`.
- Abort, then at most `FACTORY_STOP_ABORT_GRACE_MS` of cleanup, then kill the whole sandbox
  process group. `processGroupAbsent: true` is written only after the runtime confirms that no
  process remains.
- A bounded stop timeout leaves `state = 'uncertain'`, retains the budget hold via
  `markUncertainInTransaction(..., "physical_stop_unconfirmed")`, and retains the compute
  allocation. It never releases capacity and never rewrites a prior outcome.
- A later valid receipt settles the original operation only. It never launches replacement work.
- Only the supervisor host key signs a physical observation. A gateway callback can request a
  stop; it can never assert one. `signStopReceipt` is injected
  (`attempt-runtime.ts:209`), so product code never holds the host private key.
- The pool must agree before settlement: `confirmStopped` must return `state === "settled"` with
  matching `holderGeneration`, `allocationGeneration`, and `hostId`, or
  `factory_task_stop_pool_mismatch`.

### Schema and migration
Change `src/db/migrations/add-factory-task-stops.ts`:

- `attempt_command_id TEXT` becomes nullable. The existing composite FK to
  `factory_task_outcomes` is MATCH SIMPLE, so PostgreSQL skips the check when any column is NULL.
  That is the smallest correct change; the FK stays.
- Add `source TEXT NOT NULL DEFAULT 'terminal-outcome' CHECK (source IN ('terminal-outcome','sealed-launch'))`.
- Add `FOREIGN KEY (attempt_id) REFERENCES factory_attempt_launches(attempt_id) ON DELETE RESTRICT`,
  so a stop cannot exist without a sealed launch.
- Add `CHECK (source <> 'terminal-outcome' OR attempt_command_id IS NOT NULL)`.
- Keep the four existing state coherence checks.

**Drizzle drift to correct.** The `factoryTaskStops` model in `src/db/schema.ts` omits three of
the migration's checks: `accepted_at_ms >= 0`, the nullable-digest patterns, and all four
state/column coherence checks. Add them, or the PostgreSQL schema parity lane will diverge.

**Ordering.** `add-factory-attempt-launches` (W01) must be registered **before**
`add-factory-task-stops` (W03), because of the new foreign key.

### Validation rules — what is rejected
- A stop request whose `workerId`, `hostId`, `holderGeneration`, or `allocationGeneration`
  differs from the sealed launch row.
- A receipt that fails `verifyHostReceipt`: unknown `hostKeyId`, host mismatch, wrong
  `schemaVersion`, any identity mismatch, `processGroupAbsent !== true`, a `receiptDigest` that is
  not the hash of the unsigned body, a non-base64url signature, or a failed RSA-SHA256 verify.
- A receipt whose reason differs from the sealed request's reason.
- A pool acknowledgement that is not `settled` with equal generations and host.
- A stop on an attempt with no launch row, or on a launch row in state `prepared`.
- A stop clock outside bounds: `factory_task_stop_clock_invalid`.

### Minimal type checkpoint
`feat(factory): type live stop authority`. Adds `FactoryLiveStopAuthority`, `FactoryStopSource`,
the widened `FactoryTaskStopRequest`, `FactoryTaskStopCode`, the two constants, and the migration
change. No behavior change: `source` defaults to `terminal-outcome` and the existing path is
untouched.

### What it extends (C13)
C03's lease fencing reuses the `extension_runtime_locks` shape (`fence`, `generation`, `effects`,
`held | quarantined`), already realized in `src/factory/pool/ledger.ts`. Do not add a second lock
table. `src/factory/executions.ts` already requires `src/db/queries/audit-log.ts` and
`src/extensions/v4/blobs.ts` (`check-factory-boundaries.ts:58-59`).

### Open questions and recommended defaults
1. **Does `withCurrentCancellation` keep requiring `runtime.status === "stopping"`?** Default:
   yes for the kernel-initiated path. Add a second authority path in `command-authority.ts` for
   package quarantine and revocation (W02), which has no `cancel-node` command. Keep both in one
   file so the F13 duplicate-signature check sees one implementation.
2. **Total stop timeout.** Default: keep 20 s. That is 10 s of contract grace plus 10 s of
   kill-and-confirm margin.
3. **Reason vocabulary.** Default: unchanged four members. A live cancellation uses `"cancelled"`;
   quarantine and lease loss use `"lease-revoked"`.
4. **Where does the abort signal originate?** Default: the stop worker registered in W09 owns the
   `AbortController`; shutdown aborts it, and the stop degrades to `uncertain` rather than to a
   false stopped fact.

---

## 4. Usage-settled event (W03)

### Owner and consumers
Emission writer: **Sol lifecycle (W03)**. The SDK event type already exists and belongs to Sol
controls under "kernel/reference graph semantics"; **no SDK change is needed**, which is why W03
can own this end to end. Consumers: the kernel, `src/factory/budgets.ts`, W14 cost views.

### Files
- `packages/@ezcorp/factory-sdk/src/kernel-types.ts:196-205` — the event, unchanged.
- `src/factory/task-stops.ts` — the stop-path emitter.
- New: `src/factory/usage-settlement.ts` — the reconciler and the product record.
- `src/factory/budgets.ts`, `src/factory/inbox.ts`.
- New migration: `src/db/migrations/add-factory-usage-settlements.ts`.

### What exists today
The event is declared and never emitted. `git grep "usage-settled" -- src` returns nothing;
matches exist only in `packages/@ezcorp/factory-sdk/src/{kernel.ts,kernel-types.ts,*.test.ts}`.

```ts
// packages/@ezcorp/factory-sdk/src/kernel-types.ts:196-205
  | (KernelEventBase & {
      readonly kind: "usage-settled";
      readonly nodeId: string;
      readonly commandId: string;
      readonly candidateGeneration: number;
      readonly attempt: number;
      readonly revision: number;
      readonly knownCostMicros: string;
      readonly unknownCostMicros?: string;
    })
```

The stash's `finalize` settles the budget ledger but emits only `attempt-stopped`, so the kernel
never learns the settled cost:

```ts
// src/factory/task-stops.ts, finalize() (bae1bec2d)
const measured = current.outcome.result.usage?.kind === "measured" ? current.outcome.result.usage : undefined;
if (measured) await this.budgets.settleInTransaction(transaction, { ... }, { costMicros: measured.costMicros, tokens: measured.inputTokens + measured.outputTokens, computeMs: measured.computeMs }, receipt.receiptDigest);
else await this.retainUncertainBudget(transaction, reference, current.request.reservationId);
```

### Frozen type

```ts
// src/factory/usage-settlement.ts — NEW. Single writer: W03.

export const FACTORY_USAGE_SETTLEMENT_SCHEMA_VERSION = "factory.usage-settlement.v1" as const;

export type FactoryUsageSettlementSource = "stop" | "reconciliation";

export interface FactoryUsageSettlement {
  readonly schemaVersion: "factory.usage-settlement.v1";
  readonly reservationId: string;
  readonly attemptId: string;
  /** Monotonic per reservation. Starts at 1. */
  readonly revision: number;
  readonly source: FactoryUsageSettlementSource;
  /** Unsigned decimal string. Never a number. */
  readonly knownCostMicros: string;
  /** Omitted only when nothing is held. */
  readonly unknownCostMicros?: string;
  /** Required when source is "reconciliation". */
  readonly providerReceiptDigest?: string;
  readonly settledAtMs: number;
  /** `sha256:` + 64 hex over the canonical settlement, excluding this field. */
  readonly settlementDigest: string;
  readonly event: Extract<KernelEvent, { readonly kind: "usage-settled" }>;
}

/** Trusted later reconciliation of an operation whose cost was unknown. */
export interface FactoryUsageReconciler {
  reconcile(
    input: {
      readonly reservationId: string;
      readonly attemptId: string;
      readonly operationId: string;
      readonly providerReceiptDigest: string;
      readonly usage: FactoryMeasuredUsage;   // factory-sdk/src/types.ts:483-489
    },
    signal?: AbortSignal,
  ): Promise<FactoryUsageSettlement>;
}
```

### Identities and invariants
- Event id is `` `${reservationId}:usage:${revision}` ``. One idempotent event per revision.
- `revision` increments only when the settled amount changes. A repeat with the same provider
  receipt digest returns the same settlement and emits no second event.
- An unknown provider cost is never settled as zero. `unknownCostMicros` stays present until a
  verified receipt lands. `knownCostMicros` may be `"0"` only when a measured usage really is zero.
- Settlement still requires a `sha256:` receipt digest. `src/factory/budgets.ts:214-217` already
  enforces `/^sha256:[a-f0-9]{64}$/` or `factory_budget_receipt_invalid`. Keep it.
- Costs are unsigned decimal strings end to end. `FactoryMeasuredUsage.costMicros` and
  `FactoryUnknownUsage.heldCostMicros` are already strings
  (`factory-sdk/src/types.ts:483-497`); `isUnsignedDecimal` in `canonical.ts` is the validator.
- A late settlement settles the original operation only. It can never re-open a settled
  reservation for different work.

### Schema and migration
New table `factory_usage_settlements`:

```sql
CREATE TABLE IF NOT EXISTS factory_usage_settlements (
  tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL, revision BIGINT NOT NULL CHECK (revision >= 1),
  attempt_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('stop','reconciliation')),
  known_cost_micros TEXT NOT NULL CHECK (known_cost_micros ~ '^[0-9]+$'),
  unknown_cost_micros TEXT CHECK (unknown_cost_micros IS NULL OR unknown_cost_micros ~ '^[0-9]+$'),
  provider_receipt_digest TEXT CHECK (provider_receipt_digest IS NULL OR provider_receipt_digest ~ '^sha256:[0-9a-f]{64}$'),
  settled_at_ms BIGINT NOT NULL CHECK (settled_at_ms >= 0),
  settlement_digest TEXT NOT NULL CHECK (settlement_digest ~ '^sha256:[0-9a-f]{64}$'),
  event_json TEXT NOT NULL, event_digest TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, project_id, run_id, reservation_id, revision),
  CHECK (source <> 'reconciliation' OR provider_receipt_digest IS NOT NULL),
  FOREIGN KEY (tenant_id, project_id, run_id, reservation_id)
    REFERENCES factory_budget_reservations (tenant_id, project_id, run_id, reservation_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_factory_usage_settlement_receipt
  ON factory_usage_settlements (tenant_id, project_id, run_id, reservation_id, provider_receipt_digest)
  WHERE provider_receipt_digest IS NOT NULL;
```

`factory_budget_reservations.state` gains no new member. The existing
`'held' | 'running' | 'uncertain' | 'settled'` check is sufficient; `uncertain -> settled`
already exists.

### Validation rules — what is rejected
- A non-decimal cost string, a negative value, or a number where a string is required.
- A settlement whose `knownCostMicros` is below a previously settled revision.
- A reconciliation without a verified provider receipt digest.
- A settlement for a reservation in `held`, which never started. Only `running`, `uncertain`, and
  `settled` are settleable.
- A second event id for the same revision with different bytes.
- A settlement whose `settlementDigest` does not equal the recomputed canonical digest.

### Minimal type checkpoint
`feat(factory): type usage settlement`. Adds `src/factory/usage-settlement.ts`, the migration,
and one test that proves `attempt-stopped` and `usage-settled` are enqueued in the same
transaction through `src/factory/inbox.ts`.

### What it extends (C13)
`src/factory/budgets.ts` settle and markUncertain; `src/factory/inbox.ts`
`enqueueInTransaction`, which is already the durable inbox. Audit writes go through
`src/db/queries/audit-log.ts`, already required for `src/factory/executions.ts`
(`check-factory-boundaries.ts:58`). No new queue.

### Open questions and recommended defaults
1. **Does the kernel need `usage-settled` before a node can complete?** Default: no. The kernel
   accounting fields already exist (`KernelState.usageSettlements`, `spentCostMicros`,
   `unknownCostMicros`, `kernel-types.ts:146-148`). Emit on stop and on reconciliation, and let the
   kernel fold the event whenever it arrives.
2. **Who runs reconciliation?** Default: a bounded, stop-aware background worker registered by
   W09, polling reservations in `uncertain` that hold a cost.
3. **Can a confirmed zero charge release the hold?** Default: yes, as
   `source: "reconciliation"`, `knownCostMicros: "0"`, with the provider receipt digest present.
   That is evidence-backed, and it is not the forbidden case of settling an unknown as zero.

---

## 5. Asynchronous release profile (W07/W08)

### Owner and consumers
Single writer: **Sol assurance (W05)**, under the plan's row "Protected candidate/validator
binding and async release-profile interface". Consumers: W07 (coordinator, then a free Sol
worker), W08 (free Terra worker), W09 startup composition, W04a archive writer.

### Files
- `src/factory/protected-command-effects.ts:20-38` — the profile that must become asynchronous.
- `src/factory/release-application.ts:7-9` — the provider resolver, which stays as it is.
- `src/factory/releases.ts:103-107` — the provider, which gains a signal on `publish`.
- New: `src/factory/release-profile.ts`.

### What exists today

```ts
// src/factory/protected-command-effects.ts:33-38 — SYNCHRONOUS build
export interface FactoryReleaseCommandProfile {
  readonly adapter: RunnerReference;
  readonly action: string;
  build(input: FactoryReleaseCommandProfileInput): FactoryReleaseCommandProfileResult;
}
// :20-31
export interface FactoryReleaseCommandProfileInput {
  readonly acceptedCandidate: JsonValue;
  readonly destination: JsonValue;
  readonly decision: FactoryAcceptanceDecision;
  readonly material: FactoryReleaseMaterial;
}
export interface FactoryReleaseCommandProfileResult {
  readonly destination: FactoryReleaseDestination;
  readonly request: JsonValue;
  readonly estimatedSpendMicros: number;
}
```

```ts
// src/factory/release-application.ts:7-9 — provider SELECTION, a different concern
export interface FactoryReleaseProviderResolver {
  resolve(operation: FactoryReleaseOperation): FactoryReleaseProvider | Promise<FactoryReleaseProvider>;
}
// src/factory/releases.ts:103-107 — the provider itself
export interface FactoryReleaseProvider {
  publish(claim: FactoryReleaseClaim): Promise<FactoryProviderReceipt>;
  verifyReceipt(operation: FactoryReleaseOperation, receipt: FactoryProviderReceipt, evidence: unknown, signal?: AbortSignal): Promise<boolean>;
  proveNoEffect(operation: FactoryReleaseOperation, evidence: unknown, signal?: AbortSignal): Promise<boolean>;
}
```

`publish` takes no signal while the other two do. That asymmetry must go.

### Frozen type

```ts
// src/factory/release-profile.ts — NEW. Single writer: W05.

export const FACTORY_RELEASE_RESOLVE_TIMEOUT_MS = 120_000;

export interface FactoryReleaseProfileInput {
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  /** Exact accepted candidate, already frozen by the acceptance decision. */
  readonly acceptedManifest: JsonValue;
  readonly requestedDestination: JsonValue;
  readonly decision: FactoryAcceptanceDecision;   // src/factory/assurance.ts:24
  readonly material: FactoryReleaseMaterial;      // src/factory/releases.ts:34-39
}

export interface FactoryReleaseProfileResult {
  readonly schemaVersion: "factory.release-profile-result.v1";
  readonly destination: FactoryReleaseDestination;   // src/factory/releases.ts:27-32
  readonly request: JsonValue;
  readonly estimatedSpendMicros: number;
  /** `sha256:` digest of the canonical input this result was resolved from. */
  readonly inputDigest: string;
  /** `sha256:` digest of the canonical result, excluding this field. */
  readonly resultDigest: string;
  readonly resolvedAtMs: number;
}

/** Runs outside every transaction, under an abortable deadline. */
export interface FactoryAsyncReleaseProfile {
  readonly adapter: RunnerReference;
  readonly action: string;
  resolve(input: FactoryReleaseProfileInput, signal: AbortSignal): Promise<FactoryReleaseProfileResult>;
}
```

The provider gains one parameter for symmetry:

```ts
// src/factory/releases.ts:103-107 — CHANGED
export interface FactoryReleaseProvider {
  publish(claim: FactoryReleaseClaim, signal?: AbortSignal): Promise<FactoryProviderReceipt>;
  verifyReceipt(operation: FactoryReleaseOperation, receipt: FactoryProviderReceipt, evidence: unknown, signal?: AbortSignal): Promise<boolean>;
  proveNoEffect(operation: FactoryReleaseOperation, evidence: unknown, signal?: AbortSignal): Promise<boolean>;
}
```

### Identities and invariants — the required order
1. **Resolve** outside every transaction, under `FACTORY_RELEASE_RESOLVE_TIMEOUT_MS` and the
   caller's `AbortSignal`.
2. **Freeze** the result. Compute `inputDigest` and `resultDigest`.
3. **Archive before claim** (W04a). Write the immutable recovery intent plus every referenced
   candidate, evidence, and request object, and verify readability. `releases.ts:439-441` already
   writes the intent and material archives before setting `archive_ready = TRUE`. Publication
   stays pending while any member is unavailable or corrupt.
4. **One product transaction**: lock the operation, re-derive the exact input, recompute
   `inputDigest`, and reject on any difference. Then check acceptance, freshness, membership,
   package and validator trust, deadline, archive receipt, release-enable epoch, and the
   destination reservation. Atomically consume the exact approval or policy allowance and claim
   `pending -> executing` with a dispatch generation (`releases.ts:486`).
5. **Dispatch** outside the transaction (`releases.ts:515-530`).
6. **Receipt before settlement**: archive the confirmed receipt, then settle the product row.
   `releases.ts:526-528` already does archive-then-settle; keep that order.

Further invariants:
- No provider network I/O inside a transaction. **This is violated today**: `reconcile` calls
  `provider.verifyReceipt` and `provider.proveNoEffect` inside the open transaction at
  `releases.ts:541` and `:545`. W07 must move both outside and re-derive authority inside.
- An aborted resolve produces no operation row and no archive object.
- A result older than the resolve timeout is unusable. Re-resolve rather than reuse.
- The operation identity is unchanged and is re-derived on every read:
  `operationId === \`factory-release:${digestObject(identityFor(operation))}\`` (`releases.ts:317`,
  minted at `:425`). Database uniqueness stays
  `(tenant_id, project_id, run_id, node_instance_id, candidate_generation, action, destination_provider, destination_account, destination_object)`.

### Schema and migration
`factory_release_operations` gains three columns:

```sql
ALTER TABLE factory_release_operations ADD COLUMN IF NOT EXISTS profile_input_digest TEXT;
ALTER TABLE factory_release_operations ADD COLUMN IF NOT EXISTS profile_result_digest TEXT;
ALTER TABLE factory_release_operations ADD COLUMN IF NOT EXISTS profile_resolved_at_ms BIGINT;
-- catalog-driven CHECK: state = 'pending' OR profile_result_digest IS NOT NULL
-- catalog-driven CHECK: profile_input_digest IS NULL OR profile_input_digest ~ '^sha256:[0-9a-f]{64}$'
```

No new table.

### Validation rules — what is rejected
- A result whose `inputDigest` differs from the re-derived input inside the final transaction:
  `factory_release_profile_stale`.
- A request over the existing 1 MiB bound (`releases.ts:19`, checked at `:283`).
- An `estimatedSpendMicros` that is not a safe non-negative integer. Reuse `safeCount`
  (`protected-command-effects.ts:79`).
- A destination whose provider is not the resolver's provider for that operation.
- A resolve that returns after the timeout, or after the signal aborted.
- A receipt that fails `validateReceipt`: wrong provider, account, object, `operationId`,
  `requestDigest`, or `dispatchGeneration` gives `factory_release_foreign_receipt`
  (`releases.ts:325`).

### Minimal type checkpoint
`feat(factory): type asynchronous release profile`. Adds `src/factory/release-profile.ts`, adds
the three columns, adds the optional `signal` to `publish`, and redefines
`FactoryReleaseCommandProfile` to extend `FactoryAsyncReleaseProfile` with the synchronous `build`
retained and marked deprecated. W07 and W08 then implement `resolve` only.

### What it extends (C13)
C04's approval, claim, and uncertain-outcome pattern comes from
`src/extensions/project-pull-request-broker.ts` and `src/extensions/v4/lifecycle.ts`, both in
`SHARED_REUSE_MODULES` (`check-factory-boundaries.ts:34-35`). `src/factory/releases.ts` already
requires `src/delivery-queue/durable-delivery-queue.ts`, `src/db/queries/audit-log.ts`, and
`src/extensions/v4/blobs.ts` (`check-factory-boundaries.ts:52-54`), and
`src/factory/release-adapters.ts` requires `src/extensions/v4/blobs.ts` (`:55`).
`src/factory/release-profile.ts` should contain pure types and no blob access, so it needs no
`REQUIRED_SHARED_IMPORTS` row.

### Open questions and recommended defaults
1. **The name `resolve` collides.** `FactoryReleaseProviderResolver.resolve` already exists and
   means provider selection. Default: keep both. They sit on different interfaces, the plan quotes
   this exact spelling for the profile, and the F13 duplicate check inspects top-level functions
   and class fingerprints, not interface members, so there is no gate conflict. Document the
   distinction in both doc comments.
2. **Timeout value.** Default 120 s. Materializing a full code-pack tree on GitHub can exceed 30 s,
   and the node deadline is 30 minutes.
3. **Where does the signal come from?** Default: the release worker registered in W09 owns the
   `AbortController`; shutdown aborts it and the operation stays `pending`.
4. **Does `reconcile` keep its transaction?** Default: split it. Gather provider evidence outside,
   then re-derive authority and apply the reconciliation action inside one transaction.

---

## 6. Host launch, attach, stop protocol and per-attempt device contract (W01/W02)

### Owner and consumers
Single writer: **Terra runtime (W01 and W02)**, per the plan's table. Consumers: Sol lifecycle
(W03 stop), coordinator (W09 startup).

### Files
- `src/factory/runner/attempt-runtime.ts` — unmerged, commit `599e49e73`, fenced by `24f811e2e`.
- `src/db/migrations/add-factory-attempt-launches.ts` — unmerged.
- `packages/@ezcorp/extension-contract/src/types.d.ts:160-186` — `StartRequest`, `Runner`.
- `packages/@ezcorp/extension-runner/src/podman.ts` — shared module.
- `packages/@ezcorp/extension-runner/src/protocol.ts` — the frame policy.
- `src/factory/runner/supervisor.ts`, `src/factory/runner/native.ts`.
- `packages/@ezcorp/factory-sdk/src/types.ts` — `FactoryGuestModelRequest`,
  `FactoryGuestModelResponse`, `FACTORY_GUEST_MODEL_LIMITS` (added 2026-09-20, see section 16).
- `src/factory/runner/guest-model-broker.ts` — `FactoryGuestBroker`, the one reverse-capability
  seam both host runtimes take.
- `src/factory/runner/guest-model-journal.ts` — the durable half of a model call.
- `src/factory/runner/provider-one-hop.ts` — the adapter from the provider broker's stream.

### What exists today, and the four gaps

```ts
// packages/@ezcorp/extension-contract/src/types.d.ts:160-165 — the whole launch payload
export interface StartRequest {
  workerId: string;
  artifactDigest: string;
  context: InvocationContext;
  limits: ResourceLimits;
}
```
No device, no host, no fence, no generation.

```ts
// src/factory/runner/attempt-runtime.ts:67-74 (599e49e73)
export interface FactoryAttemptLaunchIntent {
  readonly request: FactoryRunnerRequest;
  readonly requestDigest: string;
  readonly lease: FactoryAttemptLease;
  readonly preparedPackage: FactoryPreparedPackageReceipt;
  readonly workerId: string;
  readonly state: FactoryAttemptLaunchState;
}
```

**Gap 1 — no durable invocation id.** It is synthesized ephemerally at `attempt-runtime.ts:269`
as `` invocationId: `${intent.workerId}:run` `` and never persisted.

**Gap 2 — devices are host-global.** `configuredRunnerDevices` reads process configuration or
`EZ_EXTENSION_RUNNER_DEVICES` once per runner instance (`podman.ts:60`) and applies the same list
to every execution container (`podman.ts:125`). The authors recorded the defect in
`tasks/lessons.md`: "GPU devices belong to the held per-attempt allocation; a global host runner
device list cannot authorize every attempt on that host."

**Gap 3 — `wait()` after attach always throws.**
```ts
// attempt-runtime.ts:281-289
wait: async () => { void execution; throw new FactoryAttemptRuntimeError("launch_uncertain", "Recovered factory workers require a durable terminal result before another invocation."); },
```
Nothing persists a `FactoryRunnerResult`. `factory_attempt_launches.state` reaches `'terminal'`,
which is a physical fact, not a result.

**Gap 4 — `supervisor.stop` returns nothing.**
```ts
// src/factory/runner/supervisor.ts:125-127
async stop(attemptId: string): Promise<void> { await this.active.get(attemptId)?.close(); }
```

The frame protocol exists but binds only a worker:
```ts
// packages/@ezcorp/extension-runner/src/protocol.ts:5 — not exported
type Frame = { jsonrpc: "2.0"; id?: string | number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };
```

### Frozen type

```ts
// src/factory/runner/attempt-runtime.ts — CHANGED. Single writer: W01/W02.

/** Exact device authorization for one attempt. A CPU attempt carries empty lists. */
export interface FactoryAttemptDeviceGrant {
  readonly schemaVersion: "factory.attempt-devices.v1";
  readonly attemptId: string;
  readonly reservationId: string;
  readonly holderGeneration: number;
  readonly hostId: string;
  /** Raw device nodes the held allocation authorizes. Empty for CPU. */
  readonly devices: readonly string[];
  /** CDI device names for the production NVIDIA profile. Empty on the local AMD profile. */
  readonly cdiDevices: readonly string[];
  readonly capabilities: readonly ("compute" | "utility")[];
  /** `sha256:` digest over the canonical grant, excluding this field. */
  readonly grantDigest: string;
}

export interface FactoryAttemptLaunchIntent {
  readonly schemaVersion: "factory.attempt-launch.v1";
  readonly request: FactoryRunnerRequest;
  readonly requestDigest: string;
  readonly lease: FactoryAttemptLease;               // attempt-runtime.ts:23-31, unchanged
  readonly preparedPackage: FactoryPreparedPackageReceipt;
  readonly workerId: string;
  /** Durable and stable across attach. Bound into every control frame. */
  readonly invocationId: string;
  readonly devices: FactoryAttemptDeviceGrant;
  readonly state: FactoryAttemptLaunchState;         // "prepared"|"launching"|"launched"|"terminal"|"uncertain"
}

export interface FactoryGuestControlFrame {
  readonly schemaVersion: "factory.guest-control.v1";
  readonly workerId: string;
  readonly invocationId: string;
  readonly attemptId: string;
  readonly sequence: number;
  readonly body: {
    readonly jsonrpc: "2.0";
    readonly id?: string | number;
    readonly method?: string;
    readonly params?: unknown;
    readonly result?: unknown;
    readonly error?: { readonly code: number; readonly message: string };
  };
}

export interface FactoryAttemptOpen {
  readonly disposition: FactoryAttemptOpenDisposition;   // "started"|"attached"|"terminal"|"uncertain"
  readonly workerId: string;
  readonly invocationId: string;
  wait(signal?: AbortSignal): Promise<FactoryRunnerResult>;
  stop(reason: FactoryPhysicalStopReason): Promise<FactoryPhysicalStopReceipt>;
}

export interface FactoryHostLaunchProtocol {
  launch(intent: FactoryAttemptLaunchIntent, signal: AbortSignal): Promise<FactoryAttemptOpen>;
  /** Reconnect without launching another guest and without orphan cleanup. */
  attach(attemptId: string, signal: AbortSignal): Promise<FactoryAttemptOpen>;
  stop(request: FactoryTaskStopRequest, signal: AbortSignal): Promise<FactoryPhysicalStopReceipt>;
}

/** Durable and reproducible after total row loss, like factoryAttemptWorkerId. */
export function factoryAttemptInvocationId(attemptId: string, candidateGeneration: number, attemptNumber: number): string;
```

Shared-package change, additive only:

```ts
// packages/@ezcorp/extension-contract/src/types.d.ts:160-165 — CHANGED
export interface StartRequest {
  workerId: string;
  artifactDigest: string;
  context: InvocationContext;
  limits: ResourceLimits;
  /** Exactly the devices this start may use. Absent means none. */
  devices?: readonly string[];
}
```

### Identities and invariants
- One durable launch intent per attempt. `worker_id` stays `NOT NULL UNIQUE`.
- `invocationId` is durable, stable, and reproducible. A fresh attach reuses it and never issues a
  second `extension/invoke`. The existing CAS is the one-winner rule:
  `UPDATE factory_attempt_launches SET state='launching' ... WHERE attempt_id=$1 AND state='prepared'`
  (`attempt-runtime.ts:189`).
- Every control frame binds worker, invocation, and attempt. A frame whose triple does not match
  is dropped, not answered.
- Losing the controlling attachment never terminates the guest and never authorizes another
  effect. `podman.ts` `attach` already denies reverse effects with `recovery_effect_denied`.
- Attach must not run the normal-startup orphan cleanup. `probeSecurity(cleanupOrphans)` is
  already parameterized for that.
- A CPU start carries `devices: []` and `cdiDevices: []`. A non-empty list without a `gpu-host`
  allocation is rejected.
- The guest gets exactly one reverse method. `attempt-runtime.ts:259` already enforces
  `method !== "factory.broker"` as an error.
- The supervisor signs the physical stop receipt. `signStopReceipt` is injected
  (`attempt-runtime.ts:209`), so product code never receives the host private key.
- `wait()` returns a terminal result after recovery once a durable terminal result exists.

### Schema and migration
`src/db/migrations/add-factory-attempt-launches.ts`:

```sql
ALTER TABLE factory_attempt_launches ADD COLUMN IF NOT EXISTS invocation_id TEXT;
-- backfill from factoryAttemptInvocationId for existing rows, then:
ALTER TABLE factory_attempt_launches ALTER COLUMN invocation_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_factory_attempt_launches_invocation ON factory_attempt_launches (invocation_id);
ALTER TABLE factory_attempt_launches ADD COLUMN IF NOT EXISTS device_grant_json JSONB NOT NULL DEFAULT '{"devices":[],"cdiDevices":[],"capabilities":[]}'::jsonb;
ALTER TABLE factory_attempt_launches ADD COLUMN IF NOT EXISTS device_grant_digest TEXT;
-- catalog-driven CHECK: device_grant_digest IS NULL OR device_grant_digest ~ '^sha256:[0-9a-f]{64}$'
```

**Existing defect to correct in the same migration.** The current backfill adds
`package_receipt_json JSONB` with `ADD COLUMN IF NOT EXISTS` and never applies `SET NOT NULL`,
while `CREATE TABLE` declares it `NOT NULL`. An upgraded database can therefore hold a NULL where
a fresh one cannot. Add a fail-closed guard and the `SET NOT NULL`, exactly as the migration
already does for `host_id`.

**Terminal result storage.** Recommended default: reuse `factory_execution_terminals`
(`attempt_id TEXT PRIMARY KEY`, already holding `result_json`, `terminal_result_digest`,
`terminal_fact_digest`). Recovery reads it. No new table.

**Ordering.** `add-factory-attempt-launches` must be registered before `add-factory-task-stops`
(surface 3) and before any migration that references a launch row.

### Validation rules — what is rejected
- A device outside `/dev/kfd` or `/dev/dri/renderD[0-9]+`, more than 16 devices, or a duplicate.
  `configuredRunnerDevices` (`podman.ts:31-35`) already implements this; it becomes a per-attempt
  validator instead of a host-global source.
- A device grant whose `holderGeneration` or `hostId` differs from the current lease.
- Any device on a start whose allocation vector lacks `gpu-host`.
- A control frame with a mismatched worker, invocation, or attempt; an oversized frame
  ("Control frame exceeds policy", `protocol.ts:59`); more than 32 pending frames; a method name
  over 128 characters; or a method other than `factory.broker`.
- `attach` on an attempt with no launch row, or on a row still in `prepared`.
- A second `claimStart` on a `launching` row.
- A launch whose request digest fails `/^[0-9a-f]{64}$/` or whose package receipt digest fails
  `/^sha256:[0-9a-f]{64}$/`.

### Minimal type checkpoint
`feat(factory): type per-attempt device grant and launch identity`. Adds
`FactoryAttemptDeviceGrant`, the `invocationId` field and its derivation, `FactoryGuestControlFrame`,
`FactoryHostLaunchProtocol`, the optional `StartRequest.devices`, the migration columns, and the
`package_receipt_json` correction. Behavior is unchanged: every device list stays empty until W02.

### What it extends (C13)
C05's CPU isolation profile row names `packages/@ezcorp/extension-runner/src/podman.ts` as
"Reuse; add broker-only egress and resource classes". That file is already entry 1 of
`SHARED_REUSE_MODULES` (`check-factory-boundaries.ts:30`). Because it is shared, **any top-level
factory function whose name and arity match an exported `podman.ts` function reds the F13 gate**.
The check keys on `name / requiredParamCount / totalParamCount` only; parameter types are ignored
(`check-factory-boundaries.ts:150-156`). Budget for that blast radius.

### Open questions and recommended defaults
1. **How is `invocationId` derived?** Default:
   `factory_${sha256(attemptId + ":" + candidateGeneration + ":" + attemptNumber).slice(0, 48)}`,
   mirroring `factoryAttemptWorkerId` (`attempt-runtime.ts:127-131`), so it survives total row loss.
2. **Where does the terminal result live?** Default: `factory_execution_terminals`, written by the
   gateway before it acknowledges, so a recovered `wait()` can read it.
3. **Is `StartRequest.devices` required?** Default: optional, so v4 extension callers do not
   change. Factory starts always pass an explicit array, including `[]`.
4. **AMD versus NVIDIA.** Default: keep `devices` and `cdiDevices` as separate fields. The local
   AMD probe fills `devices`; the production NVIDIA profile fills `cdiDevices`. The plan is
   explicit that the local probe does not establish the production profile.
5. **Does `PodmanRunner` keep `configuredDevices`?** Default: yes, for the v4 extension path, so
   existing behavior does not change. Factory execution starts must use `input.devices ?? []` and
   must ignore `configuredDevices` entirely.

---

## 7. Auxiliary material service and scoped reader (W04)

### Owner and consumers
Single writer: **Sol artifacts (W04)**, under the plan's row "Auxiliary material service, scoped
reader, gateway artifact routes". Consumers: validators (W05), release providers (W07/W08),
domain packs (W10–W12), previews (W14), and W04a's archive writer.

### Files
- New: `src/factory/artifact-materials.ts`.
- Extended: `src/factory/artifacts.ts`, `src/factory/artifact-access.ts`,
  `src/factory/input-artifacts.ts`, `src/factory/executions.ts` (journal hooks).
- New migration: `src/db/migrations/add-factory-artifact-materials.ts`.

### What exists today
Every artifact write is a single in-memory buffer. There is no chunk, part, offset, append,
multipart, `Readable`, or `ReadableStream` in `artifacts.ts`, `artifact-access.ts`, or
`input-artifacts.ts`. The only payload parameters are `content: Uint8Array` and
`bytes: Uint8Array`.

```ts
// src/factory/artifacts.ts:14-16
export const FACTORY_ARTIFACT_MAX_BYTES = FACTORY_PAGE_BYTES_LIMIT;         // 32 KiB
export const FACTORY_CANDIDATE_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
export type FactoryArtifactKind = "definition_page" | "definition_manifest" | "transition_page" | "transition_manifest" | "execution_manifest" | "partition" | "candidate_output";
```

There is no update and no delete anywhere in the class. Immutability comes from a `FOR SHARE`
pre-read plus a conflict check (`artifacts.ts:84-89`) and a digest re-verification on every read
(`artifacts.ts:138`).

The artifact reference is validated in three places with three different constants but the same
16 MiB ceiling: `artifacts.ts:118`, `artifact-access.ts:93-97`, `input-artifacts.ts:14-18`. The
digest regexes differ only textually (`[0-9a-f]` versus `[a-f0-9]`).

### Frozen type

```ts
// src/factory/artifact-materials.ts — NEW. Single writer: W04.

export const FACTORY_MATERIAL_LIMITS = Object.freeze({
  maxChunkBytes: 8 * 1024 * 1024,
  maxChunks: 64,
  maxTotalBytes: 256 * 1024 * 1024,
  maxObjectsPerOperation: 256,
  maxNameLength: 512,
});

export interface FactoryMaterialScope {
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly operationId: string;
}

export interface FactoryMaterialIdentity extends FactoryMaterialScope {
  /** Author-chosen stable name, unique within the scope. */
  readonly objectName: string;
  /** Monotonic per (scope, objectName). Starts at 1. */
  readonly version: number;
}

export interface FactoryMaterialChunk {
  /** 0-based and contiguous. */
  readonly index: number;
  readonly digest: string;
  readonly encodedBytes: number;
}

export interface FactoryMaterialRecord extends FactoryMaterialIdentity {
  readonly schemaVersion: "factory.material.v1";
  readonly mediaType: string;
  /** `sha256:` + 64 hex over the assembled bytes. */
  readonly digest: string;
  readonly totalBytes: number;
  readonly chunkCount: number;
  readonly storageVersion: string;
  readonly sealed: boolean;
  readonly createdAtMs: number;
  /** Present only after seal. */
  readonly artifact?: FactoryArtifactReference;
}

export interface FactoryMaterialService {
  /** Commits the operation row before any upload. */
  begin(identity: FactoryMaterialIdentity, mediaType: string, totalBytes: number, chunkCount: number, signal?: AbortSignal): Promise<FactoryMaterialRecord>;
  writeChunk(identity: FactoryMaterialIdentity, chunk: FactoryMaterialChunk, content: Uint8Array, signal?: AbortSignal): Promise<FactoryMaterialRecord>;
  /** Verifies the assembled digest, then issues the immutable handle. */
  seal(identity: FactoryMaterialIdentity, digest: string, signal?: AbortSignal): Promise<FactoryArtifactReference>;
  list(scope: FactoryMaterialScope, signal?: AbortSignal): Promise<readonly FactoryMaterialRecord[]>;
}

/** The one reader for validators, release profiles, and previews. */
export interface FactoryScopedArtifactReader {
  read(scope: FactoryMaterialScope, artifactReference: FactoryArtifactReference, signal?: AbortSignal): Promise<Uint8Array>;
  readChunk(scope: FactoryMaterialScope, artifactReference: FactoryArtifactReference, index: number, signal?: AbortSignal): Promise<Uint8Array>;
}

/** One validator replacing the three current copies. */
export function assertFactoryArtifactReference(value: FactoryArtifactReference, maximumBytes: number): FactoryArtifactReference;
```

`FactoryArtifactKind` gains one member: `"material"`.

### Identities and invariants
- Bound to tenant, project, run, attempt, operation, and object identity. The scope is the
  identity; it is never inferred from the reference alone.
- Commit the operation row before the first chunk upload. Recheck authority before issuing a
  handle.
- Chunk writes are idempotent on `(scope, objectName, version, index, digest)`. A repeat with the
  same digest succeeds; a different digest is a conflict.
- `seal` verifies the assembled digest and the chunk count. After seal the record is immutable.
  There is no update and no delete, matching the existing class.
- `read` always re-verifies bytes against the stored digest and the storage version. No separate
  unverified blob loader is added.
- A cross-scope read is denied without disclosing whether the object exists. Reuse
  `unavailable()` (`artifact-access.ts:91`), which funnels every denial to one code.
- A late write after the attempt deadline is rejected by the journal, per C02: an expired attempt
  cannot commit an output or issue another broker request.
- Chunks never cross a Temporal argument. They move over the private gateway HTTP envelope, so the
  C08 64 KiB payload limit and the 32 KiB recorded-page limit are unaffected.

### Schema and migration

```sql
CREATE TABLE IF NOT EXISTS factory_artifact_materials (
  tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL, operation_id TEXT NOT NULL,
  object_name TEXT NOT NULL, version INTEGER NOT NULL CHECK (version >= 1),
  media_type TEXT NOT NULL,
  digest TEXT NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  total_bytes BIGINT NOT NULL CHECK (total_bytes >= 1 AND total_bytes <= 268435456),
  chunk_count INTEGER NOT NULL CHECK (chunk_count >= 1 AND chunk_count <= 64),
  storage_version TEXT NOT NULL,
  sealed BOOLEAN NOT NULL DEFAULT FALSE,
  object_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, project_id, run_id, attempt_id, operation_id, object_name, version),
  CHECK (sealed = (object_id IS NOT NULL)),
  FOREIGN KEY (attempt_id, tenant_id, project_id, run_id)
    REFERENCES factory_executions (attempt_id, tenant_id, project_id, run_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_factory_artifact_materials_object
  ON factory_artifact_materials (tenant_id, project_id, object_id) WHERE object_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS factory_artifact_material_chunks (
  tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL, operation_id TEXT NOT NULL,
  object_name TEXT NOT NULL, version INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0 AND chunk_index < 64),
  chunk_digest TEXT NOT NULL CHECK (chunk_digest ~ '^sha256:[0-9a-f]{64}$'),
  encoded_bytes INTEGER NOT NULL CHECK (encoded_bytes >= 1 AND encoded_bytes <= 8388608),
  blob_digest TEXT NOT NULL, storage_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, project_id, run_id, attempt_id, operation_id, object_name, version, chunk_index),
  FOREIGN KEY (tenant_id, project_id, run_id, attempt_id, operation_id, object_name, version)
    REFERENCES factory_artifact_materials (tenant_id, project_id, run_id, attempt_id, operation_id, object_name, version) ON DELETE RESTRICT
);
```

`factory_artifacts.kind` must accept `'material'`. A CHECK cannot be altered in place, so use a
catalog-driven `DO $$` block that drops the old check by definition match and re-adds the widened
one, the same technique as `strengthen-factory-assurance.ts:11`.

**Do not reconcile `factory_artifacts` uniqueness into `schema.ts`.** The Drizzle model
deliberately omits `factory_artifacts_admission_identity`; the helper
`src/db/migrations/factory-artifact-admission-index.ts` rebuilds that index conditionally based on
which columns exist, and three migrations re-run it.

### Validation rules — what is rejected
- `chunkCount` or `totalBytes` beyond `FACTORY_MATERIAL_LIMITS`; a chunk index out of range; a
  gap in the chunk sequence at seal.
- A media type outside the existing grammar
  `/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/u` (`artifact-access.ts:92`).
- A digest mismatch at seal, a missing chunk, or a duplicate object name at the same version.
- A version that is not `previous + 1`.
- An archive entry whose path traverses outside its root, a symlink, a device node, or a
  decompression bomb. Reuse the v4 dependency fetcher's rules; `dependencies.ts:101` already
  rejects links, devices, and extended tar entries.
- A read whose scope does not match the stored scope, or whose reference fails
  `assertFactoryArtifactReference`.
- A write after the attempt deadline, or from an attempt whose execution epoch or reservation
  generation is stale.

### Minimal type checkpoint
`feat(factory): type auxiliary artifact materials`. Adds `src/factory/artifact-materials.ts`, the
two tables, the `'material'` kind, and `assertFactoryArtifactReference`, then replaces the three
duplicate reference validators in `artifacts.ts`, `artifact-access.ts`, and `input-artifacts.ts`
with calls to it. That consolidation is also the DRY correction the three-copy divergence needs.

### What it extends (C13)
C06's blob store row names `src/extensions/v4/blobs.ts`; `src/factory/artifacts.ts` already
requires it (`check-factory-boundaries.ts:60`). W04 must add one row to `REQUIRED_SHARED_IMPORTS`:

```ts
{ factoryPath: "src/factory/artifact-materials.ts", sharedModule: "src/extensions/v4/blobs.ts" },
```

That import must be a literal top-level `import` statement resolving to exactly
`src/extensions/v4/blobs.ts`. A barrel, a dynamic `import()`, a re-export, or a `.js`-suffixed
specifier does **not** satisfy the check (`check-factory-boundaries.ts:246-265`). A type-only
import does satisfy it.

### Open questions and recommended defaults
1. **Chunk size and count.** Default 8 MiB by 64 chunks, giving 512 MiB of headroom for the
   256 MiB data export the plan names.
2. **Does a material get a `FactoryArtifactReference`?** Default: yes, at seal, so validators,
   release profiles, and previews all consume one reference type.
3. **Where do workspace checkpoints live?** Default: as materials under a reserved `workspace/`
   object-name prefix, so recovery uses the same scoped reader and the same verification.
4. **Does the scoped reader replace `loadSharedInTransaction`?** Default: no. Cross-project read
   grants stay in `artifact-access.ts` with their own sealed grant digest. The scoped reader is
   the attempt-scoped path; the two are different authorities and must not merge.

---

## 8. Journal outcome, stop, and usage validation (W03)

### Owner and consumers
Single writer: **Sol lifecycle (W03)**, exactly as the plan's table states. Consumers: Terra
runtime (W01), Sol artifacts (W04 artifact writer), Sol assurance (W05 validators).

### Files
- New: `src/factory/journal-validation.ts`.
- Extended: `src/factory/executions.ts`, `src/factory/task-outcomes.ts`,
  `src/factory/task-completions.ts`, `src/factory/task-stops.ts`.

### What exists today
The rules exist but are scattered inline, and the journal boundary is untyped.

```ts
// src/factory/executions.ts:65-71 — usage is `unknown` at the journal boundary
export interface FactoryOperationSettlement {
  readonly operationId: string;
  readonly state: "completed" | "failed" | "uncertain";
  readonly resultDigest?: string;
  readonly result?: JsonValue;
  readonly usage?: unknown;
  readonly workspaceCheckpoint?: FactoryCheckpointReference;
  readonly providerReceiptDigest?: string;
}
// src/factory/executions.ts:274-275 — settlement preconditions
if (state === "completed" && (!result.resultDigest || result.result === undefined || result.usage === undefined || result.workspaceCheckpoint === undefined)) throw new Error("A completed factory operation needs result, usage, and workspace checkpoint evidence.");
if (state === "failed" && !result.resultDigest) throw new Error("A failed factory operation needs a result digest.");
```

`executions.ts:344` narrows usage only at terminal verification; `:367` sums `inputTokens`,
`outputTokens`, and `computeMs` as numbers and `costMicros` as `BigInt`, then requires byte
equality with `result.usage`.

```ts
// src/factory/task-outcomes.ts:22-29
export interface FactoryTaskOutcomeReceipt {
  readonly reservationId: string;
  readonly resultStatus: FactoryNonSuccessfulRunnerResult["status"];
  readonly terminalResultDigest: string;
  readonly evidenceDigest: string;
  readonly usageDisposition: "measured_pending_stop" | "unknown_held";
  readonly event: Extract<KernelEvent, { readonly kind: "node-failed" }>;
}
```

### Frozen type

```ts
// src/factory/journal-validation.ts — NEW. Single writer: W03.

export type FactoryJournalFact = "outcome" | "stop" | "usage";

export interface FactoryJournalValidationIssue {
  readonly fact: FactoryJournalFact;
  readonly code: string;
  readonly path: readonly (string | number)[];
}

export type FactoryJournalValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly FactoryJournalValidationIssue[] };

export function validateFactoryOperationUsage(usage: unknown): FactoryJournalValidationResult;
export function validateFactoryTerminalUsage(
  result: FactoryRunnerResult,
  operations: readonly FactoryJournalOperationEvidence[],
): FactoryJournalValidationResult;
export function validateFactoryTaskOutcome(
  receipt: FactoryTaskOutcomeReceipt,
  result: FactoryNonSuccessfulRunnerResult,
  authority: FactoryAttemptAuthority,
): FactoryJournalValidationResult;
export function validateFactoryStopReceipt(
  request: FactoryTaskStopRequest,
  receipt: FactoryPhysicalStopReceipt,
  keys: ReadonlyMap<string, { readonly hostId: string; readonly publicKey: KeyLike }>,
): FactoryJournalValidationResult;
```

One field changes type, from `unknown` to the SDK union:

```ts
// src/factory/executions.ts:65-71 — CHANGED
export interface FactoryOperationSettlement {
  readonly operationId: string;
  readonly state: "completed" | "failed" | "uncertain";
  readonly resultDigest?: string;
  readonly result?: JsonValue;
  readonly usage?: FactoryUsage;                    // was: unknown
  readonly workspaceCheckpoint?: FactoryCheckpointReference;
  readonly providerReceiptDigest?: string;
}
```

The `FactoryValidationResult` shape mirrors the SDK's existing `ValidationResult`
(`factory-sdk/src/types.ts:576-578`), so the two report styles stay consistent.

### Identities and invariants
- A `completed` operation needs a result, measured usage, and a workspace checkpoint.
- An `uncertain` operation needs `FactoryUnknownUsage` and a provider receipt digest. The SDK
  already states this: the `"uncertain"` arm of `FactoryRunnerResult` requires both
  (`factory-sdk/src/types.ts:529-561`).
- Terminal usage must equal the summed operation usage, with `costMicros` compared as `BigInt`.
- A stop receipt is valid only against a preloaded host-key map, the exact sealed request fields,
  and `processGroupAbsent === true`.
- `usageDisposition` stays a two-member union. A settled usage moves the reservation state, not
  the disposition.
- Late reconciliation writes `state = 'uncertain'` with a mandatory provider receipt digest, only
  from `state = 'dispatched'`, and never advances `journal_cursor` (`executions.ts:386`).

### Schema and migration
No new table. One tightening on `factory_execution_operations`:

```sql
-- catalog-driven CHECK: usage_json IS NULL OR (usage_json::jsonb->>'kind') IN ('measured','unknown')
```

### Validation rules — what is rejected
- A usage kind outside `"measured" | "unknown"`.
- A non-decimal `costMicros` or `heldCostMicros`, or a negative token or compute count.
- A completed operation missing any of result, usage, or workspace checkpoint.
- An uncertain operation without a provider receipt digest.
- A terminal whose summed operation usage differs from `result.usage` in any field.
- A stop receipt with an unknown key id, a host mismatch, a wrong schema version, a digest that is
  not the hash of the unsigned body, a non-base64url signature, or a failed RSA-SHA256 verify.
- A stop clock outside bounds.

### Minimal type checkpoint
`feat(factory): share journal fact validation`. Adds `src/factory/journal-validation.ts`, changes
`FactoryOperationSettlement.usage` to `FactoryUsage`, and moves the existing inline checks into
the module. This is a pure refactor with no behavior change, so it can land in wave 1 ahead of
every other checkpoint.

### What it extends (C13)
`src/factory/executions.ts` already requires `src/db/queries/audit-log.ts` and
`src/extensions/v4/blobs.ts` (`check-factory-boundaries.ts:58-59`). No new shared module.

**F13 arity trap.** The duplicate check compares `name / requiredParams / totalParams` on all
top-level declarations, exported or not, across
`packages/@ezcorp/factory-sdk/src`, `src/factory`, `web/src/lib/factory`, and
`web/src/routes/api/factories`. Do not name a new helper `validate(a, b)` or `parse(a)`; those
collide with common shared-module exports. There is no allowlist or suppression.

### Open questions and recommended defaults
1. **Should `FactoryTaskStopError.code` become a union?** It is a bare `string` today, unlike the
   sibling error classes, which use unions. Default: yes. Use `FactoryTaskStopCode` from surface 3
   and map each member to an HTTP status in `web/src/routes/api/factories/_shared.ts`. The
   unmerged stash does not map any of them, so a stop failure currently surfaces as a 500.
2. **Does the Drizzle model need the migration's coherence checks?** Default: yes. The
   `factoryTaskStops` model omits four of them, which is a real schema-parity failure waiting to
   happen on the PostgreSQL lane.

---

## 9. Strict validator report (W05)

### Owner and consumers
Single writer: **Sol controls**, under the plan's row "SDK validator report, public
artifact-reference validation, acceptance events, kernel/reference graph semantics". Consumers:
Sol assurance (W05, the producer and the first consumer), Sol product (W14), domain packs
(W10–W12).

This split is deliberate. The plan says: "This lets W05 consume the report/event contract without
waiting for all of W06." The SDK type checkpoint must land early even though W06's remediation
proof lands late.

### Files
- `packages/@ezcorp/factory-sdk/src/types.ts` — the new types.
- `packages/@ezcorp/factory-sdk/src/validation.ts` — the new semantic validator.
- `packages/@ezcorp/factory-sdk/src/index.ts` — the export barrel.
- New generated `packages/@ezcorp/factory-sdk/src/factory-validator-report.schema.json`.
- `src/factory/validator-materials.ts` — the consumer, replacing `strictClaims`.

### What exists today
There is no verdict type. `grep` for `ValidatorReport`, `VALIDATOR_REPORT`, and `validatorReport`
across the SDK and `src/factory` returns zero hits. The entire vocabulary is a boolean pair, and
exactly one claim:

```ts
// src/factory/validator-materials.ts:163
function strictClaims(content: Uint8Array, validatorId: string): readonly { id: string; passed: boolean; decisive: boolean }[] {
// :169
if (value.schemaVersion !== "factory.validator-result.v1" || !Array.isArray(value.claims) || value.claims.length !== 1) throw new FactoryTrustedValidatorError("factory_validator_result_invalid");
```

Process exit is **not** used for verdicts. The one `process.exitCode` in the validator path is a
JSON-parse failure signal in a bridge CLI (`src/factory/runner/canonical-validator.mjs:6-20`); the
success path writes the result to stdout and sets no exit code.

### Frozen type
Two types, not one. C04 states that "arbitrary runner JSON cannot mint issuer provenance", so the
guest writes claims only and the gateway's validator path seals the provenance.

```ts
// packages/@ezcorp/factory-sdk/src/types.ts — NEW. Single writer: Sol controls.

export const FACTORY_VALIDATOR_CLAIMS_SCHEMA_VERSION = "factory.validator-claims.v1" as const;
export const FACTORY_VALIDATOR_REPORT_SCHEMA_VERSION = "factory.validator-report.v1" as const;

export type FactoryValidatorVerdict = "PASS" | "FAIL" | "INCONCLUSIVE" | "VALIDATOR_ERROR";

export interface FactoryValidatorClaimOutcome {
  /** @minLength 1 @maxLength 512 */
  readonly id: string;
  readonly verdict: FactoryValidatorVerdict;
  /** A decisive claim can close its group alone. */
  readonly decisive: boolean;
  /** @maxLength 2048 */
  readonly summary: string;
  /** Machine-readable reason. @minLength 1 @maxLength 128 */
  readonly reasonCode: string;
  /** @maxItems 100 */
  readonly evidence: readonly FactoryArtifactReference[];
  /** @minimum 0 @maximum 9007199254740991 */
  readonly measuredAtMs: number;
}

/** What the isolated guest writes. It carries no provenance and mints no trust. */
export interface FactoryValidatorClaimReport {
  readonly schemaVersion: "factory.validator-claims.v1";
  /** @minItems 1 @maxItems 1000 */
  readonly claims: readonly FactoryValidatorClaimOutcome[];
  /** Present only when every claim is VALIDATOR_ERROR. */
  readonly error?: { readonly code: string; readonly message: string };
}

/** Gateway-sealed provenance. Every field is read from the durable assignment row. */
export interface FactoryValidatorProvenance {
  readonly attemptId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly candidateNodeInstanceId: string;
  readonly candidateGeneration: number;
  /** @minLength 71 @maxLength 71 */
  readonly candidateDigest: string;
  /** @minLength 71 @maxLength 71 */
  readonly validatorLockDigest: string;
  /** @minLength 71 @maxLength 71 */
  readonly runnerDigest: string;
  /** @minLength 71 @maxLength 71 */
  readonly environmentDigest: string;
  /** @minLength 71 @maxLength 71 */
  readonly configurationDigest: string;
  readonly model?: FactoryModelPin;
  /** @minimum 1 */
  readonly trustRevision: number;
  /** @minimum 1 */
  readonly issuerGrantRevision: number;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

/** The sealed report. Only the gateway validator path constructs one. */
export interface FactoryValidatorReport {
  readonly schemaVersion: "factory.validator-report.v1";
  readonly provenance: FactoryValidatorProvenance;
  /** @minItems 1 @maxItems 1000 */
  readonly claims: readonly FactoryValidatorClaimOutcome[];
  readonly error?: { readonly code: string; readonly message: string };
}
```

```ts
// packages/@ezcorp/factory-sdk/src/validation.ts — NEW
export function validateFactoryValidatorClaimReport(value: unknown): ValidationResult;
export function validateFactoryValidatorReport(value: unknown): ValidationResult;
```

### Identities and invariants
- A successful process exit is not a PASS. The report is the only verdict source.
- `VALIDATOR_ERROR` is an infrastructure fact. It is never an acceptance input and never a
  rejection input.
- `INCONCLUSIVE` never satisfies a required claim and never counts toward a group's
  `minimumPasses`.
- Every claim id must appear in the bound assignment's `validatorIds`. Extra ids are rejected.
- Every provenance digest must equal the durable assignment row's value. The runner cannot supply
  its own provenance.
- `decisive` survives, because `assurance.ts` group evaluation uses `requireAllDecisive`
  (`FactoryReleaseContractBody.claimGroups`, `factory-sdk/src/types.ts`).
- The full 71-character digest format (`sha256:` plus 64 hex) is the house standard everywhere
  except `contextDigest`, which is bare 64 hex.

### Schema and migration
`src/db/migrations/add-factory-validator-report.ts`, registered **after**
`allow-factory-validator-multiclaim`:

```sql
ALTER TABLE factory_validator_results ADD COLUMN IF NOT EXISTS verdict TEXT;
ALTER TABLE factory_validator_results ADD COLUMN IF NOT EXISTS report_digest TEXT;
UPDATE factory_validator_results SET verdict =
  CASE WHEN ((claims_json::jsonb)->0->>'passed')::boolean THEN 'PASS' ELSE 'FAIL' END
  WHERE verdict IS NULL;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM factory_validator_results WHERE verdict IS NULL) THEN
    RAISE EXCEPTION 'factory validator result requires an explicit verdict';
  END IF;
END $$;
ALTER TABLE factory_validator_results ALTER COLUMN verdict SET NOT NULL;
-- catalog-driven CHECK: verdict IN ('PASS','FAIL','INCONCLUSIVE','VALIDATOR_ERROR')
-- catalog-driven CHECK: report_digest IS NULL OR report_digest ~ '^sha256:[0-9a-f]{64}$'
```

`verdict` is denormalized for fast console reads and for the rejection path in surface 10. The
authoritative record stays `claims_json`.

### Validation rules — what is rejected
- Any unknown key, an unknown verdict, a missing `reasonCode`, a `summary` over 2048 characters,
  more than 100 evidence references, or a duplicate claim id.
- A claim id that is not in the bound assignment.
- An evidence reference that fails `assertFactoryArtifactReference` or points outside the
  attempt's scope.
- A report older than the claim's `freshnessMs`, or older than `maxEvidenceAgeMs`.
- A report whose bytes do not match the terminal artifact digest.
- A guest-written payload that carries any provenance field.

### Minimal type checkpoint
`feat(factory-sdk): type strict validator report`. Adds the three types and the verdict union to
`types.ts`, runs `schema:generate` for the new schema file, exports everything from `index.ts`,
and adds the two validators to `validation.ts`. This is the checkpoint that unblocks W05 without
W06.

### What it extends (C13)
The SDK **is** the shared module here; C07 states that
"`@ezcorp/factory-sdk` owns the only execution schema" and that "handwritten alternative execution
schemas are forbidden". On the product side this replaces `strictClaims`
(`validator-materials.ts:163`); it does not add a parallel parser.

### Open questions and recommended defaults
1. **One schema version or two?** Default: two, as above. C04 forbids runner-minted provenance,
   so the guest envelope must be a strict subset of the sealed report.
2. **Must a FAIL carry evidence?** Default: yes, at least one evidence reference or a non-empty
   `summary`. Otherwise W06 cannot build a useful repair input.
3. **Does the old `passed` boolean survive anywhere?** Default: no. Replace it everywhere, and let
   the migration's backfill be the only place the mapping exists.
4. **`schema:generate` is manual.** Editing `types.ts` without rerunning it silently desynchronizes
   eight committed schema files, and the hand-rolled validator at `schema.ts:46-84` silently
   ignores `allOf`, `oneOf`, `not`, `pattern`, `format`, `patternProperties`, `dependencies`,
   `multipleOf`, and `uniqueItems`. Default: W18 adds a CI check asserting that regeneration
   produces no diff, and no sketch uses an ignored keyword.

---

## 10. Acceptance and rejection events (W05/W06)

### Owner and consumers
SDK event semantics: **Sol controls**. Durable receipt writer: **Sol assurance (W05)** for the
acceptance branch, **Sol controls (W06)** for the rejection branch. This is the one file with two
writers; they must split by decision branch and coordinate. Consumers: W05, W06, W14.

### Files
- `packages/@ezcorp/factory-sdk/src/kernel-types.ts` — `FailureKind`, events, commands.
- `packages/@ezcorp/factory-sdk/src/kernel.ts` — the remediation wait and the bound.
- `src/factory/protected-command-effects.ts` — the receipt union.
- `src/factory/assurance.ts` — claim evaluation.
- `src/db/migrations/add-factory-protected-command-effects.ts`.

### What exists today, and the recorded defect
Acceptance crosses the boundary as a command and returns as a `node-result` event.

```ts
// packages/@ezcorp/factory-sdk/src/kernel-types.ts:388-396
  | {
      readonly kind: "request-acceptance";
      readonly id: string;
      readonly nodeId: string;
      readonly candidateGeneration: number;
      readonly candidate: JsonValue;
      readonly evidence: JsonValue;
      readonly deadlineAtMs: number;
    }
// :45-55
export type FailureKind =
  | "execution" | "output_invalid" | "deadline" | "cancelled"
  | "admission_denied" | "approval_denied" | "approval_expired"
  | "acceptance_rejected" | "release_uncertain" | "bound_exhausted";
```

`"acceptance_rejected"` is declared and never emitted. A failing claim is a thrown exception:
`assurance.ts:247` throws `FactoryAssuranceError("factory_assurance_claim_failed")`. No receipt
row is written, so there is **no durable rejected fact at all**. The `accept()` path has only two
branches:

```ts
// src/factory/protected-command-effects.ts:147
const decision = await this.assurance.acceptCurrentInTransaction(transaction, { ... }, context.node.contract);
```
`acceptCurrentInTransaction` either returns a `FactoryAcceptanceDecision` or throws. There is no
third branch.

The consequence is recorded as a lesson in the unmerged validator-binding worktree:

> Persist both accepted and rejected protected decisions as kernel events. If an acceptance
> activity throws for a policy rejection, the worker retries until timeout and never reaches the
> factory's bounded repair or remediation path.

### Frozen type

```ts
// src/factory/protected-command-effects.ts — CHANGED.

export type FactoryProtectedDecision = "accepted" | "rejected";

/** Classifies why acceptance did not succeed. Only "semantic" becomes a rejection. */
export type FactoryAcceptanceFailureClass =
  | "semantic"        // a required claim FAILed, or a group fell below minimumPasses
  | "infrastructure"  // the validator could not run; retry within bounds, write no receipt
  | "corruption"      // stored evidence does not verify; operator, no retry
  | "trust";          // revoked package, validator, or contract; block, no retry

export function classifyFactoryAcceptanceFailure(error: unknown): FactoryAcceptanceFailureClass;

/** The durable rejected fact. Mirrors AcceptanceReceipt field for field. */
export interface FactoryRejectionReceipt {
  readonly schemaVersion: "factory.protected-command-receipt.v1";
  readonly kind: "request-acceptance";
  readonly decision: "rejected";
  readonly reference: TrustedFactoryCommandReference;
  readonly commandDigest: string;
  readonly source: FactoryProtectedTaskSource;       // protected-command-provenance.ts:5-10
  readonly candidateDigest: string;
  readonly contractDigest: string;
  readonly evidenceSetDigest: string;
  /** Semantic failures only. Never an infrastructure or trust error. */
  readonly failures: readonly {
    readonly claimId: string;
    readonly validatorId: string;
    readonly verdict: FactoryValidatorVerdict;       // surface 9
    readonly reasonCode: string;
  }[];
  readonly groupFailures: readonly {
    readonly groupId: string;
    readonly passes: number;
    readonly minimumPasses: number;
  }[];
  readonly event: Extract<KernelEvent, { readonly kind: "node-failed" }> & {
    readonly failureKind: "acceptance_rejected";
  };
}

/** The existing AcceptanceReceipt gains one field. */
// decision: "accepted"
```

### Identities and invariants
- `VALIDATOR_ERROR` and `INCONCLUSIVE` are never `semantic`. Only a `FAIL` on a required claim, or
  a group below `minimumPasses`, produces a rejection.
- A rejection is a durable receipt plus one `node-failed` event with
  `failureKind: "acceptance_rejected"`. It is never a thrown activity error.
- The kernel's remediation wait consumes the declared bound. `AcceptanceNode.maxRepairs`
  (`factory-sdk/src/types.ts:245-251`) is the contract bound; code packs additionally cap at three
  total candidate generations per W06, and image packs at two rounds per W11.
- A virtual acceptance failure must not create a `cancel-node` command. That is the plan's
  explicit rule.
- Prior candidates and evidence stay immutable. Completed evidence never changes ownership to a
  repaired candidate (C07).
- Receipt identity is unchanged: one receipt per command reference, with
  `factory_protected_effect_conflict` on a differing digest.

### Schema and migration

```sql
ALTER TABLE factory_protected_command_effects ADD COLUMN IF NOT EXISTS decision TEXT;
-- catalog-driven CHECK: decision IS NULL OR decision IN ('accepted','rejected')
-- catalog-driven CHECK: kind = 'request-acceptance' OR decision IS NULL
UPDATE factory_protected_command_effects SET decision = 'accepted'
  WHERE decision IS NULL AND kind = 'request-acceptance';
```

The existing `kind IN ('request-acceptance','request-release')` check stays. No new table and no
new key: the command reference is already the identity.

### Validation rules — what is rejected
- A rejection receipt with both `failures` and `groupFailures` empty.
- A `failures` entry whose verdict is `PASS`.
- A rejection built from an infrastructure, corruption, or trust error.
- A second receipt for the same command with a different digest:
  `factory_protected_effect_conflict`.
- An acceptance whose evidence set digest differs from the current one.
- A rejection whose `source` does not resolve to a succeeded, stopped, non-uncertain attempt at
  the current candidate generation. `protected-command-provenance.ts:72-76` already enforces that.

### Minimal type checkpoint
`feat(factory): type protected rejection receipt`. Adds `FactoryRejectionReceipt`,
`FactoryProtectedDecision`, `classifyFactoryAcceptanceFailure`, and the `decision` column, and
emits `acceptance_rejected` for the required-claim case. W06 then adds the kernel remediation wait
and the bound consumption.

### What it extends (C13)
C04's human approval reuses `LifecycleApproval` from `src/extensions/v4/lifecycle.ts`, already
entry 3 of `SHARED_REUSE_MODULES` (`check-factory-boundaries.ts:32`). The proposal, claim, and
uncertain-outcome pattern reuses `src/extensions/project-pull-request-broker.ts` (`:33`). Add no
parallel approval or claim implementation.

### Open questions and recommended defaults
1. **Does the kernel need a new event kind?** Default: no. `node-failed` with
   `failureKind: "acceptance_rejected"` already exists and is unused. Reuse it. Adding a kind would
   change `KernelEvent` from 16 members to 17 and force a replay-compatibility review.
2. **Where does the remediation wait live?** Default: in the kernel, as a `waiting` reason.
   `KernelState.pendingRepair` already exists (`kernel-types.ts:153-163`), as do
   `KernelNodeState.priorCandidates`, `inputOverride`, and `factoryOverride` (`:77-88`).
3. **Who owns `protected-command-effects.ts`?** Default: W05 owns the acceptance branch and the
   file's structure; W06 owns the rejection branch only. Any change to the shared receipt union or
   the class constructor goes through W05.
4. **Should `FactoryAssuranceError.code` become a union?** Default: yes, at the same time, so the
   classifier can switch on it exhaustively rather than on strings.

---

## 11. Git operation ID and branch ref encoding (W07)

### Owner and consumers
Single writer: **W07** (the coordinator, then a free Sol worker, per the plan's table). Consumers:
W04a (archive intent), W10 (code reference pack), W14 (console links).

### Files
- New: `src/factory/release-git-refs.ts`.
- Extended: `src/factory/release-adapters.ts`, `src/factory/releases.ts` (receipt fields).
- Shared: `src/extensions/project-pull-request-broker.ts`.
- Defect to fix: `src/extensions/project-open-pr.ts:99`.

### What exists today
Factory operation ids contain a colon. The release operation id is minted and then re-derived on
every read:

```ts
// src/factory/releases.ts:425
const operationId = `factory-release:${digestObject(identityFor(input))}`;
// src/factory/releases.ts:317 (abridged)
if (operation.operationId !== `factory-release:${digestObject(identityFor(operation))}`) throw new FactoryReleaseError("factory_release_corrupt");
```

So the shape is `factory-release:` plus 64 lowercase hex, 79 characters, with exactly one colon.
The same pattern appears on three sibling ids: `factory-reservation:` (`task-admission.ts:37`),
`factory-admission:` (`compute-admissions.ts:318`), and `protected-release:`
(`protected-command-effects.ts:78`). Git refs cannot contain a colon.

Nothing in `src/factory/**` produces a git ref today. The only ref producer in the repository is:

```ts
// src/extensions/project-open-pr.ts:99
const branch = `ez-code/${input.runId}`;
// :100-102 — the BASE branch is validated; the head branch is not
if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(base) || base.includes("..")) throw new Error("Invalid default branch");
// :128
await checked(["git", "push", `https://github.com/${repository}.git`, `HEAD:refs/heads/${branch}`], worktree);
```

`input.runId` is interpolated raw into a ref and into an argv. That is an injection surface today.

### Frozen type

```ts
// src/factory/release-git-refs.ts — NEW. Single writer: W07.

/** Broker-only namespace. Distinct from the existing ez-code/ prefix. */
export const FACTORY_BRANCH_NAMESPACE = "ezcorp-factory" as const;
export const FACTORY_BRANCH_SUFFIX_MAX_LENGTH = 200;

export interface FactoryGitBranchBinding {
  readonly schemaVersion: "factory.git-branch.v1";
  /** The original id, colon intact, exactly as stored. */
  readonly operationId: string;
  /** The reversible suffix. */
  readonly suffix: string;
  /** `ezcorp-factory/<suffix>`. */
  readonly branch: string;
  /** `refs/heads/ezcorp-factory/<suffix>`. */
  readonly ref: string;
}

export function encodeFactoryOperationRefSuffix(operationId: string): string;
export function decodeFactoryOperationRefSuffix(suffix: string): string;
export function factoryGitBranchBinding(operationId: string): FactoryGitBranchBinding;
```

The provider receipt gains two optional fields:

```ts
// src/factory/releases.ts:109-119 — CHANGED
export interface FactoryProviderReceipt {
  readonly provider: string;
  readonly account: string;
  readonly object: string;
  readonly requestDigest: string;
  readonly operationId: string;
  readonly dispatchGeneration: number;
  readonly providerReceiptId: string;
  readonly version: string;
  readonly effectDigest: string;
  /** Git destinations only. The exact ref that was created. */
  readonly ref?: string;
  /** Git destinations only. The short branch name. */
  readonly branch?: string;
}
```

### The encoding rule
Start from `encodeURIComponent(operationId)`, which escapes `:` to `%3A` and leaves
`A-Z a-z 0-9 - _ . ! ~ * ' ( )`. Then post-escape the residual characters that git forbids or that
make a ref ambiguous: `.` `!` `~` `*` `'` `(` `)`. The result uses only
`A-Z a-z 0-9 - _ %`, which `git check-ref-format` accepts. `decodeURIComponent` is the exact
inverse, because every post-escape is a standard `%XX` triple.

For today's ids the transformation is trivial: `factory-release:<64 hex>` becomes
`factory-release%3A<64 hex>`, 81 characters.

### Identities and invariants
- `decodeFactoryOperationRefSuffix(encodeFactoryOperationRefSuffix(id)) === id` for every id the
  identifier validator accepts: 1 to 512 characters, NUL-free.
- **Both the original operation id and the exact ref are bound in the approved request and in the
  receipt.** That is the plan's explicit requirement, and it is what lets reconciliation find a
  branch from an id with no lookup table.
- The namespace is broker-only. The selected-repository GitHub App must restrict pushes to
  `refs/heads/ezcorp-factory/*`.
- A branch conflict is never force-updated. Two operations differ in their id, so they differ in
  their suffix.
- Suffix length is capped at `FACTORY_BRANCH_SUFFIX_MAX_LENGTH` after encoding. Longer ids are
  rejected for git destinations only.

### Schema and migration

```sql
ALTER TABLE factory_release_operations ADD COLUMN IF NOT EXISTS destination_ref TEXT;
ALTER TABLE factory_release_operations ADD COLUMN IF NOT EXISTS destination_branch TEXT;
-- catalog-driven CHECK: destination_ref IS NULL OR destination_ref LIKE 'refs/heads/ezcorp-factory/%'
-- catalog-driven CHECK: (destination_ref IS NULL) = (destination_branch IS NULL)
```

### Validation rules — what is rejected
- A suffix that fails `git check-ref-format --branch`.
- A ref outside the namespace.
- A decoded id that does not equal the stored operation id.
- An operation id whose encoded suffix exceeds 200 characters, for git destinations only.
- A receipt whose `ref` differs from the approved request's ref.
- A branch name containing `..`, a leading or trailing `.`, a trailing `.lock`, `@{`, a space, or
  any control character.

### Minimal type checkpoint
`feat(factory): encode operation ids in git refs`. Adds `src/factory/release-git-refs.ts` with the
two pure functions, the binding type, a round-trip property test over the four id prefixes, a
`git check-ref-format` conformance test, and the two columns.

### What it extends (C13)
The C10 GitHub adapter row names `src/extensions/project-pull-request-broker.ts`, to be "extended
with branch namespace, tested-base binding, and receipt fields". That module is already entry 4 of
`SHARED_REUSE_MODULES` (`check-factory-boundaries.ts:33`). W07 must add one row to
`REQUIRED_SHARED_IMPORTS`:

```ts
{ factoryPath: "src/factory/release-adapters.ts", sharedModule: "src/extensions/project-pull-request-broker.ts" },
```

### Open questions and recommended defaults
1. **Percent-encoding or a digest suffix?** Default: percent-encoding. The plan asks for a
   reversible `encodeURIComponent(operationId)`, and reversibility is what makes reconciliation by
   exact ref possible without a lookup table.
2. **Namespace name.** Default `ezcorp-factory/`. It cannot collide with the existing `ez-code/`
   prefix, so the extension path and the factory path stay separable in a repository that hosts both.
3. **Fix `project-open-pr.ts:99` in the same change?** Default: yes. An unvalidated run id in a ref
   is a live injection surface, and the base branch two lines below is already validated. The fix
   is small and it is exactly the kind of adjacent defect the engineering standard says to correct.
4. **Does the branch carry the tested base?** Default: no. The base SHA, base branch, and
   title/body digest bind in the approved request and the receipt, per W07's own checklist. The ref
   carries only the operation identity.

---

## 12. Shared file ownership

One owner per file. A second worker who needs a change files it with the owner; the owner lands it.

### SDK and shared packages

| File | Single owner | Note |
| --- | --- | --- |
| `packages/@ezcorp/factory-sdk/src/types.ts` | Sol controls | Validator report, verdict union, artifact reference. Re-run `schema:generate`. |
| `packages/@ezcorp/factory-sdk/src/kernel-types.ts` | Sol controls | 16 events, 16 commands. No new event kind is expected. |
| `packages/@ezcorp/factory-sdk/src/kernel.ts` | Sol controls | Remediation wait, bound consumption, usage folding. |
| `packages/@ezcorp/factory-sdk/src/validation.ts` | Sol controls | In the F07 determinism closure. No regex, no ambient time, no code generation. |
| `packages/@ezcorp/factory-sdk/src/expressions.ts` | Sol controls | Same determinism closure. |
| `packages/@ezcorp/factory-sdk/src/*.schema.json` | Sol controls | Generated only. Never hand-edit. |
| `packages/@ezcorp/factory-sdk/src/index.ts` | Sol controls | Export barrel. |
| `packages/@ezcorp/extension-contract/src/types.d.ts` | Terra runtime | `StartRequest.devices` and `StartRequest.materials` only. |
| `packages/@ezcorp/extension-runner/src/podman.ts` | Terra runtime | C13 shared module. Adding to it widens the F13 duplicate surface. |
| `packages/@ezcorp/extension-runner/src/protocol.ts` | Terra runtime | Frame policy and bounds. |
| `packages/@ezcorp/extension-runner/src/dependencies.ts` | Terra runtime | C13 shared module. Fetch and unpack limits. |

### Database

| File | Single owner | Note |
| --- | --- | --- |
| `src/db/migrate.ts` | Coordinator | Append only. Source-statement order is the registry. There is no ledger table. |
| `src/db/schema.ts` | Coordinator | 30 inline factory tables. |
| `src/db/factory-schema.ts` | Coordinator | 24 factory tables behind `buildFactorySchema`. Easy to miss with a `schema.ts`-only grep. |
| `src/db/migrations/factory-artifact-admission-index.ts` | Sol artifacts | Unregistered helper; three migrations re-run it. Do not "fix" it into `schema.ts`. |
| `src/db/migrations/add-factory-attempt-launches.ts` | Terra runtime (W01) | Unmerged. Fix the `package_receipt_json` NOT NULL gap. |
| `src/db/migrations/add-factory-task-stops.ts` | Sol lifecycle (W03) | Unmerged, inside a stash's third parent. |
| `src/db/migrations/allow-factory-validator-multiclaim.ts` | Sol assurance (W05) | Untracked in a separate worktree. |
| `src/db/migrations/add-factory-admission-origin.ts` | Sol assurance (W05) | New. |
| `src/db/migrations/add-factory-usage-settlements.ts` | Sol lifecycle (W03) | New. |
| `src/db/migrations/add-factory-artifact-materials.ts` | Sol artifacts (W04) | New. |
| `src/db/migrations/add-factory-validator-report.ts` | Sol controls with W05 | New. Must follow the multiclaim migration. |
| `src/db/migrations/add-factory-release-profile.ts` | Sol assurance (W05) | New. Also carries the W07 git-ref columns. |

### Factory modules

| File | Single owner | Note |
| --- | --- | --- |
| `src/factory/admission-origin.ts` | Sol assurance (W05) | New. |
| `src/factory/task-admission.ts` | Sol assurance (W05) | Reservation identity. |
| `src/factory/task-execution-admission.ts` | Terra runtime (W01) | Dispatch path. |
| `src/factory/compute-admissions.ts` | Sol lifecycle (W03) | Poll, retain, cancel. |
| `src/factory/budgets.ts` | Sol lifecycle (W03) | Settlement and uncertainty. |
| `src/factory/usage-settlement.ts` | Sol lifecycle (W03) | New. |
| `src/factory/journal-validation.ts` | Sol lifecycle (W03) | New. |
| `src/factory/executions.ts` | Terra runtime (W01) | Journal; W03 files the usage type change. |
| `src/factory/task-stops.ts` | Sol lifecycle (W03) | Unmerged. |
| `src/factory/task-outcomes.ts` | Sol lifecycle (W03) | |
| `src/factory/task-completions.ts` | Sol assurance (W05) | |
| `src/factory/command-authority.ts` | Sol lifecycle (W03) | Both cancellation authority paths live here. |
| `src/factory/runner/attempt-runtime.ts` | Terra runtime (W01) | Unmerged. |
| `src/factory/runner/supervisor.ts` | Terra runtime (W01) | |
| `src/factory/runner/native.ts` | Terra runtime (W01) | |
| `src/factory/pool/ledger.ts` | Sol lifecycle (W03) | Includes the round-robin fairness audit lead. |
| `src/factory/pool/process.ts` | Terra deployment (W16) | GPU host registration. |
| `src/factory/artifacts.ts` | Sol artifacts (W04) | |
| `src/factory/artifact-materials.ts` | Sol artifacts (W04) | New. |
| `src/factory/artifact-access.ts` | Sol artifacts (W04) | Cross-project grants stay separate from the scoped reader. |
| `src/factory/input-artifacts.ts` | Sol artifacts (W04) | |
| `src/factory/validator-materials.ts` | Sol assurance (W05) | Uncommitted changes exist in a separate worktree. |
| `src/factory/assurance.ts` | Sol assurance (W05) | Claim evaluation. |
| `src/factory/assurance-commands.ts` | Sol assurance (W05) | |
| `src/factory/protected-command-effects.ts` | Sol assurance (W05) structure and acceptance; Sol controls (W06) rejection branch | The only two-writer file. |
| `src/factory/protected-command-provenance.ts` | Sol assurance (W05) | |
| `src/factory/release-profile.ts` | Sol assurance (W05) | New. |
| `src/factory/release-application.ts` | Sol assurance (W05) | Resolver seam. |
| `src/factory/releases.ts` | W07 owner | Provider signature and git receipt fields. |
| `src/factory/release-adapters.ts` | W08 (S3), W07 (GitHub) | Split by adapter; W07 owns the file's shape. |
| `src/factory/release-authority.ts` | W07 owner | |
| `src/factory/release-git-refs.ts` | W07 owner | New. |
| `src/factory/run-controls.ts` | Sol controls (W06) | Unmerged at `3a84d4867`. |
| `src/factory/transition-authority.ts` | Sol controls (W06) | Unmerged at `3a84d4867`. |
| `src/factory/run-lifecycle.ts` | Sol controls (W06) | |
| `src/factory/run-inputs.ts` | Sol controls (W06) | |
| `src/factory/application.ts` | Coordinator (W09) | Composition root. |
| `src/factory/boot.ts` | Coordinator (W09) | |

### Tests, fixtures, and gates

| File | Single owner | Note |
| --- | --- | --- |
| `src/__tests__/helpers/factory-migration-restart-suite.ts` | Coordinator | The only repeat-migration gate. Every new migration adds a case. |
| `src/__tests__/helpers/factory-validator-materials-suite.ts` | Sol assurance (W05) | Modified in the unmerged worktree. |
| `src/__tests__/helpers/factory-assurance-suite.ts` | Sol assurance (W05) | |
| `src/__tests__/helpers/factory-run-lifecycle-suite.ts` | Sol controls (W06) | Gains 169 lines in the unmerged controls range. |
| `src/__tests__/helpers/factory-attempt-queue-suite.ts` | Terra runtime (W01) | |
| `src/__tests__/helpers/factory-execution-admission-suite.ts` | Terra runtime (W01) | |
| `src/__tests__/helpers/factory-execution-gateway-suite.ts` | Terra runtime (W01) | |
| `src/__tests__/helpers/factory-pool-suite.ts` | Sol lifecycle (W03) | C03 ledger behavior. |
| `src/__tests__/helpers/factory-budgets-suite.ts` | Sol lifecycle (W03) | |
| `src/__tests__/helpers/factory-records-suite.ts` | Sol artifacts (W04) | |
| `src/__tests__/helpers/factory-run-inputs-suite.ts` | Sol artifacts (W04) | |
| `src/__tests__/helpers/factory-release-suite.ts` | W07 owner | W08 files S3 cases. |
| `src/__tests__/helpers/factory-release-authority-suite.ts` | W07 owner | |
| `src/__tests__/helpers/factory-package-preparation-suite.ts` | Terra runtime (W02) | |
| `src/__tests__/helpers/factory-private-service-suite.ts` and `factory-certificates.ts` | Coordinator (W09) | mTLS material and the three `.mjs` Node clients. |
| `scripts/check-factory-boundaries.ts` | Coordinator | Every package appends its own rows; the coordinator merges. |
| `scripts/coverage-thresholds.json` | Free Sol worker (W18) | |
| `web/src/routes/api/factories/_shared.ts` | Sol product (W14) | Error-to-status mapping. W03, W05, and W06 file entries. |

### Two traps in `check-factory-boundaries.ts` every owner must know

1. **A typo in `SHARED_REUSE_MODULES` reds the whole gate.** `sourceInput` does an unguarded
   `Bun.file(path).text()` (`check-factory-boundaries.ts:289-291`), so a non-existent path throws
   rather than warning.
2. **Adding a module to `SHARED_REUSE_MODULES` is retroactive.** The factory side scans
   non-exported top-level declarations too (`:223`), so a newly shared exported `foo(a, b)` reds
   every factory file that happens to declare a top-level `foo(a, b)`. The key is name and arity
   only; parameter types are ignored. There is no suppression mechanism.

---

## 13. Unmerged checkpoints and recommended merge order

Four unmerged sources hold parts of these surfaces. Three of them are not where the task
description says they are; verify before merging.

**Correction 1.** `6c500113a` does **not** contain the attempt runtime. It is the tip of
`feat/factory-lazy-input` and touches only `packages/@ezcorp/extension-runner/src/podman.ts` and
its test. The attempt-runtime work lands in `599e49e73` and is fenced by `24f811e2e`.

**Correction 2.** `6c500113a` is **not** a descendant of the integration head. `git merge-base
33cab8657 6c500113a` is `84cfd2a99`; neither is an ancestor of the other. Merge the range
`84cfd2a99..6c500113a`, which is six commits, not the single commit.

**Correction 3.** `8fda869045129d415ac8fc2b8df6cb5ffb7f50ea` is a **git stash commit with three
parents**, not an ordinary commit. `git diff <sha>^1 <sha>` shows six modified files and hides the
two new files, which live only in the third parent `bae1bec2d`. Those two files,
`src/db/migrations/add-factory-task-stops.ts` and `src/factory/task-stops.ts`, are 314 of about
404 changed lines, and they are the entire stop-settlement surface. The finished form of the same
work is `5e017a9c7` on `feat/factory-attempt-dispatcher`.

**Correction 4.** `src/factory/task-stops.ts` imports `./runner/attempt-runtime`, which does not
exist at the stash's first parent. The stop work therefore cannot typecheck before the attempt
runtime lands.

### Recommended merge order

1. **Sol run controls: `3a84d4867`, then `b6cfa4798`.** The plan states this order explicitly. No
   migrations; low conflict risk. Adds `src/factory/run-controls.ts` (92 lines),
   `src/factory/transition-authority.ts` (66 lines), 169 lines to
   `src/__tests__/helpers/factory-run-lifecycle-suite.ts`, the `runControls` seam on
   `FactoryApplication`, the route dispatch branch, and the coverage-gate correction for
   declaration-only source files.
2. **Terra attempt runtime: the range `84cfd2a99..6c500113a`.** Commit Terra's dirty recovery
   changes first, then merge, then rerun. Registers `add-factory-attempt-launches` at the end of
   `migrate()`. Known blocker recorded on that branch: full PostgreSQL schema conformance fails on
   the pre-import C05 three-foreign-key mismatch for `factory_runner_package_bindings`; root's
   `310534627` correction resolves it during integration, and `310534627` is already an ancestor of
   the validator-binding worktree.
3. **Sol multi-claim validator binding.** Commit the worktree
   `/home/dev/work/EZCorp/EZHarness-worktrees/factory-validator-binding` first; it is currently
   uncommitted with two untracked files, and HEAD there is `84cfd2a99`. The migration splices
   between `add-factory-validator-materials` and `add-factory-package-preparations`, so it must
   land before any later validator migration.
4. **Sol Phase B stop settlement.** Take `5e017a9c7` from `feat/factory-attempt-dispatcher`, not
   the stash, and only after step 2, because of the `attempt-runtime` import and the new launch
   foreign key.

### Recommended type-checkpoint order

Wave A, no dependencies, land in parallel:
- Surface 8, journal fact validation. A pure refactor.
- Surface 9, SDK strict validator report. Unblocks W05 without W06.
- Surface 6, per-attempt device grant and launch identity.
- Surface 7, auxiliary material types and the single artifact-reference validator.

Wave B, after wave A and after merge steps 1 to 4:
- Surface 1, typed validator admission origin.
- Surface 2, multi-claim result identity.
- Surface 3, live stop authority.
- Surface 4, usage settlement.

Wave C, after wave B:
- Surface 5, asynchronous release profile.
- Surface 10, protected rejection receipt.
- Surface 11, git ref encoding.

Migration registry order, appended to `src/db/migrate.ts` after
`add-factory-protected-command-effects`:

```
32  allow-factory-validator-multiclaim        (W05, spliced earlier: after add-factory-validator-materials)
33  add-factory-attempt-launches              (W01)
34  add-factory-task-stops                    (W03, needs 33)
35  add-factory-admission-origin              (W05)
36  add-factory-usage-settlements             (W03)
37  add-factory-artifact-materials            (W04)
38  add-factory-validator-report              (W06 with W05, needs 32)
39  add-factory-release-profile               (W05, carries the W07 git-ref columns)
40  add-factory-protected-decision            (W06)
```

Entry 32 is the one splice rather than an append. Everything else appends. Each entry must add a
case to `factoryMigrationRestartConformance`, because that suite is the only mechanism that catches
a mis-splice.

---

## 14. Open questions index

Thirty-four decisions need an owner's sign-off. Each has a recommended default in its section.

**Surface 1 — validator origin**
1. Which budget envelope funds a validator reservation. Default: the candidate node's envelope.
2. Whether a validator origin needs its own pool resource class. Default: no.
3. Whether the origin is sealed into the attempt token. Default: no; the token's 17-claim set is
   frozen and its verifier rejects extras.

**Surface 2 — multi-claim result identity**
4. Claim cap per attempt. Default 1000.
5. Whether one failed claim voids the attempt's other rows. Default: no.
6. Unique constraint versus unique index on the fresh path. Default: index on both paths, so fresh
   and upgraded catalogs match.
7. `FactoryTrustedValidatorGateway` still declares neither binder. W05 must widen it in a separate
   checkpoint.

**Surface 3 — live cancellation**
8. Whether `withCurrentCancellation` keeps requiring `runtime.status === "stopping"`. Default: yes,
   plus a second authority path for quarantine and revocation.
9. Total stop timeout. Default 20 s, of which 10 s is contract grace.
10. Stop reason vocabulary. Default: unchanged four members.
11. Where the abort signal originates. Default: the W09 stop worker.

**Surface 4 — usage settlement**
12. Whether the kernel needs `usage-settled` before a node completes. Default: no.
13. Who runs reconciliation. Default: a bounded W09 background worker.
14. Whether a confirmed zero charge releases the hold. Default: yes, with a receipt digest.

**Surface 5 — asynchronous release profile**
15. The `resolve` name collision with the provider resolver. Default: keep both.
16. Resolve timeout. Default 120 s.
17. Where the abort signal originates. Default: the W09 release worker.
18. Whether `reconcile` keeps provider I/O inside its transaction. Default: no, split it. This is a
    required correction, not a preference.

**Surface 6 — host protocol and devices**
19. How `invocationId` is derived. Default: a reproducible digest, like `factoryAttemptWorkerId`.
20. Where the durable terminal result lives. Default: `factory_execution_terminals`.
21. Whether `StartRequest.devices` is required. Default: optional, so v4 callers do not change.
22. AMD versus NVIDIA field split. Default: separate `devices` and `cdiDevices`.
23. Whether `PodmanRunner` keeps `configuredDevices`. Default: yes for v4, ignored for factory
    execution starts.

**Surface 7 — artifact materials**
24. Chunk size and count. Default 8 MiB by 64.
25. Whether a sealed material gets a `FactoryArtifactReference`. Default: yes.
26. Where workspace checkpoints live. Default: materials under a `workspace/` name prefix.
27. Whether the scoped reader replaces `loadSharedInTransaction`. Default: no; different authority.

**Surface 8 — journal validation**
28. Whether `FactoryTaskStopError.code` becomes a union. Default: yes, with HTTP mappings.
29. Whether the Drizzle `factoryTaskStops` model gains the migration's four coherence checks.
    Default: yes.

**Surface 9 — validator report**
30. One schema version or two. Default: two, because C04 forbids runner-minted provenance.
31. Whether a FAIL must carry evidence. Default: yes.
32. Whether `schema:generate` drift gets a CI check. Default: yes, in W18.

**Surface 10 — acceptance and rejection**
33. Whether the kernel needs a new event kind. Default: no; reuse `node-failed` with
    `failureKind: "acceptance_rejected"`, which is declared and currently unemitted.

**Surface 11 — git refs**
34. Whether to fix the unvalidated head-branch interpolation at `src/extensions/project-open-pr.ts:99`
    in the same change. Default: yes.

---

## 15. Corrections this freeze requires before fan-out

These are defects found while grounding the sketches. Each has an owner above. None is closed by
this document.

1. `src/factory/releases.ts:541` and `:545` perform provider network proofs inside an open database
   transaction. W07.
2. `src/db/migrations/add-factory-attempt-launches.ts` adds `package_receipt_json` without
   `SET NOT NULL`, so an upgraded database can hold a NULL where `CREATE TABLE` forbids one. W01.
3. The `factoryTaskStops` Drizzle model omits four checks that its migration declares. W03.
4. `allow-factory-validator-multiclaim` creates the new uniqueness as an index on the upgrade path
   and as a constraint on the fresh path. W05.
5. `src/extensions/project-open-pr.ts:99` interpolates an unvalidated run id into a git ref and an
   argv, while the base branch two lines later is validated. W07.
6. `FactoryTaskStopError.code` is a bare `string` while every sibling error class uses a union, and
   no stop code maps to an HTTP status. W03 files, W14 lands.
7. The artifact reference is validated by three near-identical functions with three constants.
   Collapse to one. W04.
8. `"factory.lazy-input.v1"` is the only `schemaVersion` with no exported constant and no generated
   schema file, so every constructor hardcodes the string. Sol controls.
9. `attempt-runtime.ts` `opened()` still advertises `"started" | "attached"`, but after `24f811e2e`
   only `"started"` reaches it. Dead code from the fix. W01.

---

*End of freeze. Owners sign off in `tasks/factory/`; this file is the reference W00 hands to
W01–W08.*

## 16. Dated corrections after wave-1 integration (coordinator, 2026-09-13)

Accepted deviations, recorded here so consumers read the landed contract rather than the sketch:

- **Section 6 (W01).** The durable terminal result lives in two new columns on `factory_attempt_launches`, not in `factory_execution_terminals`, because that table requires a verified output-artifact foreign key and cannot hold failed, cancelled, or uncertain results. `FactoryHostLaunchProtocol.stop` currently takes W01's `FactoryPhysicalStopRequest` (attempt, reservation, holder generation, reason); W03 reconciles it with `FactoryTaskStopRequest` when section 3 lands. Cross-host replacement enforcement (signed-receipt consumption plus fencing) remains W03's, not W01's.
- **Section 7 (W04).** `factory_artifacts` gains `material_key` and the admission-index helper a conditional `material_key` dimension; `FactoryArtifactAccessError` and `unavailable()` moved to `artifact-materials.ts` and are re-exported from `artifact-access.ts`; unsealed materials carry reserved `digest`/`storage_version` sentinels until `seal`; the material handle is one `factory_artifacts` row of kind `material` carrying the chunk manifest; `FactoryAttemptMaterials` adds `chunks()` and `readChunk()`; `maxObjectsPerOperation` counts versions as objects; `FactoryWorkspaceCheckpoints` implements open question 26's default (`workspace/` prefix), leaving the checkpoint payload shape to the runner. `add-factory-release-authority.ts` no longer re-adds its narrower `kind` check on every boot.
- **Section 6 addendum (W01, in progress).** The guest-side control channel becomes a FIFO triple (`in`, `out`, `err`) in a per-attempt directory under the runner root, bind-mounted read-write at `/channel`. An in-container shim opens all three with `O_RDWR` and hands them to the extension as stdin/stdout/stderr, so a FIFO reader sees EOF only when the guest itself exits; the supervisor connects by opening the same FIFOs and its death closes only its own descriptors. The host-side contract (`FramedExecution`, frame policy, `Runner`, `FactoryHostLaunchProtocol`) is unchanged. W02's Python guest must implement the same shim contract. Design record: `/tmp/factory-platform-evidence/w01/DESIGN-guest-lifetime.md`.
- **Section 6 material mount (W01 review of W12, 2026-09-14).** `StartRequest.materials` and the Podman material mount are approved in shape: a private per-attempt directory bind-mounted read-write at the fixed path `/materials` is the right answer to a control channel bounded at one mebibyte, and it widens nothing a guest can reach. Three corrections bind both W11 and W12. First, the mount options must read `rw=true,relabel=private,noexec,nosuid,nodev`, so the only two writable surfaces a guest has share the posture `/tmp` already carries; execution was denied without `noexec` on the test host, but by that filesystem's own flags rather than by anything the profile guarantees. Second, a guest CAN plant a symbolic link in that directory, measured in the shipped profile and confirmed on the host, so no consumer may walk or open the tree itself: both must read it through `listRunnerMaterials` and `openRunnerMaterial` in `packages/@ezcorp/extension-runner/src/materials.ts`, which open with `O_NOFOLLOW` and `O_NONBLOCK`, require a regular file, and bound entries, bytes, and depth. `O_NONBLOCK` is load-bearing: a planted FIFO otherwise hangs the read-back forever. Third, the directory is the caller's to create and destroy, never `0o777`, never shared or reused between attempts, and unbounded in size because Podman cannot quota a bind mount, so its owner must place it on a quota'd filesystem. Read back only after the guest is confirmed stopped; a live guest can swap a directory component and no host-side check closes that race. `GUEST_MATERIALS_PATH` stays a fixed path rather than an environment variable, discovery guests never receive the mount, `/workspace` and `/channel` stay read-only, and `materials` stays optional so no v4 caller changes. Full verdict: `/tmp/factory-platform-evidence/w01b/materials-mount-review.md`.
- **Section 6 guest byte path (W01, 2026-09-14).** The material mount is the byte path out of a guest that W11 and W12 both need, and it now has one canonical definition in Terra's own files rather than a copy in each pack. `StartRequest.materials` is an optional host-owned directory; absent means no mount, so every v4 caller is unchanged, and a discovery guest never receives one because the build phase has no attempt. It appears at the fixed path `/materials`, never an environment variable. `runnerMaterialMount` is the only way to construct it and carries `rw=true,relabel=private,noexec,nosuid,nodev`: it is the one read-write mount a guest gets, and `noexec,nosuid,nodev` hold it at the posture `/tmp` already has. Three rules bind every consumer. A guest CAN create a symbolic link in its own material directory, measured in the shipped profile, so the host must read results back only through `listRunnerMaterials` and `openRunnerMaterial`, which open with `O_NOFOLLOW` and `O_NONBLOCK`, require a regular file, and bound entries, bytes, and depth; `O_NONBLOCK` is load-bearing because a planted FIFO otherwise hangs the read-back forever. The directory is the caller's to create and destroy, never world-writable, never shared or reused between attempts, and needs a filesystem quota because Podman cannot bound a bind mount. And removing it needs `podman unshare`: a guest's subdirectories belong to a mapped subuid, so an ordinary recursive remove fails with EACCES, measured rather than assumed, and an `idmap` mount did not avoid this on Podman 5.8.2. Read back only after the guest is confirmed stopped. Evidence: `/tmp/factory-platform-evidence/w01c/`.
- **Section 6 guest model broker (W01, 2026-09-20).** A guest could not reach its pinned model: there was no wire type for the request or the reply, and three host-side broker shapes for one job. The contract is two SDK types with generated schemas, `FactoryGuestModelRequest` (`factory.guest-model-request.v1`, `urn:ezcorp:factory:guest-model-request:v1`) and `FactoryGuestModelResponse` (`factory.guest-model-response.v1`, `urn:ezcorp:factory:guest-model-response:v1`), enforced identically in Bun and in the Python runtime because C07 rejects a validator that works in only one, and compared verdict by verdict over `src/factory/runner/fixtures/c02-conformance.json` in a host Python process and inside the isolated guest. Bounds are `FACTORY_GUEST_MODEL_LIMITS`, measured in BYTES not characters: 64 messages, 16 KiB per message, 32 KiB of input, 1 to 8192 output tokens, 128 KiB of response. The three broker shapes collapse to `FactoryGuestBroker`, which is now the type of both `IsolatedFactoryAttemptRuntimeOptions.broker` and `FactoryHostLaunchSupervisorOptions.broker`; the supervisor's was a bare function over the launch intent, so one broker instance could not serve both runtimes. `createFactoryOneHopProvider` adapts the third, `FactoryBroker.stream` in `src/runtime/factory-execution.ts`, into the one-hop reply a frame carries, and takes `resolveModel` as an option so it needs no provider registry of its own; W10 supplies `createFactoryProviderBroker({ pin })` as its `broker`. Five rules bind every consumer. A guest may call only the model its attempt pinned, compared as the canonical JSON of the whole `FactoryModelPin`, field for field; an attempt with no pin may call no model. One model call per operation, decided by a durable claim — `prepare` then `dispatch` on `FactoryExecutionJournal`, never an in-memory guard, because the host supervisor and the product process are two processes — so a second concurrent call is `operation_busy` and a call after settlement is `operation_settled`. The provider receipt digest and the measured usage are written to the journal BEFORE the guest is answered; the digest is the PREFIXED `sha256:<64 hex>` form, because `FactoryUsageReconciliation` enforces `^sha256:[0-9a-f]{64}$` at both entry points and refuses any other shape through the same branch it uses for a tampered digest. A completed call settles the ordinary way and carries no reconciliation: its measured usage is summed into the terminal result, which is what the budget hold settles on at stop. Only a call whose completed settlement is lost leaves the operation `uncertain` carrying exactly the receipt and the cost and nothing else, which is the one state `resolve` considers and the only shape `reconcileLate` will match; the guest is refused rather than answered, and W03c settles the cost later. A completion is never discarded on a failed settlement. A refusal is never a substitution: no fallback model, no retry, and no truncation, so an answer too large for the frame is refused AFTER its cost is recorded rather than shortened. Note for W03: the C02 runner-result contract still spells `providerReceiptDigest` as BARE 64-hex in `validateFactoryRunnerResult` while `usage-settlement.ts` requires the prefixed form; this leaf's contract uses the prefixed form end to end, and the pre-existing disagreement on W03's own two surfaces is disclosed rather than changed here. And the one reverse capability stays `factory.broker`: a payload whose `schemaVersion` is `factory.guest-model-request.v1` is answered by this broker and every other payload, including the validator report frame, goes to its `delegate` or is denied. The guest program shape W10's generator and reviewer and W11's evaluator implement is `GUEST_PROGRAM` in `src/factory/runner/guest-model.podman.integration.test.ts`, a real program that runs under rootless Podman rather than a description: it reads its pin and `authority.nextOperationIndex` off the request it was handed, builds `operationId` as `runId:nodeInstanceId:candidateGeneration:index`, sends one frame, and treats a refusal as an outcome rather than an error. Evidence: `/tmp/factory-platform-evidence/w01e/`, gate file `tasks/factory/w01e-GATES.md`.
- **Section 12 (W18).** `scripts/check-factory-boundaries.ts` now derives the C13 inventory from the real import graph (46 edges) and gains a workspace-package resolver; each later package still appends its rows, and the coordinator merges.

## 17. Dated correction: the runner reference names its manifest (coordinator, 2026-09-14)

**Supersedes the workaround each reference pack adopted. W10, W11 and W12 must migrate.**

Two rules could not both be satisfied, and the conflict was found by the W12 validator and
disclosed independently by W10, W11 and W12:

- `packages/@ezcorp/extension-contract/src/validation.ts:126` constrains a v4 manifest name to
  `^[a-z][a-z0-9-]{0,63}$`. A scoped name such as `@ezcorp/reference-data` can never match it.
- `releaseFacts()` in `src/factory/package-preparation.ts` required `release.manifest.name` to
  EQUAL the runner reference's `package`, which is exactly the scoped name a pack publishes.

No real pack could satisfy both, so each of the three worked around it differently: one renamed
its manifest to the unscoped form and lost the scope, one kept the scope and never called
`FactoryPackagePreparations.bind`, and one carried both spellings in different places.

**Decision.** The v4 manifest grammar is the shared contract (C13) and stays unchanged. The runner
reference now carries the manifest's exact name explicitly, and the scoped distribution identity
keeps the separate field it already had:

```ts
// packages/@ezcorp/factory-sdk/src/types.ts — CHANGED. Single writer: Sol controls; landed by W02b.
export interface RunnerReference {
  readonly package: string;        // scoped distribution identity, e.g. @ezcorp/reference-data
  readonly manifestName: string;   // NEW, REQUIRED. Exactly manifest.name of the built v4 release.
  readonly version: string;
  readonly digest: string;
  readonly export: string;
  readonly model?: string;
  readonly configurationDigest?: string;
}
```

- `manifestName` is validated against the v4 grammar by the SDK's exported `isManifestName`, so a
  reference the execution schema admits is one `validateManifest` would admit. A scoped name
  offered as a manifest name is `RUNNER_MANIFEST_NAME`.
- The generated JSON Schemas are regenerated with the field required. The Python validator carries
  the identical rule, because C07 rejects a validator that works in only one runtime.
- `releaseFacts()`, `bindInTransaction()` and `hydrate()` compare `manifestName`; nothing compares a
  manifest name to `package` any more.
- The field is sealed with the rest of the reference into the binding, the trust revision and the
  prepared receipt through the reference digest, so a receipt cannot be replayed under a different
  manifest name.

**Migration for W10, W11 and W12.** Every `RunnerReference` literal gains `manifestName`. Set it to
the built manifest's own name and keep `package` scoped; the two are expected to differ. A pack that
had renamed its manifest to the unscoped form to get past `releaseFacts()` should restore the scoped
`package` and leave `manifestName` as the manifest already spells it. A pack that avoided
`FactoryPackagePreparations.bind` can now bind normally. `manifestNameOf()` in
`packages/@ezcorp/factory-sdk/src/references.ts` derives the conventional name from a scoped one.
