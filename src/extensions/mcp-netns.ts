/**
 * Linux user+mount namespace wrapper for stdio MCP spawns — the
 * Phase 7 process-isolation leg of the unified permission system.
 *
 * MCP servers are arbitrary external binaries (Python, Go, Node, Rust)
 * we did NOT write. They speak MCP over stdio. Phase 2's sandbox-preload
 * cannot poison their network modules — they aren't Bun. So we run
 * each stdio MCP inside its own user (`-U`) and mount (`-m`) namespace,
 * giving it a clean cap-bounding-set + isolated mount table. Network
 * isolation is intentionally NOT done via `-n`: the resulting netns
 * cannot reach the host's loopback proxy without a veth pair (complex)
 * or `http+unix://...` HTTPS_PROXY (unparseable by stdlib clients).
 * Instead, the MCP shares the host's network namespace and outbound
 * HTTPS is gated by per-host PDP at the forward proxy on host loopback.
 *
 * Phase 7 fix-pass C2: dropped `-n` from the `unshare` flags. The
 * netns approach broke the HTTPS_PROXY URL on the supposed-primary
 * Linux production path. Kernel-level network isolation is deferred
 * to a future hardening phase; per-host PDP, bearer token,
 * `prlimit`-bound memory, and namespace-isolated cap-bounding remain.
 *
 * On non-Linux (macOS / Windows dev) namespaces don't exist; the
 * wrapper degrades to "HTTPS_PROXY only" mode, which covers stdlib HTTP
 * clients but is bypassable by raw-socket libc. The fallback is logged
 * + audited at startup so fleet operators know which deployments are
 * running in less-strict mode.
 *
 * Tied to:
 *   - `mcp-proxy.ts`        — the loopback forward proxy this wrapper
 *                             redirects MCP traffic to
 *   - `mcp-launcher.sh`     — the in-namespace setup script (cap-drop
 *                             via capsh + exec). No iptables.
 *   - `mcp-sandbox.ts`      — the caller; appends `unshare ... --` in
 *                             front of the existing `prlimit ...` chain
 *   - `audit-actions.ts`    — `MCP_NETNS_FALLBACK` action code (kept
 *                             for back-compat: "fallback" now means
 *                             "no namespace at all", but the audit
 *                             stream's name didn't change)
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export interface NetnsCapabilities {
  /** True iff `buildNetnsSpawnArgs` will produce an `unshare`-prefixed
   *  command on this host. False on non-Linux, missing binaries, or a
   *  kernel that disallows unprivileged user namespace creation. */
  available: boolean;
  /** Human-readable reason. Only meaningful when `available === false`.
   *  Surfaced verbatim in audit metadata + deployment docs so operators
   *  can chase the gap. */
  reason?: string;
}

/** Static cache for the probe result. The probe shells out to `unshare`
 *  exactly once per process — repeated calls in the same boot return
 *  the cached value. Tests reset via `_resetProbeCacheForTests()`. */
let probeCache: NetnsCapabilities | null = null;

/**
 * Detect whether this host supports unprivileged user+net+mount
 * namespace creation. The decision is the union of three checks:
 *
 *   1. `process.platform === "linux"` — Darwin/Win32 lack `unshare`.
 *   2. `unshare`, `iptables`, `ip` binaries present on PATH (probed by
 *      `Bun.which`). Missing any one means the launcher script can't
 *      run inside the namespace.
 *   3. Kernel allows unprivileged userns. Older kernels expose the
 *      `kernel.unprivileged_userns_clone` sysctl knob (must be `1`).
 *      Newer kernels (>=5.10ish) drop the knob — userns is on by
 *      default. NixOS 6.19 + most modern distros fall in this bucket.
 *      We treat "knob present + value 1" OR "knob absent" as ok.
 *      `max_user_namespaces > 0` is the secondary gate.
 *
 * As a final correctness check we shell out `unshare -U -n -m
 * --map-root-user true` once. If that fails the namespace path is
 * unusable regardless of what /proc says (e.g. a hardened seccomp
 * profile blocking the syscall). The result is cached for the rest
 * of the process lifetime.
 */
export function probeNetnsAvailability(): NetnsCapabilities {
  if (probeCache !== null) return probeCache;
  probeCache = computeProbe();
  return probeCache;
}

function computeProbe(): NetnsCapabilities {
  if (process.platform !== "linux") {
    return { available: false, reason: "not linux" };
  }

  // Bun.which returns null when the binary isn't on PATH. We only need
  // `unshare` now — Phase 7 fix-pass C2 dropped `-n`, so neither `ip`
  // (loopback bring-up) nor `iptables` (OUTPUT-DROP) runs in the
  // launcher. The Dockerfile still installs them as belt-and-suspenders
  // for any future hardening phase that re-enables netns.
  if (!Bun.which("unshare")) {
    return { available: false, reason: "missing binary: unshare" };
  }

  // Kernel knob: legacy /proc/sys/kernel/unprivileged_userns_clone (Debian
  // / Ubuntu prior to 5.10) — must be "1". Modern kernels removed the
  // knob; userns is enabled by default. We treat absence as "ok, but
  // verify via max_user_namespaces and a test-spawn".
  const userNsKnob = "/proc/sys/kernel/unprivileged_userns_clone";
  if (existsSync(userNsKnob)) {
    const value = readFileSync(userNsKnob, "utf8").trim();
    if (value !== "1") {
      return {
        available: false,
        reason: `kernel.unprivileged_userns_clone=${value}`,
      };
    }
  }

  // Hard gate: zero `max_user_namespaces` blocks unshare even if the
  // knob is "1" or absent. Some hardened images set this to 0.
  const maxUsernsKnob = "/proc/sys/user/max_user_namespaces";
  if (existsSync(maxUsernsKnob)) {
    const value = readFileSync(maxUsernsKnob, "utf8").trim();
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed === 0) {
      return { available: false, reason: "max_user_namespaces=0" };
    }
  }

  // Final live check: the cheapest possible unshare invocation. If
  // a seccomp profile, AppArmor policy, or container runtime blocks
  // the syscall, the proc/sys checks above pass but this fails.
  // `Bun.spawnSync` returns success=false on non-zero exit.
  //
  // We probe with the same flags the production wrap uses (`-U -m`
  // post-fix-pass — no `-n`), so the probe succeeds exactly when the
  // production path will work.
  try {
    const probe = Bun.spawnSync({
      cmd: ["unshare", "-U", "-m", "--map-root-user", "true"],
      stdout: "ignore",
      stderr: "ignore",
    });
    if (!probe.success) {
      return {
        available: false,
        reason: `unshare probe exited ${probe.exitCode ?? "non-zero"}`,
      };
    }
  } catch (err) {
    return {
      available: false,
      reason: `unshare probe failed: ${(err as Error).message}`,
    };
  }

  return { available: true };
}

/**
 * Drop the cached probe result. Tests reset this so they can simulate
 * different platforms / kernel configurations within one process.
 */
export function _resetProbeCacheForTests(): void {
  probeCache = null;
}

export interface BuildNetnsSpawnArgsInput {
  /** The original MCP command (already wrapped in `prlimit` by the
   *  caller). Becomes the inner exec target for the launcher script. */
  origCommand: string;
  /** All `prlimit` arguments PLUS the original MCP command + its args.
   *  The launcher script splits at the first `--` to separate
   *  prlimit-flags from the MCP exec target. */
  origArgs: readonly string[];
  /** Filesystem path to `mcp-launcher.sh`. The caller resolves it
   *  relative to its own location so the test harness can substitute
   *  a fixture script. */
  launcherPath: string;
}

export interface BuildNetnsSpawnArgsResult {
  /** Final command for `Bun.spawn` — `unshare` when wrapped, the
   *  original `origCommand` when the netns probe failed. */
  command: string;
  /** Final argv. When wrapped: `unshare`-flags then `--` then the
   *  launcher script then the original argv. When not: the original
   *  argv unchanged. */
  args: string[];
  /** True iff the result is the `unshare` wrap. False when the input
   *  was returned unchanged. */
  wrapped: boolean;
}

/**
 * Construct the spawn args for an MCP process inside a fresh user+mount
 * namespace. The shape matches what `Bun.spawn(...)` expects:
 *
 *   command: "unshare"
 *   args:    ["-U", "-m", "--map-root-user", "--",
 *             "<launcherPath>",
 *             ...<original prlimit + MCP args>]
 *
 * The launcher script handles `capsh` privilege drop + `exec` of the
 * MCP binary. No iptables, no `ip` — the MCP shares the host's network
 * namespace so it can reach the loopback proxy at
 * `http://127.0.0.1:<port>` (per Phase 7 fix-pass C2).
 *
 * On non-Linux or unavailable namespaces, returns the original
 * command/args unchanged. The caller (`mcp-sandbox.ts`) then injects
 * `HTTPS_PROXY` env to cover the fallback path.
 */
export function buildNetnsSpawnArgs(
  input: BuildNetnsSpawnArgsInput,
): BuildNetnsSpawnArgsResult {
  const probe = probeNetnsAvailability();
  if (!probe.available) {
    return {
      command: input.origCommand,
      args: [...input.origArgs],
      wrapped: false,
    };
  }

  return {
    command: "unshare",
    args: [
      "-U",
      "-m",
      "--map-root-user",
      "--",
      input.launcherPath,
      input.origCommand,
      ...input.origArgs,
    ],
    wrapped: true,
  };
}

/**
 * Resolve the absolute path of `mcp-launcher.sh` for callers that don't
 * want to import-meta-resolve themselves. The script lives next to
 * `mcp-netns.ts` on disk; this helper consolidates the path lookup so
 * a future move only touches one site.
 */
export function getDefaultLauncherPath(): string {
  // import.meta.url points at this module's compiled location. The
  // launcher sits in the same directory in both source layout and the
  // production Docker image (Dockerfile copies src/ verbatim).
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "mcp-launcher.sh");
}
