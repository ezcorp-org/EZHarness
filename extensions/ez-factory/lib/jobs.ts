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
// Ported from `docs/extensions/examples/ez-code-factory/lib/jobs.ts`
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

/**
 * How a job fires.
 *
 * **v1 accepts `manual` only** — see {@link validateJobDraft}. The other
 * shapes are modelled so a stored job written by a later version round-trips
 * through this store unmangled, not because anything here can create one.
 *
 * Background fires are refused rather than broken: a cron / webhook fire is
 * ownerless, and `ctx.workflows.run()` fails `-32106` without an acting user
 * (`src/extensions/workflows-handler.ts:325-345`). A job that fires and
 * silently starts nothing is worse than a job that cannot be created.
 */
export type JobTrigger =
  | { kind: "manual" }
  | { kind: "cron"; cron: string; timezone: string }
  | { kind: "webhook" }
  | { kind: "event"; event: string }
  | { kind: "workflow"; onWorkflow: string; onStatus: string[] };

/**
 * Who a run is attributed to.
 *
 * **Written, never acted on.** v1 always writes `{kind: "user", id:
 * <creator>}` because that is the only attribution the host will accept, and
 * it accepts it from the calling identity, not from this field. Delegated
 * execution (`service`) is C3, which is unbuilt and blocked. The field exists
 * so a C3-era row has somewhere to land; reading it to make a decision today
 * would be inventing a capability.
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
  /** Forward-compat, always `null` in v1. C3 hashes the transitive closure of
   *  a graph at consent time; nothing computes or checks a hash today, so
   *  writing anything but `null` here would claim a verification that does
   *  not happen. */
  consentHash: string | null;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  /** Bookkeeping — last time this job was fired, and the run it produced.
   *  Set by {@link JobStore.touchJob}, never by an operator edit. */
  lastRunAt?: string;
  lastWorkflowRunId?: string;
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
 * v1 accepts `manual` only. See {@link JobTrigger} for why a background
 * trigger is refused at creation rather than created and left inert.
 */
function validateTrigger(raw: unknown): JobResult<JobTrigger> {
  if (raw === undefined) return { ok: true, value: { kind: "manual" } };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "trigger must be an object" };
  }
  const kind = (raw as { kind?: unknown }).kind;
  if (kind === "manual") return { ok: true, value: { kind: "manual" } };
  if (
    kind === "cron" ||
    kind === "webhook" ||
    kind === "event" ||
    kind === "workflow"
  ) {
    return {
      ok: false,
      error: `trigger '${kind}' is not available yet: a background fire has no acting user, and starting a workflow without one is refused -32106 (delegated execution is C3, unbuilt). Only 'manual' can actually run.`,
    };
  }
  return { ok: false, error: "trigger.kind must be 'manual'" };
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
 * non-manual trigger, and any input key outside the workflow's allowlist.
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
