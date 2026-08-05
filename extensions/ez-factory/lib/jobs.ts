// ── Jobs — saved job definitions over the three shipped workflows ────
//
// A `FactoryJob` is a NAME + a workflow + the input to start it with. Firing
// one is `ctx.workflows.run(job.workflow, job.input)`; everything else here is
// the store and the validator that decide what a job is allowed to say.
//
// ── STORAGE IS INSTALL-WIDE, NOT PER-USER OR PER-PROJECT ─────────────
//
// `StorageScope` is `"global" | "conversation" | "user"`
// (`packages/@ezcorp/sdk/src/runtime/storage.ts`). **There is no project
// scope.** Jobs live in the `global` bucket because the Hub page that renders
// them is itself shared — the page cache is keyed `(extensionId, pageId,
// variant=projectId)` with no user dimension, so a per-user bucket would
// render one user's jobs to everybody anyway.
//
// The consequence is a product fact, not an implementation detail: **every
// job is visible to, and editable by, everyone who can reach this extension's
// Hub page.** There is no per-job owner check anywhere below. `createdBy` /
// `updatedBy` are an attribution trail, never an authorization one. Any UI
// built on this store must say so on the page.
//
// ── EVERY MUTATION RUNS INSIDE `withLock` ───────────────────────────
//
// Binding per `src/extensions/CLAUDE.md`: the subprocess channel dispatches
// inbound frames fire-and-forget, so two `tools/call` frames interleave and
// the second `set` silently discards the first's mutation — state that lags
// or reverts, never an error. `task-tracking`, `ez-code` and `ez-code-factory`
// each shipped that bug.
//
// The discipline is STRUCTURAL here rather than conventional: {@link rmw} is
// the ONLY function in this file that touches `storage.set` / `storage.delete`,
// and its whole body is a `withLock`. A read-modify-write cannot be written
// any other way without adding a second call site, which `jobs.test.ts`
// asserts does not exist.
//
// ── INVARIANT B — A JOB CANNOT CONFIGURE AWAY A PROTECTED STEP ──────
//
// Ported from `ez-code-factory/lib/jobs.ts` (that reference extension was
// retired 2026-08-03 in phase 9 — read it in git history)
// (`PROTECTED_STEPS`, enforced at `:214-215` and `:489-490`). There the unit
// was a step NAME an operator could add to `skipSteps`; here the graph is a
// shipped YAML asset the operator never edits, so the attack surface moved —
// but it did not close. Three doors, all shut below:
//
//   1. **`input`.** A step's `when` guard is a `WorkflowCondition`
//      (`src/types.ts`) evaluated before dispatch; false ⇒ the step is
//      `skipped` and the run CONTINUES. `resolveConditionRef` resolves
//      `$input.<field>` **leniently** — a missing key is `undefined`
//      (`src/runtime/workflow-refs.ts:259-261`), and `undefined` fails `eq` /
//      `gt` / `exists` / `truthy` (`workflow-condition.ts:20-47`). So an
//      approval step guarded by `when: {ref: $input.needsReview, op: eq,
//      value: true}` is skipped by an operator supplying `false` **and** by
//      one who simply omits the key. A value-level check cannot defend that.
//      {@link JOB_SETTABLE_INPUT_KEYS} does: input keys are a closed
//      ALLOWLIST per workflow, and an unlisted key is rejected. Each entry is
//      a claim that no `gate`/`approval` step in that template reads
//      `$input.<key>` in a `when` or `condition`. A template that later grows
//      such a guard is safe unless somebody ALSO adds the key here — two
//      deliberate edits in two files, one of them this security control.
//      Fail-closed on template drift; a denylist would fail open.
//
//   2. **`skipDependents`.** Default `true`: skipping a step skips its
//      declared dependents. Flipping it to `false` un-skips them, so a step
//      downstream of an unanswered gate executes anyway — a change that
//      touches no capability declaration and no permission grant.
//      {@link RESERVED_CONTROL_FLOW_FIELDS} rejects it, and every other
//      step-shaping key, by NAME, both as a job field and as an input key.
//      A job carries no step configuration and the validator says so out
//      loud: an absent field is a hole the day somebody adds it, whereas an
//      explicitly refused one has to be deleted first.
//
//   3. **`workflow`.** Pointing a job at a FORK with the gate deleted is the
//      same bypass by another route. {@link FACTORY_WORKFLOWS} is closed to
//      the three names this extension ships and declares in
//      `permissions.workflows.names`. A fork gets a bare name of its own
//      (`web/src/routes/api/workflows/[name]/fork/+server.ts`), and the host
//      would refuse it anyway — but refusing it HERE is what makes the
//      refusal legible and testable.
//
// This is the only thing standing between an operator holding `manage-jobs`
// and a human-review gate that no longer exists. It is a security control.

import { Storage, withLock } from "@ezcorp/sdk/runtime";

// TYPE-ONLY, and deliberately so: `lib/triggers.ts` imports VALUES from
// this module (`isBackgroundTrigger`, `isValidJobId`,
// `BACKGROUND_TRIGGER_KINDS`), so a value import back the other way would
// be a real runtime cycle. `import type` is erased at compile time, which
// makes the dependency one-directional at runtime while still letting the
// fire outcome's shape live next to the table that classifies it.
import type { JobFireOutcome } from "./triggers";

// ── The three shipped workflows ─────────────────────────────────────

/**
 * The workflows a job may target — BARE names, byte-identical to
 * `permissions.workflows.names` in `ezcorp.config.ts` (pinned by a test).
 *
 * **Bare, never `ez-factory:docs-factory`.** `ctx.workflows.run()` takes the
 * bare name and applies the `<extensionName>:` prefix host-side; a name
 * carrying `:` fails `isValidWorkflowName`
 * (`src/runtime/workflow-name.ts`) and the call is rejected -32602. The
 * namespaced form is what the host PRODUCES, never what the wire supplies —
 * which is exactly why an extension cannot address a host workflow or another
 * extension's.
 */
export const FACTORY_WORKFLOWS = [
  "docs-factory",
  "etl-factory",
  "draft-and-verify",
] as const;

export type FactoryWorkflow = (typeof FACTORY_WORKFLOWS)[number];

const FACTORY_WORKFLOW_SET: ReadonlySet<string> = new Set(FACTORY_WORKFLOWS);

/** True when `name` is one of the three shipped bare workflow names. */
export function isFactoryWorkflow(name: unknown): name is FactoryWorkflow {
  return typeof name === "string" && FACTORY_WORKFLOW_SET.has(name);
}

/**
 * Door 1 of invariant B: the input keys a job may set, per workflow.
 *
 * **A closed allowlist, and a claim about the templates.** Listing a key here
 * asserts that no `gate` or `approval` step in that workflow reads
 * `$input.<key>` from a `when` or a `condition`. Adding a key without
 * checking that is how the human-review gate stops existing.
 *
 * The rule the templates must hold up their end of: **a `gate` or `approval`
 * step's guard reads `$steps.*` only, never `$input.*`.** Run inputs are
 * operator-supplied; step outputs are produced by the graph. Only the second
 * kind can decide whether a human gets asked. Verified to hold across all
 * three shipped assets: `docs-factory.accepted` reads
 * `$steps.review-loop.output.choice`; `etl-factory.schema-ok` reads
 * `$steps.ingest.output.*`; `etl-factory.anomaly-gate` and `.consent` both
 * read `$steps.report.output.skippedJson`; `draft-and-verify.review` carries
 * no `when` at all.
 *
 * A listed key is still operator-controlled data with real reach. A template
 * CAN bind a model by ref (`model: {model: "$input.verifyModel"}`,
 * `src/types.ts`), which would let an operator point a verification step at a
 * weaker model and disable the check while the graph still reported a pass —
 * so the shipped templates bind no `provider`/`model` at all, `effort` and
 * `maxTokens` only. If that ever changes, the key lands here and the tradeoff
 * gets taken on purpose rather than by omission.
 *
 * **This is the single source of truth.** `workflow-templates.test.ts` (8.5)
 * checks the templates against it — by import once the branches merge, so the
 * two cannot drift. Keep it a directly importable named export.
 */
export const JOB_SETTABLE_INPUT_KEYS: Readonly<
  Record<FactoryWorkflow, readonly string[]>
> = {
  // Source globs to read, and where the accepted doc is written.
  "docs-factory": ["globs", "outPath"],
  // The same two. NOT `now`: the design's `ingestedAt: "{{ $input.now }}"`
  // is a caller-supplied string, not a clock — a transform does no I/O and
  // reads no clock — so a SAVED job would freeze one timestamp across every
  // run it ever fired. Worse than having none, and the run's own `startedAt`
  // is already on the trace.
  "etl-factory": ["globs", "outPath"],
  // The sub-workflow, addressable directly: the draft under review and the
  // sources it is verified against.
  //
  // `priorContent` / `priorVerdict` are deliberately absent even though the
  // template declares them in `inputSchema`. `docs-factory` supplies them
  // through its `review-loop` step's `input` mapping (`$loop.last.output.*`),
  // resolved by the executor — they never pass through this store. The
  // declaration documents the full input contract; the gap here is the
  // correct shape, not an oversight to "fix".
  "draft-and-verify": ["draft", "sources"],
};

/** The allowlisted input keys for one workflow. */
export function jobSettableInputKeys(
  workflow: FactoryWorkflow,
): readonly string[] {
  return JOB_SETTABLE_INPUT_KEYS[workflow];
}

/**
 * Door 2 of invariant B: key names that shape a workflow STEP rather than
 * feed it. Refused as a job field and as an input key, always, with a
 * security-specific message.
 *
 * A job carries no step configuration at all, so none of these has anywhere
 * to land today — which is the point. Refusing them by name means a future
 * author who wants one has to delete a named check and a named test, instead
 * of adding a field to a shape that silently accepted it all along.
 */
export const RESERVED_CONTROL_FLOW_FIELDS: readonly string[] = [
  "when",
  "skipDependents",
  "condition",
  "dependsOn",
  "steps",
  "step",
  "stepOverrides",
  "skipSteps",
  "rbacScope",
  "choices",
  "requireItemConsent",
  "itemsRef",
  "timeoutMs",
  "onTimeout",
  "loop",
] as const;

const RESERVED_FIELD_SET: ReadonlySet<string> = new Set(
  RESERVED_CONTROL_FLOW_FIELDS,
);

// ── Bounds ──────────────────────────────────────────────────────────

export const MAX_JOB_NAME_LEN = 80;
export const MAX_JOB_DESCRIPTION_LEN = 500;
/**
 * Serialized `input` ceiling, mirroring the host's `MAX_WORKFLOW_INPUT_BYTES`
 * (`src/extensions/workflows-handler.ts`). Measured the same way the host
 * measures it — `JSON.stringify(...).length`, UTF-16 code units, NOT bytes —
 * so the two checks agree exactly on non-ASCII input instead of one of them
 * letting through what the other rejects.
 */
export const MAX_JOB_INPUT_CHARS = 16_384;
/** Nesting cap on `input`. Bounds the validator's walk and doubles as a cycle
 *  guard, so the size check downstream can never hit a `JSON.stringify` throw. */
export const MAX_JOB_INPUT_DEPTH = 8;
/** Run records retained per job, newest first. Full history is core's
 *  `workflow_runs` (C5); this copy is a fast index, never the record. */
export const MAX_RUNS_PER_JOB = 50;

/**
 * Job and run ids. Constrained BECAUSE ids are spliced into storage keys
 * (`job:<id>`, `run:<jobId>:<runId>`, `run-index:<jobId>`): an id carrying
 * `:` could forge a key belonging to another job. The charset is a strict
 * subset of the host's `KEY_REGEX` (`src/extensions/storage-handler.ts`), so
 * a validated id can never produce a key the host rejects.
 */
export const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** True when `id` is a legal job / run id. */
export function isValidJobId(id: unknown): id is string {
  return typeof id === "string" && JOB_ID_RE.test(id);
}

/** Mint a fresh job id. A UUID satisfies {@link JOB_ID_RE} by construction. */
export function newJobId(): string {
  return crypto.randomUUID();
}

// ── Model ───────────────────────────────────────────────────────────

// ── Background-trigger bounds ───────────────────────────────────────

/**
 * `permissions.triggers` from `ezcorp.config.ts`, mirrored.
 *
 * Mirrored rather than imported for the same reason {@link FACTORY_WORKFLOWS}
 * is: importing `../ezcorp.config` would drag `defineExtension` — and with it
 * a `src/extensions/**` host module — into the sandboxed bundle. A test pins
 * the two against each other, so drift is a named failure rather than a
 * silent one.
 */
export const TRIGGER_ENVELOPE = {
  maxCron: 25,
  maxWebhooks: 25,
  maxRunsPerDay: 500,
} as const;

/**
 * The most fires a day ONE background job may claim.
 *
 * Not a number picked here: it is the host's own per-key derivation,
 * `defaultPerKeyCap(envelope, maxCron)` = `max(1, floor(500 / 25))` = 20
 * (`src/extensions/triggers-store.ts`). The host applies that cap to every
 * dynamic cron row whatever the extension asks for, so a job saved with a
 * larger number would be throttled to 20 anyway — silently, and only ever
 * visible as "it ran fewer times than I told it to". Refusing it at save
 * time is the honest version of the same bound.
 */
export const MAX_JOB_RUNS_PER_DAY = Math.max(
  1,
  Math.floor(TRIGGER_ENVELOPE.maxRunsPerDay / TRIGGER_ENVELOPE.maxCron),
);

/**
 * The most tokens ONE unattended run may spend.
 *
 * This one IS a number chosen here, because the host has none to inherit:
 * the consent route accepts any positive integer
 * (`web/src/routes/api/workflows/delegations/+server.ts` —
 * `z.number().int().positive()`), deliberately, so the person consenting
 * chooses. This console's job is to keep the choice bounded before it gets
 * there.
 *
 * The arithmetic a reviewer should check before moving it: worst case for a
 * single job is `MAX_JOB_TOKENS_PER_RUN × MAX_JOB_RUNS_PER_DAY` =
 * 250k × 20 = 5M tokens a day, and the extension may hold
 * {@link TRIGGER_ENVELOPE}`.maxCron` = 25 such jobs. Raising either number
 * multiplies the unattended spend of every job on the install.
 *
 * The FLOOR is deliberately the host's own — a positive integer, nothing
 * invented. A job whose ceiling is too low to finish a step wastes its own
 * quota and no one else's, which is a bad job rather than an unsafe one.
 */
export const MAX_JOB_TOKENS_PER_RUN = 250_000;

/** Longest cron expression this console will store. A 5-field expression
 *  with fully-enumerated lists is far shorter; the bound just keeps an
 *  unbounded string out of a field the host re-parses. */
export const MAX_CRON_LEN = 120;
/** Longest IANA zone name this console will store (`America/Argentina/
 *  ComodRivadavia` is 32). */
export const MAX_TIMEZONE_LEN = 64;

/**
 * The bounds every BACKGROUND trigger carries, and the reason they are on
 * the trigger rather than beside it.
 *
 * A `workflow_delegations` row has `max_tokens_per_run` and
 * `max_runs_per_day` as NOT NULL columns (`src/db/schema.ts`), and a
 * delegated fire is the only way a background trigger ever reaches a run.
 * Putting them in the trigger's own type makes "a background job without
 * bounds" UNCONSTRUCTIBLE rather than merely rejected — a `manual` job has
 * no delegation and therefore carries none, and the union is what says so.
 *
 * A cron job with no ceiling is a self-inflicted denial of service, and
 * this program has already shipped one permanent-DoS shape by accident. A
 * bound that lives in the validator only is a bound the next author can
 * route around by adding a second write path; a bound that lives in the
 * type cannot be.
 */
export interface JobTriggerBounds {
  /** Fires a day, 1..{@link MAX_JOB_RUNS_PER_DAY}. Becomes the delegation
   *  row's `max_runs_per_day`. */
  maxRunsPerDay: number;
  /** Tokens per run, 1..{@link MAX_JOB_TOKENS_PER_RUN}. Becomes the
   *  delegation row's `max_tokens_per_run`. TOKENS, never cents — an
   *  unpriced (OAuth-subscription) model reports a null price and would
   *  spend without bound under a cost cap. */
  maxTokensPerRun: number;
}

/**
 * How a job fires.
 *
 * **`manual`, `cron` and `webhook` are creatable** (phase 9); `event` and
 * `workflow` are modelled only so a stored job written by a later version
 * round-trips through this store unmangled — see {@link validateJobDraft}.
 *
 * ## What changed, and what did NOT
 *
 * Until phase 9 a background trigger was refused at creation, and the
 * reason given was sound: a cron / webhook fire is ownerless, and
 * `ctx.workflows.run()` fails `-32106` (`WORKFLOWS_NO_OWNER`) without an
 * acting user. That refusal in the host is UNCHANGED and must stay — it
 * exists because `WorkflowExecutor.runWorkflow` scopes `workflow:*` SSE on
 * `userId` and is fail-closed without one.
 *
 * What changed is that `run` is no longer the only verb.
 * `ctx.workflows.runFor(jobRef)` fires as the human who consented to a
 * `workflow_delegations` row, which is exactly what an unattended fire
 * needs, and the manifest now declares `workflows.allowDelegated` to opt
 * in. So a background job is no longer "created and inert": it is created
 * with the bounds a delegation requires, and stays unarmed until a human
 * consents to it.
 *
 * **A saved background trigger is NOT itself authority.** Nothing in this
 * store mints a delegation, and a job whose trigger is `cron` fires nothing
 * until a human has consented through core's session-only consent route.
 * That handoff is a separate surface; this type is the shape it reads.
 */
export type JobTrigger =
  | { kind: "manual" }
  | ({ kind: "cron"; cron: string; timezone: string } & JobTriggerBounds)
  | ({ kind: "webhook" } & JobTriggerBounds)
  | { kind: "event"; event: string }
  | { kind: "workflow"; onWorkflow: string; onStatus: string[] };

/** The trigger kinds that fire without a human present — the ones that
 *  carry {@link JobTriggerBounds} and need a delegation to act. */
export const BACKGROUND_TRIGGER_KINDS = ["cron", "webhook"] as const;

export type BackgroundTriggerKind = (typeof BACKGROUND_TRIGGER_KINDS)[number];

/** A trigger that fires unattended, narrowed so callers get the bounds. */
export type BackgroundJobTrigger = Extract<
  JobTrigger,
  { kind: BackgroundTriggerKind }
>;

/**
 * True when `trigger` fires without a human present.
 *
 * The one predicate for that question. The fire path, the console, and the
 * consent handoff all need it, and three hand-rolled `kind === "cron" ||
 * kind === "webhook"` checks is how one of them ends up disagreeing the day
 * a third background kind lands.
 */
export function isBackgroundTrigger(
  trigger: JobTrigger,
): trigger is BackgroundJobTrigger {
  return trigger.kind === "cron" || trigger.kind === "webhook";
}

/**
 * The bounds a background trigger carries, or `null` for an attended one.
 *
 * The seam the delegation-consent handoff and the fire path read: both need
 * `{maxRunsPerDay, maxTokensPerRun}` and neither should re-derive them from
 * the trigger's shape.
 */
export function triggerBounds(trigger: JobTrigger): JobTriggerBounds | null {
  return isBackgroundTrigger(trigger)
    ? { maxRunsPerDay: trigger.maxRunsPerDay, maxTokensPerRun: trigger.maxTokensPerRun }
    : null;
}

/**
 * Who a run is attributed to.
 *
 * **Written, never acted on.** The store always writes `{kind: "user", id:
 * <creator>}` because that is the only attribution the host will accept on
 * a MANUAL fire, and it accepts it from the calling identity, not from this
 * field.
 *
 * C3 has since merged, so `service` is no longer hypothetical — but it is
 * still not this field's to decide. A delegated fire runs as the owner
 * recorded on the `workflow_delegations` row (`owner_kind` / `owner_id`),
 * which a human set when they consented; reading THIS field to choose an
 * owner would let a job's stored bytes name who it runs as, which is the
 * confused deputy that table is shaped to prevent. It stays an attribution
 * record.
 */
export interface JobRunAs {
  kind: "user" | "service";
  id: string;
}

/** One saved job. Install-wide — see the module header. */
export interface FactoryJob {
  id: string;
  name: string;
  description: string;
  /** BARE workflow name — one of {@link FACTORY_WORKFLOWS}. */
  workflow: FactoryWorkflow;
  /** Top-level run input (`$input.<field>`). Keys are allowlisted per
   *  workflow by {@link JOB_SETTABLE_INPUT_KEYS} — invariant B, door 1. */
  input: Record<string, unknown>;
  trigger: JobTrigger;
  enabled: boolean;
  /** Forward-compat, never read. See {@link JobRunAs}. */
  runAs: JobRunAs;
  /** Always `null`, and it stays that way even now C3 has merged. The
   *  consent hash is computed HOST-side over the transitive closure of the
   *  graph (`computeDelegationConsentRecord`) and re-derived at fire time to
   *  compare; a copy stored here would be a second answer this extension
   *  cannot recompute, which is worse than no answer. The authoritative
   *  value lives on the `workflow_delegations` row. */
  consentHash: string | null;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  /** Bookkeeping — last time this job was fired, and the run it produced.
   *  Set by {@link JobStore.touchJob}, never by an operator edit. */
  lastRunAt?: string;
  lastWorkflowRunId?: string;
  /**
   * The outcome of this job's last UNATTENDED fire. Set by
   * {@link JobStore.noteFire}, never by an operator edit.
   *
   * **Why the job carries this and `lastRunAt` cannot.** `lastRunAt` is
   * written by `reconcileRuns`, which reads `ctx.workflows.runs()` — a
   * read the host scopes to the ASKING USER with `eq(workflow_runs.user_id,
   * …)`. A delegated run owned by a service account has `user_id IS NULL`
   * and therefore matches no viewer at all, and a refused fire produces no
   * run row in the first place. So without this field a cron job whose
   * authority went stale is indistinguishable from one whose next tick has
   * simply not come round: both show an old `lastRunAt` and nothing else.
   *
   * This value comes from the rejection of THIS console's own `runFor`
   * call, so it does not depend on any run-visibility question being
   * answered a particular way.
   */
  lastFire?: JobFireOutcome;
}

/** The editable subset of a job. Ids, timestamps, attribution and bookkeeping
 *  are store-owned. */
export interface JobDraft {
  name: string;
  description: string;
  workflow: FactoryWorkflow;
  input: Record<string, unknown>;
  trigger: JobTrigger;
  enabled: boolean;
}

declare const VALIDATED: unique symbol;

/**
 * A {@link JobDraft} that has been through {@link validateJobDraft}.
 *
 * The brand is type-only — it costs nothing at runtime and carries invariant
 * B into the type system: {@link JobStore.createJob} and
 * {@link JobStore.saveJob} accept nothing else, so there is no way to write a
 * job's `workflow` or `input` without passing the allowlist first. The one
 * cast that mints the brand is inside the validator, which has earned it.
 *
 * This is the deliberate divergence from `ez-code-factory`, whose
 * `updateJob(id, patch: Partial<Job>)` merges an arbitrary patch straight
 * into the stored row — a second, unvalidated write path around its own
 * `PROTECTED_STEPS` check.
 */
export type ValidatedJobDraft = JobDraft & { readonly [VALIDATED]: true };

/** One run of a job, as `ctx.workflows.runs()` reports it, plus the job it
 *  belongs to. A fast local index over core's `workflow_runs`. */
export interface JobRunRecord {
  jobId: string;
  /** The `workflow_runs` row id — what the trace UI keys on. */
  workflowRunId: string;
  /** Fully-namespaced, as the host reports it (`ez-factory:docs-factory`). */
  workflowName: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  suspendedReason: string | null;
  resumable: boolean;
}

/**
 * One run as the HOST reports it — the subset of the SDK's
 * `WorkflowRunSummary` this console reads.
 *
 * Declared structurally rather than imported so the mapper below is a pure
 * function over data with no SDK surface in its signature, and so a host
 * that adds a field cannot silently change what this module accepts.
 */
export interface HostWorkflowRun {
  workflowRunId: string;
  workflowName: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  suspendedReason: string | null;
  resumable: boolean;
  /** The handle this console passed as `jobRef` when it fired the run —
   *  `null` for a run started any other way (the REST route, the CLI, a
   *  chat `run_workflow`). */
  jobRef: string | null;
}

/**
 * Turn the host's run list into the records this store keeps, keeping ONLY
 * runs that are attributable to a job it knows about.
 *
 * ## This is the correlation, and it is exact
 *
 * `ctx.workflows.run()` returns no run id, so before `jobRef` existed the
 * only way to say "that run came from this job" was to match on start
 * time — which is wrong the first time two jobs fire in the same second,
 * and wrong in a way nobody notices, because both answers look plausible.
 * `jobRef` is the id this console itself supplied, echoed back off the
 * `workflow_runs` row. There is no guessing left in it.
 *
 * ## Three refusals, all fail-closed
 *
 *   - `jobRef === null` — the run was started by some OTHER surface (a
 *     hand-fired REST run, the CLI). It is a real run of a real workflow
 *     and it is not this job's; claiming it would put a run in the
 *     console that the console did not start.
 *   - `jobRef` names a job that is not in `knownJobIds` — deleted since,
 *     or never ours. `deleteJob` drops a job's run records with it, so
 *     re-recording one would resurrect an index entry pointing at a job
 *     that no longer exists.
 *   - either id fails {@link isValidJobId} — the ids are spliced into
 *     storage keys, and the store would reject them anyway. Refusing here
 *     keeps the store from having to defend the same thing twice.
 *
 * Pure: no storage, no clock. The caller writes what comes back.
 */
export function runRecordsFromHostRuns(
  runs: readonly HostWorkflowRun[],
  knownJobIds: ReadonlySet<string>,
): JobRunRecord[] {
  const records: JobRunRecord[] = [];
  for (const run of runs) {
    const jobId = run.jobRef;
    if (jobId === null || !isValidJobId(jobId) || !knownJobIds.has(jobId)) continue;
    if (!isValidJobId(run.workflowRunId)) continue;
    records.push({
      jobId,
      workflowRunId: run.workflowRunId,
      workflowName: run.workflowName,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      suspendedReason: run.suspendedReason,
      resumable: run.resumable,
    });
  }
  return records;
}

/**
 * The bookkeeping {@link JobStore.touchJob} should write for each job, given
 * the run records just reconciled: the NEWEST run per job.
 *
 * Newest by `startedAt`, not by list position — the host returns newest
 * first today, but a job's `lastRunAt` must not silently invert if that
 * ever changes, and a string compare on ISO instants is total and cheap.
 *
 * Pure, for the same reason the mapper is.
 */
export function latestRunPerJob(
  records: readonly JobRunRecord[],
): Map<string, JobRunRecord> {
  const latest = new Map<string, JobRunRecord>();
  for (const record of records) {
    const current = latest.get(record.jobId);
    if (current === undefined || record.startedAt > current.startedAt) {
      latest.set(record.jobId, record);
    }
  }
  return latest;
}

/** Store-layout marker, so a v2 key layout can migrate rather than guess. */
export interface JobStoreMeta {
  version: number;
  migratedAt: string;
}

export const JOB_STORE_VERSION = 1;

/** Either-shaped validation result. `error` is operator-facing prose. */
export type JobResult<T> = { ok: true; value: T } | { ok: false; error: string };

// ── Validation ──────────────────────────────────────────────────────

/** The complete set of keys a draft may carry. The shape is CLOSED: anything
 *  else is rejected, so a step-shaping field cannot arrive by accident. */
export const JOB_DRAFT_FIELDS: readonly string[] = [
  "name",
  "description",
  "workflow",
  "input",
  "trigger",
  "enabled",
] as const;

const DRAFT_FIELD_SET: ReadonlySet<string> = new Set(JOB_DRAFT_FIELDS);

const reservedFieldError = (where: string, key: string): string =>
  `${where} '${key}' shapes a workflow step and is refused: a job supplies a workflow's INPUT, never its control flow. Allowing it would let a saved job skip an approval or gate step.`;

/**
 * Walk `value` and report the first JSON-unsafe thing in it, or `null`.
 *
 * Rejects what `JSON.stringify` would silently discard or coerce —
 * `undefined` and functions vanish, `NaN` / `Infinity` become `null` — so an
 * operator never saves an input that the host receives as something else.
 * Depth is capped, which also means a cyclic object is refused here rather
 * than throwing out of the size check below.
 */
function jsonSafetyError(value: unknown, path: string, depth: number): string | null {
  if (depth > MAX_JOB_INPUT_DEPTH) {
    return `input ${path} nests deeper than ${MAX_JOB_INPUT_DEPTH} levels`;
  }
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return null;
    case "number":
      return Number.isFinite(value)
        ? null
        : `input ${path} is ${String(value)}, which JSON turns into null`;
    case "undefined":
      return `input ${path} is undefined, which JSON silently drops`;
    case "object":
      break;
    default:
      return `input ${path} is a ${typeof value}, which is not JSON data`;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const err = jsonSafetyError(value[i], `${path}[${i}]`, depth + 1);
      if (err) return err;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (RESERVED_FIELD_SET.has(key)) return reservedFieldError("input key", key);
    const err = jsonSafetyError(child, `${path}.${key}`, depth + 1);
    if (err) return err;
  }
  return null;
}

/** Validate the `input` map against the chosen workflow's allowlist. */
function validateInput(
  raw: unknown,
  workflow: FactoryWorkflow,
): JobResult<Record<string, unknown>> {
  if (raw === undefined) return { ok: true, value: {} };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "input must be a plain object" };
  }
  const allowed = JOB_SETTABLE_INPUT_KEYS[workflow];
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    // Reserved names are refused with the security message even though the
    // allowlist below would also reject them — an operator who typed
    // `skipDependents` deserves to be told why, not "unknown key".
    if (RESERVED_FIELD_SET.has(key)) {
      return { ok: false, error: reservedFieldError("input key", key) };
    }
    if (!allowed.includes(key)) {
      return {
        ok: false,
        error: `input key '${key}' is not settable on '${workflow}' (allowed: ${allowed.join(", ") || "none"})`,
      };
    }
    const err = jsonSafetyError(value, key, 1);
    if (err) return { ok: false, error: err };
    input[key] = value;
  }
  const serialized = JSON.stringify(input);
  if (serialized.length > MAX_JOB_INPUT_CHARS) {
    return {
      ok: false,
      error: `input too large (${serialized.length} > ${MAX_JOB_INPUT_CHARS}) — reduce it rather than letting the host truncate it`,
    };
  }
  return { ok: true, value: input };
}

/**
 * A bounded positive integer, accepting a NUMERIC STRING as well as a
 * number.
 *
 * The string form is not a convenience: every value the Hub's form node
 * collects is a string, so `maxRunsPerDay` arrives as `"20"`. The same
 * coercion the three tools' numeric args already document ("Number or
 * numeric string"). Over-cap input is REJECTED, never clamped — a coercion
 * that accepts `"20"` must not become one that accepts anything.
 */
function boundedCount(
  raw: unknown,
  field: string,
  max: number,
): JobResult<number> {
  let value: number;
  if (typeof raw === "number") {
    value = raw;
  } else if (typeof raw === "string" && /^[0-9]+$/.test(raw.trim())) {
    // Digits only: `parseInt` would happily read "20 runs" as 20, and
    // `Number("")` is 0. Neither is a number the operator typed.
    value = Number(raw.trim());
  } else {
    return {
      ok: false,
      error: `${field} is required and must be a whole number (1-${max})`,
    };
  }
  if (!Number.isInteger(value) || value < 1 || value > max) {
    return {
      ok: false,
      error: `${field} must be a whole number between 1 and ${max} (got ${value})`,
    };
  }
  return { ok: true, value };
}

/**
 * Structural check on a cron expression.
 *
 * **Shape only, and the host stays the authority.** `validateCron`
 * (`src/extensions/cron.ts`) owns the semantics — field ranges, steps,
 * lists, and the minimum 5-minute interval — and `ctx.triggers.register`
 * returns `TRIGGER_CRON_INVALID` with the validator's own message verbatim
 * on `data.cronReason`, which is what belongs next to the field the
 * operator typed into. Re-implementing those rules here would give the
 * console a second opinion that can drift from the one that decides.
 *
 * What IS checked here is the part that cannot drift: a 5-field expression
 * is the host's stated contract (its own error reads "expected 5 fields,
 * got 4") and `@`-shorthand is refused outright. Catching those two in the
 * console turns the most common typo into an immediate message instead of
 * a job that saves and never arms.
 *
 * Note what bounds the DAMAGE either way: it is not the interval, it is
 * {@link JobTriggerBounds.maxRunsPerDay}, which is mandatory and capped at
 * {@link MAX_JOB_RUNS_PER_DAY}. Even an accepted every-five-minutes
 * expression (288 potential fires a day) cannot exceed it.
 */
function validateCronExpr(raw: unknown): JobResult<string> {
  if (typeof raw !== "string") {
    return { ok: false, error: "trigger.cron is required and must be a string" };
  }
  const cron = raw.trim();
  if (cron === "") return { ok: false, error: "trigger.cron is required" };
  if (cron.length > MAX_CRON_LEN) {
    return {
      ok: false,
      error: `trigger.cron must be ${MAX_CRON_LEN} characters or fewer (got ${cron.length})`,
    };
  }
  if (cron.startsWith("@")) {
    return {
      ok: false,
      error: "trigger.cron does not accept @shorthand — write a 5-field expression (min hour dom month dow)",
    };
  }
  const fields = cron.split(/\s+/);
  if (fields.length !== 5) {
    return {
      ok: false,
      error: `trigger.cron must have 5 fields (min hour dom month dow); got ${fields.length}`,
    };
  }
  return { ok: true, value: cron };
}

/**
 * An IANA time zone the runtime can actually resolve.
 *
 * Checked HERE rather than deferred, unlike the cron expression, because
 * the host does not check it: `triggers-handler.ts` only asserts
 * `typeof timezone === "string"` and hands it straight to
 * `parseCron(expr, timezone)`, which resolves it through
 * `Intl.DateTimeFormat`. A bogus zone therefore surfaces as a thrown
 * `RangeError` from inside the register call rather than as a field error.
 *
 * `Intl` is untouched by the sandbox preload (it poisons `node:fs`,
 * `Bun.file`, `Bun.write` and `Bun.glob`), and `src/extensions/cron.ts`
 * resolves zones the same way — so this asks the same question the host
 * will ask, with the same implementation, one step earlier.
 */
function validateTimezone(raw: unknown): JobResult<string> {
  if (typeof raw !== "string") {
    return {
      ok: false,
      error: "trigger.timezone is required and must be an IANA zone (e.g. America/New_York)",
    };
  }
  const timezone = raw.trim();
  if (timezone === "") return { ok: false, error: "trigger.timezone is required" };
  if (timezone.length > MAX_TIMEZONE_LEN) {
    return {
      ok: false,
      error: `trigger.timezone must be ${MAX_TIMEZONE_LEN} characters or fewer (got ${timezone.length})`,
    };
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    // The only thing this throws for is an unresolvable zone, and the
    // operator-facing message is the same either way. Re-reporting the
    // RangeError's text would leak an implementation detail into a form.
    return {
      ok: false,
      error: `trigger.timezone '${timezone}' is not a time zone this runtime knows (use an IANA name like America/New_York or UTC)`,
    };
  }
  return { ok: true, value: timezone };
}

/**
 * Validate a trigger.
 *
 * `manual`, `cron` and `webhook` are accepted; `event` and `workflow` are
 * still refused, because nothing dispatches them — modelling a shape is not
 * the same as having a path that fires it, and a job that saves and can
 * never run is the failure this whole function exists to prevent.
 *
 * **A background trigger cannot be built without its bounds.** Both are
 * REQUIRED, neither defaults, and there is no "unlimited". A default would
 * be a number nobody chose and an unlimited option would be the number
 * everybody chooses — the same reasoning core's own consent route gives
 * for refusing to default them. They are what a `workflow_delegations` row
 * needs as NOT NULL columns, so a job without them could never become an
 * armed delegation anyway; requiring them here is what stops a
 * half-configured job existing in the first place.
 */
function validateTrigger(raw: unknown): JobResult<JobTrigger> {
  if (raw === undefined) return { ok: true, value: { kind: "manual" } };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "trigger must be an object" };
  }
  const trigger = raw as Record<string, unknown>;
  const kind = trigger.kind;
  if (kind === "manual") return { ok: true, value: { kind: "manual" } };

  if (kind === "cron" || kind === "webhook") {
    // Bounds first: they are the blast-radius bound, and reporting them
    // before a cron typo means an operator who omitted them is told so
    // rather than being sent round the loop twice.
    const maxRunsPerDay = boundedCount(
      trigger.maxRunsPerDay,
      "trigger.maxRunsPerDay",
      MAX_JOB_RUNS_PER_DAY,
    );
    if (!maxRunsPerDay.ok) return maxRunsPerDay;
    const maxTokensPerRun = boundedCount(
      trigger.maxTokensPerRun,
      "trigger.maxTokensPerRun",
      MAX_JOB_TOKENS_PER_RUN,
    );
    if (!maxTokensPerRun.ok) return maxTokensPerRun;
    const bounds: JobTriggerBounds = {
      maxRunsPerDay: maxRunsPerDay.value,
      maxTokensPerRun: maxTokensPerRun.value,
    };

    if (kind === "webhook") return { ok: true, value: { kind: "webhook", ...bounds } };

    const cron = validateCronExpr(trigger.cron);
    if (!cron.ok) return cron;
    const timezone = validateTimezone(trigger.timezone);
    if (!timezone.ok) return timezone;
    return {
      ok: true,
      value: { kind: "cron", cron: cron.value, timezone: timezone.value, ...bounds },
    };
  }

  if (kind === "event" || kind === "workflow") {
    return {
      ok: false,
      error: `trigger '${kind}' is modelled but not dispatched: nothing in this extension registers for it, so the job would save and never fire. Use 'manual', 'cron' or 'webhook'.`,
    };
  }
  return { ok: false, error: "trigger.kind must be 'manual', 'cron' or 'webhook'" };
}

/** Required, trimmed, bounded string field. Over-length is REJECTED, never
 *  clamped — a silently truncated field is a silently wrong field. */
function boundedText(
  raw: unknown,
  field: string,
  max: number,
  required: boolean,
): JobResult<string> {
  if (raw === undefined || raw === null) {
    return required ? { ok: false, error: `${field} is required` } : { ok: true, value: "" };
  }
  if (typeof raw !== "string") return { ok: false, error: `${field} must be a string` };
  const trimmed = raw.trim();
  if (required && trimmed === "") return { ok: false, error: `${field} is required` };
  if (trimmed.length > max) {
    return { ok: false, error: `${field} must be ${max} characters or fewer (got ${trimmed.length})` };
  }
  return { ok: true, value: trimmed };
}

/**
 * Validate and normalize a job draft, returning the branded value or the
 * FIRST error.
 *
 * The one door into a writable job — see {@link ValidatedJobDraft}. Rejects,
 * in order: unknown or step-shaping fields, a blank / over-long name, an
 * over-long description, a workflow outside {@link FACTORY_WORKFLOWS}, a
 * trigger that is undispatchable or (for a background kind) unbounded, and
 * any input key outside the workflow's allowlist.
 */
export function validateJobDraft(draft: unknown): JobResult<ValidatedJobDraft> {
  if (typeof draft !== "object" || draft === null || Array.isArray(draft)) {
    return { ok: false, error: "job must be an object" };
  }
  const raw = draft as Record<string, unknown>;

  // Closed shape FIRST, so an unexpected field is a refusal rather than a
  // value that was quietly dropped and never asked about again.
  for (const key of Object.keys(raw)) {
    if (RESERVED_FIELD_SET.has(key)) {
      return { ok: false, error: reservedFieldError("job field", key) };
    }
    if (!DRAFT_FIELD_SET.has(key)) {
      return {
        ok: false,
        error: `unknown job field '${key}' (allowed: ${JOB_DRAFT_FIELDS.join(", ")})`,
      };
    }
  }

  const name = boundedText(raw.name, "name", MAX_JOB_NAME_LEN, true);
  if (!name.ok) return name;
  const description = boundedText(
    raw.description,
    "description",
    MAX_JOB_DESCRIPTION_LEN,
    false,
  );
  if (!description.ok) return description;

  if (!isFactoryWorkflow(raw.workflow)) {
    const got = typeof raw.workflow === "string" ? `'${raw.workflow}'` : "nothing";
    const hint =
      typeof raw.workflow === "string" && raw.workflow.includes(":")
        ? " — use the BARE name; the host applies the 'ez-factory:' prefix itself and rejects a name containing ':'"
        : "";
    return {
      ok: false,
      error: `workflow must be one of ${FACTORY_WORKFLOWS.join(", ")} (got ${got})${hint}`,
    };
  }
  const workflow: FactoryWorkflow = raw.workflow;

  const trigger = validateTrigger(raw.trigger);
  if (!trigger.ok) return trigger;

  const input = validateInput(raw.input, workflow);
  if (!input.ok) return input;

  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    return { ok: false, error: "enabled must be a boolean" };
  }

  // The ONE cast that mints the brand. Nothing else in the extension may
  // produce a `ValidatedJobDraft`.
  const value: JobDraft = {
    name: name.value,
    description: description.value,
    workflow,
    input: input.value,
    trigger: trigger.value,
    enabled: raw.enabled !== false,
  };
  return { ok: true, value: value as ValidatedJobDraft };
}

/** Fields an operator edits, and therefore the fields an audit diff reports.
 *  Exported so `lib/audit.ts` can report the NAMES that moved without also
 *  importing `diffJob`'s `{from, to}` values — see that module's header. */
export const DIFFABLE_FIELDS: readonly (keyof FactoryJob)[] = [
  "name",
  "description",
  "workflow",
  "input",
  "trigger",
  "enabled",
] as const;

/**
 * Shallow old→new diff of the editable fields, for the audit trail
 * (invariant I). Only changed fields appear. Jobs hold no secrets, but
 * `input` is operator-authored free data — whoever renders this owes it the
 * same escaping every other untrusted string gets.
 */
export function diffJob(
  before: FactoryJob,
  after: FactoryJob,
): Record<string, { from: unknown; to: unknown }> {
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of DIFFABLE_FIELDS) {
    if (JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null)) {
      diff[field] = { from: before[field] ?? null, to: after[field] ?? null };
    }
  }
  return diff;
}

// REMOVED: `parseJobIdPayload`, which read `payload.jobId`.
//
// It had no production caller, and the key it read is not one any page
// action carries: a form field id must match `/^[a-z0-9][a-z0-9_]{0,31}$/`
// or the host DROPS it, so the console's id travels as `job_id`
// (`JOB_FORM_FIELDS.jobId`). A reader keyed on `jobId` returns `null` for
// every real payload, and the failure is silent — the action refuses,
// the Hub still answers `{ok:true}`, and the button looks like it did
// nothing.
//
// That is not hypothetical: the Run action was written against it and
// refused every single click on a live server. `lib/page.ts` now owns the
// ONE reader (`jobIdFromActionPayload`), next to the field-id constant it
// has to agree with, and both actions use it.

// ── Storage layout ──────────────────────────────────────────────────
//
// One key per job and per run — NEVER a single packed array. A packed
// read-modify-write is what raced and lost state in three prior extensions.
// The index keys are the residual shared state, so they hold IDS ONLY: a lost
// update there costs at most a missing list entry, recoverable by a repair
// sweep, rather than corrupt job data.
//
//   meta                        → JobStoreMeta
//   job:<jobId>                 → FactoryJob
//   job-index                   → string[]        (job ids)
//   run:<jobId>:<runId>         → JobRunRecord
//   run-index:<jobId>           → string[]        (run ids, newest first, ≤50)

const META_KEY = "meta";
const JOB_KEY_PREFIX = "job:";
const JOB_INDEX_KEY = "job-index";
const RUN_KEY_PREFIX = "run:";
const RUN_INDEX_PREFIX = "run-index:";

/** Jobs are install-wide. There is no project scope to put them in. */
export const JOB_STORAGE_SCOPE = "global" as const;

const jobKey = (id: string): string => `${JOB_KEY_PREFIX}${id}`;
const runKey = (jobId: string, runId: string): string =>
  `${RUN_KEY_PREFIX}${jobId}:${runId}`;
const runIndexKey = (jobId: string): string => `${RUN_INDEX_PREFIX}${jobId}`;

/** Lock names are namespaced: `withLock` keys are process-global across every
 *  module the extension loads, so an unqualified `"meta"` would serialize
 *  against an unrelated module's `"meta"`. */
const lockName = (key: string): string => `ez-factory:jobs:${key}`;

export interface JobStore {
  /** Write a new job. Refuses an id that already exists rather than
   *  overwriting it. */
  createJob(
    draft: ValidatedJobDraft,
    opts: { id: string; actor: string; now: string },
  ): Promise<JobResult<FactoryJob>>;
  /** Replace a job's editable fields wholesale. `null` when it is gone. */
  saveJob(
    id: string,
    draft: ValidatedJobDraft,
    opts: { actor: string; now: string },
  ): Promise<FactoryJob | null>;
  /** Flip `enabled`. Separate from {@link saveJob} because a toggle should not
   *  require rebuilding — and re-validating — a whole draft. Safe to keep out
   *  of the validated path: disabling a job stops the entire run, which can
   *  never make an unreachable step reachable. */
  setEnabled(
    id: string,
    enabled: boolean,
    opts: { actor: string; now: string },
  ): Promise<FactoryJob | null>;
  /** Fire bookkeeping. Deliberately narrow: it can reach `lastRunAt` and
   *  `lastWorkflowRunId` and nothing else, so the "every semantic field goes
   *  through the validator" rule has no back door. */
  touchJob(
    id: string,
    bookkeeping: { lastRunAt: string; lastWorkflowRunId?: string },
  ): Promise<FactoryJob | null>;
  /**
   * Record the outcome of an UNATTENDED fire — see
   * {@link FactoryJob.lastFire}.
   *
   * Narrow for the same reason {@link touchJob} is: it can reach exactly
   * one field and nothing else, so "every semantic field goes through the
   * validator" keeps having no back door. A SUCCESS overwrites a previous
   * refusal rather than accumulating, because the question this field
   * answers is "is this job firing right now", not "has it ever failed" —
   * the history is the audit trail's job.
   */
  noteFire(id: string, outcome: JobFireOutcome): Promise<FactoryJob | null>;
  getJob(id: string): Promise<FactoryJob | null>;
  listJobs(): Promise<FactoryJob[]>;
  deleteJob(id: string): Promise<boolean>;
  /** Append (or update) a run record, newest-first, trimming to
   *  {@link MAX_RUNS_PER_JOB}. Evicted run keys are deleted. */
  recordRun(record: JobRunRecord): Promise<JobResult<JobRunRecord>>;
  listRuns(jobId: string, limit?: number): Promise<JobRunRecord[]>;
  readMeta(): Promise<JobStoreMeta | null>;
  /** Stamp {@link JOB_STORE_VERSION} on first use. Fails closed against a
   *  layout written by a NEWER build. */
  ensureMeta(now: string): Promise<JobResult<JobStoreMeta>>;
}

/**
 * A {@link JobStore} over the SDK's global storage bucket.
 *
 * Multi-key operations are sequential single-key critical sections, never
 * nested locks — nothing here holds one lock while taking another, so no
 * ordering can deadlock. The cost is that a crash mid-operation can leave a
 * blob with no index entry; the reverse (an index entry with no blob) is
 * tolerated too, because every read path skips a missing blob. Both are
 * recoverable by a repair sweep over `storage.list()`; neither corrupts a
 * job.
 */
export function createJobStore(): JobStore {
  const storage = new Storage(JOB_STORAGE_SCOPE);

  /**
   * **The only write path in this file.**
   *
   * Serializes read → edit → write on one key. `edit` returning `null` means
   * delete (no stored value is ever `null`, so the sentinel is unambiguous);
   * returning the value it was GIVEN means "unchanged", and neither case
   * spends a write.
   *
   * Every mutation below is expressed through this, which is what makes "no
   * `storage.set` outside a `withLock`" a structural property of the module
   * rather than a convention — `jobs.test.ts` asserts there is exactly one
   * call site for each of `set` and `delete`, and that it lives here.
   */
  async function rmw<T>(
    key: string,
    edit: (current: T | null) => T | null,
  ): Promise<T | null> {
    return withLock(lockName(key), async () => {
      const read = await storage.get<T>(key);
      const current = read.exists && read.value !== undefined ? read.value : null;
      const next = edit(current);
      if (next === current) return current;
      if (next === null) {
        await storage.delete(key);
        return null;
      }
      await storage.set(key, next);
      return next;
    });
  }

  const readList = async (key: string): Promise<string[]> => {
    const read = await storage.get<string[]>(key);
    return Array.isArray(read.value) ? read.value : [];
  };

  /** Apply `edit` to a stored job under its own lock. */
  const editJob = async (
    id: string,
    edit: (job: FactoryJob) => FactoryJob,
  ): Promise<FactoryJob | null> => {
    if (!isValidJobId(id)) return null;
    return rmw<FactoryJob>(jobKey(id), (current) =>
      current === null ? null : edit(current),
    );
  };

  return {
    async createJob(draft, opts) {
      if (!isValidJobId(opts.id)) {
        return { ok: false, error: `invalid job id '${opts.id}'` };
      }
      let created: FactoryJob | null = null;
      await rmw<FactoryJob>(jobKey(opts.id), (current) => {
        if (current !== null) return current;
        created = {
          id: opts.id,
          name: draft.name,
          description: draft.description,
          workflow: draft.workflow,
          input: draft.input,
          trigger: draft.trigger,
          enabled: draft.enabled,
          // Attribution the host will accept, and the only kind it accepts.
          runAs: { kind: "user", id: opts.actor },
          consentHash: null,
          createdBy: opts.actor,
          createdAt: opts.now,
          updatedBy: opts.actor,
          updatedAt: opts.now,
        };
        return created;
      });
      if (created === null) {
        return { ok: false, error: `job '${opts.id}' already exists` };
      }
      // Index second: a crash here leaves an unlisted blob, never a list
      // entry pointing at nothing.
      await rmw<string[]>(JOB_INDEX_KEY, (ids) => {
        const list = ids ?? [];
        return list.includes(opts.id) ? list : [...list, opts.id];
      });
      return { ok: true, value: created };
    },

    async saveJob(id, draft, opts) {
      return editJob(id, (job) => ({
        ...job,
        name: draft.name,
        description: draft.description,
        workflow: draft.workflow,
        input: draft.input,
        trigger: draft.trigger,
        enabled: draft.enabled,
        updatedBy: opts.actor,
        updatedAt: opts.now,
      }));
    },

    async setEnabled(id, enabled, opts) {
      return editJob(id, (job) => ({
        ...job,
        enabled,
        updatedBy: opts.actor,
        updatedAt: opts.now,
      }));
    },

    async touchJob(id, bookkeeping) {
      return editJob(id, (job) => ({
        ...job,
        lastRunAt: bookkeeping.lastRunAt,
        ...(bookkeeping.lastWorkflowRunId !== undefined
          ? { lastWorkflowRunId: bookkeeping.lastWorkflowRunId }
          : {}),
      }));
    },

    async noteFire(id, outcome) {
      return editJob(id, (job) => ({ ...job, lastFire: outcome }));
    },

    async getJob(id) {
      if (!isValidJobId(id)) return null;
      const read = await storage.get<FactoryJob>(jobKey(id));
      return read.exists && read.value ? read.value : null;
    },

    async listJobs() {
      const ids = await readList(JOB_INDEX_KEY);
      const jobs: FactoryJob[] = [];
      for (const id of ids) {
        const read = await storage.get<FactoryJob>(jobKey(id));
        // A missing blob is skipped, not an error: the index is a hint, and a
        // crash between the two writes must not break the whole list.
        if (read.exists && read.value) jobs.push(read.value);
      }
      return jobs;
    },

    async deleteJob(id) {
      if (!isValidJobId(id)) return false;
      let existed = false;
      await rmw<FactoryJob>(jobKey(id), (current) => {
        existed = current !== null;
        return null;
      });
      if (!existed) return false;
      await rmw<string[]>(JOB_INDEX_KEY, (ids) =>
        (ids ?? []).filter((x) => x !== id),
      );
      // The job's run records go with it, index first so nothing is left
      // pointing at a deleted run.
      const runIds = await readList(runIndexKey(id));
      await rmw<string[]>(runIndexKey(id), () => null);
      for (const runId of runIds) await rmw(runKey(id, runId), () => null);
      return true;
    },

    async recordRun(record) {
      if (!isValidJobId(record.jobId) || !isValidJobId(record.workflowRunId)) {
        return {
          ok: false,
          error: `invalid run record ids (job '${record.jobId}', run '${record.workflowRunId}')`,
        };
      }
      await rmw<JobRunRecord>(runKey(record.jobId, record.workflowRunId), () => record);
      // Newest-first, deduped, trimmed in the SAME critical section as the
      // append so two concurrent records cannot both survive the cap.
      let evicted: string[] = [];
      await rmw<string[]>(runIndexKey(record.jobId), (ids) => {
        const next = [
          record.workflowRunId,
          ...(ids ?? []).filter((x) => x !== record.workflowRunId),
        ];
        evicted = next.slice(MAX_RUNS_PER_JOB);
        return next.slice(0, MAX_RUNS_PER_JOB);
      });
      // Outside the index lock on purpose: deleting a blob while holding the
      // index lock would nest two locks and invent an ordering to get wrong.
      // A crash here leaves an unreferenced blob, which the repair sweep
      // finds and no read path can reach.
      for (const runId of evicted) await rmw(runKey(record.jobId, runId), () => null);
      return { ok: true, value: record };
    },

    async listRuns(jobId, limit = MAX_RUNS_PER_JOB) {
      if (!isValidJobId(jobId)) return [];
      const ids = (await readList(runIndexKey(jobId))).slice(0, limit);
      const runs: JobRunRecord[] = [];
      for (const runId of ids) {
        const read = await storage.get<JobRunRecord>(runKey(jobId, runId));
        if (read.exists && read.value) runs.push(read.value);
      }
      return runs;
    },

    async readMeta() {
      const read = await storage.get<JobStoreMeta>(META_KEY);
      const meta = read.exists ? read.value : null;
      if (!meta || typeof meta.version !== "number") return null;
      return meta;
    },

    async ensureMeta(now) {
      // Decided inside the critical section so the verdict and the stored
      // value can never describe different reads. Every branch assigns.
      let outcome: JobResult<JobStoreMeta> | undefined;
      await rmw<JobStoreMeta>(META_KEY, (current) => {
        if (current === null || typeof current.version !== "number") {
          const fresh: JobStoreMeta = { version: JOB_STORE_VERSION, migratedAt: now };
          outcome = { ok: true, value: fresh };
          return fresh;
        }
        // Fail closed against the future. A build that does not understand
        // the stored layout must not write to it — a v1 writer loose in a v2
        // key space corrupts exactly the data the version marker exists to
        // protect.
        outcome =
          current.version > JOB_STORE_VERSION
            ? {
                ok: false,
                error: `job store is version ${current.version}; this build understands ${JOB_STORE_VERSION}`,
              }
            : { ok: true, value: current };
        return current;
      });
      return outcome as JobResult<JobStoreMeta>;
    },
  };
}
