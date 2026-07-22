#!/usr/bin/env bun
// ── ez-code-factory — git "gate" as an EZCorp extension (M0) ──────────
//
// Wiring only — all logic lives in `lib/` (fully unit/integration tested):
//   - `init_gate` tool        → lib/gate.ts initGate (bare repo + hook + wiring)
//   - `push-received` action  → lib/runs.ts runGateLifecycle (run + worktree)
//   - `dashboard` page        → lib/page.ts buildDashboard (runs table)
//
// Like ez-code, this module loads inside the sandboxed subprocess (poisoned
// `node:fs`); every git/filesystem op is shell-driven via the injectable
// runner in lib/shell.ts, so no `node:fs` import ever enters the load graph.
// Logging is via `lib/log.ts`'s sandbox-safe `logLine` (Bun.stderr, NOT
// `process.stderr.write` — the latter lazily inits a `node:fs` WriteStream the
// sandbox poisons, which crashed the subprocess on start, bug B1). The host-only
// `extensionLogger` convention does not apply — decision #1 leaves M0 with no
// host-side code.

import {
  createToolDispatcher,
  definePage,
  getChannel,
  getToolContext,
  invalidatePage,
  invoke,
  Rbac,
  Schedule,
  Storage,
  toolError,
  toolResult,
  type HubPageTree,
  type PageActionEvent,
  type PageRenderContext,
  type ScheduleHandlerContext,
  type ToolHandler,
} from "@ezcorp/sdk/runtime";
import {
  GATE_REMOTE,
  PAGE_ID,
  TRIGGER_EVENT,
  EXTENSION_NAME,
  DEFAULT_BASE_URL,
  dataDir,
  gateDir as gateDirFor,
  repoId as repoIdFor,
  credentialPath as credentialPathFor,
  mintCredentialCommand,
  initGate,
} from "./lib/gate";
import {
  runChatTool,
  statusChatTool,
  respondChatTool,
  type ChatToolDeps,
  type ChatToolOutcome,
} from "./lib/chat-tools";
import { enforceRespondContract } from "./lib/chat-contract";
import { createIntentCache, makeConversationIntentInferrer } from "./lib/intent-infer";
import { join } from "node:path";
import {
  buildAuditView,
  buildConfigView,
  buildDashboard,
  buildHome,
  buildJobView,
  buildProjectDashboard,
  buildRunDetailView,
  buildStepDetailView,
  buildUnknownView,
  normalizeRespondPayload,
  orphanRuns,
  parseRunIdPayload,
  parseView,
  projectIdForRun,
  runsForProject,
  type RunDetail,
  type StepDetail,
} from "./lib/page";
import {
  createRunStore,
  parsePushReceived,
  parseRespondPayload,
  removeWorktree,
  runGateLifecycle,
  resumeGateLifecycle,
  type ParsedRespond,
  type RunRecord,
  type RunStore,
  type StepResultRecord,
} from "./lib/runs";
import { productionHostRunner, type ShellRunner } from "./lib/shell";
import { logLine } from "./lib/log";
import { PIPELINE_STEPS, resolvePipelineConfig, type PipelineConfig, type PipelineStep } from "./lib/config";
import { makeSpawnDispatcher } from "./lib/agent";
import { makeJailedShell } from "./lib/jail";
import { makeGit } from "./lib/git";
import { resolveTrustedRepoConfig } from "./lib/repo-config";
import { startPipeline, respondToGate, reconcileGate, type ExecutorDeps } from "./lib/executor";
import { makeGhRunner, resolveGhToken, type TokenStorage } from "./lib/gh-runner";
import { guardScope, MANAGE_JOBS_SCOPE, RESPOND_SCOPE, YOLO_SCOPE, type RbacCheck } from "./lib/rbac";
import { decideYoloAction } from "./lib/yolo";
import {
  reconcileSweep,
  SWEEP_CRON,
  type ReconcileResult,
  type SweepSummary,
} from "./lib/sweep";
import {
  isRunStale,
  productionHeartbeatKV,
  productionRunHeartbeatKV,
  type HeartbeatKV,
  type RunHeartbeatKV,
} from "./lib/heartbeat";
import { recoverRuns, type RecoverySummary } from "./lib/recovery";
import { runDoctor, type DoctorReport } from "./lib/doctor";
import {
  applyJobEdit,
  createJobStore,
  DEFAULT_JOB_ID,
  diffJob,
  jobConcreteBranch,
  loadJobsWithDefault,
  matchPushJob,
  isScheduleJobDue,
  parseJobIdPayload,
  shouldSynthesizeRun,
  validateJobDraft,
  type Job,
  type JobDraft,
  type JobStore,
} from "./lib/jobs";
import { createAuditLog, type AuditLog } from "./lib/audit";

/** Full namespaced action name the post-receive hook triggers. */
export const PUSH_RECEIVED_ACTION = `${EXTENSION_NAME}:${TRIGGER_EVENT}`;
/** The gate action the M2 approval UI (and any harness) drives to answer a
 *  parked gate: `{ runId, step, action: approve|fix|skip|abort, … }`. */
export const RESPOND_ACTION = `${EXTENSION_NAME}:respond`;
/** The "yolo" action: the M6 fix-once autopilot for one run (`{ runId, step }`).
 *  For each remaining gate it auto-fixes findings ONCE then approves, but STOPS
 *  at the first gate carrying an `ask-user` finding — it does NOT blanket-bypass
 *  per-gate human review. */
export const YOLO_ACTION = `${EXTENSION_NAME}:yolo`;
/** The M4 "reconcile" action: re-check a run parked at the CI gate — a read-only
 *  ReconcileApprovalGate poll that auto-resolves the gate when its PR has
 *  merged/closed (`{ runId }`). Harness/future-sweep-triggerable. */
export const RECONCILE_ACTION = `${EXTENSION_NAME}:reconcile`;
/** Control-plane job actions (L7): create/edit a job (`{ jobId?, <field> }`),
 *  toggle a job's enabled flag (`{ jobId }`), delete a job (`{ jobId }`), and
 *  fire a manual run for an enabled job (`{ jobId }`). All are gated on the
 *  `manage-jobs` RBAC scope (guardScope FIRST) and audited with `event.userId`. */
export const JOB_SAVE_ACTION = `${EXTENSION_NAME}:job-save`;
export const JOB_TOGGLE_ACTION = `${EXTENSION_NAME}:job-toggle`;
export const JOB_DELETE_ACTION = `${EXTENSION_NAME}:job-delete`;
export const RUN_NOW_ACTION = `${EXTENSION_NAME}:run-now`;

// ── Injectable seams (production defaults; tests override) ────────────
//
// Each seam's production default is a SINGLE named closure reused by both the
// initial binding and the `_set*ForTests(null)` reset — one function to cover
// (DRY) instead of a duplicated inline fallback the reset path never exercises.

// Prefer the PER-CALL project root the host resolves from the conversation's
// active project (`ctx.projectRoot`, forwarded on `_meta.ezProjectRoot`): one
// persistent subprocess serves every conversation, so the process-wide
// `EZCORP_PROJECT_ROOT` env var only ever names ONE project and is wrong the
// moment a second project's conversation calls in. The env var stays as a
// last-resort fallback for out-of-band dispatches (schedule/lifecycle) where
// no tool-call context is bound.
const defaultProjectRoot = (): string | undefined =>
  getToolContext()?.projectRoot ?? process.env.EZCORP_PROJECT_ROOT;
let projectRootImpl: () => string | undefined = defaultProjectRoot;
export function _setProjectRootForTests(fn: (() => string | undefined) | null): void {
  projectRootImpl = fn ?? defaultProjectRoot;
}

/** Accept an UNTRUSTED project-root claim (hook payload / stored run record)
 *  only when it hashes to the repo id it arrived with — `repoId` IS
 *  `sha256(absProjectRoot)[:12]` (gate.ts), so the pair is self-binding: a
 *  forged root cannot name someone else's gate repo. Returns undefined on any
 *  mismatch/absence. */
const validatedProjectRoot = (claimed: string | null | undefined, repo: string): string | undefined =>
  claimed && repoIdFor(claimed) === repo ? claimed : undefined;

/** Resolve the project root for a CONTEXT-FREE event fire (Hub action, git
 *  hook, cron): the HASH-VALIDATED claim (event payload / run record) wins —
 *  it is self-binding to the fire's own repoId — with ctx/env only as the
 *  fallback for pre-stamp rows. The reverse order was a latent wrong-tree
 *  bug: one persistent subprocess serves every project, so the process-wide
 *  env root names whichever project spawned it, not necessarily this run's
 *  (same per-run-root rule as reconcileOneRun / recoverOnStart). */
const resolveEventProjectRoot = (repo: string, claimed?: string | null): string | undefined =>
  validatedProjectRoot(claimed, repo) ?? projectRootImpl();

// Kept worktrees (and evidence) MUST survive subprocess respawns: a parked
// run's checkout lives for minutes-to-days across human triage, but the host
// WIPES the per-proc TMPDIR on every (re)spawn — a mid-triage respawn was
// destroying the kept worktree and failing the next step with "not a git
// repository" (drive-3). The durable, jail-writable home is the extension
// DATA DIR under the project root ($CWD fs grant), same convention as the
// gate repos. The old volatile-TMPDIR default is gone on purpose.
const defaultTmpBase = (projectRoot: string): string => join(dataDir(projectRoot), "tmp");
let tmpBaseImpl: (projectRoot: string) => string = defaultTmpBase;
export function _setTmpBaseForTests(fn: (() => string) | null): void {
  tmpBaseImpl = fn ? () => fn() : defaultTmpBase;
}

const defaultBaseUrl = (): string => process.env.EZCORP_BASE_URL || DEFAULT_BASE_URL;
let baseUrlImpl: () => string = defaultBaseUrl;
export function _setBaseUrlForTests(fn: (() => string) | null): void {
  baseUrlImpl = fn ?? defaultBaseUrl;
}

let shellImpl: ShellRunner = productionHostRunner;
export function _setShellForTests(fn: ShellRunner | null): void {
  shellImpl = fn ?? productionHostRunner;
}

let storeImpl: RunStore | null = null;
function getStore(): RunStore {
  if (!storeImpl) storeImpl = createRunStore("global");
  return storeImpl;
}
export function _setStoreForTests(store: RunStore | null): void {
  storeImpl = store;
}

// ── Control plane (L4/L5): job store + audit log seams ────────────────
let jobStoreImpl: JobStore | null = null;
function getJobStore(): JobStore {
  if (!jobStoreImpl) jobStoreImpl = createJobStore("global");
  return jobStoreImpl;
}
export function _setJobStoreForTests(store: JobStore | null): void {
  jobStoreImpl = store;
}

let auditImpl: AuditLog | null = null;
function getAudit(): AuditLog {
  if (!auditImpl) auditImpl = createAuditLog("global");
  return auditImpl;
}
export function _setAuditForTests(audit: AuditLog | null): void {
  auditImpl = audit;
}

let invalidatePageImpl: typeof invalidatePage = invalidatePage;
export function _setInvalidatePageForTests(fn: typeof invalidatePage | null): void {
  invalidatePageImpl = fn ?? invalidatePage;
}

// ── GitHub-token seam (the pr/ci steps' gh auth) ──────────────────────
//
// The `type:"secret"` `github_token` setting is stored ENCRYPTED in user-scoped
// Storage under `github-token`; the SDK Storage read decrypts it transparently.
// `resolveProductionGhToken` resolves it (env override → stored secret → null)
// each time the gh runner needs it, so a rotated token takes effect without a
// restart. The storage is a seam so tests never touch the real user store.

const defaultTokenStorage = (): TokenStorage => new Storage("user");
let tokenStorageImpl: () => TokenStorage = defaultTokenStorage;
export function _setTokenStorageForTests(fn: (() => TokenStorage) | null): void {
  tokenStorageImpl = fn ?? defaultTokenStorage;
}

/** Resolve the GitHub token for the gh runner (env → encrypted secret → null). */
export function resolveProductionGhToken(): Promise<string | null> {
  return resolveGhToken(process.env, tokenStorageImpl());
}

// ── Extension-RBAC seam (M6, triage-action gating) ────────────────────
//
// `ctx.rbac.check(scope)` asks the host whether the acting user holds `scope`
// for this extension (identity resolved host-side from the call's provenance
// token — a Hub click mints onBehalfOf = the clicking user). The chat respond
// tool + the Hub respond/yolo actions enforce it via `guardScope`; the seam lets
// tests drive both the granted + refused paths with a fake.
//
// NOTE (project-coordinate asymmetry, fail-CLOSED nit): a Hub respond/yolo click
// carries no conversation, so the host resolves the grant at the NULL-project
// coordinate — only an admin / all-projects grant satisfies it — whereas the
// chat `code_factory_respond` tool resolves at the CONVERSATION's project, so a
// project-scoped grant satisfies it. Asymmetric, but the Hub path demands the
// STRICTLY broader grant, never the narrower one — so it fails closed, never open.

const defaultRbacCheck: RbacCheck = (scope) => new Rbac().check(scope);
let rbacCheckImpl: RbacCheck = defaultRbacCheck;
export function _setRbacCheckForTests(fn: RbacCheck | null): void {
  rbacCheckImpl = fn ?? defaultRbacCheck;
}

// ── Reconcile-sweep heartbeat KV (M6, doctor's "loop healthy?" evidence) ──
//
// The background sweep records a heartbeat (last run + counts) in global
// Storage; `code_factory_doctor` reads it. The KV lives in lib/heartbeat.ts
// (its read/write bodies are covered there, isolated from bun's object-literal
// coverage drift); here it is just a swappable seam.

let heartbeatKVImpl: () => HeartbeatKV = productionHeartbeatKV;
export function _setHeartbeatKVForTests(fn: (() => HeartbeatKV) | null): void {
  heartbeatKVImpl = fn ?? productionHeartbeatKV;
}

// ── Per-run liveness heartbeat KV (L3, the status-truthfulness fix) ──
//
// The executor writes `heartbeats/<runId>` every 60 s while a step runs; the
// sweep reads it to mark a silent `running` run `stalled`. A swappable seam
// (tests inject a fake KV) like the sweep heartbeat above.
let runHeartbeatKVImpl: () => RunHeartbeatKV = productionRunHeartbeatKV;
export function _setRunHeartbeatKVForTests(fn: (() => RunHeartbeatKV) | null): void {
  runHeartbeatKVImpl = fn ?? productionRunHeartbeatKV;
}

// ── Settings live-read seam (M2, resolves M1's defaultPipelineConfig TODO) ──
//
// The pipeline config (auto-fix caps, gate remote, ignore globs, default
// branch) is resolved FRESH from the extension's user settings at each pipeline
// start / respond, so a settings change takes effect on the next push without a
// restart. `runtime.settings.getMine` resolves the calling extension's clamped
// settings for the acting user; the post-receive-hook trigger path may be
// system-driven (no user/session), in which case the RPC is unavailable — we
// fall back to `{}` → `resolvePipelineConfig` defaults rather than failing the
// pipeline. This is a best-effort live read, never a fake.

type SettingsMap = Record<string, unknown>;
const defaultSettingsRead = async (): Promise<SettingsMap> => {
  try {
    return await invoke<SettingsMap>("runtime.settings.getMine", {});
  } catch {
    return {};
  }
};
let settingsReadImpl: () => Promise<SettingsMap> = defaultSettingsRead;
export function _setSettingsReadForTests(fn: (() => Promise<SettingsMap>) | null): void {
  settingsReadImpl = fn ?? defaultSettingsRead;
}

/** Resolve the live pipeline config for a pipeline run (settings → validated
 *  + clamped config; defaults on any read failure). */
async function resolveLiveConfig(): Promise<PipelineConfig> {
  return resolvePipelineConfig(await settingsReadImpl());
}

// ── Pipeline runner seam ─────────────────────────────────────────────
//
// The executor + steps + jailed shell live behind a single injectable factory
// so the index-level lifecycle tests exercise the WIRING (parked vs terminal,
// worktree keep vs teardown) without driving the whole pipeline, which is
// tested end-to-end in executor.test / steps.test.

/** Applies a pipeline action to one run's worktree; returns whether it parked. */
export type PipelineRunner = (ctx: { runId: string; worktreePath: string }) => Promise<{ parked: boolean }>;

/** Build the ExecutorDeps for a run against its worktree (production wiring:
 *  host git read-only, the nested jail for mutating commit/push, native
 *  spawn-assignment agents). `config` is the LIVE settings-resolved pipeline
 *  config (M2 resolves M1's defaultPipelineConfig TODO). */
function buildExecutorDeps(
  projectRoot: string,
  gateDir: string,
  worktreePath: string,
  config: PipelineConfig,
  job?: Pick<Job, "name" | "skipSteps" | "agentName">,
): ExecutorDeps {
  const evidenceDir = join(tmpBaseImpl(projectRoot), "ez-code-factory-evidence");
  return {
    store: getStore(),
    worktree: worktreePath,
    gateDir,
    workingPath: projectRoot,
    tmpBase: tmpBaseImpl(projectRoot),
    config,
    // Control plane (L4): the matched job's step-skip overlay + name (for the
    // `skipped by job <name>` reason). Protected steps were rejected on save,
    // so a skip can never bypass the review gate.
    ...(job && job.skipSteps.length > 0 ? { skipSteps: job.skipSteps, jobName: job.name } : {}),
    dispatcher: makeSpawnDispatcher({ evidenceDir }),
    hostRunner: shellImpl,
    jailedRunner: makeJailedShell(gateDir, projectRoot),
    // The pr/ci steps shell `gh` in the worktree with GH_TOKEN injected from the
    // encrypted `github_token` secret (skip-not-fail when gh is unauthenticated).
    gh: makeGhRunner(shellImpl, worktreePath, resolveProductionGhToken),
    // SECURITY (spec §1 invariant 1): resolve the trusted-branch-gated repo
    // config from the freshly-fetched default branch BEFORE any agent runs. The
    // pushed copy is read from the worktree HEAD (the checked-out pushed SHA). A
    // failure here aborts the run fail-closed inside startPipeline.
    resolveRepoConfig: () =>
      resolveTrustedRepoConfig(makeGit(shellImpl, worktreePath), config.defaultBranch, "HEAD"),
    now: () => Date.now(),
    onChange: refreshDashboard,
    // Control-plane audit sink (L5): run status transitions are recorded via
    // the executor's setRunStatus choke.
    audit: getAudit(),
    log: (runId, step, message) =>
      logLine(`ez-code-factory[${runId}/${step}]: ${message}`),
    // Per-run liveness heartbeat (L3): a 60 s beat around each step's execute so
    // the sweep can truthfully mark a dead run `stalled`. Separate key, never a
    // read-modify-write on the run record.
    heartbeat: { write: (runId, at) => runHeartbeatKVImpl().write(runId, at) },
  };
}

const defaultRunPipeline = (projectRoot: string, gateDir: string, job?: Job): PipelineRunner => {
  return async ({ runId, worktreePath }) => {
    const config = await resolveLiveConfig();
    const outcome = await startPipeline(
      runId,
      buildExecutorDeps(projectRoot, gateDir, worktreePath, config, job),
    );
    return { parked: outcome.status === "parked" };
  };
};
const defaultRespondRunner =
  (projectRoot: string, gateDir: string, respond: ReturnType<typeof parseRespondPayload>): PipelineRunner => {
    return async ({ runId, worktreePath }) => {
      const config = await resolveLiveConfig();
      const outcome = await respondToGate(
        runId,
        respond!,
        buildExecutorDeps(projectRoot, gateDir, worktreePath, config),
      );
      return { parked: outcome.status === "parked" };
    };
  };

let makeRunPipelineImpl = defaultRunPipeline;
export function _setRunPipelineForTests(fn: typeof defaultRunPipeline | null): void {
  makeRunPipelineImpl = fn ?? defaultRunPipeline;
}
let makeRespondRunnerImpl = defaultRespondRunner;
export function _setRespondRunnerForTests(fn: typeof defaultRespondRunner | null): void {
  makeRespondRunnerImpl = fn ?? defaultRespondRunner;
}

/** Drives the CI step's ReconcileApprovalGate for a parked run; returns whether
 *  the run remains parked (still open / not reconcilable) after the check.
 *
 *  Runs against the GATE REPO dir, NOT the run's worktree: reconcile is a
 *  read-only PR-state poll (`gh pr view --repo owner/name`), and a `checks_passed`
 *  run has ALREADY torn its worktree down (H2). The bare gate repo always exists
 *  and shares the upstream `origin`, so `git remote get-url origin` + `gh` resolve
 *  the host without a live worktree. (A CI-timeout-parked run still has its
 *  worktree, but gateDir works for it too — reconcile never writes.) */
const defaultReconcileRunner = (projectRoot: string, gateDir: string): PipelineRunner => {
  return async ({ runId }) => {
    const config = await resolveLiveConfig();
    const outcome = await reconcileGate(
      runId,
      buildExecutorDeps(projectRoot, gateDir, gateDir, config),
    );
    return { parked: outcome.status === "parked" };
  };
};
let makeReconcileRunnerImpl = defaultReconcileRunner;
export function _setReconcileRunnerForTests(fn: typeof defaultReconcileRunner | null): void {
  makeReconcileRunnerImpl = fn ?? defaultReconcileRunner;
}

// ── Chat-entry tools (M5) — run / status / respond ───────────────────
//
// The /no-mistakes-skill equivalent as pure-extension LLM-callable tools. Thin
// wiring only: the validated orchestration + the contract-in-code (verbatim
// ask-user relay + no-blanket-approval) live in lib/chat-tools.ts +
// lib/chat-contract.ts; intent inference in lib/intent-infer.ts. Every backend
// touch reuses the M0/M1/M2 entry points (runGateLifecycle / resumeGateLifecycle
// via the same respond runner + the trusted-config-gated executor).

/**
 * Assemble the chat-tool deps for the active project (production wiring). The
 * intent inferrer reads the CURRENT conversation via `runtime.conversations.
 * getMessages` (auth-scoped to the tool's own conversation) and summarizes with
 * a native spawn-assignment agent; `dispatch` is the dispatcher's method (its
 * body lives + is covered in lib/agent.ts). One shared `log` closure feeds both
 * the tool + the inferrer. Async because the live pipeline config (default
 * branch) is settings-resolved. */
async function defaultBuildChatToolDeps(projectRoot: string): Promise<ChatToolDeps> {
  const id = repoIdFor(projectRoot);
  const gDir = gateDirFor(projectRoot, id);
  const config = await resolveLiveConfig();
  const evidenceDir = join(tmpBaseImpl(projectRoot), "ez-code-factory-evidence");
  const log = (message: string): void => {
    logLine(`ez-code-factory[chat]: ${message}`);
  };
  return {
    projectRoot,
    gateDir: gDir,
    repoId: id,
    defaultBranch: config.defaultBranch,
    run: shellImpl,
    store: getStore(),
    triggerRun: (push) =>
      runGateLifecycle(push, {
        gateDir: gDir,
        tmpBase: tmpBaseImpl(projectRoot),
        store: getStore(),
        run: shellImpl,
        onChange: refreshDashboard,
        runPipeline: makeRunPipelineImpl(projectRoot, gDir),
        // Stamp the tool-call-resolved root on the record — the later Hub
        // respond/yolo/reconcile fires are context-free and re-derive every
        // path from this (same as the push path's stamp).
        projectRoot,
      }),
    resumeRun: (runId, respond) =>
      resumeGateLifecycle(runId, {
        gateDir: gDir,
        store: getStore(),
        run: shellImpl,
        onChange: refreshDashboard,
        respond: makeRespondRunnerImpl(projectRoot, gDir, respond),
      }),
    inferIntent: makeConversationIntentInferrer({
      getConversationId: () => getToolContext()?.conversationId ?? null,
      invoke,
      dispatch: makeSpawnDispatcher({ evidenceDir }).dispatch,
      cache: createIntentCache("global"),
      projectRoot,
      log,
    }),
    log,
  };
}

let buildChatToolDepsImpl = defaultBuildChatToolDeps;
export function _setChatToolDepsForTests(
  fn: ((projectRoot: string) => Promise<ChatToolDeps>) | null,
): void {
  buildChatToolDepsImpl = fn ?? defaultBuildChatToolDeps;
}

/** Shared handler shell: resolve the active project, build deps, run one chat
 *  orchestrator, and map its outcome to a tool result. DRY across the three
 *  tools (they differ only in the arg shape + orchestrator). */
async function dispatchChatTool<A>(
  args: unknown,
  orchestrator: (a: A, deps: ChatToolDeps) => Promise<ChatToolOutcome>,
) {
  const projectRoot = projectRootImpl();
  if (!projectRoot) {
    return toolError("EZCORP_PROJECT_ROOT unset — no active project to gate");
  }
  const deps = await buildChatToolDepsImpl(projectRoot);
  const outcome = await orchestrator((args ?? {}) as A, deps);
  return outcome.ok ? toolResult(JSON.stringify(outcome.data)) : toolError(outcome.error);
}

/** `code_factory_run` — trigger a gate run (explicit or inferred intent). */
export const codeFactoryRunTool: ToolHandler = (args) =>
  dispatchChatTool<{ intent?: unknown; branch?: unknown }>(args, runChatTool);

/** `code_factory_status` — report a run's gate state + verbatim-relay findings. */
export const codeFactoryStatusTool: ToolHandler = (args) =>
  dispatchChatTool<{ runId?: unknown }>(args, statusChatTool);

/** `code_factory_respond` — approve/fix/skip/abort a parked gate (contract-in-code).
 *  RBAC (M6): gated on `respond-gate`. The manifest ALSO declares this scope as
 *  the tool's `rbacScope`, so the HOST denies it pre-dispatch — this in-code
 *  guard mirrors that for a clear, contract-shaped refusal (and unit coverage). */
export const codeFactoryRespondTool: ToolHandler = async (args) => {
  const guard = await guardScope(rbacCheckImpl, RESPOND_SCOPE, "respond to a gate");
  if (!guard.ok) return toolError(guard.error);
  return dispatchChatTool<Parameters<typeof respondChatTool>[0]>(args, respondChatTool);
};

/** `code_factory_doctor` — a read-only health report for the active project's
 *  gate (spec §13 doctor). Mutates nothing; every check is a git/gh probe or a
 *  Storage read behind the shared production seams. */
export const codeFactoryDoctorTool: ToolHandler = async () => {
  const projectRoot = projectRootImpl();
  if (!projectRoot) {
    return toolError("EZCORP_PROJECT_ROOT unset — no active project to diagnose");
  }
  const id = repoIdFor(projectRoot);
  const gDir = gateDirFor(projectRoot, id);
  const config = await resolveLiveConfig();
  const report: DoctorReport = await runDoctor({
    gateDir: gDir,
    defaultBranch: config.defaultBranch,
    credentialPath: credentialPathFor(projectRoot),
    run: shellImpl,
    gh: makeGhRunner(shellImpl, gDir, resolveProductionGhToken),
    resolveToken: resolveProductionGhToken,
    readHeartbeat: () => heartbeatKVImpl().read(),
  });
  return toolResult(JSON.stringify(report));
};

/** Run statuses that get an inline dashboard detail section: a parked run
 *  (awaiting_approval) for triage, and a resting checks_passed run so its CI gate
 *  detail + the "Re-check PR state" reconcile control render (M4). */
const DETAIL_STATUSES: ReadonlySet<RunRecord["status"]> = new Set(["awaiting_approval", "checks_passed"]);

/** Gather the run details to inline on the dashboard: for every run awaiting
 *  approval OR resting at checks_passed, its ordered step results (so the detail
 *  section can show the step list + the parked/CI step's findings + controls).
 *  Other runs need no detail. */
async function collectParkedDetails(store: RunStore, runs: RunRecord[]): Promise<RunDetail[]> {
  const details: RunDetail[] = [];
  for (const run of runs) {
    if (!DETAIL_STATUSES.has(run.status)) continue;
    const steps: StepResultRecord[] = [];
    for (const step of PIPELINE_STEPS) {
      const sr = await store.getStepResult(run.id, step);
      if (sr) steps.push(sr);
    }
    details.push({ run, steps });
  }
  return details;
}

/** Signal "the dashboard changed" (content-free SSE invalidation → every open
 *  Hub view re-pulls its OWN variant). With per-project variants a single
 *  pushed tree can't serve the home + every project view, so this replaced
 *  the old `pushPage` full-tree refresh. */
async function refreshDashboard(): Promise<void> {
  invalidatePageImpl(PAGE_ID);
}

/** Render the read-only run-DETAIL view for `?run=<id>`: load the run + its
 *  ordered step results and hand them to the pure builder. An unknown id yields
 *  a "not found" note (never an error) — the run may have been swept, or the
 *  deep-link is stale. `ctx` carries the render's project context (the single
 *  project on the project hub, the full list on the global hub); we resolve the
 *  run's OWNING project from it so the detail's per-turn rows can deep-link into
 *  their chat sub-conversations. An orphan run (no matching project) renders the
 *  same detail without those links. */
async function renderRunDetail(
  store: RunStore,
  runId: string,
  ctx?: PageRenderContext,
): Promise<HubPageTree> {
  const run = await store.getRun(runId);
  if (!run) return buildRunDetailView(runId, null);
  const steps: StepResultRecord[] = [];
  for (const step of PIPELINE_STEPS) {
    const sr = await store.getStepResult(runId, step);
    if (sr) steps.push(sr);
  }
  const projects = ctx?.projects ?? (ctx?.project ? [ctx.project] : []);
  const projectId = projectIdForRun(run, projects);
  const stalledRunIds = await computeStalledRunIds([run]);
  return buildRunDetailView(runId, { run, steps }, projectId, stalledRunIds);
}

/**
 * Derived-stalled ids (L3, immediate — doesn't wait for the sweep cron): for
 * each `running` run, read its per-run heartbeat and evaluate the SHARED
 * `isRunStale` helper with `Date.now()`. A run persisted as `stalled` by the
 * sweep needs no entry here (it already renders stalled); this set only
 * upgrades a `running` run whose executor has gone silent. One heartbeat read
 * per running run (typically 0–1).
 */
async function computeStalledRunIds(runs: RunRecord[]): Promise<Set<string>> {
  const kv = runHeartbeatKVImpl();
  const now = Date.now();
  const ids = new Set<string>();
  for (const run of runs) {
    if (run.status !== "running") continue;
    const heartbeatAt = await kv.read(run.id);
    if (isRunStale(run, heartbeatAt, now)) ids.add(run.id);
  }
  return ids;
}

/**
 * Render the read-only STEP-detail view for `?run=<id>&step=<name>` (L5). An
 * arbitrary 128-char `step` string reaches here — validate it against
 * PIPELINE_STEPS (unknown → empty state, never throw). Loads the run, the single
 * step result + its rounds, and the per-round IO records via `listStepIO` (a
 * PREFIX listing — an errored final attempt writes an IO record beyond
 * `sr.round`, so a 1..round loop would miss it). Resolves the owning project for
 * the per-dispatch chat deep-links exactly as the run detail does.
 */
async function renderStepDetail(
  store: RunStore,
  runId: string,
  step: string,
  ctx?: PageRenderContext,
): Promise<HubPageTree> {
  // Unknown step (arbitrary reachable string) → honest empty state, never throw.
  if (!(PIPELINE_STEPS as readonly string[]).includes(step)) {
    return buildStepDetailView(null);
  }
  const pipelineStep = step as PipelineStep;
  const run = await store.getRun(runId);
  if (!run) return buildStepDetailView(null);

  const result = await store.getStepResult(runId, pipelineStep);
  const rounds = await store.getStepRounds(runId, pipelineStep);
  const io = await store.listStepIO(runId, pipelineStep);

  const projects = ctx?.projects ?? (ctx?.project ? [ctx.project] : []);
  const projectId = projectIdForRun(run, projects);
  const stalledRunIds = await computeStalledRunIds([run]);
  const detail: StepDetail = { run, step: pipelineStep, result, rounds, io };
  return buildStepDetailView(detail, projectId, stalledRunIds);
}

// ── Control-plane views (`?view=` render variants — L6) ──────────────

/** Route a `?view=` render to its builder (config / job / audit). The raw value
 *  is parsed HERE (compound `audit:<day>` / `job:<id>`); an unknown/malformed
 *  value renders an empty state, never a throw. */
async function renderViewVariant(
  store: RunStore,
  view: string,
  ctx?: PageRenderContext,
): Promise<HubPageTree> {
  const parsed = parseView(view);
  switch (parsed.kind) {
    case "config":
      return renderConfigView(store, ctx);
    case "job":
      return renderJobView(store, parsed.jobId, ctx);
    case "audit":
      return renderAuditView(parsed.day, ctx);
    default:
      return buildUnknownView(view);
  }
}

/** Render the `?view=config` surface: jobs (default-seeded), runs, the live
 *  settings-resolved pipeline config, and the sweep heartbeat. Row hrefs are
 *  project-scoped only on the project hub (`ctx.project`). */
async function renderConfigView(store: RunStore, ctx?: PageRenderContext): Promise<HubPageTree> {
  const jobs = await loadJobsWithDefault(getJobStore(), getAudit());
  const runs = await store.listRuns();
  const config = await resolveLiveConfig();
  const sweepHeartbeat = await heartbeatKVImpl().read();
  return buildConfigView({
    jobs,
    runs,
    config,
    sweepHeartbeat,
    nowMs: Date.now(),
    extensionId: EXTENSION_NAME,
    projectId: ctx?.project?.id,
  });
}

/** Render the `?view=job:<id>` surface: the job's definition + its runs (newest
 *  20). An unknown id renders an honest "not found". */
async function renderJobView(
  store: RunStore,
  jobId: string,
  ctx?: PageRenderContext,
): Promise<HubPageTree> {
  const jobs = await loadJobsWithDefault(getJobStore(), getAudit());
  const job = jobs.find((j) => j.id === jobId) ?? null;
  const runs = job ? (await store.listRuns()).filter((r) => r.jobId === jobId).slice(0, 20) : [];
  return buildJobView(jobId, job, runs, ctx?.project?.id);
}

/** Render the `?view=audit[:<day>]` surface: the target day's bucket (or the
 *  newest day with entries when none is specified) + the day-nav set. */
async function renderAuditView(day: string | undefined, ctx?: PageRenderContext): Promise<HubPageTree> {
  const audit = getAudit();
  const days = await audit.listDays();
  const targetDay = day ?? days[0] ?? new Date().toISOString().slice(0, 10);
  const bucket = await audit.readDay(targetDay);
  return buildAuditView(targetDay, bucket, days, ctx?.project?.id);
}

// ── Handlers ─────────────────────────────────────────────────────────

/** `init_gate` tool — provision the gate for the active project. */
export const initGateTool: ToolHandler = async (args) => {
  const projectRoot = projectRootImpl();
  if (!projectRoot) {
    return toolError("EZCORP_PROJECT_ROOT unset — no active project to gate");
  }
  const { upstream } = (args ?? {}) as { upstream?: unknown };
  const res = await initGate({
    projectRoot,
    run: shellImpl,
    baseUrl: baseUrlImpl(),
    ...(typeof upstream === "string" && upstream.trim() ? { upstream: upstream.trim() } : {}),
  });
  if (!res.ok) {
    return toolError(`init_gate failed: ${res.error ?? "unknown error"}`);
  }
  const base = {
    ok: true,
    repoId: res.repoId,
    gateRemote: res.gateRemote,
    gateDir: res.gateDir,
    credentialPath: res.credentialPath,
    // The hook silently drops every push until the minted key file exists — the
    // #1 silent-setup gap. Surfaced verbatim so the success reply must confront it.
    credentialPresent: res.credentialPresent,
    bareCreated: res.bareCreated,
    hookAction: res.hookAction,
    remoteAction: res.remoteAction,
    pushHint: `git push ${GATE_REMOTE} <branch>`,
    warnings: res.warnings,
  };
  // When the credential is missing the gate is provisioned but INERT — attach
  // the exact mint command as `nextStep` (paired with the tool description's
  // CONTRACT clause) so a bare "initialized" summary is not the whole story.
  return toolResult(
    JSON.stringify(
      res.credentialPresent
        ? base
        : { ...base, nextStep: mintCredentialCommand(res.credentialPath) },
    ),
  );
};

/** `push-received` Hub action — the post-receive hook's trigger target. The
 *  `payload` is attacker-controlled; validate every field before acting. The
 *  whole body is wrapped: this is a fire-and-forget notification handler, so a
 *  throw here is otherwise SWALLOWED by the SDK channel (no id → no error
 *  frame), hiding the failure entirely. Emit one stderr line instead. */
export async function handlePushReceived(event: PageActionEvent): Promise<void> {
  try {
    const push = parsePushReceived(event.payload);
    if (!push) {
      logLine("ez-code-factory: push-received with invalid payload — ignored");
      return;
    }
    // Ctx/env first, else the hook-baked payload root — accepted only when it
    // hashes to the payload's repoId (see resolveEventProjectRoot).
    const projectRoot = resolveEventProjectRoot(push.repoId, push.projectRoot);
    if (!projectRoot) {
      logLine(
        "ez-code-factory: push-received with no resolvable project root " +
          "(no ctx/env and the payload root is missing or fails the repoId binding) — ignored",
      );
      return;
    }
    const gDir = gateDirFor(projectRoot, push.repoId);

    // Control plane (L4): match the push branch to an ENABLED job (the default
    // job — push, pattern `*`, all steps — is auto-seeded on first read, so
    // today's behavior is preserved exactly). A push matching NO enabled job is
    // IGNORED and AUDITED (never silent), not run.
    const jobs = await loadJobsWithDefault(getJobStore(), getAudit());
    const job = matchPushJob(jobs, push.branch);
    if (!job) {
      await getAudit().append({
        actor: "system",
        kind: "push-ignored",
        detail: { branch: push.branch, reason: "no matching enabled job" },
      });
      logLine(`ez-code-factory: push to ${push.branch} matched no enabled job — ignored`);
      return;
    }

    const result = await runGateLifecycle(push, {
      gateDir: gDir,
      tmpBase: tmpBaseImpl(projectRoot),
      store: getStore(),
      run: shellImpl,
      onChange: refreshDashboard,
      // The matched job threads its step-skip overlay into the pipeline and its
      // id onto the run record (job-scoped supersede + run-row label).
      runPipeline: makeRunPipelineImpl(projectRoot, gDir, job),
      projectRoot,
      jobId: job.id,
    });
    // `ok` is true only for `completed`; awaiting_approval (parked) and
    // checks_passed (rested green) are success-ish non-terminal states, not
    // failures, so they are NOT logged as errors.
    if (!result.ok && result.status !== "awaiting_approval" && result.status !== "checks_passed") {
      logLine(
        `ez-code-factory: run ${result.runId} failed: ${result.error ?? "unknown"}`,
      );
    }
  } catch (err) {
    // runGateLifecycle marks its own run failed; this guards anything outside it
    // (payload parse, store construction, worktree teardown) whose throw the
    // channel would swallow.
    const message = err instanceof Error ? err.message : String(err);
    logLine(`ez-code-factory: push-received handler error: ${message}`);
  }
}

/** `respond` Hub action — answers a parked gate (approve/fix/skip/abort). The
 *  payload is attacker-reachable via the events route; validate every field.
 *  The verbatim ask-user relay + no-blanket-approval rules are enforced
 *  structurally: the no-blanket-approval chokepoint (`enforceRespondContract`,
 *  the SAME helper the chat `code_factory_respond` tool runs) is applied here
 *  too, so a raw events POST cannot bypass the locked invariant (spec §1 inv2)
 *  by driving the Hub surface instead of the chat surface (decision #4). */
export async function handleRespond(event: PageActionEvent): Promise<void> {
  try {
    // Normalize the Hub's flat scalar action payload (findingId + instruction)
    // into M1's canonical findingIds[]/instructions{} shape, then validate via
    // the single M1 validator. A harness POST that already sends the canonical
    // shape passes through untouched.
    const normalized = normalizeRespondPayload(event.payload);
    const respond = parseRespondPayload(normalized);
    if (!respond) {
      logLine("ez-code-factory: respond with invalid payload — ignored");
      return;
    }
    // RBAC (M6): the acting user must hold `respond-gate`. A Hub click resolves
    // the user host-side from the fire's provenance token; a denied respond is a
    // no-op (never mutates the run) with a clear refusal line — not a 500.
    const guard = await guardScope(rbacCheckImpl, RESPOND_SCOPE, "respond to a gate");
    if (!guard.ok) {
      logLine(`ez-code-factory: respond refused — ${guard.error}`);
      return;
    }
    const rec = await getStore().getRun(respond.runId);
    if (!rec) {
      logLine(`ez-code-factory: respond for unknown run ${respond.runId} — ignored`);
      return;
    }
    // A Hub click fires with no tool-call context — re-derive the root from
    // the run record stamped at push time (hash-validated), ctx/env first.
    const projectRoot = resolveEventProjectRoot(rec.repoId, rec.projectRoot);
    if (!projectRoot) {
      logLine(`ez-code-factory: respond for run ${respond.runId} with no resolvable project root — ignored`);
      return;
    }
    // CONTRACT-IN-CODE (spec §1 inv2): the SAME no-blanket-approval chokepoint the
    // chat `code_factory_respond` tool runs — enforced AFTER RBAC, BEFORE any
    // mutation, against the parked step's REAL findings. A raw events POST that
    // omits findingIds cannot bulk-clear a gate carrying ask-user findings (a
    // clean gate still approves ids-free; a `consentAll:true` in the untrusted
    // payload still bypasses, but is logged for audit; skip/abort are unaffected;
    // a named id that is not on the parked step is rejected). A refused respond
    // is a side-effect-free no-op — the run stays parked, its worktree kept.
    const stepResult = await getStore().getStepResult(respond.runId, respond.step);
    const parkedItems = stepResult?.findings.items ?? [];
    const consentAll =
      !!normalized &&
      typeof normalized === "object" &&
      (normalized as Record<string, unknown>).consentAll === true;
    const approval = enforceRespondContract(respond.action, respond.findingIds, consentAll, parkedItems);
    if (!approval.ok) {
      logLine(`ez-code-factory: respond refused — ${approval.error}`);
      return;
    }
    if (approval.consentAllUsed) {
      logLine(
        `ez-code-factory: respond consentAll bypass — run=${respond.runId} step=${respond.step} ` +
          `action=${respond.action} cleared a gate with ` +
          `${parkedItems.filter((f) => f.action === "ask-user").length} ask-user finding(s) WITHOUT named ids`,
      );
    }
    const gDir = gateDirFor(projectRoot, rec.repoId);
    const result = await resumeGateLifecycle(respond.runId, {
      gateDir: gDir,
      store: getStore(),
      run: shellImpl,
      onChange: refreshDashboard,
      respond: makeRespondRunnerImpl(projectRoot, gDir, respond),
    });
    if (result === null) {
      logLine(`ez-code-factory: respond for run ${respond.runId} could not resume`);
    }
    // Audit the triage action (L5): actor = the acting user (host-stamped on
    // the fire), action + finding IDS only (never restated finding content).
    await getAudit().append({
      actor: event.userId || "system",
      kind: "respond",
      runId: respond.runId,
      step: respond.step,
      detail: {
        action: respond.action,
        findingIds: respond.findingIds,
        resumed: result !== null,
        ...(approval.consentAllUsed ? { consentAll: true } : {}),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logLine(`ez-code-factory: respond handler error: ${message}`);
  }
}

/** The parked step RESULT of a run (the first step awaiting approval / fix
 *  review), read from the store. Null when nothing is parked. */
async function findParkedStepResult(store: RunStore, runId: string): Promise<StepResultRecord | null> {
  for (const step of PIPELINE_STEPS) {
    const sr = await store.getStepResult(runId, step);
    if (sr && (sr.status === "awaiting_approval" || sr.status === "fix_review")) return sr;
  }
  return null;
}

/** Hard bound on the yolo autopilot loop. Under fix-once each pipeline step is
 *  visited at most twice (one fix round + one approve), so twice the step count
 *  plus a margin can never be legitimately exceeded — a pathological re-park can
 *  never spin. */
const YOLO_MAX_ITERATIONS = PIPELINE_STEPS.length * 2 + 1;

/**
 * The yolo autopilot (M6 fix-once, spec §13): drive each remaining parked gate
 * of a run via the SAME approve/fix respond path the Hub buttons use — FIX its
 * actionable auto-fix findings ONCE, then APPROVE the rest — but STOP the
 * instant a gate carries an `ask-user` finding (yolo must not clear a decision
 * the gate exists to force a human to make). `decideYoloAction` owns each
 * per-gate call; the `fixedSteps` set enforces the one-fix-per-step budget.
 * Bounded by `YOLO_MAX_ITERATIONS` so a pathological re-park can never spin.
 */
async function runYoloAutopilot(runId: string, projectRoot: string): Promise<void> {
  const store = getStore();
  const fixedSteps = new Set<PipelineStep>();
  for (let i = 0; i < YOLO_MAX_ITERATIONS; i++) {
    const rec = await store.getRun(runId);
    if (!rec || rec.status !== "awaiting_approval") return; // terminal / gone / not parked
    const sr = await findParkedStepResult(store, runId);
    if (!sr) return; // parked run with no parked step — nothing to act on
    const step = sr.step as PipelineStep;
    const decision = decideYoloAction(sr.findings, fixedSteps.has(step));
    if (decision.kind === "stop") {
      logLine(
        `ez-code-factory[yolo]: stopping at '${step}' — ${decision.askUserCount} ask-user ` +
          `finding(s) require a human decision (relay + await approval)`,
      );
      return;
    }
    const gDir = gateDirFor(projectRoot, rec.repoId);
    const respond: ParsedRespond =
      decision.kind === "fix"
        ? { runId, step, action: "fix", findingIds: decision.findingIds, instructions: {}, addedFindings: [] }
        : { runId, step, action: "approve", findingIds: [], instructions: {}, addedFindings: [] };
    if (decision.kind === "fix") fixedSteps.add(step);
    const result = await resumeGateLifecycle(runId, {
      gateDir: gDir,
      store,
      run: shellImpl,
      onChange: refreshDashboard,
      respond: makeRespondRunnerImpl(projectRoot, gDir, respond),
    });
    // Stop the instant the run leaves the parked state (terminal), or if the
    // resume could not be applied (null) — a rejected respond leaves the run
    // parked, and looping would spin, so treat non-parked as done.
    if (result === null || !result.parked) return;
  }
}

/** `yolo` Hub action — run the fix-once autopilot over a run's remaining gates
 *  (auto-fix findings once, then approve; STOP at any `ask-user` gate). The
 *  payload is attacker-reachable via the events route; validate the runId. */
export async function handleYolo(event: PageActionEvent): Promise<void> {
  try {
    const runId = parseRunIdPayload(event.payload);
    if (!runId) {
      logLine("ez-code-factory: yolo with invalid payload — ignored");
      return;
    }
    const rec = await getStore().getRun(runId);
    if (!rec) {
      logLine(`ez-code-factory: yolo for unknown run ${runId} — ignored`);
      return;
    }
    // Context-free Hub fire: root from the record (hash-validated), ctx/env first.
    const projectRoot = resolveEventProjectRoot(rec.repoId, rec.projectRoot);
    if (!projectRoot) {
      logLine(`ez-code-factory: yolo for run ${runId} with no resolvable project root — ignored`);
      return;
    }
    // RBAC (M6): yolo has its OWN scope (`yolo`) — strictly broader than a single
    // approve, since the autopilot fixes-once-then-approves across every remaining
    // gate of a run (stopping only at an ask-user gate). A denied yolo is a no-op
    // with a clear refusal line, not a 500.
    const guard = await guardScope(rbacCheckImpl, YOLO_SCOPE, "run the yolo autopilot");
    if (!guard.ok) {
      logLine(`ez-code-factory: yolo refused — ${guard.error}`);
      return;
    }
    await runYoloAutopilot(runId, projectRoot);
    // Audit the triage action (L5): actor = the acting user; result = the run's
    // status after the autopilot settled (id only, no content).
    await getAudit().append({
      actor: event.userId || "system",
      kind: "yolo",
      runId,
      detail: { status: (await getStore().getRun(runId))?.status ?? "unknown" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logLine(`ez-code-factory: yolo handler error: ${message}`);
  }
}

/** `reconcile` Hub action — re-check a run parked at the CI gate. Drives the CI
 *  step's ReconcileApprovalGate through resumeGateLifecycle (which reattaches the
 *  kept worktree + tears it down only on a persisted terminal status), so a
 *  merged/closed PR auto-resolves the gate and the run completes. Read-only when
 *  the gate does not resolve — the run stays parked. Payload: `{ runId }`. */
export async function handleReconcile(event: PageActionEvent): Promise<void> {
  try {
    const runId = parseRunIdPayload(event.payload);
    if (!runId) {
      logLine("ez-code-factory: reconcile with invalid payload — ignored");
      return;
    }
    const rec = await getStore().getRun(runId);
    if (!rec) {
      logLine(`ez-code-factory: reconcile for unknown run ${runId} — ignored`);
      return;
    }
    // Context-free Hub fire: root from the record (hash-validated), ctx/env first.
    const projectRoot = resolveEventProjectRoot(rec.repoId, rec.projectRoot);
    if (!projectRoot) {
      logLine(`ez-code-factory: reconcile for run ${runId} with no resolvable project root — ignored`);
      return;
    }
    const gDir = gateDirFor(projectRoot, rec.repoId);
    const result = await resumeGateLifecycle(runId, {
      gateDir: gDir,
      store: getStore(),
      run: shellImpl,
      onChange: refreshDashboard,
      respond: makeReconcileRunnerImpl(projectRoot, gDir),
    });
    if (result === null) {
      logLine(`ez-code-factory: reconcile for run ${runId} could not resume`);
    }
    // Audit the triage action (L5): actor = the acting user; result only.
    await getAudit().append({
      actor: event.userId || "system",
      kind: "reconcile",
      runId,
      detail: { resumed: result !== null, ...(result ? { parked: result.parked } : {}) },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logLine(`ez-code-factory: reconcile handler error: ${message}`);
  }
}

// ── Control-plane job actions (L7) ───────────────────────────────────
//
// Four Hub page actions manage job DEFINITIONS: job-save (create/edit),
// job-toggle (enable/disable), job-delete, and run-now (manual fire). Each is
// attacker-reachable via the generic events route, so every handler:
//   1. guardScope(`manage-jobs`) FIRST — fail-closed, a denied action is a no-op
//      that mutates nothing AND audits nothing (never a 500);
//   2. validates the payload;
//   3. mutates the job store + AUDITS with the acting `event.userId`;
//   4. refreshes the page (content-free SSE invalidation).
// The whole body is wrapped: a throw in a notification handler would otherwise
// be swallowed by the SDK channel (no id → no error frame).

/** Mint a fresh job id (`job_<ts36>_<rand>`), mirroring the run-id convention. */
function newJobId(): string {
  return `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** `job-save` Hub action — create a NEW job (no `jobId`) or edit an existing one
 *  (a single scalar field merged in by a prompt). The full merged draft is
 *  re-validated (protected steps rejected, branch patterns clamped) BEFORE any
 *  write; a validation failure is a logged no-op + refresh (never a partial
 *  save). An edit audits the field diff; a create audits the new definition. */
export async function handleJobSave(event: PageActionEvent): Promise<void> {
  try {
    const guard = await guardScope(rbacCheckImpl, MANAGE_JOBS_SCOPE, "manage jobs");
    if (!guard.ok) {
      logLine(`ez-code-factory: job-save refused — ${guard.error}`);
      return;
    }
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const rawJobId = typeof payload.jobId === "string" ? payload.jobId.trim() : "";
    const store = getJobStore();
    const jobs = await loadJobsWithDefault(store, getAudit());
    const existing = rawJobId ? jobs.find((j) => j.id === rawJobId) ?? (await store.getJob(rawJobId)) : null;

    // The candidate draft: the existing job's fields (edit) or the create
    // defaults (a DISABLED push job on `main`, configured further in the editor).
    const base: JobDraft = existing
      ? {
          name: existing.name,
          trigger: existing.trigger,
          enabled: existing.enabled,
          skipSteps: existing.skipSteps,
          ...(existing.agentName !== undefined ? { agentName: existing.agentName } : {}),
          ...(existing.intentTemplate !== undefined ? { intentTemplate: existing.intentTemplate } : {}),
        }
      : { name: "", trigger: { kind: "push", branchPattern: "main" }, enabled: false, skipSteps: [] };

    const applied = applyJobEdit(base, payload);
    if (!applied.ok) {
      logLine(`ez-code-factory: job-save refused — ${applied.error}`);
      await refreshDashboard();
      return;
    }
    const validated = validateJobDraft(applied.draft);
    if (!validated.ok) {
      logLine(`ez-code-factory: job-save refused — ${validated.error}`);
      await refreshDashboard();
      return;
    }

    const actor = event.userId || "system";
    if (existing) {
      const updated = await store.updateJob(existing.id, { ...validated.value, updatedBy: actor });
      if (updated) {
        await getAudit().append({ actor, kind: "job-save", jobId: existing.id, detail: diffJob(existing, updated) });
      }
    } else {
      const nowIso = new Date().toISOString();
      const job: Job = {
        id: newJobId(),
        ...validated.value,
        createdBy: actor,
        createdAt: nowIso,
        updatedBy: actor,
        updatedAt: nowIso,
      };
      await store.createJob(job);
      await getAudit().append({ actor, kind: "job-create", jobId: job.id, detail: { name: job.name, trigger: job.trigger } });
    }
    await refreshDashboard();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logLine(`ez-code-factory: job-save handler error: ${message}`);
  }
}

/** `job-toggle` Hub action — flip a job's enabled flag (`{ jobId }`). Audited. */
export async function handleJobToggle(event: PageActionEvent): Promise<void> {
  try {
    const guard = await guardScope(rbacCheckImpl, MANAGE_JOBS_SCOPE, "manage jobs");
    if (!guard.ok) {
      logLine(`ez-code-factory: job-toggle refused — ${guard.error}`);
      return;
    }
    const jobId = parseJobIdPayload(event.payload);
    if (!jobId) {
      logLine("ez-code-factory: job-toggle with invalid payload — ignored");
      return;
    }
    const store = getJobStore();
    const jobs = await loadJobsWithDefault(store, getAudit());
    const job = jobs.find((j) => j.id === jobId);
    if (!job) {
      logLine(`ez-code-factory: job-toggle for unknown job ${jobId} — ignored`);
      return;
    }
    const actor = event.userId || "system";
    const next = !job.enabled;
    await store.updateJob(jobId, { enabled: next, updatedBy: actor });
    await getAudit().append({ actor, kind: "job-toggle", jobId, detail: { enabled: next } });
    await refreshDashboard();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logLine(`ez-code-factory: job-toggle handler error: ${message}`);
  }
}

/** `job-delete` Hub action — remove a job definition (`{ jobId }`). The DEFAULT
 *  job is protected (deleting it would break today's every-branch behaviour), so
 *  its deletion is refused. Audited. */
export async function handleJobDelete(event: PageActionEvent): Promise<void> {
  try {
    const guard = await guardScope(rbacCheckImpl, MANAGE_JOBS_SCOPE, "manage jobs");
    if (!guard.ok) {
      logLine(`ez-code-factory: job-delete refused — ${guard.error}`);
      return;
    }
    const jobId = parseJobIdPayload(event.payload);
    if (!jobId) {
      logLine("ez-code-factory: job-delete with invalid payload — ignored");
      return;
    }
    if (jobId === DEFAULT_JOB_ID) {
      logLine("ez-code-factory: job-delete refused — the default job cannot be deleted");
      await refreshDashboard();
      return;
    }
    const store = getJobStore();
    const jobs = await loadJobsWithDefault(store, getAudit());
    const job = jobs.find((j) => j.id === jobId);
    if (!job) {
      logLine(`ez-code-factory: job-delete for unknown job ${jobId} — ignored`);
      return;
    }
    const actor = event.userId || "system";
    await store.deleteJob(jobId);
    await getAudit().append({ actor, kind: "job-delete", jobId, detail: { name: job.name } });
    await refreshDashboard();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logLine(`ez-code-factory: job-delete handler error: ${message}`);
  }
}

/** `run-now` Hub action — manually fire a run for an ENABLED job (`{ jobId }`) on
 *  its concrete branch at the branch's current head, via the SAME synthesized-run
 *  path the schedule tick uses (force: no no-change skip — the user asked for it).
 *  A disabled job, a glob-pattern push job (no single branch), or a branch the
 *  gate never received is refused/no-run. Audited with the acting user. */
export async function handleRunNow(event: PageActionEvent): Promise<void> {
  try {
    const guard = await guardScope(rbacCheckImpl, MANAGE_JOBS_SCOPE, "run a job now");
    if (!guard.ok) {
      logLine(`ez-code-factory: run-now refused — ${guard.error}`);
      return;
    }
    const jobId = parseJobIdPayload(event.payload);
    if (!jobId) {
      logLine("ez-code-factory: run-now with invalid payload — ignored");
      return;
    }
    const projectRoot = projectRootImpl();
    if (!projectRoot) {
      logLine(`ez-code-factory: run-now for job ${jobId} with no resolvable project root — ignored`);
      return;
    }
    const store = getJobStore();
    const jobs = await loadJobsWithDefault(store, getAudit());
    const job = jobs.find((j) => j.id === jobId);
    if (!job) {
      logLine(`ez-code-factory: run-now for unknown job ${jobId} — ignored`);
      return;
    }
    // run-now REQUIRES an enabled job (spec L7): a disabled job is refused.
    if (!job.enabled) {
      logLine(`ez-code-factory: run-now refused — job ${jobId} is disabled`);
      await refreshDashboard();
      return;
    }
    const branch = jobConcreteBranch(job);
    if (!branch) {
      logLine(`ez-code-factory: run-now for job ${jobId} needs a concrete branch (glob push pattern) — ignored`);
      await refreshDashboard();
      return;
    }
    const rId = repoIdFor(projectRoot);
    const gDir = gateDirFor(projectRoot, rId);
    const actor = event.userId || "system";
    const newSha = await resolveJobHead(gDir, branch);
    if (!newSha) {
      await getAudit().append({ actor, kind: "run-now-no-branch", jobId, detail: { branch } });
      logLine(`ez-code-factory: run-now for job ${jobId} — branch '${branch}' not in the gate repo`);
      await refreshDashboard();
      return;
    }
    const result = await runJobLifecycle(job, { projectRoot, gDir, repoId: rId, branch, newSha });
    // Bookkeep the head so a following schedule tick sees no-change (never a
    // double run). Manual fire does NOT touch lastScheduleFireAt.
    await store.updateJob(jobId, { lastHeadSha: newSha });
    await getAudit().append({ actor, kind: "run-now", jobId, runId: result.runId, detail: { branch, headSha: newSha } });
    await refreshDashboard();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logLine(`ez-code-factory: run-now handler error: ${message}`);
  }
}

// ── Reconcile sweep (M6, background loop) ─────────────────────────────
//
// The scheduled catch-up the README promised: every SWEEP_CRON fire re-checks
// each reconcilable run and completes the ones whose PR merged/closed. Ownerless
// (a cron fire has no acting user) — reconcile is read-only truth-driven and
// never RBAC-gated. Drives the SAME resume + reconcile runner the Hub "Re-check
// PR state" button uses, resolving each run's own gate dir.

/** Reconcile ONE run (resume + the read-only ReconcileApprovalGate poll). Null
 *  when the run is gone / cannot resume / carries no resolvable root. */
async function reconcileOneRun(fallbackRoot: string | undefined, runId: string): Promise<ReconcileResult> {
  const rec = await getStore().getRun(runId);
  if (!rec) return null;
  // Per-run root: the record's own stamped root (hash-validated) beats the
  // sweep-level ctx/env fallback — one subprocess may hold runs from several
  // projects, and the env var can only ever name one of them.
  const projectRoot = validatedProjectRoot(rec.projectRoot, rec.repoId) ?? fallbackRoot;
  if (!projectRoot) {
    logLine(`ez-code-factory[sweep]: run ${runId} has no resolvable project root — skipped`);
    return null;
  }
  const gDir = gateDirFor(projectRoot, rec.repoId);
  return resumeGateLifecycle(runId, {
    gateDir: gDir,
    store: getStore(),
    run: shellImpl,
    onChange: refreshDashboard,
    respond: makeReconcileRunnerImpl(projectRoot, gDir),
  });
}

/** Run one reconcile sweep (the cron fire's work). Records a heartbeat for
 *  `code_factory_doctor`. Runs resolve their own stamped roots, so the sweep
 *  no longer needs an active-project env var to do useful work. */
export async function runReconcileSweep(): Promise<SweepSummary> {
  // A cron fire has no tool-call context; ctx/env is only a FALLBACK here.
  // Each run resolves its own stamped (hash-validated) root inside
  // reconcileOneRun, so the sweep still works when the env var is unset —
  // the structural norm in prod, where one subprocess serves every project.
  const fallbackRoot = projectRootImpl();
  return reconcileSweep({
    store: getStore(),
    reconcile: (runId) => reconcileOneRun(fallbackRoot, runId),
    // Staleness pass (L3): read each running run's per-run heartbeat so a
    // silent (dead-executor) run is truthfully marked `stalled`.
    readHeartbeat: (runId) => runHeartbeatKVImpl().read(runId),
    now: () => Date.now(),
    recordHeartbeat: (hb) => heartbeatKVImpl().write(hb),
    log: (m) => logLine(`ez-code-factory[sweep]: ${m}`),
  });
}

/** Resolve a branch's current head in the gate bare repo (where pushes land). A
 *  branch the gate has never received → rev-parse fails → "" (no head to run).
 *  Shared by the schedule tick + the manual run-now path. */
async function resolveJobHead(gDir: string, branch: string): Promise<string> {
  const rev = await shellImpl(["git", "-C", gDir, "rev-parse", `refs/heads/${branch}`], gDir);
  return rev.exitCode === 0 ? rev.stdout.trim() : "";
}

/** Drive `runGateLifecycle` for a synthesized (schedule/manual) job run on a
 *  concrete branch at `newSha`, with the job's step-skip overlay + id stamped —
 *  the SAME entry point a push takes. Shared by the schedule tick and the
 *  run-now action (the committed schedule path, spec L4/L7). The job's last
 *  bookkept head anchors force-push safety (base). */
function runJobLifecycle(
  job: Job,
  o: { projectRoot: string; gDir: string; repoId: string; branch: string; newSha: string },
) {
  return runGateLifecycle(
    {
      repoId: o.repoId,
      branch: o.branch,
      ref: `refs/heads/${o.branch}`,
      newSha: o.newSha,
      oldSha: job.lastHeadSha ?? "0".repeat(40),
      ...(job.intentTemplate ? { intent: job.intentTemplate } : {}),
    },
    {
      gateDir: o.gDir,
      tmpBase: tmpBaseImpl(o.projectRoot),
      store: getStore(),
      run: shellImpl,
      onChange: refreshDashboard,
      runPipeline: makeRunPipelineImpl(o.projectRoot, o.gDir, job),
      projectRoot: o.projectRoot,
      jobId: job.id,
    },
  );
}

/**
 * Synthesize runs for SCHEDULE-trigger jobs that are due on this sweep tick
 * (control plane, L4). Reuses the existing every-15-min sweep tick as the job
 * tick — no new manifest cron, no in-ext cron parser. A cron fire is
 * context-free, so we resolve the project from the ctx/env fallback root (the
 * same source the reconcile sweep uses); when it is unresolvable this is a
 * logged no-op. For each due job whose branch HEAD actually advanced past the
 * job's last bookkept head (never mint a no-op run — C2 no-change skip), we
 * drive `runGateLifecycle` on the job's branch with its jobId stamped, then
 * bookkeep the head + fire time. Every outcome (fired / no-change / no-branch)
 * is audited so the tick is never silent. Best-effort: a per-job failure is
 * logged + audited and never aborts the tick.
 *
 * `now` is injected so tests can drive the coarse due boundaries deterministically.
 */
export async function synthesizeScheduledRuns(now: Date): Promise<void> {
  const projectRoot = projectRootImpl();
  if (!projectRoot) return; // context-free tick with no resolvable project — no-op
  const rId = repoIdFor(projectRoot);
  const gDir = gateDirFor(projectRoot, rId);
  const audit = getAudit();
  const jobStore = getJobStore();

  const jobs = await loadJobsWithDefault(jobStore, audit);
  for (const job of jobs) {
    if (job.trigger.kind !== "schedule" || !job.enabled) continue;
    const lastFire = job.lastScheduleFireAt ? new Date(job.lastScheduleFireAt) : null;
    if (!isScheduleJobDue(job, now, lastFire)) continue;

    const branch = job.trigger.branch;
    try {
      // Current branch head in the gate bare repo (where pushes land). A branch
      // the gate has never received → rev-parse fails → nothing to run.
      const newSha = await resolveJobHead(gDir, branch);
      if (!newSha) {
        await audit.append({ actor: "system", kind: "schedule-no-branch", jobId: job.id, detail: { branch } });
        await jobStore.updateJob(job.id, { lastScheduleFireAt: now.toISOString() });
        continue;
      }
      // C2 no-change skip: never mint a no-op run when HEAD hasn't moved.
      if (!shouldSynthesizeRun(job, newSha)) {
        await audit.append({ actor: "system", kind: "schedule-no-change", jobId: job.id, detail: { branch, headSha: newSha } });
        await jobStore.updateJob(job.id, { lastScheduleFireAt: now.toISOString() });
        continue;
      }
      const result = await runJobLifecycle(job, { projectRoot, gDir, repoId: rId, branch, newSha });
      await jobStore.updateJob(job.id, { lastHeadSha: newSha, lastScheduleFireAt: now.toISOString() });
      await audit.append({
        actor: "system",
        kind: "schedule-fire",
        jobId: job.id,
        runId: result.runId,
        detail: { branch, headSha: newSha, every: job.trigger.every },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logLine(`ez-code-factory[schedule]: job ${job.id} synthesis error: ${message}`);
      await audit.append({ actor: "system", kind: "schedule-error", jobId: job.id, detail: { branch, error: message } }).catch(() => {});
    }
  }
}

/** The SWEEP_CRON schedule-fire handler — runs one reconcile sweep, then routes
 *  due schedule-trigger jobs (control plane, L4). Each stage swallows its own
 *  throw (a cron fire is fire-and-forget; a thrown handler must not escape). */
export async function handleScheduleFire(_ctx: ScheduleHandlerContext): Promise<void> {
  const now = new Date();
  try {
    const summary = await runReconcileSweep();
    // Audit the sweep outcome (L5): counts only, no run content.
    await getAudit().append({
      actor: "system",
      kind: "sweep",
      detail: {
        scanned: summary.scanned,
        advanced: summary.advanced,
        stillParked: summary.stillParked,
        skipped: summary.skipped,
        stalled: summary.stalled,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logLine(`ez-code-factory: reconcile sweep error: ${message}`);
  }
  try {
    await synthesizeScheduledRuns(now);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logLine(`ez-code-factory: schedule job routing error: ${message}`);
  }
  // Retention (L5): prune audit buckets older than 30 days on the sweep tick.
  try {
    await getAudit().pruneRetention(now);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logLine(`ez-code-factory: audit retention prune error: ${message}`);
  }
}

// ── Crash recovery (M6, startup) ──────────────────────────────────────

/** Re-derive parked state + reap orphaned worktrees on (re)start.
 *  Fire-and-forget from `start()`. Runs resolve their own stamped roots. */
export async function recoverOnStart(): Promise<RecoverySummary> {
  // Boot fire — no tool-call context. Same per-run root resolution as the
  // sweep: the record's stamped (hash-validated) root, ctx/env as fallback.
  const fallbackRoot = projectRootImpl();
  return recoverRuns({
    store: getStore(),
    reapWorktree: (run) => {
      const projectRoot = validatedProjectRoot(run.projectRoot, run.repoId) ?? fallbackRoot;
      if (!projectRoot) {
        logLine(`ez-code-factory[recovery]: run ${run.id} has no resolvable project root — worktree not reaped`);
        return Promise.resolve();
      }
      return removeWorktree(shellImpl, gateDirFor(projectRoot, run.repoId), run.worktreePath ?? "");
    },
    log: (m) => logLine(`ez-code-factory[recovery]: ${m}`),
  });
}

/** Dashboard render — variant picked from the host's `perProject` context:
 *  a single project's view on `/project/<id>/hub/...`, the all-projects home
 *  on the global hub, or the classic combined dashboard when the host sends
 *  no context (older host / flag off). Parked-run details (serial per-step
 *  store reads) are collected ONLY for the runs the variant will actually
 *  inline — a project view never pays for other projects' triage. */
export async function renderDashboard(ctx?: PageRenderContext) {
  const store = getStore();
  // Step-detail variant (`?run=<id>&step=<name>`): render ONE step's detail —
  // its per-round inputs/outputs — BEFORE the run branch (a step is a
  // sub-variant of a run; the SDK only supplies `step` alongside `run`).
  if (ctx?.run && ctx?.step) {
    return renderStepDetail(store, ctx.run, ctx.step, ctx);
  }
  // Run-detail variant (`?run=<id>`): render ONE run's read-only detail
  // (meta + step results + agent-turn provenance) instead of the dashboard.
  // Reachable from either hub, so it takes precedence over project context.
  if (ctx?.run) {
    return renderRunDetail(store, ctx.run, ctx);
  }
  // Control-plane view variant (`?view=config|job:<id>|audit[:<day>]`): an
  // alternate page surface. Precedence (spec L6): run+step > run > VIEW >
  // project > projects > dashboard — so it wins over project context (a config/
  // audit render on the project hub is the config/audit, not that project's
  // dashboard). Unknown/malformed view → empty state (never a throw).
  if (ctx?.view) {
    return renderViewVariant(store, ctx.view, ctx);
  }
  const runs = await store.listRuns();
  // Derived-stalled ids (immediate truthfulness — the sweep persists them
  // durably on its own cadence). Computed once and threaded into every builder.
  const stalledRunIds = await computeStalledRunIds(runs);
  if (ctx?.project) {
    const own = runsForProject(ctx.project, runs);
    return buildProjectDashboard(ctx.project, runs, await collectParkedDetails(store, own), stalledRunIds);
  }
  if (ctx?.projects) {
    const orphans = orphanRuns(ctx.projects, runs);
    return buildHome(ctx.projects, runs, await collectParkedDetails(store, orphans), stalledRunIds);
  }
  return buildDashboard(runs, await collectParkedDetails(store, runs), stalledRunIds);
}

// ── Wiring ───────────────────────────────────────────────────────────

export const tools: Record<string, ToolHandler> = {
  init_gate: initGateTool,
  code_factory_run: codeFactoryRunTool,
  code_factory_status: codeFactoryStatusTool,
  code_factory_respond: codeFactoryRespondTool,
  code_factory_doctor: codeFactoryDoctorTool,
};

/** Register the page (+ its push-received action), the reconcile-sweep cron
 *  handler, and the tool dispatcher, and return — no stdin side effects (tests
 *  call this against a stubbed channel). */
export function register(): void {
  definePage({
    id: PAGE_ID,
    render: renderDashboard,
    actions: {
      [PUSH_RECEIVED_ACTION]: handlePushReceived,
      [RESPOND_ACTION]: handleRespond,
      [YOLO_ACTION]: handleYolo,
      [RECONCILE_ACTION]: handleReconcile,
      // Control-plane job actions (L7) — RBAC-gated (manage-jobs) + audited.
      [JOB_SAVE_ACTION]: handleJobSave,
      [JOB_TOGGLE_ACTION]: handleJobToggle,
      [JOB_DELETE_ACTION]: handleJobDelete,
      [RUN_NOW_ACTION]: handleRunNow,
    },
  });
  // M6: the background reconcile sweep (cron declared in ezcorp.config.ts).
  new Schedule().on(SWEEP_CRON, handleScheduleFire);
  createToolDispatcher(tools);
}

export function start(): void {
  register();
  getChannel().start();
  // M6: re-derive parked state + reap orphaned worktrees left by the last
  // process (fire-and-forget — a restart must not block on recovery). MUST be
  // .catch-wrapped: an unhandled rejection here kills the subprocess at boot.
  // The known rejecter is the host's provenance gate — a raw boot fire carries
  // no host-issued ezCallId, so the store RPC fails fast (-32602) on hosts
  // that don't mint boot provenance; recovery then waits for the next
  // provenanced fire (the reconcile sweep) instead of crashing the extension.
  recoverOnStart().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    logLine(`ez-code-factory: crash recovery skipped: ${message}`);
  });
}

// Production wiring — gated on import.meta.main so test imports don't open stdin.
if (import.meta.main) start();
