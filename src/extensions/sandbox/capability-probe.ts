/**
 * Sandbox capability probe (Phase A1 — GO/NO-GO gate).
 *
 * Detects, at boot, which OS-isolation primitives are available and caches
 * the strongest tier. The isolation thesis (see tasks/ez-code.md) is
 * Landlock-primary: it needs zero namespaces/caps/setuid and its syscalls
 * pass Docker's default seccomp, so it works inside the app container where
 * the prior bwrap/netns spike failed on unprivileged-userns restrictions.
 *
 * Tiers (strongest first):
 *   "bwrap"    — unprivileged user namespaces work (`unshare -Ur true`),
 *                so we can additionally hide /proc + PIDs on top of Landlock.
 *   "landlock" — Landlock LSM is active (ABI >= 1) but userns is blocked;
 *                fs-jail only, no PID/proc hiding.
 *   "advisory" — neither works; fall back to SDK module-poisoning only
 *                (the documented status-quo limitation).
 *
 * The pure `selectTier()` is unit-tested exhaustively by mocking each
 * probe's outcome; the live FFI probes are exercised by the in-repo
 * evidence scripts under `__spikes__/`.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  accessSync,
  statSync,
  constants as fsConstants,
} from "node:fs";
import { arch } from "node:os";
import { delimiter, join } from "node:path";
import { landlockAbiVersion } from "./landlock-ffi";

/**
 * Setuid bit (S_ISUID, octal 04000). `node:fs` does not export it as a
 * constant, so define it locally for the `statSync().mode` check below.
 */
const S_ISUID = 0o4000;

/**
 * Is the `bwrap` we would exec a SETUID-root binary?
 *
 * On hosts that disable unprivileged user namespaces at the sysctl/kernel
 * level (NixOS by default, several hardened distros), bubblewrap ships as
 * a SETUID-root wrapper instead. A setuid bwrap REFUSES the `--size`
 * option on its private `/tmp` tmpfs ("The --size option is not permitted
 * in setuid mode") and aborts — which would crash every sandboxed
 * extension subprocess. We detect that here so the bwrap argv builder can
 * omit `--size` (and only `--size`) on those hosts; all confinement flags
 * stay intact.
 *
 * Returns false when `bwrap` can't be found on PATH or can't be stat'd —
 * the caller only consults this on the bwrap tier, where bwrap exists.
 */
export function bwrapIsSetuid(): boolean {
  try {
    const pathEnv = process.env.PATH ?? "";
    for (const dir of pathEnv.split(delimiter)) {
      if (!dir) continue;
      const candidate = join(dir, "bwrap");
      try {
        const st = statSync(candidate);
        if ((st.mode & S_ISUID) !== 0) return true;
        // Found a non-setuid bwrap first on PATH — that's the one exec'd.
        return false;
      } catch {
        // Not in this PATH entry; keep looking.
      }
    }
    return false;
  } catch {
    return false;
  }
}

export type SandboxTier = "bwrap" | "landlock" | "advisory";

/** Raw outcomes of each individual capability probe. */
export interface ProbeOutcomes {
  /** Landlock ABI version (>0 supported, <=0 / null unsupported). */
  landlockAbi: number | null;
  /** Whether `unshare -Ur true` succeeded (unprivileged userns usable). */
  userns: boolean;
  /** Whether a writable `cgroup.subtree_control` exists (cgroup v2 deleg.). */
  cgroupV2Delegation: boolean;
  /** Whether /dev/kvm is present (informational — microVM upgrade path). */
  kvm: boolean;
  /** Host CPU architecture (Landlock FFI syscall numbers are x86_64-only). */
  arch: string;
  /** Whether the `bwrap` on PATH is the SETUID-root wrapper. When true we
   *  refuse the bwrap tier: setuid bwrap rejects `--size` and (on hosts
   *  that ship it setuid, e.g. NixOS) the runtime binaries live behind
   *  `/run/current-system/...` symlinks the minimal FHS bind-set can't
   *  reach, so the jailed exec fails. Landlock has neither problem
   *  (in-process, no namespace remap), so we drop to it instead. */
  bwrapSetuid: boolean;
}

export interface SandboxCapabilities extends ProbeOutcomes {
  /** The resolved strongest tier. */
  tier: SandboxTier;
  /** True when Landlock can restrict the fs (ABI >= 1 on a supported arch). */
  landlockUsable: boolean;
}

/**
 * PURE tier-selection from probe outcomes. Exhaustively unit-tested.
 *
 * Rules:
 *   - Landlock is "usable" only on x86_64 (we refuse to guess syscall
 *     numbers on other arches) AND when the probed ABI is >= 1.
 *   - bwrap tier requires usable Landlock AND working userns (the bwrap
 *     upgrade rides on top of the Landlock fs-jail) AND a NON-setuid
 *     bwrap. A setuid-root bwrap can't run our jail (rejects `--size`;
 *     and on setuid-bwrap hosts the runtime lives behind `/run/...`
 *     symlinks the minimal bind-set misses), so we drop to the landlock
 *     tier — same real fs confinement, just no PID/proc hiding.
 *   - landlock tier = usable Landlock without (usable) userns.
 *   - advisory = no usable Landlock (regardless of userns).
 */
export function selectTier(o: ProbeOutcomes): {
  tier: SandboxTier;
  landlockUsable: boolean;
} {
  const landlockUsable = o.arch === "x64" && (o.landlockAbi ?? 0) >= 1;
  if (!landlockUsable) {
    return { tier: "advisory", landlockUsable: false };
  }
  if (o.userns && !o.bwrapSetuid) {
    return { tier: "bwrap", landlockUsable: true };
  }
  return { tier: "landlock", landlockUsable: true };
}

/** Probe Landlock ABI via FFI; null on any failure. */
export function probeLandlockAbi(): number | null {
  try {
    const v = landlockAbiVersion();
    return v > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Probe unprivileged user namespaces by spawning `unshare -Ur true`. */
export function probeUserns(): boolean {
  try {
    const r = spawnSync("unshare", ["-Ur", "true"], {
      stdio: "ignore",
      timeout: 5000,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** Probe cgroup v2 delegation: a writable cgroup.subtree_control file. */
export function probeCgroupV2Delegation(): boolean {
  const path = "/sys/fs/cgroup/cgroup.subtree_control";
  try {
    if (!existsSync(path)) return false;
    accessSync(path, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Probe /dev/kvm presence (informational). */
export function probeKvm(): boolean {
  try {
    return existsSync("/dev/kvm");
  } catch {
    return false;
  }
}

/**
 * Run every probe and resolve the full capability set + tier.
 * Side-effecting (spawns/syscalls); the cached accessor below memoizes it.
 */
export function probeSandboxCapabilities(): SandboxCapabilities {
  const outcomes: ProbeOutcomes = {
    landlockAbi: probeLandlockAbi(),
    userns: probeUserns(),
    cgroupV2Delegation: probeCgroupV2Delegation(),
    kvm: probeKvm(),
    arch: arch(),
    bwrapSetuid: bwrapIsSetuid(),
  };
  const { tier, landlockUsable } = selectTier(outcomes);
  return { ...outcomes, tier, landlockUsable };
}

let cached: SandboxCapabilities | null = null;

/** Cached full capability set (probes once per process). */
export function getSandboxCapabilities(): SandboxCapabilities {
  if (!cached) cached = probeSandboxCapabilities();
  return cached;
}

/** Cached strongest-available tier. */
export function getSandboxTier(): SandboxTier {
  return getSandboxCapabilities().tier;
}

/** Test-only: reset the memoized capability set. */
export function __resetSandboxCapabilitiesCache(): void {
  cached = null;
}
