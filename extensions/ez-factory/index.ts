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
} from "@ezcorp/sdk/runtime";
import type { HubPageTree, PageActionEvent, PageRenderContext } from "@ezcorp/sdk/runtime";

import { createAuditLog, auditableJobDiff, type AuditLog } from "./lib/audit";
import {
  createJobStore,
  validateJobDraft,
  type FactoryJob,
  type JobRunRecord,
  type JobStore,
} from "./lib/jobs";
import {
  buildFactoryPage,
  buildJobPage,
  draftFromFormPayload,
  FACTORY_PAGE_ID,
  JOB_PAGE_ID,
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
 * the process-wide `EZCORP_PROJECT_ROOT` names only ever ONE project and
 * is a last resort for out-of-band dispatches (a workflow tool step
 * carries a synthetic conversation with no project to resolve).
 *
 * This value is a CONVENIENCE, not a boundary. The host expands the
 * `filesystem: ["$CWD"]` grant through `grantCwdBase()` → `getProjectRoot()`
 * and authorizes against that, so a wrong value here produces a permission
 * denial, never an escape.
 */
export function activeProjectRoot(): string {
  return getToolContext()?.projectRoot ?? process.env.EZCORP_PROJECT_ROOT ?? process.cwd();
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
  const runs = view.kind === "runs" || view.kind === "jobs" ? await recentRuns(jobs) : [];
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

/** Register both Hub pages. Split out of {@link start} so a test can mount
 *  them against the SDK test channel without opening stdin. */
export function registerPages(): void {
  definePage({
    id: FACTORY_PAGE_ID,
    render: renderFactoryPage,
    actions: { [JOB_SAVE_EVENT]: handleJobSave },
  });
  definePage({
    id: JOB_PAGE_ID,
    render: renderJobPage,
    actions: { [JOB_SAVE_EVENT]: handleJobSave },
  });
}

/**
 * Production boot. Exported rather than inlined under `import.meta.main`
 * so `boot.test.ts` can drive it IN-process against the SDK test channel —
 * a spawned subprocess's coverage never reaches this process's lcov. Same
 * shape as `extensions/memory-extractor/index.ts`.
 */
export function start(): void {
  createToolDispatcher(createFactoryToolHandlers(deps));
  registerPages();
  getChannel().start();
}

/** @internal — test-only: drop the lazily-created singletons so each test
 *  gets a store bound to its own stubbed channel. */
export function __resetStateForTests(): void {
  store = null;
  audit = null;
}

// Gated on `import.meta.main` so test imports do not open stdin.
if (import.meta.main) start();
