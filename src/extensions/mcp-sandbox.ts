import type {
  ExtensionManifestV2,
  ExtensionPermissions,
  McpServerDefinition,
  McpServerStdio,
} from "./types";
import { buildAllowedEnv } from "./registry";
import { parseMemoryLimit, DEFAULT_MEMORY_LIMIT_MB } from "./subprocess";
import {
  probeNetnsAvailability,
  probeBwrapAvailability,
  buildNetnsSpawnArgs,
  getDefaultLauncherPath,
  probeVethCapability,
  allocVethSlot,
  releaseVethSlot,
  computeVethMcpIp,
  type NetnsCapabilities,
} from "./mcp-netns";
import { createMcpProxy, type McpProxyHandle } from "./mcp-proxy";
import type { PermissionEngine } from "./permission-engine";
import { insertAuditEntry } from "../db/queries/audit-log";
import { getDbMaskDirs } from "../db/connection";
import { EXT_AUDIT_ACTIONS } from "./audit-actions";
import { parseAndEmitSeccompViolations } from "./runtime/seccomp-soak-reader";
import {
  buildMcpJailBwrapArgs,
  assertJailArgsSafe,
  forbiddenDataDir,
  DEFAULT_RO_SYSTEM_DIRS,
} from "./preview-jail";
import { getSandboxTier, type SandboxTier } from "./sandbox/capability-probe";
import { buildLandlockJailSpec } from "./sandbox/landlock";
import { LANDLOCK_SPEC_ENV } from "./sandbox/landlock-shim";
import { fileURLToPath } from "node:url";
import {
  existsSync as realExistsSync,
  readFileSync as realReadFileSync,
  closeSync,
  mkdirSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";

/**
 * Audit finding #1 fix: MCP stdio extensions must run under the same
 * sandbox envelope as regular subprocess extensions — `prlimit` for
 * resource bounds + `buildAllowedEnv` so the child never inherits the
 * web server's `process.env` (which would otherwise leak secrets like
 * `EZCORP_PERMITTED_HOSTS`, `EZCORP_SHELL_ALLOWED`, or operator vars).
 *
 * Phase 7 extension: when a `ctx` (PermissionEngine + audit context)
 * is supplied, we additionally:
 *   - On Linux with userns enabled: wrap the spawn in `unshare -U -m`
 *     and a launcher script that drops CAP_SYS_ADMIN before exec.
 *     (Phase 7 fix-pass C2: the original `-U -n -m` chain trapped the
 *     MCP in a netns where the host's loopback proxy was unreachable
 *     and HTTPS_PROXY URLs were unparseable. Dropped `-n`.)
 *   - Always: start a per-MCP forward proxy on host loopback (random
 *     OS-assigned port) and inject `HTTPS_PROXY` env so the MCP's
 *     outbound HTTPS traffic routes through the proxy. The proxy gates
 *     each CONNECT against the manifest's network grant.
 *
 * `ctx` is optional. Unit tests that exercise `buildSandboxedMcpSpec`
 * without a real PDP omit it; the function returns the prlimit-only
 * spec from before Phase 7 in that case. The production caller
 * (`registry.getMcpClient`) always provides `ctx`.
 *
 * Not applicable to http/sse transports: those transports are network
 * clients, not subprocess spawns, so there is nothing to sandbox.
 */

export interface BuildSandboxedMcpCtx {
  engine: PermissionEngine;
  conversationId: string | null;
  userId: string | null;
}

// ─────────────────────────────────────────────────────────────────────
// Plan 55-02 — kill-switch boot row tracking.
//
// When `EZCORP_MCP_STAGE1_TMPFS=0` is set we emit ONE audit row per
// process lifetime so operators see what's disabled in /audit. The
// flag persists across all `buildSandboxedMcpSpec` calls; tests reset
// via `_resetTmpfsKillSwitchBootFlagForTests`.
// ─────────────────────────────────────────────────────────────────────
let killSwitchBootRowEmitted = false;

export function _resetTmpfsKillSwitchBootFlagForTests(): void {
  killSwitchBootRowEmitted = false;
}

// ─────────────────────────────────────────────────────────────────────
// Plan 55-03 — seccomp kill-switch boot row tracking.
//
// Parallel to the tmpfs kill-switch above: a one-time-per-process flag
// that fires the first time `EZCORP_MCP_STAGE1_SECCOMP=0` causes a
// spawn to skip the BPF profile load. Operators reading /audit see
// exactly one row per process lifetime indicating the seccomp profile
// is disabled. Tests reset via `_resetSeccompKillSwitchBootFlagForTests`.
// ─────────────────────────────────────────────────────────────────────
let seccompKillSwitchBootRowEmitted = false;

export function _resetSeccompKillSwitchBootFlagForTests(): void {
  seccompKillSwitchBootRowEmitted = false;
}

// ─────────────────────────────────────────────────────────────────────
// Phase 58 / MCP-05 — Stage 2 veth kill-switch boot row tracking.
//
// Mirrors the tmpfs + seccomp kill-switch one-time module-scope flags
// above. Fires exactly once per process when EZCORP_MCP_STAGE2_VETH=0
// causes a spawn to skip the Stage 2 wrap (falling back to Stage 1 —
// bwrap + seccomp without kernel-level network isolation). Operators
// reading `/audit` see exactly one row per process lifetime with
// `reason='kill-switch: stage2 veth disabled'`. Tests reset via
// `_resetStage2KillSwitchBootFlagForTests`.
// ─────────────────────────────────────────────────────────────────────
let stage2KillSwitchBootRowEmitted = false;

export function _resetStage2KillSwitchBootFlagForTests(): void {
  stage2KillSwitchBootRowEmitted = false;
}

// ─────────────────────────────────────────────────────────────────────
// Phase 58 / MCP-05 — Plan 58-03 — Pre-spawn conntrack pressure guard.
//
// Reads /proc/sys/net/netfilter/nf_conntrack_count + _max via a test
// seam (`_setConntrackOverridesForTests`). When count > 0.7 * max
// (strict `>` not `>=`), the spawn is refused with a descriptive error
// AND an MCP_CONNTRACK_HIGH audit row is emitted (fire-and-forget).
//
// On non-Linux (or /proc absent), the check is skipped — no audit row,
// no refusal. Companion to the boot-time `ensureConntrackCeiling` floor-
// guarantee in `mcp-bridge.ts`.
// ─────────────────────────────────────────────────────────────────────
interface ConntrackOverrides {
  readFile?: (path: string) => string;
  exists?: (path: string) => boolean;
}
let conntrackOverrides: ConntrackOverrides | null = null;

export function _setConntrackOverridesForTests(
  o: ConntrackOverrides | null,
): void {
  conntrackOverrides = o;
}

function readConntrackPressure(): {
  ok: boolean;
  count: number;
  max: number;
  ratio: number;
} {
  const exists = conntrackOverrides?.exists ?? ((p: string) => realExistsSync(p));
  const read =
    conntrackOverrides?.readFile ?? ((p: string) => realReadFileSync(p, "utf8"));
  const maxPath = "/proc/sys/net/netfilter/nf_conntrack_max";
  const countPath = "/proc/sys/net/netfilter/nf_conntrack_count";
  if (!exists(maxPath) || !exists(countPath)) {
    return { ok: false, count: 0, max: 0, ratio: 0 };
  }
  let max = 0;
  let count = 0;
  try {
    max = Number.parseInt(read(maxPath).trim(), 10) || 0;
    count = Number.parseInt(read(countPath).trim(), 10) || 0;
  } catch {
    return { ok: false, count: 0, max: 0, ratio: 0 };
  }
  if (max <= 0) return { ok: false, count: 0, max: 0, ratio: 0 };
  return { ok: true, count, max, ratio: count / max };
}

// ─────────────────────────────────────────────────────────────────────
// EZCORP_MCP_REQUIRE_SANDBOX — fail-closed sandbox enforcement.
//
// Pre-launch security finding: every fallback point below (netns probe
// failure, missing bwrap, Stage 2 veth/nft setup failure, Stage 1/2
// kill-switches) FAILS OPEN — the spawn proceeds at a weaker isolation
// stage with only a fire-and-forget MCP_NETNS_FALLBACK audit row. On
// many real Docker hosts netns/veth cannot be set up even with
// --privileged, so untrusted MCP extensions silently run without
// kernel network isolation.
//
// When the operator sets `EZCORP_MCP_REQUIRE_SANDBOX=1`, ANY spawn
// that would degrade below full isolation (Stage 1 userns wrap + bwrap
// tmpfs + seccomp BPF profile + Stage 2 veth network isolation) is
// REFUSED instead: the spawn throws an operator-actionable error
// (propagated through `registry.getMcpClient`, the same surface as
// the conntrack-pressure refusal above) and emits one
// MCP_SANDBOX_REQUIRED_REFUSAL audit row per refusal.
//
// Default (flag unset / any value other than "1"): behavior is exactly
// the pre-flag fail-open degrade — existing stage detection, fallback
// logic, and audit rows are untouched.
// ─────────────────────────────────────────────────────────────────────

function isSandboxRequired(): boolean {
  return process.env.EZCORP_MCP_REQUIRE_SANDBOX === "1";
}

// ─────────────────────────────────────────────────────────────────────
// CRITICAL security fix — MCP filesystem confinement.
//
// The launcher's bwrap branch mapped the WHOLE host filesystem into the
// jail (`--bind / /`) — only /tmp was swapped out. MCP servers are
// arbitrary external binaries (Python/Go/Rust — the SDK sandbox-preload
// module-poisoning does NOT apply to them), so any MCP could read the
// PGlite data dir (full user DB + JWT secret), `~/.ssh`, `.env`, etc.
//
// Two-layer fix, both built here on the host:
//   - ALWAYS (default posture): `env.EZCORP_MCP_DATA_DIR` threads the
//     forbidden `<projectRoot>/.ezcorp/data` path so the launcher masks
//     it with a private tmpfs ON TOP of the back-compat `--bind / /`
//     envelope. No spawn that works today stops working; the platform's
//     own DB + JWT secret stop being readable.
//   - STRICT (EZCORP_MCP_REQUIRE_SANDBOX=1): the complete bwrap argv is
//     built via `preview-jail.ts:buildMcpJailBwrapArgs` (minimal bind
//     set — ONE rw extension-data work dir, ro system dirs, private
//     tmpfs /tmp, NO root bind, nothing under `.ezcorp/data`) and the
//     launcher execs it verbatim (`EZCORP_MCP_FS_JAIL=1` branch, same
//     contract as EZCORP_PREVIEW_JAIL). Any failure to build the jail
//     refuses the spawn through the existing require-sandbox gate.
//
// `projectRootOverride` is a test seam (mirrors the conntrack / soak
// seams above): production resolves the root from `buildAllowedEnv`'s
// EZCORP_PROJECT_ROOT (host-computed — deliberately NOT overridable by
// the manifest's `spec.env`).
// ─────────────────────────────────────────────────────────────────────
let projectRootOverride: string | null | undefined = undefined;

export function _setProjectRootOverrideForTests(
  v: string | null | undefined,
): void {
  projectRootOverride = v;
}

// ──────────────────────────────────────────────────────────────────────
// Phase A3 (Seam C) — unconditional, tier-gated filesystem jail.
//
// Closes the documented default-posture leak: previously the non-strict
// leg execed `--bind / /` (whole host fs visible) and merely MASKED the
// DB/secret dir with a tmpfs (a denylist). The fs-jail is now ALWAYS on
// when the capability probe reports a usable tier — an allowlist that
// never binds the host root:
//   - "bwrap"    tier → the existing EZCORP_MCP_FS_JAIL=1 minimal-bind
//                       launcher branch (reused, no longer strict-only).
//   - "landlock" tier → wrap the inner command with the Landlock shim
//                       (works in the Docker container where bwrap's
//                       unprivileged userns is blocked — Phase A1 finding).
//   - "advisory" tier → no OS jail available; fall back to the legacy
//                       masked `--bind / /` path (best-effort, unchanged).
//
// EZCORP_MCP_REQUIRE_SANDBOX=1 still hard-FAILS the spawn on any
// degradation; the difference is the jail no longer DEPENDS on that flag.
let sandboxTierOverride: SandboxTier | null = null;
/** Test-only: pin the resolved sandbox tier (bypasses the live probe). */
export function _setSandboxTierOverrideForTests(t: SandboxTier | null): void {
  sandboxTierOverride = t;
}
function resolveSandboxTier(): SandboxTier {
  return sandboxTierOverride ?? getSandboxTier();
}

/** Resolve the colocated Landlock shim path (works under bun + bundling). */
function landlockShimPath(): string {
  return fileURLToPath(new URL("./sandbox/landlock-shim.ts", import.meta.url));
}

/**
 * RO system dirs for the strict MCP jail: the conventional Linux set
 * (filtered to dirs that exist on this host) plus runtime prefixes
 * (/opt, /nix) and the directory of the resolved MCP binary when it
 * lives outside that set (e.g. `~/.local/bin`). Never "/", "/home",
 * or $HOME itself — binding those would re-expose user secrets.
 */
function computeMcpJailRoDirs(mcpCommand: string): string[] {
  const dirs = [...DEFAULT_RO_SYSTEM_DIRS, "/opt", "/nix"].filter((d) =>
    realExistsSync(d),
  );
  const resolved = mcpCommand.includes("/")
    ? resolve(mcpCommand)
    : Bun.which(mcpCommand);
  if (resolved) {
    const binDir = dirname(resolved);
    const home = process.env.HOME ? resolve(process.env.HOME) : null;
    const denied = binDir === "/" || binDir === "/home" || binDir === home;
    const covered = dirs.some((d) => binDir === d || binDir.startsWith(d + "/"));
    if (!denied && !covered && realExistsSync(binDir)) dirs.push(binDir);
  }
  return dirs;
}

/**
 * Emit the refusal audit row (fire-and-forget, matching every other
 * audit row in this file) and throw the operator-actionable spawn
 * error. Single helper so all degrade points share one row shape and
 * one message format.
 */
function refuseDegradedSpawn(opts: {
  userId: string | null;
  extensionId: string;
  extensionName: string;
  capability: string;
  reason: string;
}): never {
  void insertAuditEntry(
    opts.userId,
    EXT_AUDIT_ACTIONS.MCP_SANDBOX_REQUIRED_REFUSAL,
    opts.extensionId,
    {
      permission: "network",
      oldValue: null,
      newValue: null,
      actor: "system",
      extensionName: opts.extensionName,
      requiredCapability: opts.capability,
      reason: opts.reason,
      platform: process.platform,
    },
  ).catch(() => {
    // Fire-and-forget — the throw below is the load-bearing refusal;
    // a DB blip in the audit writer must not mask it.
  });
  throw new Error(
    `MCP spawn refused: EZCORP_MCP_REQUIRE_SANDBOX=1 requires full sandbox isolation, ` +
      `but ${opts.capability} is unavailable on this host (${opts.reason}). ` +
      `Provision the missing capability (see docs/deployment.md § "Fail-closed sandbox ` +
      `enforcement") or unset EZCORP_MCP_REQUIRE_SANDBOX to allow degraded spawns.`,
  );
}

/**
 * Statically-detectable degradations, checked BEFORE the per-MCP proxy
 * is started so a refusal never leaks a listener. Covers: netns probe
 * failure, bwrap probe failure, the Stage 1 tmpfs + seccomp and Stage 2
 * veth kill-switches (deliberately disabling an isolation layer
 * contradicts the require-sandbox flag), and the veth capability probe
 * (Linux + ip + nft + CAP_NET_ADMIN, incl. stage2-degraded-at-boot).
 *
 * The two remaining degrade points — seccomp BPF blob missing and the
 * runtime veth slot/create/attach failures — are only observable
 * mid-flow and are guarded inline in `buildSandboxedMcpSpec`.
 *
 * Returns `null` when the host can deliver full isolation.
 */
function detectStaticSandboxDegradation(
  netns: NetnsCapabilities,
): { capability: string; reason: string } | null {
  if (!netns.available) {
    return {
      capability: "user+mount namespace isolation (unshare)",
      reason: netns.reason ?? "netns probe failed",
    };
  }
  const bwrap = probeBwrapAvailability();
  if (!bwrap.available) {
    return {
      capability: "bubblewrap tmpfs sandbox (bwrap)",
      reason: bwrap.reason ?? "bwrap probe failed",
    };
  }
  if (process.env.EZCORP_MCP_STAGE1_TMPFS === "0") {
    return {
      capability: "bubblewrap tmpfs sandbox (bwrap)",
      reason: "kill-switch active: EZCORP_MCP_STAGE1_TMPFS=0",
    };
  }
  if (process.env.EZCORP_MCP_STAGE1_SECCOMP === "0") {
    return {
      capability: "seccomp BPF syscall filter",
      reason: "kill-switch active: EZCORP_MCP_STAGE1_SECCOMP=0",
    };
  }
  if (process.env.EZCORP_MCP_STAGE2_VETH === "0") {
    return {
      capability: "Stage 2 veth network isolation",
      reason: "kill-switch active: EZCORP_MCP_STAGE2_VETH=0",
    };
  }
  const veth = probeVethCapability();
  if (!veth.available) {
    return {
      capability: "Stage 2 veth network isolation (ip/nft/CAP_NET_ADMIN)",
      reason: veth.reason ?? "veth probe failed",
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Plan 55-03 — post-shutdown soak reader injection seam.
//
// Tests inject a fake journalctl runner so the spawn-time wiring can
// be unit-tested without requiring an actual MCP child to have run
// (and without depending on host kernel state). Production code path
// is unchanged when `seccompSoakOverrides` is null.
//
// The seam returns (a) the journalctl lines to feed the parser and
// (b) optionally the child's PID to filter on. In production we use
// the host PID Bun.spawn returns.
// ─────────────────────────────────────────────────────────────────────
interface SeccompSoakOverrides {
  /** Feeds the parser instead of shelling out to journalctl. */
  runJournalctl: (sinceISO: string, pid: string) => Promise<readonly string[]>;
}
let seccompSoakOverrides: SeccompSoakOverrides | null = null;

export function _setSeccompSoakOverridesForTests(
  overrides: SeccompSoakOverrides | null,
): void {
  seccompSoakOverrides = overrides;
}

export interface BuildSandboxedMcpResult {
  spec: McpServerDefinition;
  /** Proxy handle, or null when `ctx` was omitted (test path) or the
   *  transport isn't stdio. The caller is responsible for `proxyHandle.stop()`
   *  on extension unload. */
  proxyHandle: McpProxyHandle | null;
}

/**
 * Build the sandboxed spawn spec for an MCP server. Phase 7 made this
 * async because the proxy listener must be bound before we hand the
 * URL to the child via env. Sync callers (the existing unit tests for
 * pre-Phase-7 invariants) drop into a back-compat branch when `ctx` is
 * omitted and never await proxy startup.
 */
export async function buildSandboxedMcpSpec(
  spec: McpServerDefinition,
  manifest: ExtensionManifestV2,
  grantedPermissions: ExtensionPermissions,
  extensionId: string,
  ctx?: BuildSandboxedMcpCtx,
): Promise<BuildSandboxedMcpResult> {
  if (spec.transport !== "stdio") return { spec, proxyHandle: null };

  // Fail-closed switch — read once per spawn so tests (and operators
  // restarting the host process) see a consistent decision per call.
  const sandboxRequired = isSandboxRequired();

  // Phase A3 (Seam C) — resolve the OS-isolation tier once per spawn. The
  // fs-jail is now unconditional whenever a usable tier is present (bwrap
  // or landlock), not gated behind EZCORP_MCP_REQUIRE_SANDBOX. The flag
  // still controls fail-CLOSED vs fail-SAFE behavior on degradation.
  const sandboxTier = resolveSandboxTier();
  // bwrap-tier fs-jail wanted whenever the tier supports it OR the operator
  // forced strict mode. The landlock tier is handled separately below (it
  // can't use the bwrap launcher branch — no userns in the container).
  const bwrapJailWanted = sandboxRequired || sandboxTier === "bwrap";

  // Phase 58 / MCP-05 — Plan 58-03 — pre-spawn conntrack pressure check.
  // Short-circuits BEFORE any proxy or Stage 2 setup work: if the kernel
  // table is >70% full, refuse the spawn + emit MCP_CONNTRACK_HIGH.
  // Threshold matches the Linux kernel's own conntrack-pressure warning.
  // SKIPs cleanly on non-Linux (/proc absent) — no audit row, no refusal.
  if (ctx) {
    const conntrack = readConntrackPressure();
    if (conntrack.ok && conntrack.ratio > 0.7) {
      void insertAuditEntry(
        ctx.userId,
        EXT_AUDIT_ACTIONS.MCP_CONNTRACK_HIGH,
        extensionId,
        {
          permission: "network",
          oldValue: null,
          newValue: null,
          actor: "system",
          extensionName: manifest.name,
          conntrackCount: conntrack.count,
          conntrackMax: conntrack.max,
          ratio: conntrack.ratio,
        },
      ).catch(() => {});
      throw new Error(
        `MCP spawn refused: conntrack table pressure ${(conntrack.ratio * 100).toFixed(1)}% > 70% threshold. ` +
          `Wait for active TCP connections to drain (TIME_WAIT 120s default) or bump net.netfilter.nf_conntrack_max.`,
      );
    }
  }

  const memBytes = manifest.resources?.memory
    ? parseMemoryLimit(manifest.resources.memory)
    : DEFAULT_MEMORY_LIMIT_MB * 1024 * 1024;

  const baseEnv = buildAllowedEnv(manifest, grantedPermissions, extensionId);
  const env: Record<string, string> = { ...baseEnv, ...(spec.env ?? {}) };

  // `--rss` caps resident (physical) memory — that's the real bound on
  // how much RAM the child can occupy. `--as` (virtual address space)
  // must NOT be pinned to the same value: JIT runtimes (Bun's JSC +
  // mimalloc, Node, JVM) RESERVE tens of GB of *virtual* address space
  // at startup while keeping RSS tiny. Setting `--as=${memBytes}` (512MB
  // default) is below Bun's minimum reservation and segfaults it before
  // the first JSON-RPC byte. We keep a FINITE `--as` ceiling (the AF-1
  // invariant — child must not inherit the parent's "unlimited") but
  // size it with generous headroom so the runtime's virtual reservations
  // fit. Floor at 4 GiB; scale to 8× rss for larger memory grants.
  const asBytes = Math.max(memBytes * 8, 4 * 1024 * 1024 * 1024);

  // The pre-Phase-7 spec shape: command="prlimit", args=[--rss, --as,
  // <orig-cmd>, ...orig-args]. Build it once; the netns wrap (if any)
  // takes the entire array as its inner exec target.
  const prlimitCommand = "prlimit";
  const prlimitArgs: string[] = [
    `--rss=${memBytes}`,
    `--as=${asBytes}`,
    spec.command,
    ...(spec.args ?? []),
  ];

  // Fail-closed gate (no-ctx leg): the back-compat branch below builds
  // a prlimit-only spec — no namespace, no proxy, no bwrap. Under
  // EZCORP_MCP_REQUIRE_SANDBOX=1 that is far below full isolation, so
  // refuse rather than silently producing the weakest possible spec.
  if (sandboxRequired && !ctx) {
    refuseDegradedSpawn({
      userId: null,
      extensionId,
      extensionName: manifest.name,
      capability: "sandbox wiring (PermissionEngine ctx)",
      reason: "buildSandboxedMcpSpec called without ctx — prlimit-only spec",
    });
  }

  // Back-compat path: when `ctx` is omitted, skip Phase-7 wrap. Existing
  // unit tests covering only the prlimit + bounded-env invariants land
  // here and behave identically to their pre-Phase-7 expectations.
  if (!ctx) {
    const wrapped: McpServerStdio = {
      transport: "stdio",
      name: spec.name,
      description: spec.description,
      command: prlimitCommand,
      args: prlimitArgs,
      env,
    };
    return { spec: wrapped, proxyHandle: null };
  }

  // Phase 7 — production wiring path.
  const netns = probeNetnsAvailability();

  // Fail-closed gate (static legs): netns, bwrap, kill-switches, and
  // the veth capability probe are all knowable BEFORE any setup work,
  // so a refusal here never leaks a proxy listener or a veth slot.
  if (sandboxRequired) {
    const degraded = detectStaticSandboxDegradation(netns);
    if (degraded) {
      refuseDegradedSpawn({
        userId: ctx.userId,
        extensionId,
        extensionName: manifest.name,
        capability: degraded.capability,
        reason: degraded.reason,
      });
    }
  }

  // CRITICAL fix — minimal-bind filesystem jail (strict leg). Built
  // BEFORE the proxy starts so a refusal never leaks a listener (same
  // placement rationale as the static gate above). See the module-scope
  // comment at `projectRootOverride` for the full design. The project
  // root comes from the HOST-resolved EZCORP_PROJECT_ROOT in `baseEnv`
  // (never from `spec.env` — the manifest must not be able to steer the
  // data-dir exclusion).
  const jailProjectRoot =
    projectRootOverride !== undefined
      ? projectRootOverride
      : baseEnv.EZCORP_PROJECT_ROOT ?? null;
  let strictJailArgs: string[] | null = null;
  // Phase A3 — landlock-tier env additions (the shim wrap + spec). Threaded
  // into `env` near the end so `spec.env` can't override them.
  let landlockJailEnv: Record<string, string> | null = null;
  let landlockShimWrap: { bun: string; shim: string } | null = null;

  // Phase A3 — the per-extension writable workspace (the ONLY rw host path
  // in the jail). Shared by both the bwrap and landlock legs.
  const computeWorkDir = (root: string): string =>
    join(root, ".ezcorp", "extension-data", manifest.name);

  if (bwrapJailWanted) {
    // Project root is REQUIRED to compute the .ezcorp/data exclusion. Under
    // strict mode a missing root fails CLOSED; otherwise we can't safely
    // jail, so fall back to the legacy masked path (fail-SAFE).
    if (!jailProjectRoot) {
      if (sandboxRequired) {
        refuseDegradedSpawn({
          userId: ctx.userId,
          extensionId,
          extensionName: manifest.name,
          capability: "minimal-bind filesystem jail (project root)",
          reason:
            "EZCORP_PROJECT_ROOT unresolved (no .git ancestor) — cannot compute the .ezcorp/data exclusion",
        });
      }
      // else: leave strictJailArgs null → legacy masked --bind / / path.
    } else {
      try {
        // The ONLY writable host path inside the jail: the extension's own
        // data store (docs/extensions/data-storage.md convention). Created
        // up front — the builder's canonicalization fails closed on
        // missing paths.
        const workDir = computeWorkDir(jailProjectRoot);
        mkdirSync(workDir, { recursive: true });
        const extTmpDir = baseEnv.TMPDIR;
        strictJailArgs = buildMcpJailBwrapArgs({
          workDir,
          projectRoot: jailProjectRoot,
          roSystemDirs: computeMcpJailRoDirs(spec.command),
          // bwrap reads the BPF blob from FD 3 (the
          // EZCORP_MCP_BWRAP_SECCOMP_FD convention). A missing blob is
          // refused by the seccomp gate below before any spawn happens,
          // so the flag never dangles.
          seccompFd: 3,
          // Re-create the per-extension TMPDIR inside the fresh tmpfs so
          // runtimes that honor TMPDIR keep working.
          tmpDirs:
            extTmpDir?.startsWith("/tmp/") ? [extTmpDir] : [],
          command: prlimitCommand,
          args: prlimitArgs,
        });
        // Runtime guard against a future refactor re-opening the hole.
        assertJailArgsSafe(strictJailArgs, jailProjectRoot);
      } catch (err) {
        if (sandboxRequired) {
          refuseDegradedSpawn({
            userId: ctx.userId,
            extensionId,
            extensionName: manifest.name,
            capability: "minimal-bind filesystem jail (bwrap bind set)",
            reason: (err as Error).message,
          });
        }
        // Non-strict: jail build failed (e.g. missing bin dir) — fall back
        // to the legacy masked path rather than refuse the spawn.
        strictJailArgs = null;
      }
    }
  } else if (sandboxTier === "landlock" && jailProjectRoot) {
    // Phase A3 — landlock tier (the Docker container, where bwrap's
    // unprivileged userns is blocked). Wrap the inner command with the
    // Landlock shim: it applies an allowlist fs-jail in-process then execs
    // the inner command (which inherits the restrictions). NOTHING under
    // .ezcorp/data is granted — buildLandlockJailSpec asserts this.
    try {
      const workDir = computeWorkDir(jailProjectRoot);
      mkdirSync(workDir, { recursive: true });
      const llSpec = buildLandlockJailSpec({
        workspaceDir: workDir,
        projectRoot: jailProjectRoot,
        roPaths: computeMcpJailRoDirs(spec.command),
      });
      landlockJailEnv = { [LANDLOCK_SPEC_ENV]: JSON.stringify(llSpec) };
      landlockShimWrap = { bun: "bun", shim: landlockShimPath() };
    } catch {
      // Non-strict landlock build failure → legacy masked path (fail-safe).
      landlockJailEnv = null;
      landlockShimWrap = null;
    }
  }

  // Proxy always listens on host loopback (post-fix-pass C2 — UDS
  // produces an unparseable `http+unix://...` HTTPS_PROXY URL). The MCP
  // process shares the host's network namespace (unshare drops `-n`)
  // so 127.0.0.1:<port> is reachable from inside the user+mount
  // namespace. Bearer token at the proxy gates rogue same-host
  // processes; per-host PDP gates the destination.
  const proxyHandle = createMcpProxy({
    extensionId,
    extensionName: manifest.name,
    conversationId: ctx.conversationId,
    userId: ctx.userId,
    permittedHosts: grantedPermissions.network ?? [],
    engine: ctx.engine,
    bindAddress: "127.0.0.1:0",
  });
  await proxyHandle.start();

  // Inject HTTPS_PROXY / HTTP_PROXY. The URL embeds the per-instance
  // bearer token so only this MCP can pass the proxy's auth gate.
  // Lower-case forms are also injected because some HTTP clients
  // (notably Python's requests + Go's http.DefaultTransport) check the
  // lower-case env names exclusively.
  const proxyUrl = proxyHandle.proxyUrl();
  env.HTTPS_PROXY = proxyUrl;
  env.HTTP_PROXY = proxyUrl;
  env.https_proxy = proxyUrl;
  env.http_proxy = proxyUrl;

  // Audit either MCP_NETNS_CREATED (user+mount namespace entered) or
  // MCP_NETNS_FALLBACK (no namespace) exactly once per spawn so fleet
  // operators can quantify which deployments hit the namespace path.
  // Fire-and-forget on purpose: a DB blip in the audit writer must not
  // fail-open the spawn — the proxy + namespace are already in place,
  // the audit row is just a signal. See `auditBlocked` in mcp-proxy.ts
  // for the same fire-and-forget treatment.
  const auditAction = netns.available
    ? EXT_AUDIT_ACTIONS.MCP_NETNS_CREATED
    : EXT_AUDIT_ACTIONS.MCP_NETNS_FALLBACK;
  void insertAuditEntry(
    ctx.userId,
    auditAction,
    extensionId,
    {
      permission: "network",
      oldValue: null,
      newValue: null,
      actor: "system",
      extensionName: manifest.name,
      reason: netns.reason ?? null,
      proxyUrl: `127.0.0.1:${new URL(proxyUrl).port}`,
      platform: process.platform,
    },
  ).catch(() => {
    // Fire-and-forget — see comment above. Logging an audit row failure
    // here would itself need a DB write, so we swallow.
  });

  // Build the final command/args. On Linux netns, prepend `unshare -U
  // -n -m -- <launcher.sh> ...`. Otherwise leave the prlimit chain
  // unchanged.
  const launcherPath = getDefaultLauncherPath();
  const finalSpawn = buildNetnsSpawnArgs({
    origCommand: prlimitCommand,
    origArgs: prlimitArgs,
    launcherPath,
  });

  // Fail-closed gate (seccomp leg): the static gate above already
  // guaranteed bwrap is present and both Stage 1 kill-switches are off,
  // so a null `seccompFd` here means the compiled BPF blob itself is
  // missing — the spawn would run without the syscall filter. Stop the
  // proxy we just started before refusing (no listener leak).
  if (sandboxRequired && finalSpawn.seccompFd == null) {
    try {
      await proxyHandle.stop();
    } catch {
      /* best-effort teardown */
    }
    refuseDegradedSpawn({
      userId: ctx.userId,
      extensionId,
      extensionName: manifest.name,
      capability: "seccomp BPF syscall filter",
      reason: "compiled BPF profile missing (mcp-seccomp.bpf absent or unreadable)",
    });
  }

  // Plan 55-02 (MCP-02): emit one extra MCP_NETNS_FALLBACK row when
  // bwrap is missing on a Linux host so /audit shows "tmpfs absent" as
  // a degraded mode. This is ON TOP of the existing MCP_NETNS_CREATED
  // row — operators reading the audit stream see both that the user+
  // mount namespace was entered AND that the inner tmpfs wrap was
  // skipped, so they can chase the missing dependency.
  if (
    finalSpawn.bwrapAvailable === false &&
    !finalSpawn.tmpfsKillSwitchActive &&
    netns.available
  ) {
    void insertAuditEntry(
      ctx.userId,
      EXT_AUDIT_ACTIONS.MCP_NETNS_FALLBACK,
      extensionId,
      {
        permission: "network",
        oldValue: null,
        newValue: null,
        actor: "system",
        extensionName: manifest.name,
        reason: "bubblewrap unavailable",
        bwrapReason: finalSpawn.bwrapReason ?? null,
        platform: process.platform,
      },
    ).catch(() => {
      // Fire-and-forget — see existing MCP_NETNS_CREATED row above.
    });
  }

  // Plan 55-02 kill-switch boot row — fires exactly once per process
  // lifetime when the operator has set EZCORP_MCP_STAGE1_TMPFS=0. The
  // row goes through the same audit-action constant + fire-and-forget
  // path as the bwrap-missing row above; only the `reason`
  // discriminator changes.
  if (finalSpawn.tmpfsKillSwitchActive && !killSwitchBootRowEmitted) {
    killSwitchBootRowEmitted = true;
    void insertAuditEntry(
      ctx.userId,
      EXT_AUDIT_ACTIONS.MCP_NETNS_FALLBACK,
      extensionId,
      {
        permission: "network",
        oldValue: null,
        newValue: null,
        actor: "system",
        extensionName: manifest.name,
        reason: "kill-switch: tmpfs disabled",
        platform: process.platform,
      },
    ).catch(() => {});
  }

  // Plan 55-03 (MCP-03) kill-switch boot row — fires exactly once per
  // process lifetime when the operator has set EZCORP_MCP_STAGE1_SECCOMP=0.
  // Same one-time module-scope flag pattern as the tmpfs kill-switch
  // above. Mirrors uniform Stage 1 kill-switch boot-row treatment per
  // checker B1: all three (DNS_RECHECK in Plan 01, TMPFS in Plan 02,
  // SECCOMP here) emit exactly one MCP_NETNS_FALLBACK boot row.
  if (
    finalSpawn.seccompKillSwitchActive &&
    !seccompKillSwitchBootRowEmitted
  ) {
    seccompKillSwitchBootRowEmitted = true;
    void insertAuditEntry(
      ctx.userId,
      EXT_AUDIT_ACTIONS.MCP_NETNS_FALLBACK,
      extensionId,
      {
        permission: "network",
        oldValue: null,
        newValue: null,
        actor: "system",
        extensionName: manifest.name,
        reason: "kill-switch: seccomp disabled",
        platform: process.platform,
      },
    ).catch(() => {});
  }

  // ─────────────────────────────────────────────────────────────────
  // Phase 58 / MCP-05 — Stage 2 veth setup.
  //
  // Gates (ALL must hold; otherwise fall back to Stage 1):
  //   - probeVethCapability() returns available (Linux + ip + nft +
  //     CAP_NET_ADMIN)
  //   - EZCORP_MCP_STAGE2_VETH !== "0" kill-switch is inactive
  //   - allocVethSlot() returned a slot (60-MCP concurrent cap)
  //   - host-side veth create + attach-to-bridge + bring-up all succeed
  //
  // On Stage 2 success: emit MCP_VETH_CREATED audit row; thread env
  // vars consumed by the launcher (EZCORP_MCP_STAGE2_VETH_ENABLED=1 +
  // peer name + IP + gateway); attach `onChildSpawned` callback +
  // `_internal_vethSetup` carrier on the returned spec.
  //
  // Gracefully degrades when the bridge is missing — Plan 03 owns
  // bridge boot; if the master-set step fails, we clean up the orphan
  // host-side veth and release the slot, leaving the caller on Stage 1.
  // ─────────────────────────────────────────────────────────────────
  const vethCap = probeVethCapability();
  const stage2KillSwitchActive = process.env.EZCORP_MCP_STAGE2_VETH === "0";

  // Stage 2 kill-switch boot row — fires exactly once per process when
  // operator has explicitly disabled Stage 2. Mirrors uniform Stage 1
  // kill-switch boot-row treatment (DNS_RECHECK, TMPFS, SECCOMP).
  if (stage2KillSwitchActive && !stage2KillSwitchBootRowEmitted) {
    stage2KillSwitchBootRowEmitted = true;
    void insertAuditEntry(
      ctx.userId,
      EXT_AUDIT_ACTIONS.MCP_NETNS_FALLBACK,
      extensionId,
      {
        permission: "network",
        oldValue: null,
        newValue: null,
        actor: "system",
        extensionName: manifest.name,
        reason: "kill-switch: stage2 veth disabled",
        platform: process.platform,
      },
    ).catch(() => {});
  }

  let vethSetup: {
    slot: number;
    vethId: string;
    hostSideName: string;
    nsSideName: string;
    vethIpv4: string;
  } | null = null;
  // Captured for the fail-closed gate below — names which runtime step
  // degraded the spawn to Stage 1 (slot exhaustion / create / attach).
  let vethDegradeReason: string | null = null;

  if (vethCap.available && !stage2KillSwitchActive && netns.available) {
    const slot = allocVethSlot();
    if (slot !== null) {
      // 8-hex shortId from UUIDv7 — monotonic-by-time so the orphan
      // sweep (Plan 03) can reason about "older than process start".
      const vethId = Bun.randomUUIDv7().replace(/-/g, "").slice(0, 8);
      const hostSideName = `mcp-${vethId}`;        // 12 chars
      const nsSideName = `mcp-${vethId}-ns`;       // 15 chars (IFNAMSIZ ceiling)
      const vethIpv4 = computeVethMcpIp(slot);

      // Create the veth pair (host-side + namespace-side as a linked peer).
      const create = Bun.spawnSync({
        cmd: ["ip", "link", "add", hostSideName, "type", "veth", "peer", "name", nsSideName],
        stdout: "ignore",
        stderr: "pipe",
      });
      if (create.success) {
        // Attach host-side to the shared `br-ezcorp-mcp` bridge.
        // Plan 03 lands `ensureBridge()` at boot; if it isn't up here,
        // master-set fails and we degrade to Stage 1.
        const attachToBridge = Bun.spawnSync({
          cmd: ["ip", "link", "set", hostSideName, "master", "br-ezcorp-mcp"],
          stdout: "ignore",
          stderr: "pipe",
        });
        const bringUp = Bun.spawnSync({
          cmd: ["ip", "link", "set", hostSideName, "up"],
          stdout: "ignore",
          stderr: "ignore",
        });
        if (attachToBridge.success && bringUp.success) {
          vethSetup = { slot, vethId, hostSideName, nsSideName, vethIpv4 };
        } else {
          // Bridge missing or down — clean up the orphan veth, release slot,
          // fall back to Stage 1.
          Bun.spawnSync({
            cmd: ["ip", "link", "delete", hostSideName],
            stdout: "ignore",
            stderr: "ignore",
          });
          releaseVethSlot(slot);
          vethDegradeReason =
            "veth bridge attach/up failed (br-ezcorp-mcp missing or down)";
        }
      } else {
        releaseVethSlot(slot);
        const createStderr = create.stderr
          ? new TextDecoder().decode(create.stderr).trim()
          : "";
        vethDegradeReason = `veth pair create failed${createStderr ? `: ${createStderr}` : ""}`;
      }
    } else {
      vethDegradeReason = "veth slot exhausted (60 concurrent MCP cap)";
    }
  }

  // Fail-closed gate (Stage 2 runtime leg): under the require-sandbox
  // flag the static gate already guaranteed the veth CAPABILITY, so a
  // null `vethSetup` here means a runtime step failed (slot exhaustion,
  // veth create, or bridge attach). Tear down everything built so far
  // (proxy listener + seccomp FD — the veth/slot were already cleaned
  // up by the branches above) before refusing.
  if (sandboxRequired && vethSetup === null) {
    if (finalSpawn.seccompFd != null) {
      try {
        closeSync(finalSpawn.seccompFd);
      } catch {
        /* best-effort */
      }
    }
    try {
      await proxyHandle.stop();
    } catch {
      /* best-effort teardown */
    }
    refuseDegradedSpawn({
      userId: ctx.userId,
      extensionId,
      extensionName: manifest.name,
      capability: "Stage 2 veth network isolation",
      reason: vethDegradeReason ?? "veth setup failed",
    });
  }

  // Emit MCP_VETH_CREATED on Stage 2 success — operator-visible signal
  // that this MCP spawn got the kernel-level network isolation leg.
  if (vethSetup !== null) {
    void insertAuditEntry(
      ctx.userId,
      EXT_AUDIT_ACTIONS.MCP_VETH_CREATED,
      extensionId,
      {
        permission: "network",
        oldValue: null,
        newValue: null,
        actor: "system",
        extensionName: manifest.name,
        vethId: vethSetup.vethId,
        hostSideName: vethSetup.hostSideName,
        nsSideName: vethSetup.nsSideName,
        ipv4: vethSetup.vethIpv4,
      },
    ).catch(() => {});
  }

  // Plan 55-02: thread the bwrap state into the spawned env so
  // `mcp-launcher.sh` knows whether to exec under bubblewrap. The
  // launcher reads `EZCORP_MCP_BWRAP_ENABLED` BEFORE the existing
  // capsh probe; when set to "1" it execs `bwrap ... -- $@`,
  // otherwise it falls through to the unchanged capsh+exec path.
  if (
    finalSpawn.bwrapAvailable === true &&
    !finalSpawn.tmpfsKillSwitchActive
  ) {
    env.EZCORP_MCP_BWRAP_ENABLED = "1";
    // CRITICAL fix — always-on data-dir exclusion (default posture).
    // The launcher masks these paths with a private tmpfs on top of its
    // back-compat `--bind / /` envelope, so the PGlite DB + JWT secret
    // are never visible to the MCP even when the operator has not
    // opted into the strict minimal-bind jail. Set AFTER the env merge
    // above so a manifest's `spec.env` cannot override it.
    //
    // Mask the REAL DB dir + backups (resolved from EZCORP_DB_PATH, e.g.
    // prod's `/app/data/ezcorp` + `/app/data/backups`), NOT the parent
    // and NOT just the `.ezcorp/data` convention path. Masking the parent
    // would hide `/app/data/extensions` (the MCP install base); masking
    // only the convention path left the actual DB+JWT readable in prod.
    // Also mask the project `.ezcorp/data` convention path for
    // deployments that keep the DB there. Deduped, `:`-joined.
    const masks = new Set<string>(getDbMaskDirs());
    if (jailProjectRoot) masks.add(forbiddenDataDir(jailProjectRoot));
    if (masks.size > 0) {
      env.EZCORP_MCP_DATA_DIR = [...masks].join(":");
    }
  }

  // Plan 55-03 (MCP-03): thread the seccomp FD into the spawned env
  // AND populate the wrapper's `seccompFd` field so the MCP transport
  // layer can pass the FD via Bun.spawn's stdio array (index 3 —
  // bwrap reads from FD 3 per the launcher's `--seccomp 3`).
  //
  // Activation gates (all must hold):
  //   - bwrap is available (bwrap is the seccomp loader; no bwrap
  //     means no profile load even if the BPF blob is on disk).
  //   - tmpfs kill-switch is inactive (an operator disabling tmpfs
  //     usually means they want the entire bwrap branch off; we don't
  //     load seccomp in that case either to avoid mixed-mode confusion).
  //   - seccomp kill-switch is inactive.
  //   - The BPF FD opened successfully (file present, non-empty).
  //
  // When the gates pass, set EZCORP_MCP_BWRAP_SECCOMP_FD=3 so the
  // launcher appends `--seccomp 3` to its bwrap exec line. The actual
  // FD plumbing into Bun.spawn's stdio array is the caller's
  // responsibility (the wrapper's `seccompFd` field carries the value).
  let attachedSeccompFd: number | null = null;
  if (
    finalSpawn.bwrapAvailable === true &&
    !finalSpawn.tmpfsKillSwitchActive &&
    !finalSpawn.seccompKillSwitchActive &&
    finalSpawn.seccompFd != null
  ) {
    env.EZCORP_MCP_BWRAP_SECCOMP_FD = "3";
    attachedSeccompFd = finalSpawn.seccompFd;
  } else if (finalSpawn.seccompFd != null) {
    // Gates didn't pass — close the FD we opened to avoid a leak.
    try {
      const { closeSync } = require("node:fs");
      closeSync(finalSpawn.seccompFd);
    } catch {
      /* best-effort */
    }
  }

  // CRITICAL fix — minimal-bind fs-jail activation (Phase A3: now
  // UNCONDITIONAL, tier-gated, no longer requires EZCORP_MCP_REQUIRE_SANDBOX).
  // Hand the launcher the pre-built minimal-bind bwrap argv: everything
  // after the launcher path in the unshare chain is replaced by the jail
  // argv, and EZCORP_MCP_FS_JAIL=1 routes the launcher to its exec-verbatim
  // branch (which has NO `--bind / /` — the leak this closes). When the
  // operator forced strict mode, EZCORP_MCP_REQUIRE_SANDBOX is threaded too
  // so the launcher's raw-exec fallback fails closed. Set after the env
  // merge — `spec.env` cannot override either var.
  if (strictJailArgs !== null && finalSpawn.wrapped) {
    env.EZCORP_MCP_FS_JAIL = "1";
    if (sandboxRequired) env.EZCORP_MCP_REQUIRE_SANDBOX = "1";
    const launcherIdx = finalSpawn.args.indexOf(launcherPath);
    finalSpawn.args = [
      ...finalSpawn.args.slice(0, launcherIdx + 1),
      ...strictJailArgs,
    ];
  } else if (landlockShimWrap !== null && landlockJailEnv !== null) {
    // Phase A3 — landlock-tier activation (container; no bwrap launcher).
    // Wrap the INNER command (the prlimit chain) with the Landlock shim:
    // `bun <shim> -- <prlimit ...>`. The shim applies the allowlist fs-jail
    // in-process then execs the inner command, which inherits the jail.
    // Threads EZCORP_LANDLOCK_SPEC after the env merge so `spec.env` can't
    // override the data-dir exclusion.
    Object.assign(env, landlockJailEnv);
    if (finalSpawn.command === prlimitCommand) {
      // Unwrapped (no netns): prepend the shim to the prlimit chain.
      finalSpawn.command = landlockShimWrap.bun;
      finalSpawn.args = [
        landlockShimWrap.shim,
        "--",
        prlimitCommand,
        ...finalSpawn.args,
      ];
    } else {
      // netns-wrapped: insert the shim right after the launcher path so the
      // inner command runs jailed inside the namespace.
      const launcherIdx = finalSpawn.args.indexOf(launcherPath);
      if (launcherIdx >= 0) {
        finalSpawn.args = [
          ...finalSpawn.args.slice(0, launcherIdx + 1),
          landlockShimWrap.bun,
          landlockShimWrap.shim,
          "--",
          ...finalSpawn.args.slice(launcherIdx + 1),
        ];
      }
    }
  }

  // Phase 58 / MCP-05: when Stage 2 wired up, thread the launcher env
  // variables (consumed by the heredoc in mcp-launcher.sh) and capture
  // the proxy gateway port for the default-route step.
  if (vethSetup !== null) {
    env.EZCORP_MCP_STAGE2_VETH_ENABLED = "1";
    env.EZCORP_MCP_VETH_PEER_NAME = vethSetup.nsSideName;
    env.EZCORP_MCP_VETH_IPV4 = vethSetup.vethIpv4;
    // Bridge gateway is fixed at 10.42.0.1; port is the proxy listener.
    // Plan 03 will widen the proxy to bind both 127.0.0.1 AND 10.42.0.1;
    // until then the in-namespace MCP needs the bridge-side host to be
    // reachable (deferred to Plan 03 as part of bridge boot).
    const proxyPort = new URL(proxyUrl).port;
    env.EZCORP_MCP_PROXY_HOST_GATEWAY = `10.42.0.1:${proxyPort}`;
  }

  // Capture-by-value for the onChildSpawned closure so the spec carries
  // its OWN reference to vethSetup (not the outer let-binding).
  const capturedVethSetup = vethSetup;

  const wrapped: McpServerStdio = {
    transport: "stdio",
    name: spec.name,
    description: spec.description,
    command: finalSpawn.command,
    args: finalSpawn.args,
    env,
    // Plan 55-03: when set, the spawn caller threads this into
    // Bun.spawn({ stdio: [..., ..., ..., <FD>] }) at index 3 so
    // bwrap can dlopen the BPF program off FD 3. Close after spawn.
    seccompFd: attachedSeccompFd,
    // Phase 58 / MCP-05: opaque carrier consumed by registry.ts on both
    // the connect-failure tear-down path AND the happy-path child-exit
    // cleanup. Null when Stage 2 isn't active.
    _internal_vethSetup: capturedVethSetup,
    // Phase 58 / MCP-05: post-spawn hook. McpClient invokes this AFTER
    // the SDK transport spawns the child AND BEFORE the JSON-RPC
    // initialize. Two steps:
    //   1. Move the namespace-side veth peer into the child's netns.
    //   2. Write 1 byte to the child's stdin to release the launcher's
    //      `read -n 1` handshake. Caller-provided `writeByte` abstracts
    //      the actual stdin reach (decouples from SDK transport internals).
    onChildSpawned: capturedVethSetup !== null
      ? async (pid: number, writeByte: (b: number) => Promise<void>) => {
          const move = Bun.spawnSync({
            cmd: ["ip", "link", "set", capturedVethSetup.nsSideName, "netns", String(pid)],
            stdout: "ignore",
            stderr: "pipe",
          });
          if (!move.success) {
            const stderrStr = move.stderr ? new TextDecoder().decode(move.stderr).trim() : "unknown";
            throw new Error(`veth move failed: ${stderrStr}`);
          }
          // Release the launcher's read -n 1 wait with a single byte.
          await writeByte(0x01);
        }
      : undefined,
  };

  // Plan 55-03 (MCP-03): schedule the post-shutdown soak reader. We
  // don't have a child handle here (mcp-sandbox builds a SPEC; the
  // actual Bun.spawn happens in the transport layer downstream), so
  // we expose a hook the caller invokes once it has the child PID +
  // spawn timestamp. Tests use `_setSeccompSoakOverridesForTests` to
  // exercise the path deterministically.
  //
  // For production wiring: the registry caller passes the spawned
  // child's PID into `runMcpSeccompSoakReader(pid, spawnAt, ctx)`
  // when proc.exited resolves. This is wired in `registry.ts` and
  // documented in 55-03-SUMMARY.md.
  return { spec: wrapped, proxyHandle };
}

/**
 * Post-shutdown soak reader. Run by the caller after `proc.exited`
 * resolves: it shells out to `journalctl -k --since=<spawnAt> --no-pager
 * --output=short`, parses the lines for `audit: type=1326` entries
 * matching the spawned child's PID, and emits one MCP_SECCOMP_VIOLATION
 * audit row per match.
 *
 * SKIPs silently on non-Linux (no journalctl) or when journalctl is
 * missing from PATH (hardened containers). Errors during the spawn
 * are swallowed — the MCP has already exited, there is nothing to
 * fail-close on.
 *
 * Test seam: `_setSeccompSoakOverridesForTests` injects a fake
 * journalctl runner so unit tests can drive the parser deterministically.
 */
export async function runMcpSeccompSoakReader(
  childPid: number,
  spawnAt: Date,
  ctx: { userId: string | null; extensionId: string; extensionName: string },
): Promise<void> {
  const lines = await readJournalctlLines(spawnAt, String(childPid));
  if (lines.length === 0) return;
  await parseAndEmitSeccompViolations(lines, String(childPid), ctx);
}

async function readJournalctlLines(
  spawnAt: Date,
  pid: string,
): Promise<readonly string[]> {
  if (seccompSoakOverrides) {
    try {
      return await seccompSoakOverrides.runJournalctl(
        spawnAt.toISOString(),
        pid,
      );
    } catch {
      return [];
    }
  }
  if (process.platform !== "linux") return [];
  if (!Bun.which("journalctl")) return [];
  try {
    const proc = Bun.spawn({
      cmd: [
        "journalctl",
        "-k",
        "--since",
        spawnAt.toISOString(),
        "--no-pager",
        "--output=short",
      ],
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return text.split("\n").filter((line) => line.length > 0);
  } catch {
    return [];
  }
}
