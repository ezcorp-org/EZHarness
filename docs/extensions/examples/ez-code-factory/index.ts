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
// Logging is via the subprocess's stderr (the host-only `extensionLogger`
// convention does not apply — decision #1 leaves M0 with no host-side code).

import {
  createToolDispatcher,
  definePage,
  getChannel,
  getToolContext,
  invoke,
  pushPage,
  Storage,
  toolError,
  toolResult,
  type HubPageTree,
  type PageActionEvent,
  type ToolHandler,
} from "@ezcorp/sdk/runtime";
import {
  GATE_REMOTE,
  PAGE_ID,
  TRIGGER_EVENT,
  EXTENSION_NAME,
  DEFAULT_BASE_URL,
  gateDir as gateDirFor,
  repoId as repoIdFor,
  initGate,
} from "./lib/gate";
import {
  runChatTool,
  statusChatTool,
  respondChatTool,
  type ChatToolDeps,
  type ChatToolOutcome,
} from "./lib/chat-tools";
import { createIntentCache, makeConversationIntentInferrer } from "./lib/intent-infer";
import { join } from "node:path";
import { buildDashboard, normalizeRespondPayload, parseRunIdPayload, type RunDetail } from "./lib/page";
import {
  createRunStore,
  parsePushReceived,
  parseRespondPayload,
  runGateLifecycle,
  resumeGateLifecycle,
  type ParsedRespond,
  type RunRecord,
  type RunStore,
  type StepResultRecord,
} from "./lib/runs";
import { productionHostRunner, type ShellRunner } from "./lib/shell";
import { PIPELINE_STEPS, resolvePipelineConfig, type PipelineConfig, type PipelineStep } from "./lib/config";
import { makeSpawnDispatcher } from "./lib/agent";
import { makeJailedShell } from "./lib/jail";
import { makeGit } from "./lib/git";
import { resolveTrustedRepoConfig } from "./lib/repo-config";
import { startPipeline, respondToGate, reconcileGate, type ExecutorDeps } from "./lib/executor";
import { makeGhRunner, resolveGhToken, type TokenStorage } from "./lib/gh-runner";

/** Full namespaced action name the post-receive hook triggers. */
export const PUSH_RECEIVED_ACTION = `${EXTENSION_NAME}:${TRIGGER_EVENT}`;
/** The gate action the M2 approval UI (and any harness) drives to answer a
 *  parked gate: `{ runId, step, action: approve|fix|skip|abort, … }`. */
export const RESPOND_ACTION = `${EXTENSION_NAME}:respond`;
/** The M2 "yolo" action: auto-approve every remaining gate of one run in a
 *  single click (`{ runId, step }`). Bypasses per-gate human review. */
export const YOLO_ACTION = `${EXTENSION_NAME}:yolo`;
/** The M4 "reconcile" action: re-check a run parked at the CI gate — a read-only
 *  ReconcileApprovalGate poll that auto-resolves the gate when its PR has
 *  merged/closed (`{ runId }`). Harness/future-sweep-triggerable. */
export const RECONCILE_ACTION = `${EXTENSION_NAME}:reconcile`;

// ── Injectable seams (production defaults; tests override) ────────────
//
// Each seam's production default is a SINGLE named closure reused by both the
// initial binding and the `_set*ForTests(null)` reset — one function to cover
// (DRY) instead of a duplicated inline fallback the reset path never exercises.

const defaultProjectRoot = (): string | undefined => process.env.EZCORP_PROJECT_ROOT;
let projectRootImpl: () => string | undefined = defaultProjectRoot;
export function _setProjectRootForTests(fn: (() => string | undefined) | null): void {
  projectRootImpl = fn ?? defaultProjectRoot;
}

const defaultTmpBase = (): string => process.env.TMPDIR || "/tmp";
let tmpBaseImpl: () => string = defaultTmpBase;
export function _setTmpBaseForTests(fn: (() => string) | null): void {
  tmpBaseImpl = fn ?? defaultTmpBase;
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

let pushPageImpl: typeof pushPage = pushPage;
export function _setPushPageForTests(fn: typeof pushPage | null): void {
  pushPageImpl = fn ?? pushPage;
}

// ── GitHub-token seam (the pr/ci steps' gh auth) ──────────────────────
//
// The `type:"secret"` `githubToken` setting is stored ENCRYPTED in user-scoped
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
): ExecutorDeps {
  const evidenceDir = join(tmpBaseImpl(), "ez-code-factory-evidence");
  return {
    store: getStore(),
    worktree: worktreePath,
    gateDir,
    workingPath: projectRoot,
    tmpBase: tmpBaseImpl(),
    config,
    dispatcher: makeSpawnDispatcher({ evidenceDir }),
    hostRunner: shellImpl,
    jailedRunner: makeJailedShell(gateDir, projectRoot),
    // The pr/ci steps shell `gh` in the worktree with GH_TOKEN injected from the
    // encrypted `githubToken` secret (skip-not-fail when gh is unauthenticated).
    gh: makeGhRunner(shellImpl, worktreePath, resolveProductionGhToken),
    // SECURITY (spec §1 invariant 1): resolve the trusted-branch-gated repo
    // config from the freshly-fetched default branch BEFORE any agent runs. The
    // pushed copy is read from the worktree HEAD (the checked-out pushed SHA). A
    // failure here aborts the run fail-closed inside startPipeline.
    resolveRepoConfig: () =>
      resolveTrustedRepoConfig(makeGit(shellImpl, worktreePath), config.defaultBranch, "HEAD"),
    now: () => Date.now(),
    onChange: refreshDashboard,
    log: (runId, step, message) =>
      process.stderr.write(`ez-code-factory[${runId}/${step}]: ${message}\n`),
  };
}

const defaultRunPipeline = (projectRoot: string, gateDir: string): PipelineRunner => {
  return async ({ runId, worktreePath }) => {
    const config = await resolveLiveConfig();
    const outcome = await startPipeline(
      runId,
      buildExecutorDeps(projectRoot, gateDir, worktreePath, config),
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
  const evidenceDir = join(tmpBaseImpl(), "ez-code-factory-evidence");
  const log = (message: string): void => {
    process.stderr.write(`ez-code-factory[chat]: ${message}\n`);
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
        tmpBase: tmpBaseImpl(),
        store: getStore(),
        run: shellImpl,
        onChange: refreshDashboard,
        runPipeline: makeRunPipelineImpl(projectRoot, gDir),
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

/** `code_factory_respond` — approve/fix/skip/abort a parked gate (contract-in-code). */
export const codeFactoryRespondTool: ToolHandler = (args) =>
  dispatchChatTool<Parameters<typeof respondChatTool>[0]>(args, respondChatTool);

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

/** The current dashboard tree (runs list + inline triage detail for parked
 *  runs). The single source both the render-pull and the push-refresh use. */
async function currentDashboardTree(): Promise<HubPageTree> {
  const store = getStore();
  const runs = await store.listRuns();
  const details = await collectParkedDetails(store, runs);
  return buildDashboard(runs, details);
}

/** Push a fresh dashboard tree (content-free SSE invalidation → open tabs
 *  re-pull). Reads the global run store only (the shared, cross-user tree). */
async function refreshDashboard(): Promise<void> {
  pushPageImpl(PAGE_ID, await currentDashboardTree());
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
  return toolResult(
    JSON.stringify({
      ok: true,
      repoId: res.repoId,
      gateRemote: res.gateRemote,
      gateDir: res.gateDir,
      credentialPath: res.credentialPath,
      bareCreated: res.bareCreated,
      hookAction: res.hookAction,
      remoteAction: res.remoteAction,
      pushHint: `git push ${GATE_REMOTE} <branch>`,
      warnings: res.warnings,
    }),
  );
};

/** `push-received` Hub action — the post-receive hook's trigger target. The
 *  `payload` is attacker-controlled; validate every field before acting. The
 *  whole body is wrapped: this is a fire-and-forget notification handler, so a
 *  throw here is otherwise SWALLOWED by the SDK channel (no id → no error
 *  frame), hiding the failure entirely. Emit one stderr line instead. */
export async function handlePushReceived(event: PageActionEvent): Promise<void> {
  try {
    const projectRoot = projectRootImpl();
    if (!projectRoot) {
      process.stderr.write("ez-code-factory: push-received with no EZCORP_PROJECT_ROOT — ignored\n");
      return;
    }
    const push = parsePushReceived(event.payload);
    if (!push) {
      process.stderr.write("ez-code-factory: push-received with invalid payload — ignored\n");
      return;
    }
    const gDir = gateDirFor(projectRoot, push.repoId);
    const result = await runGateLifecycle(push, {
      gateDir: gDir,
      tmpBase: tmpBaseImpl(),
      store: getStore(),
      run: shellImpl,
      onChange: refreshDashboard,
      runPipeline: makeRunPipelineImpl(projectRoot, gDir),
    });
    // `ok` is true only for `completed`; awaiting_approval (parked) and
    // checks_passed (rested green) are success-ish non-terminal states, not
    // failures, so they are NOT logged as errors.
    if (!result.ok && result.status !== "awaiting_approval" && result.status !== "checks_passed") {
      process.stderr.write(
        `ez-code-factory: run ${result.runId} failed: ${result.error ?? "unknown"}\n`,
      );
    }
  } catch (err) {
    // runGateLifecycle marks its own run failed; this guards anything outside it
    // (payload parse, store construction, worktree teardown) whose throw the
    // channel would swallow.
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`ez-code-factory: push-received handler error: ${message}\n`);
  }
}

/** `respond` Hub action — answers a parked gate (approve/fix/skip/abort). The
 *  payload is attacker-reachable via the events route; validate every field.
 *  The verbatim ask-user relay + no-blanket-approval rules are enforced
 *  structurally by the executor's respond semantics, not prose (decision #4). */
export async function handleRespond(event: PageActionEvent): Promise<void> {
  try {
    const projectRoot = projectRootImpl();
    if (!projectRoot) {
      process.stderr.write("ez-code-factory: respond with no EZCORP_PROJECT_ROOT — ignored\n");
      return;
    }
    // Normalize the Hub's flat scalar action payload (findingId + instruction)
    // into M1's canonical findingIds[]/instructions{} shape, then validate via
    // the single M1 validator. A harness POST that already sends the canonical
    // shape passes through untouched.
    const respond = parseRespondPayload(normalizeRespondPayload(event.payload));
    if (!respond) {
      process.stderr.write("ez-code-factory: respond with invalid payload — ignored\n");
      return;
    }
    const rec = await getStore().getRun(respond.runId);
    if (!rec) {
      process.stderr.write(`ez-code-factory: respond for unknown run ${respond.runId} — ignored\n`);
      return;
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
      process.stderr.write(`ez-code-factory: respond for run ${respond.runId} could not resume\n`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`ez-code-factory: respond handler error: ${message}\n`);
  }
}

/** The parked step of a run (the first step awaiting approval / fix review),
 *  read from the store. Null when nothing is parked. */
async function findParkedStep(store: RunStore, runId: string): Promise<PipelineStep | null> {
  for (const step of PIPELINE_STEPS) {
    const sr = await store.getStepResult(runId, step);
    if (sr && (sr.status === "awaiting_approval" || sr.status === "fix_review")) return step;
  }
  return null;
}

/** Hard bound on the yolo auto-approve loop — a run can park at most once per
 *  pipeline step, so it can never legitimately exceed the step count. */
const YOLO_MAX_GATES = PIPELINE_STEPS.length + 1;

/**
 * The yolo autopilot: approve the current parked gate and every gate the run
 * re-parks at, until the run reaches a terminal state (or can no longer be
 * resumed). Each iteration reuses the EXACT M1 approve path
 * (`resumeGateLifecycle` → `respondToGate`) — no bypass of the gate semantics,
 * just a bounded sequence of real approvals. Bounded by `YOLO_MAX_GATES` so a
 * pathological loop can never spin.
 */
async function runYoloAutopilot(runId: string, projectRoot: string): Promise<void> {
  const store = getStore();
  for (let i = 0; i < YOLO_MAX_GATES; i++) {
    const rec = await store.getRun(runId);
    if (!rec || rec.status !== "awaiting_approval") return; // terminal / gone / not parked
    const step = await findParkedStep(store, runId);
    if (!step) return; // parked run with no parked step — nothing to approve
    const gDir = gateDirFor(projectRoot, rec.repoId);
    const respond: ParsedRespond = {
      runId,
      step,
      action: "approve",
      findingIds: [],
      instructions: {},
      addedFindings: [],
    };
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

/** `yolo` Hub action — auto-approve every remaining gate of one run. The
 *  payload is attacker-reachable via the events route; validate the runId. */
export async function handleYolo(event: PageActionEvent): Promise<void> {
  try {
    const projectRoot = projectRootImpl();
    if (!projectRoot) {
      process.stderr.write("ez-code-factory: yolo with no EZCORP_PROJECT_ROOT — ignored\n");
      return;
    }
    const runId = parseRunIdPayload(event.payload);
    if (!runId) {
      process.stderr.write("ez-code-factory: yolo with invalid payload — ignored\n");
      return;
    }
    await runYoloAutopilot(runId, projectRoot);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`ez-code-factory: yolo handler error: ${message}\n`);
  }
}

/** `reconcile` Hub action — re-check a run parked at the CI gate. Drives the CI
 *  step's ReconcileApprovalGate through resumeGateLifecycle (which reattaches the
 *  kept worktree + tears it down only on a persisted terminal status), so a
 *  merged/closed PR auto-resolves the gate and the run completes. Read-only when
 *  the gate does not resolve — the run stays parked. Payload: `{ runId }`. */
export async function handleReconcile(event: PageActionEvent): Promise<void> {
  try {
    const projectRoot = projectRootImpl();
    if (!projectRoot) {
      process.stderr.write("ez-code-factory: reconcile with no EZCORP_PROJECT_ROOT — ignored\n");
      return;
    }
    const runId = parseRunIdPayload(event.payload);
    if (!runId) {
      process.stderr.write("ez-code-factory: reconcile with invalid payload — ignored\n");
      return;
    }
    const rec = await getStore().getRun(runId);
    if (!rec) {
      process.stderr.write(`ez-code-factory: reconcile for unknown run ${runId} — ignored\n`);
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
      process.stderr.write(`ez-code-factory: reconcile for run ${runId} could not resume\n`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`ez-code-factory: reconcile handler error: ${message}\n`);
  }
}

/** Dashboard render — the runs table + inline parked-run triage (global scope). */
export async function renderDashboard() {
  return currentDashboardTree();
}

// ── Wiring ───────────────────────────────────────────────────────────

export const tools: Record<string, ToolHandler> = {
  init_gate: initGateTool,
  code_factory_run: codeFactoryRunTool,
  code_factory_status: codeFactoryStatusTool,
  code_factory_respond: codeFactoryRespondTool,
};

/** Register the page (+ its push-received action), the tool dispatcher, and
 *  return — no stdin side effects (tests call this against a stubbed channel). */
export function register(): void {
  definePage({
    id: PAGE_ID,
    render: renderDashboard,
    actions: {
      [PUSH_RECEIVED_ACTION]: handlePushReceived,
      [RESPOND_ACTION]: handleRespond,
      [YOLO_ACTION]: handleYolo,
      [RECONCILE_ACTION]: handleReconcile,
    },
  });
  createToolDispatcher(tools);
}

export function start(): void {
  register();
  getChannel().start();
}

// Production wiring — gated on import.meta.main so test imports don't open stdin.
if (import.meta.main) start();
