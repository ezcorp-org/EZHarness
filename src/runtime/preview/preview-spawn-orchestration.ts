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
import { spawnPreviewServer, type PreviewProcess } from "./preview-spawn";
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

  log.info("preview dev server launched as preview uid", {
    conversationId,
    uid: alloc.uid,
    command,
  });
  return { ok: true, uid: alloc.uid, process: proc };
}
