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
  Workflows,
} from "@ezcorp/sdk/runtime";
import type { HubPageTree, PageActionEvent, PageRenderContext } from "@ezcorp/sdk/runtime";

import { createAuditLog, auditableJobDiff, type AuditLog } from "./lib/audit";
import {
  createJobStore,
  latestRunPerJob,
  runRecordsFromHostRuns,
  validateJobDraft,
  type FactoryJob,
  type HostWorkflowRun,
  type JobRunRecord,
  type JobStore,
} from "./lib/jobs";
import {
  buildFactoryPage,
  buildJobPage,
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
 * The one page action: create or replace a job.
 *
 * Order matters and is the whole security story of this handler:
 *
 *   1. Fold the wire payload into a candidate draft (pure, no rules).
 *   2. Run it through `validateJobDraft` — the ONE door to a writable job.
 *      A create and an edit take the same door; there is no patch path.
 *   3. Write through the store, which locks the key.
 *   4. Audit with the CHANGED FIELD NAMES only (invariant I) — never the
 *      values, because a job input can be a whole document.
 *
 * A rejected draft is audited too, by reason, and then dropped. The Hub gives
 * a page action no error channel, so the alternative to recording it is that
 * a refused save leaves no trace anywhere.
 */
export async function handleJobSave(event: PageActionEvent): Promise<void> {
  const actor = event.userId;
  const now = new Date().toISOString();
  const { jobId, draft } = draftFromFormPayload(event.payload);

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

  if (jobId === null) {
    const id = crypto.randomUUID();
    const created = await jobStore().createJob(validated.value, { id, actor, now });
    await auditLog().append({
      at: now,
      actor,
      kind: created.ok ? "job-create" : "job-rejected",
      jobId: id,
      ...(created.ok ? {} : { detail: { reason: created.error } }),
    });
  } else {
    const before = await jobStore().getJob(jobId);
    const after = await jobStore().saveJob(jobId, validated.value, { actor, now });
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

  // Both pages read the job list, so both are stale. `invalidatePage` rather
  // than `pushPage`: these are `perProject` pages, so one pushed tree could
  // not cover the global and per-project variants, and this render cannot
  // know which of them is on screen.
  invalidatePage(FACTORY_PAGE_ID);
  invalidatePage(JOB_PAGE_ID);
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
  definePage({ id: JOB_PAGE_ID, render: renderJobPage, actions });
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
  channel.start();
}

/** @internal — test-only: drop the lazily-created singletons so each test
 *  gets a store bound to its own stubbed channel. */
export function __resetStateForTests(): void {
  store = null;
  audit = null;
  workflows = null;
}

// Gated on `import.meta.main` so test imports do not open stdin.
if (import.meta.main) start();
