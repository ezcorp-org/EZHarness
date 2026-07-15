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
  pushPage,
  toolError,
  toolResult,
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
  initGate,
} from "./lib/gate";
import { buildDashboard } from "./lib/page";
import {
  createRunStore,
  parsePushReceived,
  runGateLifecycle,
  type RunStore,
} from "./lib/runs";
import { productionHostRunner, type ShellRunner } from "./lib/shell";

/** Full namespaced action name the post-receive hook triggers. */
export const PUSH_RECEIVED_ACTION = `${EXTENSION_NAME}:${TRIGGER_EVENT}`;

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

/** Push a fresh dashboard tree (content-free SSE invalidation → open tabs
 *  re-pull). Reads the global run store only (the shared, cross-user tree). */
async function refreshDashboard(): Promise<void> {
  pushPageImpl(PAGE_ID, buildDashboard(await getStore().listRuns()));
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
    });
    if (!result.ok) {
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

/** Dashboard render — the runs table (global scope). */
export async function renderDashboard() {
  return buildDashboard(await getStore().listRuns());
}

// ── Wiring ───────────────────────────────────────────────────────────

export const tools: Record<string, ToolHandler> = {
  init_gate: initGateTool,
};

/** Register the page (+ its push-received action), the tool dispatcher, and
 *  return — no stdin side effects (tests call this against a stubbed channel). */
export function register(): void {
  definePage({
    id: PAGE_ID,
    render: renderDashboard,
    actions: {
      [PUSH_RECEIVED_ACTION]: handlePushReceived,
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
