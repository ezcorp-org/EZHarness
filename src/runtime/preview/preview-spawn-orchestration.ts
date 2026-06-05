/**
 * preview-spawn-orchestration.ts — the "run a dev server as this
 * conversation's preview uid" orchestration (Secure User-Site Preview /
 * Port Exposure, Phase 3a — see tasks/preview-port-exposure.md "Phase 3
 * REDESIGN" item 6, the spawn hook).
 *
 * This is the glue that ties the uid pool + the setuid helper + the watcher
 * together into one call the run loop makes when the LLM launches a dev
 * server (e.g. `npm run dev` / `bun dev`):
 *
 *   launchPreviewDevServer({ conversationId, userId, workDir, command, args })
 *     1. capability gate — only `uid` mode here (netns mode spawns
 *        differently; static mode refuses),
 *     2. allocate (or reuse) the conversation's preview uid,
 *     3. register the conversation with the watcher so the new LISTEN
 *        socket is detected + attributed,
 *     4. spawn the dev server via the setuid helper as that uid,
 *     5. return the process handle + uid for the reaper.
 *
 * It is PURE over injected deps (capability probe, uid pool, watcher,
 * spawner) so it is fully unit-testable without a live setuid binary or a
 * real /proc. The ONE remaining seam is the CALL SITE: wiring this into the
 * exact command-exec path where the LLM's shell tool launches a long-lived
 * dev server. That trigger is intentionally NOT hijacked here (it lives
 * deep in the shell-tool executor) — the run loop calls
 * `launchPreviewDevServer` when it recognizes a dev-server launch. Reported
 * as a marked seam in the SUMMARY.
 */

import { logger } from "../../logger";
import { previewCapabilities } from "./preview-netns";
import { allocatePreviewUid, reapPreviewUid } from "./preview-uid-pool";
import { spawnPreviewServer, killPreviewProcess, type PreviewProcess } from "./preview-spawn";
import type { PreviewPortWatcher } from "./preview-port-watcher";

const log = logger.child("preview.spawn-orchestration");

export interface LaunchPreviewInput {
  conversationId: string;
  userId: string;
  /** Absolute conversation work dir the dev server runs in. */
  workDir: string;
  /** The dev-server command (e.g. "bun", "npm"). */
  command: string;
  /** Command args (e.g. ["run", "dev"]). */
  args?: readonly string[];
}

export type LaunchPreviewResult =
  | { ok: true; uid: number; process: PreviewProcess }
  | { ok: false; reason: string };

/**
 * Live registry of dev-server processes launched per conversation, so the
 * reaper can kill them on conversation close / idle. A conversation may
 * launch more than one (a restart, a second port), so we keep a set. Reaping
 * kills + clears them.
 */
const conversationProcesses = new Map<string, Set<PreviewProcess>>();

/** Track a launched process under its conversation (for the reaper). */
function trackProcess(conversationId: string, proc: PreviewProcess): void {
  let set = conversationProcesses.get(conversationId);
  if (!set) {
    set = new Set();
    conversationProcesses.set(conversationId, set);
  }
  set.add(proc);
  // Drop it from the registry when it exits on its own.
  void proc.exited.then(() => {
    conversationProcesses.get(conversationId)?.delete(proc);
  }).catch(() => {});
}

/** Number of live processes tracked for a conversation (test/observability). */
export function trackedProcessCount(conversationId: string): number {
  return conversationProcesses.get(conversationId)?.size ?? 0;
}

/** Outcome of killing a conversation's tracked dev-server processes. */
export interface KillConversationResult {
  /** Processes whose kill was CONFIRMED (helper exited 0 → tree gone). */
  killed: number;
  /** Processes whose kill could NOT be confirmed (helper non-zero / no
   *  uid+pgid captured / unknown). A non-zero value means the uid MUST be
   *  quarantined, not released — a live orphan may still own it. */
  unconfirmed: number;
}

/** Injectable kill so tests don't shell out to the setuid helper. */
export interface KillConversationDeps {
  /** Group-kill a preview process via the setuid helper's --kill mode.
   *  Resolves true only on a CONFIRMED kill. Defaults to killPreviewProcess. */
  killPreview?: (uid: number, pgid: number) => Promise<boolean>;
}

/**
 * Kill + forget every tracked dev-server process for a conversation.
 *
 * CRITICAL (Phase 3b integrity fix): the reaper runs as the APP uid (1000)
 * but the dev servers run as a PREVIEW uid (90000+). A direct `proc.kill()`
 * is a cross-uid `kill(2)` → EPERM (silently swallowed), so the old path
 * left orphans alive while the reaper happily released the uid back to the
 * pool — a future conversation could then be allocated that uid OVER a live
 * orphan that still owns the shared fs/process identity. We now route every
 * kill through the setuid helper's --kill mode (group-kill by pgid) and
 * report CONFIRMED vs UNCONFIRMED kills so the reaper can quarantine the uid
 * until the tree is provably gone.
 *
 * Idempotent — an unknown conversation is a no-op ({killed:0,unconfirmed:0}).
 */
export async function killConversationProcesses(
  conversationId: string,
  deps: KillConversationDeps = {},
): Promise<KillConversationResult> {
  const set = conversationProcesses.get(conversationId);
  if (!set) return { killed: 0, unconfirmed: 0 };
  const killPreview = deps.killPreview ?? killPreviewProcess;
  let killed = 0;
  let unconfirmed = 0;
  for (const proc of set) {
    // We need the captured uid + pgid to route through the helper. Without
    // them we cannot perform (or confirm) a cross-uid kill — count it
    // unconfirmed so the uid is quarantined rather than blindly released.
    if (typeof proc.uid !== "number" || typeof proc.pgid !== "number") {
      unconfirmed++;
      continue;
    }
    try {
      const ok = await killPreview(proc.uid, proc.pgid);
      if (ok) killed++;
      else unconfirmed++;
    } catch {
      unconfirmed++;
    }
  }
  conversationProcesses.delete(conversationId);
  return { killed, unconfirmed };
}

/** Test-only: clear the process registry. */
export function _resetPreviewProcessesForTests(): void {
  conversationProcesses.clear();
}

export interface LaunchPreviewDeps {
  /** The watcher to register the conversation with (so the new LISTEN
   *  socket is detected). Optional — when absent, detection is skipped but
   *  the server still launches. */
  watcher?: Pick<PreviewPortWatcher, "watch">;
  /** Injected capability probe (defaults to previewCapabilities). */
  capabilities?: () => { mode: "netns" | "uid" | "static" };
  /** Injected uid allocator (defaults to the live uid pool). */
  allocUid?: (conversationId: string) => { uid: number } | null;
  /** Injected spawner (defaults to spawnPreviewServer). */
  spawn?: (input: { uid: number; workDir: string; command: string; args?: readonly string[] }) => PreviewProcess;
}

/**
 * Launch a dev server as the conversation's preview uid. Fail-closed:
 * returns `{ok:false}` (never throws) when the host can't run uid-mode
 * previews or the uid pool is exhausted, so the caller can surface a clean
 * message instead of a crash.
 */
export function launchPreviewDevServer(
  input: LaunchPreviewInput,
  deps: LaunchPreviewDeps = {},
): LaunchPreviewResult {
  const { conversationId, userId, workDir, command, args } = input;
  if (!conversationId || !userId) return { ok: false, reason: "missing conversationId/userId" };
  if (!workDir || !command) return { ok: false, reason: "missing workDir/command" };

  const caps = (deps.capabilities ?? previewCapabilities)();
  if (caps.mode !== "uid") {
    // netns mode launches via the hardened path; static mode has no dynamic
    // previews. This orchestration is the uid-mode path only.
    return { ok: false, reason: `uid-mode previews unavailable (mode=${caps.mode})` };
  }

  const alloc = (deps.allocUid ?? allocatePreviewUid)(conversationId);
  if (!alloc) return { ok: false, reason: "preview uid pool exhausted" };

  // Register with the watcher BEFORE spawning so the first LISTEN tick is
  // already attributable to this conversation.
  if (deps.watcher) deps.watcher.watch(conversationId, userId);

  let proc: PreviewProcess;
  try {
    proc = (deps.spawn ?? ((i) => spawnPreviewServer(i)))({ uid: alloc.uid, workDir, command, args });
  } catch (err) {
    // Spawn failed (bad argv, missing helper) — release the uid so it isn't
    // leaked, and report the failure.
    reapPreviewUid(conversationId);
    return { ok: false, reason: `spawn failed: ${(err as Error)?.message ?? String(err)}` };
  }

  // Track the process under its conversation so the reaper can kill it on
  // conversation close / idle.
  trackProcess(conversationId, proc);

  log.info("preview dev server launched as preview uid", {
    conversationId,
    uid: alloc.uid,
    command,
  });
  return { ok: true, uid: alloc.uid, process: proc };
}
