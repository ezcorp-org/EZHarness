/**
 * preview-spawn.ts — TS-side driver + testable logic for the setuid-root
 * `preview-spawn` helper (Secure User-Site Preview / Port Exposure,
 * Phase 3a — see tasks/preview-port-exposure.md "Phase 3 REDESIGN —
 * portable uid-based isolation").
 *
 * The actual privilege drop lives in the tiny C helper (build/preview-spawn.c,
 * installed root:root 4755 by the Dockerfile). This module:
 *   - owns the uid-range allowlist (mirrored in the C helper) so the
 *     boundary is enforced BEFORE we ever shell out,
 *   - builds the helper argv (pure, unit-testable),
 *   - detects whether the helper is present + setuid-root (the capability
 *     gate for `uid` mode),
 *   - spawns the dev server through the helper.
 *
 * Everything except the actual `Bun.spawn` is pure so the allowlist + arg
 * builder + present-detection are 100% unit-tested without a live setuid
 * binary. The live drop (real euid=0 → preview uid) is Docker-only and is
 * gated behind DOCKER_TEST in the integration harness.
 */

import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

/** The POSIX setuid bit. `node:fs`'s `constants.S_ISUID` is undefined
 *  under Bun, so we use the well-known literal value. */
const S_ISUID = 0o4000;

/**
 * The allowlisted preview-uid range. MUST match PREVIEW_UID_MIN/MAX in
 * build/preview-spawn.c. 90000–99000 sits well above the app uid (1000)
 * and any normal system account, so a preview uid can never collide with
 * (and inherit the fs access of) the app user that owns .ezcorp/data.
 */
export const PREVIEW_UID_MIN = 90000;
export const PREVIEW_UID_MAX = 99000;

/**
 * The on-disk path of the compiled setuid-root helper. Baked into the
 * image by the Dockerfile build stage at this fixed location; overridable
 * via env for tests / non-standard layouts.
 *
 * CRITICAL — must live OUTSIDE the source tree. App modules import the TS
 * driver extensionless (`import … from "./preview-spawn"`), so a compiled
 * binary at `src/runtime/preview/preview-spawn` (no extension) SHADOWS
 * `preview-spawn.ts` in the built image: bun resolves the extensionless
 * specifier to the ELF binary and tries to parse it as JS → boot-time
 * `Unexpected … at /app/src/runtime/preview/preview-spawn:1:1`, killing the
 * entire dynamic-preview subsystem. The default therefore points at
 * `/app/bin/`, a directory with no `.ts` siblings. (The host worktree has
 * no binary at all, so this collision is image-only and invisible to host
 * tests/typecheck — see the regression guard in preview-spawn.test.ts.)
 */
export function previewSpawnHelperPath(): string {
  const override = process.env.EZCORP_PREVIEW_SPAWN_HELPER;
  if (override && override.trim().length > 0) return override.trim();
  return "/app/bin/preview-spawn";
}

/**
 * Is `uid` a valid preview uid? A plain integer inside the allowlisted
 * range. Rejects: below the floor (incl. 0/root + the app uid 1000),
 * above the ceiling, negatives, non-integers (NaN/Infinity/floats).
 * This is the keystone allowlist — the C helper re-checks the same window.
 */
export function isValidPreviewUid(uid: number): boolean {
  if (!Number.isInteger(uid)) return false;
  return uid >= PREVIEW_UID_MIN && uid <= PREVIEW_UID_MAX;
}

export interface PreviewSpawnArgsInput {
  /** The target preview uid (must pass isValidPreviewUid). */
  uid: number;
  /** Absolute conversation work dir the helper chdir's into. */
  workDir: string;
  /** The dev-server command (e.g. "bun", "npm"). No shell is used. */
  command: string;
  /** Command args (e.g. ["run", "dev"]). */
  args?: readonly string[];
}

/**
 * Build the full argv for invoking the setuid helper:
 *   [helperPath, "<uid>", "<workDir>", command, ...args]
 *
 * Pure + fail-closed. Throws on an invalid uid, a non-absolute workDir,
 * or a missing command — the SAME refusals the C helper makes, surfaced
 * earlier so we never even spawn on bad input. No shell metacharacters are
 * interpreted (the helper execvp's directly), so args pass through verbatim.
 */
export function buildPreviewSpawnArgv(
  input: PreviewSpawnArgsInput,
  helperPath: string = previewSpawnHelperPath(),
): string[] {
  if (!isValidPreviewUid(input.uid)) {
    throw new Error(
      `preview-spawn: uid ${input.uid} is outside the allowlisted preview range ` +
        `[${PREVIEW_UID_MIN}, ${PREVIEW_UID_MAX}]`,
    );
  }
  if (!input.workDir || !isAbsolute(input.workDir)) {
    throw new Error(`preview-spawn: workDir must be an absolute path: ${input.workDir}`);
  }
  if (!input.command) {
    throw new Error("preview-spawn: command is required");
  }
  return [
    helperPath,
    String(input.uid),
    input.workDir,
    input.command,
    ...(input.args ?? []),
  ];
}

/**
 * Whether the setuid helper is present AND setuid-root (the capability
 * gate for `uid` mode). Returns true only when the file exists, is owned
 * by root (uid 0), and has the setuid bit set. Injected `statFn` makes
 * this unit-testable with synthetic stat results.
 *
 * Fail-closed: any stat error (missing file, permission) → false.
 */
export function isPreviewSpawnHelperPresent(
  helperPath: string = previewSpawnHelperPath(),
  statFn: (p: string) => { uid: number; mode: number } = (p) => {
    const s = statSync(p);
    return { uid: s.uid, mode: s.mode };
  },
): boolean {
  let info: { uid: number; mode: number };
  try {
    info = statFn(helperPath);
  } catch {
    return false;
  }
  // Must be root-owned and carry the setuid bit — otherwise it yields no
  // privilege and `uid` mode would silently fail to drop.
  if (info.uid !== 0) return false;
  return (info.mode & S_ISUID) !== 0;
}

/** A handle to a spawned preview process (subset of Bun.Subprocess). */
export interface PreviewProcess {
  pid: number;
  kill(signal?: number): void;
  readonly exited: Promise<number>;
}

export interface SpawnPreviewServerDeps {
  /** Injected spawner (defaults to Bun.spawn). Lets tests assert the argv
   *  + env without launching anything. */
  spawn?: (
    argv: string[],
    opts: { stdout: "pipe" | "ignore"; stderr: "pipe" | "ignore" },
  ) => PreviewProcess;
  /** Override the helper path (tests). */
  helperPath?: string;
}

/**
 * Spawn a dev server as a preview uid, through the setuid helper. The
 * helper does the setgid/setuid/setgroups/chdir/restricted-env work; here
 * we only assemble the argv and launch. Returns the process handle so the
 * caller (uid pool / reaper) can kill it on conversation close / idle.
 *
 * The restricted env is applied INSIDE the helper (clearenv + a fixed
 * allow set) — we do NOT pass the parent env through, so even if Bun.spawn
 * inherited it, the helper discards it before exec.
 */
export function spawnPreviewServer(
  input: PreviewSpawnArgsInput,
  deps: SpawnPreviewServerDeps = {},
): PreviewProcess {
  const helperPath = deps.helperPath ?? previewSpawnHelperPath();
  const argv = buildPreviewSpawnArgv(input, helperPath);
  const spawn =
    deps.spawn ??
    ((a, o) => {
      const proc = Bun.spawn(a, { stdout: o.stdout, stderr: o.stderr });
      return {
        pid: proc.pid,
        kill: (sig?: number) => proc.kill(sig),
        exited: proc.exited,
      };
    });
  return spawn(argv, { stdout: "pipe", stderr: "pipe" });
}
