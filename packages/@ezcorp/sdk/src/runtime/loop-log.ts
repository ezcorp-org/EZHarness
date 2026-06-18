// ── Loop log — artifact mirror + opt-in dashboard ───────────────────
//
// The human-facing projections of a loop's runs (§4.4 of the design):
//
//   1. ARTIFACT MIRROR — a fail-soft, human-/agent-readable file written
//      under `.ezcorp/extension-data/<loop>/` via the host-mediated
//      `fsWrite` (NEVER `node:fs`, which the sandbox poisons). This is a
//      mirror, never the source of truth — durable state stays in Storage.
//   2. DASHBOARD — an opt-in Hub page that re-renders the run list, with
//      content-free SSE invalidation on every state change (`pushPage`)
//      and row-action dispatch (cancel/steer/open-pr). Generalizes
//      ez-code's `buildDashboard` + `pushSharedDashboard`.
//
// Both are declared on `defineLoop({ log })` and owned here so `loop.ts`
// stays free of fs/page concerns.

import { join } from "node:path";

import { fsWrite, fsMkdir } from "./fs";
import { PageBuilder, definePage, pushPage } from "./page";
import type { HubPageTree } from "./page";
import type { RegisteredLoop } from "./loop";
import type { LoopRunState } from "./loop-types";

// Injectable seams (test-only) so the artifact/dashboard side effects can
// be observed without a live channel.
let fsWriteImpl: typeof fsWrite = fsWrite;
let fsMkdirImpl: typeof fsMkdir = fsMkdir;
let definePageImpl: typeof definePage = definePage;
let pushPageImpl: typeof pushPage = pushPage;

/** @internal test-only — override the host-mediated fs writers. */
export function _setLogFsForTests(
  write: typeof fsWrite | null,
  mkdir: typeof fsMkdir | null,
): void {
  fsWriteImpl = write ?? fsWrite;
  fsMkdirImpl = mkdir ?? fsMkdir;
}
/** @internal test-only — observe page registration + pushes. */
export function _setLogPageForTests(
  define: typeof definePage | null,
  push: typeof pushPage | null,
): void {
  definePageImpl = define ?? definePage;
  pushPageImpl = push ?? pushPage;
}

/** The project root the host injects at spawn. Falls back to cwd for the
 *  host-side / build paths. `node:path` join is sandbox-safe; `node:fs` is
 *  NOT, so we never walk for `.git` here. */
function projectRoot(): string {
  return process.env.EZCORP_PROJECT_ROOT ?? process.cwd();
}

/** Absolute `.ezcorp/extension-data/<loop>/` directory for a loop. */
export function loopDataDir(loopId: string): string {
  return join(projectRoot(), ".ezcorp", "extension-data", loopId);
}

/**
 * Wire a loop's `log` block at registration time. When `log.dashboard` is
 * present, register the Hub page (render + row-action handlers) and attach
 * `reg.pushDashboard` so the fire/transition paths can push a fresh tree.
 * A loop with no dashboard is a no-op.
 */
export function wireLog(reg: RegisteredLoop): void {
  const dashboard = reg.def.log?.dashboard;
  if (!dashboard) return;

  const renderTree = async (): Promise<HubPageTree> => {
    const runs = await reg.store.list();
    const tree = dashboard.render(runs);
    return tree instanceof PageBuilder ? tree.build() : tree;
  };

  definePageImpl({
    id: dashboard.pageId,
    render: renderTree,
    ...(dashboard.rowActions ? { actions: dashboard.rowActions } : {}),
  });

  reg.pushDashboard = async () => {
    pushPageImpl(dashboard.pageId, await renderTree());
  };
}

/**
 * After a terminal outcome: write the artifact mirror (fail-soft) + push
 * the dashboard. A loop with no `log` block is a no-op.
 */
export async function runTerminalLog(
  reg: RegisteredLoop,
  run: LoopRunState,
  outcome: unknown,
): Promise<void> {
  const log = reg.def.log;
  if (log?.artifact) {
    try {
      const artifact = log.artifact(run, outcome);
      if (artifact) {
        const dir = loopDataDir(reg.id);
        const abs = join(dir, artifact.path);
        // Create the artifact's parent dir before writing — the host's
        // fsWrite does NOT mkdir-p (matches the fs-handler contract).
        await fsMkdirImpl(parentDir(abs), { recursive: true });
        await fsWriteImpl(abs, artifact.body);
      }
    } catch {
      // Fail-soft: an artifact-mirror write must NEVER fail the run. The
      // durable record already persisted in Storage.
    }
  }
  await reg.pushDashboard?.();
}

/** Parent directory of an absolute path (sandbox-safe `node:path`). */
function parentDir(abs: string): string {
  const idx = abs.lastIndexOf("/");
  return idx <= 0 ? "/" : abs.slice(0, idx);
}
