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
import { openSeccompBpfFd } from "./runtime/seccomp-loader";
import {
  ensureBridge,
  ensureConntrackCeiling,
  sweepOrphanVeths,
  BRIDGE_CIDR_DEFAULT,
} from "./mcp-bridge";
import { insertAuditEntry } from "../db/queries/audit-log";
import { EXT_AUDIT_ACTIONS } from "./audit-actions";

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

// ─────────────────────────────────────────────────────────────────────
// Plan 55-02 — bubblewrap probe (MCP-02 host-/tmp side-channel close)
//
// bwrap is the wrap layer that provides the private 64 MB tmpfs at
// /tmp. We probe its availability with the same probe-once-cache-result
// shape as `probeNetnsAvailability` above. The probe lives INSIDE the
// launcher (Pattern B from RESEARCH.md Open Question 1) so the existing
// `unshare -U -m --map-root-user` chain stays as the outer wrap and
// preserves the MCP_NETNS_CREATED audit semantics.
//
// Test seam: `_setBwrapProbeOverridesForTests` lets unit tests inject
// the `Bun.which` result and a fake probe-runner so the missing-binary
// and probe-failure branches are reachable without mocking Bun globals.
// Mirrors the seam pattern used elsewhere in this codebase for
// kernel/binary probes that can't be cleanly module-mocked.
// ─────────────────────────────────────────────────────────────────────

interface BwrapProbeOverrides {
  whichBwrap: () => string | null;
  probeRunner: () => { success: boolean; exitCode: number | null };
}

let bwrapProbeCache: NetnsCapabilities | null = null;
let bwrapProbeOverrides: BwrapProbeOverrides | null = null;

/**
 * Detect whether this host has `bwrap` available AND a kernel that
 * accepts a minimal bwrap invocation. Same three-gate shape as
 * `probeNetnsAvailability`:
 *
 *   1. `process.platform === "linux"` — bwrap is Linux-only.
 *   2. `Bun.which("bwrap")` returns a path. Missing → degraded mode.
 *   3. A live `bwrap --unshare-user --die-with-parent ... true` probe
 *      exits 0. Older bwrap versions and locked-down kernels can fail
 *      this even if the binary is on PATH.
 *
 * Result is cached for the rest of the process lifetime. Tests reset
 * via `_resetBwrapProbeCacheForTests()`.
 */
export function probeBwrapAvailability(): NetnsCapabilities {
  if (bwrapProbeCache !== null) return bwrapProbeCache;
  bwrapProbeCache = computeBwrapProbe();
  return bwrapProbeCache;
}

function computeBwrapProbe(): NetnsCapabilities {
  if (process.platform !== "linux") {
    return { available: false, reason: "not linux" };
  }

  const whichFn = bwrapProbeOverrides?.whichBwrap ?? (() => Bun.which("bwrap"));
  if (!whichFn()) {
    return { available: false, reason: "missing binary: bwrap" };
  }

  // Live probe. We use the cheapest bwrap invocation that exercises
  // the same code path as the production wrap (tmpfs mount inside an
  // unprivileged userns). `--size 1048576` is intentionally small —
  // some setuid bwrap builds reject `--size` entirely; production
  // Docker bwrap is non-setuid so this branch is the dominant one.
  const runner = bwrapProbeOverrides?.probeRunner ?? defaultBwrapProbeRunner;
  let probe: { success: boolean; exitCode: number | null };
  try {
    probe = runner();
  } catch (err) {
    return {
      available: false,
      reason: `bwrap probe failed: ${(err as Error).message}`,
    };
  }
  if (!probe.success) {
    return {
      available: false,
      reason: `bwrap probe exited ${probe.exitCode ?? "non-zero"}`,
    };
  }
  return { available: true };
}

function defaultBwrapProbeRunner(): { success: boolean; exitCode: number | null } {
  const result = Bun.spawnSync({
    cmd: [
      "bwrap",
      "--unshare-user",
      "--die-with-parent",
      "--tmpfs",
      "/tmp",
      "--size",
      "1048576",
      "true",
    ],
    stdout: "ignore",
    stderr: "ignore",
  });
  return { success: result.success, exitCode: result.exitCode ?? null };
}

/**
 * Drop the cached bwrap probe result.
 */
export function _resetBwrapProbeCacheForTests(): void {
  bwrapProbeCache = null;
}

/**
 * Inject test-only overrides for the bwrap probe. Pass `null` to clear.
 * Tests use this to drive the missing-binary and probe-failure branches
 * without mocking Bun globals.
 */
export function _setBwrapProbeOverridesForTests(
  overrides: BwrapProbeOverrides | null,
): void {
  bwrapProbeOverrides = overrides;
}

// ─────────────────────────────────────────────────────────────────────
// Phase 58 / MCP-05 — veth capability probe.
//
// Mirrors the probe-once-cache-result shape of `probeBwrapAvailability`
// above. Probes whether this host can create veth pairs (needs Linux +
// `ip` + `nft` + CAP_NET_ADMIN). Result is cached for the rest of the
// process lifetime; the test seam `_setVethProbeOverridesForTests`
// resets the cache and lets unit tests drive every failure branch
// without mocking Bun globals.
// ─────────────────────────────────────────────────────────────────────

interface VethProbeOverrides {
  platform?: () => NodeJS.Platform;
  whichIp?: () => string | null;
  whichNft?: () => string | null;
  probeRunner?: () => { success: boolean; exitCode: number | null };
}

let vethProbeCache: NetnsCapabilities | null = null;
let vethProbeOverrides: VethProbeOverrides | null = null;

/**
 * Detect whether this host has `ip`, `nft`, AND CAP_NET_ADMIN such that
 * the Stage 2 veth+netns leg can be installed for an MCP. Same three-
 * gate shape as `probeBwrapAvailability`:
 *
 *   1. `process.platform === "linux"` — `ip`/`nft` are Linux-only.
 *   2. `Bun.which("ip")` AND `Bun.which("nft")` return paths.
 *   3. A live `ip link add probe-veth-test type veth peer name
 *      probe-veth-test-p && ip link delete probe-veth-test` succeeds.
 *      Fails on dev hosts without CAP_NET_ADMIN (Operation not permitted).
 *
 * Result is cached for the rest of the process lifetime. Tests reset
 * via `_setVethProbeOverridesForTests(null)`.
 */
export function probeVethCapability(): NetnsCapabilities {
  // Phase 58 / MCP-05 — Plan 03 — short-circuit when initStage2 detected a
  // boot-time degradation (bridge create failed, CAP_NET_ADMIN missing,
  // sweep failed). Operators reading /audit see the boot row; subsequent
  // spawns degrade to Stage 1 without re-probing.
  if (stage2DegradedAtBoot) {
    return { available: false, reason: "stage2 degraded at boot" };
  }
  if (vethProbeCache !== null) return vethProbeCache;
  vethProbeCache = computeVethProbe();
  return vethProbeCache;
}

function computeVethProbe(): NetnsCapabilities {
  const platformFn = vethProbeOverrides?.platform ?? (() => process.platform);
  if (platformFn() !== "linux") {
    return { available: false, reason: "not linux" };
  }

  const whichIpFn = vethProbeOverrides?.whichIp ?? (() => Bun.which("ip"));
  if (!whichIpFn()) {
    return { available: false, reason: "missing binary: ip" };
  }

  const whichNftFn = vethProbeOverrides?.whichNft ?? (() => Bun.which("nft"));
  if (!whichNftFn()) {
    return { available: false, reason: "missing binary: nft" };
  }

  const runner = vethProbeOverrides?.probeRunner ?? defaultVethProbeRunner;
  let probe: { success: boolean; exitCode: number | null };
  try {
    probe = runner();
  } catch (err) {
    return {
      available: false,
      reason: `veth probe failed: ${(err as Error).message}`,
    };
  }
  if (!probe.success) {
    return {
      available: false,
      reason: `veth probe exited ${probe.exitCode ?? "non-zero"}`,
    };
  }
  return { available: true };
}

function defaultVethProbeRunner(): { success: boolean; exitCode: number | null } {
  const probeName = `probe-veth-${Math.floor(Math.random() * 1e6).toString(16)}`;
  const peerName = `${probeName}-p`;
  const add = Bun.spawnSync({
    cmd: ["ip", "link", "add", probeName, "type", "veth", "peer", "name", peerName],
    stdout: "ignore",
    stderr: "ignore",
  });
  if (!add.success) return { success: false, exitCode: add.exitCode ?? null };
  // Best-effort cleanup — host-side delete auto-cleans the peer.
  Bun.spawnSync({
    cmd: ["ip", "link", "delete", probeName],
    stdout: "ignore",
    stderr: "ignore",
  });
  return { success: true, exitCode: 0 };
}

/**
 * Inject test-only overrides for the veth probe. Pass `null` to clear
 * (which ALSO resets the cache). Tests use this to drive the missing-
 * binary, non-Linux, and probe-failure branches without mocking Bun
 * globals (mirrors `_setBwrapProbeOverridesForTests` shape).
 */
export function _setVethProbeOverridesForTests(
  overrides: VethProbeOverrides | null,
): void {
  vethProbeOverrides = overrides;
  vethProbeCache = null; // reset cache on every override change
}

// ─────────────────────────────────────────────────────────────────────
// Phase 58 / MCP-05 — /30 IP slot allocator.
//
// Bridge `br-ezcorp-mcp` lives on 10.42.0.0/24 with gateway 10.42.0.1.
// Each MCP gets a /30 within that /24:
//
//   Slot N → bridge-end IP = 10.42.0.{N*4 + 1}/30  (host-side veth)
//           MCP-end IP    = 10.42.0.{N*4 + 2}/30  (ns-side veth)
//
//   Slot 1: bridge=10.42.0.5,  MCP=10.42.0.6
//   Slot 2: bridge=10.42.0.9,  MCP=10.42.0.10
//   ...
//   Slot 63: bridge=10.42.0.253, MCP=10.42.0.254
//
// Slot 0 is reserved for the bridge gateway (10.42.0.1/24) and is
// never returned by allocVethSlot. Slots 1..63 are mathematically
// usable; the live concurrent cap is 60 (4 reserved as headroom).
// Allocation is lowest-free wins; release is idempotent.
//
// In-memory only — orphan veth sweep at boot (Plan 03) reconciles any
// leftover host-side interfaces from a crashed prior process.
// ─────────────────────────────────────────────────────────────────────

const VETH_SLOT_MAX_CONCURRENT = 60;
const VETH_SLOT_RANGE_MAX = 63;
const vethSlotsInUse = new Set<number>();

export function allocVethSlot(): number | null {
  if (vethSlotsInUse.size >= VETH_SLOT_MAX_CONCURRENT) return null;
  for (let slot = 1; slot <= VETH_SLOT_RANGE_MAX; slot++) {
    if (!vethSlotsInUse.has(slot)) {
      vethSlotsInUse.add(slot);
      return slot;
    }
  }
  return null;
}

export function releaseVethSlot(slot: number): void {
  if (slot <= 0 || slot > VETH_SLOT_RANGE_MAX) return;
  vethSlotsInUse.delete(slot);
}

export function computeVethBridgeIp(slot: number): string {
  return `10.42.0.${slot * 4 + 1}/30`;
}

export function computeVethMcpIp(slot: number): string {
  return `10.42.0.${slot * 4 + 2}/30`;
}

export function _resetVethSlotAllocatorForTests(): void {
  vethSlotsInUse.clear();
}

// ─────────────────────────────────────────────────────────────────────
// Phase 58 / MCP-05 — Plan 58-03 — Boot-time Stage 2 init.
//
// `initStage2` runs ONCE per host process at boot (called from
// `registry.ts`'s constructor as fire-and-forget). It runs three
// idempotent steps in order:
//
//   1. `sweepOrphanVeths` — delete any `mcp-<8hex>` host-side veths
//      left over from a crashed prior process (RTNETLINK collision-
//      prevention). Emits MCP_VETH_ORPHAN_SWEPT (count=0 still fires
//      so operators see the sweep ran).
//   2. `ensureConntrackCeiling` — floor-guarantee
//      `net.netfilter.nf_conntrack_max >= 262144` (Pitfall 3 / Debian
//      bookworm default). Idempotent only-write-if-lower.
//   3. `ensureBridge` — idempotent `br-ezcorp-mcp` create. Respects
//      `EZCORP_MCP_STAGE2_BRIDGE_SUBNET` override (CIDR-validated;
//      invalid value falls back to default + emits boot row).
//
// On any failure: sets `stage2DegradedAtBoot` flag + emits one-time
// MCP_NETNS_FALLBACK boot row + returns `{ ok: false, reason }`. The
// flag is consumed by `probeVethCapability` above — subsequent spawns
// degrade to Stage 1 without re-probing.
// ─────────────────────────────────────────────────────────────────────

let stage2InitCompleted = false;
let stage2DegradedAtBoot = false;
let stage2BootRowEmitted = false;

/**
 * Test-only: reset all init-stage2 state. Used by unit tests that need
 * to exercise the boot path multiple times in one process.
 */
export function _resetInitStage2ForTests(): void {
  stage2InitCompleted = false;
  stage2DegradedAtBoot = false;
  stage2BootRowEmitted = false;
  vethProbeCache = null;
}

/**
 * Production accessor for the degraded-at-boot flag. Used by audit
 * dashboards or external diagnostics that want to surface boot status
 * outside the per-spawn audit row stream.
 */
export function isStage2DegradedAtBoot(): boolean {
  return stage2DegradedAtBoot;
}

async function emitStage2BootRow(
  userId: string | null,
  reason: string,
): Promise<void> {
  if (stage2BootRowEmitted) return;
  stage2BootRowEmitted = true;
  try {
    await insertAuditEntry(
      userId,
      EXT_AUDIT_ACTIONS.MCP_NETNS_FALLBACK,
      undefined,
      {
        permission: "network",
        oldValue: null,
        newValue: null,
        actor: "system",
        reason,
        platform: process.platform,
      },
    );
  } catch {
    // Fire-and-forget — boot must not fail on audit write hiccup.
  }
}

/**
 * CIDR validator for the `EZCORP_MCP_STAGE2_BRIDGE_SUBNET` override.
 * Accepts /8 .. /30 (the operator subnets the bridge could reasonably
 * carve; /31 + /32 don't make sense for a multi-veth bridge).
 */
function isValidCidr(s: string): boolean {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/(8|9|[12][0-9]|30)$/.test(s);
}

/**
 * Boot-time Stage 2 init. Idempotent — repeated calls short-circuit
 * after the first completes. Safe to call from any boot site that
 * needs Stage 2 capability before the first MCP spawn.
 *
 * Returns `{ ok, reason? }` for callers that want to observe the
 * outcome. Production callers in `registry.ts` fire-and-forget; the
 * `stage2DegradedAtBoot` flag (consumed by `probeVethCapability`) is
 * the load-bearing signal.
 */
export async function initStage2(
  userId: string | null = null,
): Promise<{ ok: boolean; reason?: string }> {
  if (stage2InitCompleted) {
    return { ok: !stage2DegradedAtBoot };
  }
  stage2InitCompleted = true;

  if (process.platform !== "linux") {
    stage2DegradedAtBoot = true;
    return { ok: false, reason: "not linux" };
  }

  // Validate the optional subnet override.
  const subnetOverride = process.env.EZCORP_MCP_STAGE2_BRIDGE_SUBNET;
  let effectiveSubnet = BRIDGE_CIDR_DEFAULT;
  if (subnetOverride && !isValidCidr(subnetOverride)) {
    // Invalid CIDR — fall back to default + emit boot row. Stage 2 still
    // attempts to come up on the default subnet (degraded-with-warning).
    await emitStage2BootRow(userId, "stage2 invalid bridge subnet");
  } else if (subnetOverride) {
    effectiveSubnet = subnetOverride;
  }

  // Step 1: sweep orphans BEFORE the bridge create. The sweep walks
  // `ip link show` for old `mcp-<8hex>` host-side veths and deletes
  // each; the kernel auto-cleans the namespace-side peers.
  const sweep = await sweepOrphanVeths(userId);
  if (sweep.error) {
    stage2DegradedAtBoot = true;
    await emitStage2BootRow(userId, `stage2 unavailable: ${sweep.error}`);
    return { ok: false, reason: sweep.error };
  }

  // Step 2: floor-guarantee nf_conntrack_max. Best-effort — a failure
  // here doesn't degrade Stage 2 (the per-spawn pressure guard catches
  // table saturation regardless of the floor).
  ensureConntrackCeiling();

  // Step 3: idempotent bridge create. The load-bearing step — if the
  // bridge fails, host-side veth attach has nowhere to go and every
  // Stage 2 spawn would degrade to Stage 1 anyway.
  const bridge = ensureBridge({ subnetOverride: effectiveSubnet });
  if (!bridge.ok) {
    stage2DegradedAtBoot = true;
    await emitStage2BootRow(userId, `stage2 unavailable: ${bridge.reason}`);
    return { ok: false, reason: bridge.reason };
  }

  return { ok: true };
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
  /** Plan 55-02 (MCP-02): true iff `bwrap` is available on this host
   *  AND the kill-switch is not active. The caller threads this into
   *  the spawned env so `mcp-launcher.sh` knows whether to exec under
   *  bubblewrap. Plan 55-03 will extend this struct with seccomp
   *  availability + fd plumbing. */
  bwrapAvailable?: boolean;
  /** Human-readable reason when bwrap is unavailable. */
  bwrapReason?: string;
  /** True iff `EZCORP_MCP_STAGE1_TMPFS=0` is set on the host process —
   *  emergency rollback. The caller emits a one-time boot audit row
   *  and skips the bwrap wrap regardless of `bwrapAvailable`. */
  tmpfsKillSwitchActive?: boolean;
  /** Plan 55-03 (MCP-03): a raw FD pointing at the compiled seccomp
   *  BPF blob at `/app/src/extensions/mcp-seccomp.bpf`, or `null` when
   *  the file is absent (dev hosts without `docker build`), the host
   *  is not Linux, or the seccomp kill-switch is active. The caller
   *  passes this FD to Bun.spawn via `stdio[3]`; the launcher reads
   *  `$EZCORP_MCP_BWRAP_SECCOMP_FD=3` and appends `--seccomp 3` to its
   *  inner `bwrap` exec line. Parent MUST close after spawn returns. */
  seccompFd?: number | null;
  /** Plan 55-03 (MCP-03): true iff `EZCORP_MCP_STAGE1_SECCOMP=0` is set
   *  on the host process — emergency rollback. The caller emits a
   *  one-time boot audit row and skips loading the BPF profile
   *  regardless of `seccompFd`. */
  seccompKillSwitchActive?: boolean;
  // ── Phase 58 / MCP-05 — Stage 2 veth additive fields (no breaking
  // change to Phase 55 callers; all optional). Populated by
  // `mcp-sandbox.ts:buildSandboxedMcpSpec` after the veth probe + slot
  // allocation + host-side veth create succeed. Consumed by the
  // launcher (env-threaded) and registry tear-down paths.
  /** True iff `probeVethCapability()` says the host can create veth
   *  pairs (Linux + ip + nft + CAP_NET_ADMIN). False on every dev host
   *  without those capabilities; the caller falls back to Stage 1. */
  vethAvailable?: boolean;
  /** Human-readable reason when `vethAvailable === false`. Surfaced
   *  verbatim in MCP_NETNS_FALLBACK audit metadata so operators chase
   *  the gap. */
  vethReason?: string;
  /** 8-hex shortId derived from `Bun.randomUUIDv7()` — the per-spawn
   *  identifier used inside veth interface names. */
  vethId?: string;
  /** MCP-side CIDR (e.g. "10.42.0.6/30") assigned to the namespace-side
   *  veth peer (renamed to `eth0` by the launcher). */
  vethIpv4?: string;
  /** Host-side veth interface name: `mcp-<8hex>` (12 chars). Attached
   *  to the `br-ezcorp-mcp` bridge. */
  vethHostSideName?: string;
  /** Namespace-side veth interface name BEFORE the launcher's rename
   *  to `eth0`: `mcp-<8hex>-ns` (15 chars — IFNAMSIZ ceiling).
   *  Pitfall 1 lock — CONTEXT.md's `mcp-<8hex>-host` (17 chars) is
   *  rejected by the kernel. */
  vethNsSideName?: string;
  /** True iff `EZCORP_MCP_STAGE2_VETH=0` is set on the host process —
   *  emergency rollback. The caller emits a one-time boot audit row
   *  and skips the Stage 2 setup, falling back to Stage 1 (bwrap +
   *  seccomp; no kernel-level network isolation). */
  stage2KillSwitchActive?: boolean;
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
  const bwrap = probeBwrapAvailability();
  // Plan 55-02 kill-switch: operators set EZCORP_MCP_STAGE1_TMPFS=0 to
  // skip the bwrap wrap (e.g. emergency rollback if a bwrap-induced
  // regression hits production). The check is intentionally string-
  // equality on "0" so unset (≡ enabled) and any other value (typo,
  // legacy "1", etc.) all keep the wrap on.
  const tmpfsKillSwitchActive = process.env.EZCORP_MCP_STAGE1_TMPFS === "0";

  // Plan 55-03 kill-switch + BPF FD open: mirrors the tmpfs kill-switch
  // shape exactly. When the kill-switch is set, the seccomp FD is
  // forcibly null (so mcp-sandbox.ts skips the stdio plumbing and the
  // launcher omits `--seccomp`). When the kill-switch is unset, we
  // open the precompiled BPF blob — on dev hosts without docker-build
  // output the loader returns null and the launcher silently runs
  // without the profile.
  const seccompKillSwitchActive = process.env.EZCORP_MCP_STAGE1_SECCOMP === "0";
  let seccompFd: number | null = null;
  if (!seccompKillSwitchActive) {
    seccompFd = openSeccompBpfFd();
  }

  if (!probe.available) {
    return {
      command: input.origCommand,
      args: [...input.origArgs],
      wrapped: false,
      bwrapAvailable: bwrap.available,
      bwrapReason: bwrap.reason,
      tmpfsKillSwitchActive,
      seccompFd,
      seccompKillSwitchActive,
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
    bwrapAvailable: bwrap.available,
    bwrapReason: bwrap.reason,
    tmpfsKillSwitchActive,
    seccompFd,
    seccompKillSwitchActive,
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
