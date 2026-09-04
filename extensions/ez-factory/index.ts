#!/usr/bin/env bun
/**
 * ez-factory — the sandboxed subprocess entrypoint.
 *
 * Two bindings, and nothing with a decision in it:
 *
 *   1. The host's reverse-RPC filesystem surface → the three pure tool
 *      factories under `lib/tools/` (8.4).
 *   2. The two Hub pages → the pure tree builders in `lib/page.ts` and the
 *      job store in `lib/jobs.ts` (8.6).
 *
 * Everything here is glue: fetch state, hand it to a pure builder, hand the
 * result back. The rules live in `lib/`, where they are covered.
 *
 * ── Why every fs call is a host round trip ─────────────────────────────
 *
 * `src/extensions/runtime/sandbox-preload.ts` poisons `node:fs`,
 * `fs/promises`, `Bun.file`, `Bun.write` and `Bun.glob` at load. That is
 * not advice: the host realpaths each path BEFORE the PDP authorizes it,
 * which is what closes the TOCTOU window a subprocess-side `Bun.file()`
 * would reopen. `tools.grep.test.ts` asserts mechanically that no file
 * under `extensions/ez-factory/**` reaches for any of them.
 *
 * `Bun.Glob` is the one Bun API the tools do use, and it is untouched by
 * the preload for a good reason: `new Bun.Glob(p).match(s)` is pure string
 * matching over a path the host already handed us. It is `Bun.glob`,
 * the lowercase directory-SCANNING helper, that is poisoned.
 */
import {
  createToolDispatcher,
  definePage,
  fsExists,
  fsList,
  fsMkdir,
  fsRead,
  fsStat,
  fsWrite,
  getChannel,
  getToolContext,
  invalidatePage,
  Triggers,
  Workflows,
} from "@ezcorp/sdk/runtime";
import type {
  HubPageTree,
  PageActionEvent,
  PageRenderContext,
  TriggerFireContext,
} from "@ezcorp/sdk/runtime";

import { createAuditLog, auditableJobDiff, type AuditLog } from "./lib/audit";
import {
  createJobStore,
  isBackgroundTrigger,
  latestRunPerJob,
  runRecordsFromHostRuns,
  validateJobDraft,
  type FactoryJob,
  type HostWorkflowRun,
  type JobRunRecord,
  type JobStore,
  type JobTrigger,
} from "./lib/jobs";
import {
  describeFireRefusal,
  fireRefusalReason,
  jobIdFromTriggerKey,
  LOCAL_REFUSAL,
  triggerKeyForJob,
  triggerPlan,
  type JobFireOutcome,
  type TriggerRegistration,
} from "./lib/triggers";
import {
  buildFactoryPage,
  buildJobPage,
  candidateDraft,
  draftFromFormPayload,
  FACTORY_PAGE_ID,
  jobIdFromActionPayload,
  JOB_PAGE_ID,
  JOB_RUN_EVENT,
  JOB_SAVE_EVENT,
  parseFactoryView,
  parseJobView,
} from "./lib/page";
import { createFactoryToolHandlers } from "./lib/tools";
import type { FactoryFs, ToolDeps } from "./lib/tools/shared";

/**
 * The host-mediated filesystem, adapted to the narrow surface the tools
 * declare. Thin on purpose — anything with a decision in it belongs in
 * `lib/`, where it is covered.
 */
export const hostFs: FactoryFs = {
  list: (path) => fsList(path),
  stat: async (path) => ({ size: (await fsStat(path)).size }),
  read: async (path) => {
    const body = await fsRead(path, { encoding: "utf-8" });
    // `fsRead` is typed `string | Uint8Array` because the same RPC serves
    // binary reads. utf-8 always decodes host-side, but the type is the
    // contract, so decode rather than cast.
    return typeof body === "string" ? body : new TextDecoder().decode(body);
  },
  write: async (path, content) => ({ bytes: (await fsWrite(path, content)).bytes }),
  mkdir: async (path) => {
    await fsMkdir(path, { recursive: true });
  },
  exists: (path) => fsExists(path),
};

/**
 * Filesystem root of the ACTIVE project.
 *
 * Per-call first: one persistent subprocess serves every conversation, so
 * a process-wide env var names only ever ONE project and is a fallback for
 * out-of-band dispatches (a workflow tool step carries a synthetic
 * conversation with no project to resolve).
 *
 * ── WHY `EZCORP_EXTENSION_DATA_ROOT` AND NOT `process.cwd()` ──────────
 *
 * The old chain ended at `process.cwd()`, and on the only path that ever
 * reaches the end of it — every workflow tool step — that is the WRONG
 * TREE. `src/extensions/registry.ts` says so in as many words: `cwd` is
 * `/app/web` under the vite-SSR dev server, and `getProjectRoot()`
 * "resolves the container root (`/app`) in dev and prod alike".
 *
 * The failure is silent and total rather than loud, which is why it
 * survived to here:
 *
 *   · `EZCORP_PROJECT_ROOT` is only injected when `findProjectRoot()`
 *     resolves; `registry.ts` swallows the throw and leaves it unset,
 *     which ALSO leaves `getSpawnCwd()` undefined, so the subprocess
 *     inherits the host's `web/` cwd. Both fallbacks miss together.
 *   · `web/` is INSIDE the project root, so the `$CWD` grant authorizes
 *     every read and write against it. Nothing is denied. `read_files`
 *     walks `web/`, reports `CLAUDE.md` for `web/CLAUDE.md`, and returns
 *     `files: []` for a glob naming a real file — with `skippedCount: 0`,
 *     so `etl-factory`'s `anomaly-gate` does not fire either.
 *
 * `EZCORP_EXTENSION_DATA_ROOT` is the host's own answer to this question:
 * `registry.ts` sets it to `getProjectRoot()` unconditionally, and that is
 * the SAME function `grantCwdBase()` (`src/extensions/permissions.ts`)
 * expands `$CWD` through. Preferring it makes the tool's notion of "the
 * project" agree with the grant it was issued, instead of disagreeing with
 * it in a direction nothing reports.
 *
 * This value is a CONVENIENCE, not a boundary — a wrong value produces a
 * permission denial, never an escape. That is exactly why it needed a real
 * run to catch: wrong-but-authorized reads the wrong files in silence.
 */
export function activeProjectRoot(): string {
  return (
    getToolContext()?.projectRoot ??
    process.env.EZCORP_PROJECT_ROOT ??
    process.env.EZCORP_EXTENSION_DATA_ROOT ??
    process.cwd()
  );
}

/**
 * The host's conversation coordinate for the running call, forwarded on
 * `_meta.ezConversationId`. Inside a workflow this is the synthetic
 * `workflow-run:<uuid>` scope key, which is how `emit_artifact` learns
 * its run id without an argument no template could supply.
 */
export function activeConversationId(): string | undefined {
  return getToolContext()?.conversationId;
}

export const deps: ToolDeps = {
  fs: hostFs,
  projectRoot: activeProjectRoot,
  conversationId: activeConversationId,
};

// ── Hub pages (8.6) ────────────────────────────────────────────────
//
// The store and the audit log are per-process singletons, created lazily so
// importing this module (as `boot.test.ts` does) opens no channel traffic.

let store: JobStore | null = null;
let audit: AuditLog | null = null;
let workflows: Workflows | null = null;
let triggers: Triggers | null = null;

/** The job store, created on first use. */
export function jobStore(): JobStore {
  if (store === null) store = createJobStore();
  return store;
}

/** The audit trail, created on first use. */
export function auditLog(): AuditLog {
  if (audit === null) audit = createAuditLog();
  return audit;
}

/** The host's workflow client, created on first use. Constructing it opens
 *  no channel traffic — every method is a request at call time. */
export function workflowClient(): Workflows {
  if (workflows === null) workflows = new Workflows();
  return workflows;
}

/** The host's dynamic-trigger client, created on first use. Only its
 *  `register` / `unregister` verbs are used — see
 *  {@link installTriggerReceivers} for why the fire side is wired
 *  straight onto the channel instead of through `Triggers.on`. */
export function triggerClient(): Triggers {
  if (triggers === null) triggers = new Triggers();
  return triggers;
}

/**
 * The most recent runs across every job, newest first.
 *
 * Assembled here rather than in the store because it is a VIEW concern: the
 * store owns per-job run indexes (bounded, newest-first), and the console
 * wants them interleaved. Bounded twice over — `listRuns` caps per job and
 * this caps the merge — so a hundred jobs cannot produce a tree the host's
 * 500-node / 64 KB validator would reject wholesale.
 */
export const RECENT_RUNS_LIMIT = 50;

export async function recentRuns(
  jobs: readonly FactoryJob[],
  limit = RECENT_RUNS_LIMIT,
): Promise<JobRunRecord[]> {
  const perJob = await Promise.all(jobs.map((job) => jobStore().listRuns(job.id)));
  return perJob
    .flat()
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
    .slice(0, limit);
}

/**
 * How many of the host's runs one reconcile pass reads. The host caps
 * `op: "runs"` at 50 and rejects anything above it, so this IS the ceiling.
 */
export const RECONCILE_PAGE = 50;

/**
 * Pull the host's run history and fold it into the local index.
 *
 * ## Why a poll and not a subscription
 *
 * The `workflow:*` bus events can NEVER reach an extension:
 * `EventSubscriptionDispatcher.dispatch` drops any payload without a
 * top-level string `conversationId` and `WorkflowRun` has none. All four
 * names ARE direct-carrier types, so a subscription is ACCEPTED at
 * registration and then never fires — registered, silent, forever. And
 * `ctx.workflows.run()` returns no run id, because the host would have to
 * await the entire graph to learn it. So a read is the only correlation
 * path that exists, which is exactly what `op: "runs"` is for.
 *
 * ## Why it runs on RENDER
 *
 * A run outlives the click that started it by minutes: the row does not
 * even exist yet when the trigger RPC returns, and its status keeps moving
 * long after. Reconciling only at fire time would record every run as
 * `running`, forever. Reconciling when somebody LOOKS is what makes the
 * Recent-runs tab show the truth — and it costs one keyset query behind
 * the Hub's own page cache.
 *
 * ## What it is allowed to write
 *
 * Only runs the host attributes to a job THIS console knows, by the
 * `jobRef` handle the console itself supplied — see
 * {@link runRecordsFromHostRuns}. A run started from the REST route or the
 * CLI carries no handle and is skipped.
 *
 * The host scopes `runs()` to the ACTING USER, while the store and the
 * rendered tree are install-wide (invariant K). So the index accumulates
 * the union of what each viewer can see, which is the same reading the
 * Recent-runs tab already publishes ("runs started from a job on this
 * install") and the same one `lastRunAt` has always had. Nothing a run
 * PRODUCED is copied — only its id, status and timestamps, exactly as
 * invariant K requires; the trace behind the deep link enforces its own
 * authorization.
 *
 * NEVER THROWS. A render must degrade to the last known state rather than
 * failing the whole page: a rate-limited or refused read leaves the tab
 * showing what it had, not "This page failed to render".
 */
export async function reconcileRuns(
  jobs: readonly FactoryJob[],
): Promise<JobRunRecord[]> {
  if (jobs.length === 0) return [];
  let hostRuns: HostWorkflowRun[];
  try {
    const page = await workflowClient().runs({ limit: RECONCILE_PAGE });
    // The response is a WIRE value, not a typed object we constructed. A
    // host that answered without `runs` — an older build, a transport that
    // dropped the body — must degrade to "no runs this pass", not throw
    // out of a page render and turn the whole console into "This page
    // failed to render".
    hostRuns = Array.isArray(page?.runs) ? (page.runs as HostWorkflowRun[]) : [];
  } catch (err) {
    await auditLog().append({
      actor: "system",
      kind: "runs-read-failed",
      detail: { reason: err instanceof Error ? err.message : String(err) },
    });
    return [];
  }

  const known = new Set(jobs.map((job) => job.id));
  const records = runRecordsFromHostRuns(hostRuns, known);
  for (const record of records) await jobStore().recordRun(record);
  // `lastRunAt` / `lastWorkflowRunId` are the JOB's own bookkeeping, and
  // this is the only place that can know them: the fire path does not, and
  // a run's start time is the host's, not the click's.
  for (const [jobId, latest] of latestRunPerJob(records)) {
    await jobStore().touchJob(jobId, {
      lastRunAt: latest.startedAt,
      lastWorkflowRunId: latest.workflowRunId,
    });
  }
  return records;
}

/** The project a render is scoped to, when there is exactly one. The global
 *  hub passes the whole project LIST, which addresses nothing — a page-level
 *  href needs one project or none. */
function renderProjectId(ctx?: PageRenderContext): string | undefined {
  return ctx?.project?.id;
}

/** Render the `factory` console. */
export async function renderFactoryPage(ctx?: PageRenderContext): Promise<HubPageTree> {
  const jobs = await jobStore().listJobs();
  const view = parseFactoryView(ctx?.view);
  // The jobs and runs surfaces both need the run index — the jobs table
  // shows each job's latest run STATUS, not just the `lastRunAt` timestamp
  // its own record carries. The templates and unknown views are static, so
  // they skip the per-job reads entirely.
  const wantsRuns = view.kind === "runs" || view.kind === "jobs";
  // Reconcile BEFORE reading the index, so the tree this render returns
  // already reflects the host — otherwise the first look after a fire
  // shows nothing and the second shows the run, which reads as a bug.
  if (wantsRuns) await reconcileRuns(jobs);
  const runs = wantsRuns ? await recentRuns(jobs) : [];
  return buildFactoryPage({ view, jobs, runs, projectId: renderProjectId(ctx) });
}

/** Render the `job` editor. */
export async function renderJobPage(ctx?: PageRenderContext): Promise<HubPageTree> {
  const view = parseJobView(ctx?.view);
  const job = view.kind === "edit" ? await jobStore().getJob(view.jobId) : null;
  return buildJobPage({ view, job, projectId: renderProjectId(ctx) });
}

/**
 * The save action: create or replace a job, from EITHER of the job page's
 * two forms.
 *
 * Order matters and is the whole security story of this handler:
 *
 *   1. Fold the wire payload into a candidate draft (pure, no rules).
 *   2. **Complete it against the stored job** — `candidateDraft`. The job
 *      editor and the schedule editor are two forms because the host caps
 *      a form at 10 fields, so each submits half a job. Whichever half
 *      arrived, the other half is taken from the row on disk, and what
 *      goes into the validator is always a WHOLE job.
 *
 *      This step is why editing a cron job's name does not silently
 *      un-schedule it: without it the editor's draft would carry no
 *      `trigger`, `validateJobDraft` would apply its `undefined → manual`
 *      default, and the schedule would vanish with nothing failing.
 *   3. Run it through `validateJobDraft` — the ONE door to a writable job.
 *      A create, a job edit and a schedule edit take the same door; there
 *      is still no patch path, because what passes through is a complete
 *      draft and what comes out is branded.
 *   4. Write through the store, which locks the key.
 *   5. Audit with the CHANGED FIELD NAMES only (invariant I) — never the
 *      values, because a job input can be a whole document.
 *
 * A rejected draft is audited too, by reason, and then dropped. The Hub gives
 * a page action no error channel, so the alternative to recording it is that
 * a refused save leaves no trace anywhere.
 */
export async function handleJobSave(event: PageActionEvent): Promise<void> {
  const actor = event.userId;
  const now = new Date().toISOString();
  const submission = draftFromFormPayload(event.payload);
  const { jobId } = submission;

  // One read, reused for the completion above and the audit diff below. On
  // a create there is nothing to read and `candidateDraft` passes the
  // submission through unchanged.
  const before = jobId === null ? null : await jobStore().getJob(jobId);
  const draft = candidateDraft(submission, before);

  const validated = validateJobDraft(draft);
  if (!validated.ok) {
    await auditLog().append({
      at: now,
      actor,
      kind: "job-rejected",
      ...(jobId !== null ? { jobId } : {}),
      // The validator's message names the offending FIELD, never its value.
      detail: { reason: validated.error },
    });
    return;
  }

  // The written row, and the trigger it USED to have. Both feed the
  // registration step below, which is the one place in this extension with
  // an acting user AND a decision about the host's trigger rows.
  let written: FactoryJob | null = null;
  if (jobId === null) {
    const id = crypto.randomUUID();
    const created = await jobStore().createJob(validated.value, { id, actor, now });
    if (created.ok) written = created.value;
    await auditLog().append({
      at: now,
      actor,
      kind: created.ok ? "job-create" : "job-rejected",
      jobId: id,
      ...(created.ok ? {} : { detail: { reason: created.error } }),
    });
  } else {
    const after = await jobStore().saveJob(jobId, validated.value, { actor, now });
    written = after;
    await auditLog().append({
      at: now,
      actor,
      kind: after === null ? "job-missing" : "job-save",
      jobId,
      // A first-write-wins race could hand us a `before` of null; an empty
      // change list is then honest rather than invented.
      ...(before !== null && after !== null
        ? { detail: { changed: auditableJobDiff(before, after) } }
        : {}),
    });
  }

  // ── THE REGISTRATION, and this is the ONLY place it can happen ─────
  //
  // A Hub page action carries the clicking user, so `ctx.triggers` resolves
  // an owner and the host can write the `sdk_capability_calls` row its NOT
  // NULL `on_behalf_of` demands. Doing it from inside a fire instead would
  // soft-fail `-32106` every time — see `lib/triggers.ts`'s header.
  //
  // AFTER the write, never before: the row on disk is what a fire will
  // read, so arming a schedule against a save that did not land would point
  // a live cron at a job that does not exist.
  if (written !== null) {
    await syncJobTrigger(written, before?.trigger ?? null, actor, now);
  }

  // Both pages read the job list, so both are stale. `invalidatePage` rather
  // than `pushPage`: these are `perProject` pages, so one pushed tree could
  // not cover the global and per-project variants, and this render cannot
  // know which of them is on screen.
  invalidatePage(FACTORY_PAGE_ID);
  invalidatePage(JOB_PAGE_ID);
}

/**
 * Bring the host's dynamic-trigger rows in line with a job that was just
 * saved.
 *
 * ## What it does, in one sentence
 *
 * Registers the row the job wants (idempotent host-side — same key, same
 * slug, same secret, so saving twice is the normal case) and retires the
 * row it no longer wants, if any. {@link triggerPlan} decides both; this
 * function only spends the RPCs and writes the trail.
 *
 * ## It NEVER fails the save
 *
 * The job is already on disk when this runs. A refused registration means
 * the schedule is not armed — a real and reportable problem — but the
 * operator's edit landed, and throwing here would leave them with a save
 * that appears to have failed and a row that was written anyway. Every
 * outcome is audited by REASON instead, which is the same bargain
 * {@link handleJobRun} makes for the same reason: a Hub page action has no
 * error channel back to the clicker.
 *
 * ## `TRIGGER_NOT_FOUND` on an unregister is a NO-OP, deliberately
 *
 * The host answers `-32602` for a key it does not hold. That happens
 * whenever a previous registration failed, or the row was swept, or the
 * job's kind was changed twice in a row. Treating it as a failure would
 * make such a job permanently un-editable: every later save would try to
 * retire a row that never existed and report itself broken over it.
 */
export async function syncJobTrigger(
  job: FactoryJob,
  before: JobTrigger | null,
  actor: string,
  now: string,
): Promise<void> {
  const plan = triggerPlan(job, before);

  for (const kind of plan.unregister) {
    const key = triggerKeyForJob(job.id);
    if (key === null) continue;
    try {
      await triggerClient().unregister(kind, key);
      await auditLog().append({
        at: now, actor, kind: "trigger-unregistered", jobId: job.id,
        detail: { triggerKind: kind },
      });
    } catch (err) {
      const reason = fireRefusalReason(err);
      await auditLog().append({
        at: now,
        actor,
        // A row the host never held is not a failure to report as one.
        kind: reason === "TRIGGER_NOT_FOUND" ? "trigger-already-gone" : "trigger-unregister-failed",
        jobId: job.id,
        detail: { triggerKind: kind, reason },
      });
    }
  }

  if (plan.register === null) {
    // Nothing to arm. Said out loud so "manual" and "the registration was
    // refused" are different lines in the trail rather than the same
    // silence.
    if (before !== null && isBackgroundTrigger(before)) {
      await auditLog().append({
        at: now, actor, kind: "trigger-disarmed", jobId: job.id,
        detail: { triggerKind: job.trigger.kind, enabled: job.enabled },
      });
    }
    return;
  }

  await registerJobTrigger(plan.register, job, actor, now);
}

/** The register half of {@link syncJobTrigger}. Split out so the two RPC
 *  shapes (`cron` carries an expression and a zone; `webhook` carries
 *  nothing, because the host mints the slug and the secret) stay one
 *  narrow call site rather than a branch inside a loop. */
async function registerJobTrigger(
  registration: TriggerRegistration,
  job: FactoryJob,
  actor: string,
  now: string,
): Promise<void> {
  try {
    await triggerClient().register(
      registration.kind === "cron"
        ? {
            kind: "cron",
            key: registration.key,
            cron: registration.cron,
            timezone: registration.timezone,
          }
        : { kind: "webhook", key: registration.key },
    );
    await auditLog().append({
      at: now, actor, kind: "trigger-registered", jobId: job.id,
      // The KIND only. A cron expression is operator-typed text and the
      // host already records it on its own row; repeating it in a 30-day
      // bucket buys nothing and widens invariant I's surface.
      detail: { triggerKind: registration.kind },
    });
  } catch (err) {
    const reason = fireRefusalReason(err);
    await auditLog().append({
      at: now, actor, kind: "trigger-register-failed", jobId: job.id,
      detail: { triggerKind: registration.kind, reason },
    });
    // The job is saved and NOT armed. Record it where the console reads it,
    // so the row does not sit there looking scheduled.
    await jobStore().noteFire(job.id, {
      at: now,
      ok: false,
      reason,
      kind: "install",
      remedy:
        "This job's schedule could not be registered with the host, so nothing will fire. The trail carries the host's reason; fixing it and saving again re-arms it.",
    });
  }
}

/**
 * THE UNATTENDED FIRE. A cron tick or an inbound webhook, driven all the
 * way to a started workflow run.
 *
 * ## Why this is `runFor` and not `run`
 *
 * There is no acting user here — `ScheduleDaemon.dispatchFire` stamps
 * `ownerless: true` on the call token — so `ctx.workflows.run()` is refused
 * twice over: at rung 0 by `resolveReverseRpcMeta` and again at rung 7 with
 * `WORKFLOWS_NO_OWNER`. Both refusals are correct and neither is touched.
 * `runFor(jobRef)` goes out on the distinct `ezcorp/workflows-delegated`
 * method, whose ownerless-TOLERANT resolver exists so the question can be
 * re-asked at D7 against a `workflow_delegations` row a human wrote.
 *
 * The owner, the workflow name and the project all come off that row. This
 * handler supplies a job ref and an input and decides nothing else.
 *
 * ## The four local rungs, and why each survives the host having its own
 *
 *   1. **The key resolves to a job id.** `jobIdFromTriggerKey` is the one
 *      reader, and it validates with the store's own `isValidJobId` before
 *      the id can be spliced into a storage key.
 *   2. **The job exists and is ENABLED.** `enabled: false` is this
 *      console's retire. A save unregisters the row, but an unregister can
 *      fail and a host row can outlive the job that made it, so the fire
 *      asks again. This is the rung that makes retiring mean something even
 *      when the cleanup did not land.
 *   3. **The job still has a BACKGROUND trigger of the kind that fired.** A
 *      leftover cron row pointing at a job somebody switched to `manual`
 *      must not run it unattended: the delegation a human consented to
 *      named a trigger, and honouring a different one would be running
 *      under an authority nobody gave.
 *   4. **The stored job re-passes `validateJobDraft`.** Invariant B's
 *      allowlist, re-asserted at the point of spend — the same rung
 *      `handleJobRun` runs, for the same reason, and it matters more here
 *      because there is nobody watching.
 *
 * ## The webhook payload is NOT forwarded, and that is a security decision
 *
 * `fire.payload` is whatever the caller of a public `POST /api/hooks/...`
 * sent. The delegation's `consent_hash` covers the workflow and the
 * capability closure, NOT the input — so forwarding the body would let
 * anyone holding the hook token steer `$input.globs` / `$input.outPath` on
 * a run executing as the human who consented. The run's input is the
 * SAVED job's input, which is exactly what the operator authorized and what
 * `JOB_SETTABLE_INPUT_KEYS` bounds. A webhook here is a doorbell, not a
 * parameter channel.
 *
 * ## NEVER THROWS
 *
 * A notification handler's throw is swallowed by the channel
 * (`handleIncoming` catches and drops), so throwing would convert every
 * failure into silence. Each branch writes a typed reason to both the audit
 * trail and the job's own `lastFire`, which is what makes a stopped job
 * legible at all — see {@link FactoryJob.lastFire}.
 */
export async function handleTriggerFire(fire: TriggerFireContext): Promise<void> {
  const now = new Date().toISOString();
  const jobId = jobIdFromTriggerKey(fire.key);

  /** Record a refusal in both destinations. `jobId` may be null — a fire
   *  for a key this console cannot parse still belongs in the trail. */
  const refuse = async (reason: string): Promise<void> => {
    const refusal = describeFireRefusal(reason);
    await auditLog().append({
      at: now,
      actor: "system",
      kind: "job-fire-refused",
      ...(jobId !== null ? { jobId } : {}),
      detail: {
        reason: refusal.reason,
        refusalKind: refusal.kind,
        triggerKind: fire.kind,
        catchUp: fire.catchUp,
      },
    });
    if (jobId !== null) {
      await jobStore().noteFire(jobId, {
        at: now,
        ok: false,
        reason: refusal.reason,
        kind: refusal.kind,
        remedy: refusal.remedy,
      });
    }
    invalidatePage(FACTORY_PAGE_ID);
  };

  if (jobId === null) return refuse(LOCAL_REFUSAL.unknownKey);
  const job = await jobStore().getJob(jobId);
  if (job === null) return refuse(LOCAL_REFUSAL.jobMissing);
  if (!job.enabled) return refuse(LOCAL_REFUSAL.jobDisabled);
  if (!isBackgroundTrigger(job.trigger)) return refuse(LOCAL_REFUSAL.notBackground);
  if (job.trigger.kind !== fire.kind) return refuse(LOCAL_REFUSAL.kindMismatch);

  const revalidated = validateJobDraft({
    name: job.name,
    description: job.description,
    workflow: job.workflow,
    input: job.input,
    trigger: job.trigger,
    enabled: job.enabled,
  });
  if (!revalidated.ok) return refuse(LOCAL_REFUSAL.invalidJob);

  let outcome: JobFireOutcome;
  try {
    const accepted = await workflowClient().runFor({
      // The delegation row is keyed `(extension_id, job_ref)`, and this is
      // the SAME handle `handleJobRun` passes as `run()`'s inert
      // correlation id. On THIS verb it selects the authority instead —
      // the one difference between the two `jobRef`s, and the reason the
      // console must use one id for both or a hand-fired run and a
      // scheduled one would correlate to different things.
      jobRef: job.id,
      input: revalidated.value.input,
    });
    outcome = { at: now, ok: true };
    await auditLog().append({
      at: now,
      actor: "system",
      kind: "job-fire",
      jobId: job.id,
      // Closed-set data only: the workflow name is one of three authored
      // constants, `runAs` is one of two, and both come from the host.
      detail: {
        workflow: accepted.workflow,
        runAs: accepted.runAs,
        triggerKind: fire.kind,
        catchUp: fire.catchUp,
      },
    });
  } catch (err) {
    const refusal = describeFireRefusal(fireRefusalReason(err));
    outcome = {
      at: now,
      ok: false,
      reason: refusal.reason,
      kind: refusal.kind,
      remedy: refusal.remedy,
    };
    await auditLog().append({
      at: now,
      actor: "system",
      kind: "job-fire-refused",
      jobId: job.id,
      detail: {
        reason: refusal.reason,
        refusalKind: refusal.kind,
        triggerKind: fire.kind,
        catchUp: fire.catchUp,
      },
    });
  }

  await jobStore().noteFire(job.id, outcome);
  // `lastRunAt` is deliberately NOT written here, for the same reason
  // `handleJobRun` does not write it: the run has no row yet, and the only
  // honest start time is the host's.
  invalidatePage(FACTORY_PAGE_ID);
  invalidatePage(JOB_PAGE_ID);
}

/**
 * The live trigger keys this console still claims, for the host's orphan
 * sweep.
 *
 * The full path, now that it exists end to end: `HostMaintenanceDaemon`'s
 * hourly tick → `sweepAllDynamicTriggers` → `syncDynamicTriggers`
 * (`src/extensions/triggers-sweep.ts`) → `ezcorp/triggers-sync` → the
 * receiver in {@link installTriggerReceivers} → this function. (Through
 * most of phase 8 the first three hops did not exist and this doc named a
 * caller that was never wired; the sweep asked nobody and no orphan was
 * ever retired.)
 *
 * That frame arrives carrying a host-issued `_meta.ezCallId`, which is the
 * only reason the store read below can succeed at all — see
 * {@link installTriggerReceivers} on why boot cannot do this.
 *
 * Derived from the JOB STORE, which is the only honest source: a key whose
 * job is gone, disabled, or no longer background is a row that would fire
 * into {@link handleTriggerFire}'s refusals forever.
 *
 * The sweep is FAIL-OPEN by design — a malformed or missing answer disables
 * nothing — so a store read that throws must produce a THROW here rather
 * than an empty list. An empty list is a positive claim ("I hold no keys")
 * and would wipe every user's schedule; letting the error out is what makes
 * the host take the fail-open branch instead.
 */
export async function liveTriggerKeys(): Promise<string[]> {
  const jobs = await jobStore().listJobs();
  const keys: string[] = [];
  for (const job of jobs) {
    if (!job.enabled || !isBackgroundTrigger(job.trigger)) continue;
    const key = triggerKeyForJob(job.id);
    if (key !== null) keys.push(key);
  }
  return keys;
}

/**
 * Wire the two host→subprocess trigger frames.
 *
 * ## Why this is `getChannel().onRequest` and NOT `Triggers.on(key, …)`
 *
 * The SDK's `Triggers.on` is a key→handler map: a fire whose key is not in
 * the map is dropped silently, so an extension must wire every key it holds
 * BEFORE the first fire can arrive. That is impossible here, and not by a
 * little.
 *
 * This console's keys live in host-mediated storage, and storage is
 * unreachable at boot: `ezcorp/storage` resolves provenance from the
 * host-issued `_meta.ezCallId`, the SDK attaches that token from
 * `getToolContext()?.callId`, and that context is bound by
 * `withToolContext` around an INBOUND frame. `start()` runs inside no such
 * frame, so a boot-time `listJobs()` is refused `-32602` (provenance
 * unresolved) — as is `ctx.triggers.list()`, which is owner-scoped on top
 * of that. There is no `lifecycle/extension:start` hook to hang it on
 * either: `ALLOWED_LIFECYCLE_HOOKS` is the four agent/run events.
 *
 * A fire, by contrast, DOES carry a token. So resolving the job when the
 * fire arrives is not a shortcut — it is the only ordering in which the
 * lookup can succeed at all. Receiving on the method directly is the same
 * machinery the SDK sugar uses (`installReceiver` registers these exact two
 * names); nothing parallel is introduced, and no second scheduler exists.
 *
 * It also makes the sweep's answer HONEST rather than incidental: the SDK
 * would answer with whatever keys happened to be wired, which after a
 * restart is none.
 *
 * ## The registration RPCs still go through the SDK client
 *
 * `ctx.triggers.register` / `.unregister` are used unchanged from the save
 * path, where an owner exists. Only the fire side is wired here.
 */
export function installTriggerReceivers(): void {
  const channel = getChannel();
  channel.onRequest("ezcorp/trigger-fire", async (params: unknown) => {
    await handleTriggerFire(params as TriggerFireContext);
    return undefined;
  });
  channel.onRequest("ezcorp/triggers-sync", async () => ({
    v: 1,
    keys: await liveTriggerKeys(),
  }));
}

/**
 * Fire a saved job.
 *
 * This is the action the console was missing: everything else here could
 * describe work, and nothing could start it.
 *
 * ## The ladder, in order, and why each rung is here
 *
 *   1. **The job id comes off the ACTION payload**, through the same
 *      `jobIdFromActionPayload` the save path uses — never off a form
 *      field an operator can retype, and never through a second reader
 *      that could guess a different key. An id that fails `isValidJobId`
 *      is refused before it can be spliced into a storage key.
 *   2. **The job must exist**, and it is re-read from the store rather
 *      than reconstructed from the wire. Nothing about WHAT runs comes
 *      from the click.
 *   3. **A disabled job does not fire.** `enabled: false` is this
 *      console's retire (there is no delete), so honouring it here is what
 *      makes retiring mean anything. The button is also hidden, but the
 *      button is UI and this is the check.
 *   4. **The stored job is re-validated before it fires.** The store
 *      accepts only a branded `ValidatedJobDraft`, so a row got in
 *      through the allowlist once — but the allowlist is a SECURITY
 *      control (a job may not set an input key that a template's `gate`
 *      or `approval` step reads in a `when`), and this is the moment it
 *      pays off. A row written before the allowlist NARROWED, or one that
 *      arrived by any route this code has not thought of, is refused at
 *      the point of spend rather than trusted for being on disk. Cheap,
 *      fail-closed, and it means the door cannot be walked around by
 *      writing storage.
 *   5. **The host decides everything else.** `ctx.workflows.run()` runs
 *      the full 13-rung ladder — kill switch, grant, manifest allowlist,
 *      grant allowlist, PDP, ownerless bound, wiring, rate limit, payload,
 *      hourly quota, name resolution, and core's shared `canRunWorkflow`
 *      — attributed to the CLICKING user through the host-issued
 *      provenance token minted for this fire. This handler grants nothing
 *      and asserts nothing about who may run what.
 *
 * `jobRef: job.id` is what makes the run findable again — see
 * {@link reconcileRuns}.
 *
 * ## Every outcome is audited, including the refusals
 *
 * A Hub page action has NO error channel back to the clicker: the route
 * answers `{ok:true}` the moment the notification is sent. So a refusal
 * that is not written down is a refusal nobody can ever learn about. Each
 * branch below records a REASON and no values, per invariant I.
 */
export async function handleJobRun(event: PageActionEvent): Promise<void> {
  const actor = event.userId;
  const now = new Date().toISOString();
  const jobId = jobIdFromActionPayload(event.payload);

  const reject = async (reason: string): Promise<void> => {
    await auditLog().append({
      at: now,
      actor,
      kind: "job-run-rejected",
      ...(jobId !== null ? { jobId } : {}),
      detail: { reason },
    });
  };

  if (jobId === null) return reject("no valid job id on the action payload");
  const job = await jobStore().getJob(jobId);
  if (job === null) return reject("job not found");
  if (!job.enabled) return reject("job is disabled");

  // Rung 4 — the allowlist, re-asserted at the point of spend.
  const revalidated = validateJobDraft({
    name: job.name,
    description: job.description,
    workflow: job.workflow,
    input: job.input,
    trigger: job.trigger,
    enabled: job.enabled,
  });
  if (!revalidated.ok) return reject(`stored job no longer valid: ${revalidated.error}`);

  try {
    await workflowClient().run(revalidated.value.workflow, revalidated.value.input, {
      // The correlation handle. `run()` returns no run id, so this is the
      // ONLY thing that will later tie a `workflow_runs` row back to this
      // job. `JOB_ID_RE` is a strict subset of the host's `jobRef` charset,
      // so a validated job id can never be the reason a fire is refused.
      jobRef: job.id,
    });
  } catch (err) {
    // The host's typed refusal — quota exhausted, ungranted name, no
    // acting user. Recorded by REASON so an operator can tell "the host
    // said no" from "nothing happened".
    return reject(`host refused the trigger: ${err instanceof Error ? err.message : String(err)}`);
  }

  await auditLog().append({
    at: now,
    actor,
    kind: "job-run",
    jobId: job.id,
    // The workflow NAME is authored, closed-set data (one of three
    // constants), never operator content — so it is safe in the trail
    // where an input value would not be.
    detail: { workflow: job.workflow },
  });

  // `lastRunAt` is deliberately NOT written here. The run has no row yet —
  // the trigger RPC returns before `insertWorkflowRun` — so the only
  // honest start time is the host's, and `reconcileRuns` writes it when
  // the row exists. Stamping the click time would put a timestamp on the
  // job that no run ever had.
  invalidatePage(FACTORY_PAGE_ID);
  invalidatePage(JOB_PAGE_ID);
}

/** Register both Hub pages. Split out of {@link start} so a test can mount
 *  them against the SDK test channel without opening stdin.
 *
 *  BOTH actions mount on BOTH pages: the Hub POSTs an action with the
 *  `pageId` it was rendered on, and the route requires that page to be
 *  declared — so an action reachable from one page and handled only on the
 *  other is a silent no-op. */
export function registerPages(): void {
  const actions = {
    [JOB_SAVE_EVENT]: handleJobSave,
    [JOB_RUN_EVENT]: handleJobRun,
  };
  definePage({ id: FACTORY_PAGE_ID, render: renderFactoryPage, actions });
  definePage({ id: JOB_PAGE_ID, render: renderJobPage, actions: {} });
}

/**
 * Production boot. Exported rather than inlined under `import.meta.main`
 * so `boot.test.ts` can drive it IN-process against the SDK test channel —
 * a spawned subprocess's coverage never reaches this process's lcov. Same
 * shape as `extensions/memory-extractor/index.ts`.
 */
export function start(): void {
  // ── ORDER IS LOAD-BEARING: `getChannel()` FIRST ────────────────────
  //
  // `createToolDispatcher` does not own any wiring; it forwards the handler
  // map to a module-level `_register` hook in `rpc.ts` whose DEFAULT value
  // throws "channel not ready" (`packages/@ezcorp/sdk/src/runtime/rpc.ts`
  // `_defaultRegister`). The real hook is installed by
  // `ensureDispatcherRegistered()`, which `channel.ts` calls from
  // `getChannel()` and NOWHERE else — deliberately deferred so that merely
  // importing `@ezcorp/sdk/runtime` has no side effect on `rpc.ts`.
  //
  // So a `start()` whose FIRST SDK call is `createToolDispatcher` throws and
  // the subprocess exits 1 before it can serve anything — no tool call, no
  // Hub page render ("This page failed to render"), on every single boot.
  // The other bundled entrypoints survive the same textual order only by
  // accident: `memory-extractor` / `lessons-distiller` call
  // `defineMemoryLoops()` / `register()` first, and those touch
  // `getChannel()` on the way through.
  //
  // Materialising the channel is NOT the same as starting it:
  // `createProductionChannel()` only builds the impl, and the stdin read
  // loop opens at `.start()`. Taking the handle here and starting it LAST
  // therefore installs the hook before it is needed while still mounting
  // every handler and page before the first inbound frame can be read.
  //
  // `extensions/ez-factory/__tests__/boot-real-subprocess.test.ts` pins this
  // against a REAL `bun` subprocess. `boot.test.ts` cannot: it replaces both
  // `createToolDispatcher` and `getChannel` with inert spies, so the
  // ordering constraint does not exist inside it.
  const channel = getChannel();
  createToolDispatcher(createFactoryToolHandlers(deps));
  registerPages();
  // Before `start()`, like every other receiver: the read loop opens below,
  // and a fire that arrived before its handler was mounted would be dropped
  // silently by the channel (an unhandled notification has nowhere to go).
  installTriggerReceivers();
  channel.start();
}

/** @internal — test-only: drop the lazily-created singletons so each test
 *  gets a store bound to its own stubbed channel. */
export function __resetStateForTests(): void {
  store = null;
  audit = null;
  workflows = null;
  triggers = null;
}

// Gated on `import.meta.main` so test imports do not open stdin.
if (import.meta.main) start();
