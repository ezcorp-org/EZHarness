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
import { existsSync, accessSync, constants as fsConstants } from "node:fs";
import { arch } from "node:os";
import { landlockAbiVersion } from "./landlock-ffi";

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
 *   - bwrap tier requires BOTH usable Landlock AND working userns (the
 *     bwrap upgrade rides on top of the Landlock fs-jail).
 *   - landlock tier = usable Landlock without userns.
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
  if (o.userns) {
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
