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
  buildNetnsSpawnArgs,
  getDefaultLauncherPath,
  probeVethCapability,
  allocVethSlot,
  releaseVethSlot,
  computeVethMcpIp,
} from "./mcp-netns";
import { createMcpProxy, type McpProxyHandle } from "./mcp-proxy";
import type { PermissionEngine } from "./permission-engine";
import { insertAuditEntry } from "../db/queries/audit-log";
import { EXT_AUDIT_ACTIONS } from "./audit-actions";
import { parseAndEmitSeccompViolations } from "./runtime/seccomp-soak-reader";
import { existsSync as realExistsSync, readFileSync as realReadFileSync } from "node:fs";

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

  // The pre-Phase-7 spec shape: command="prlimit", args=[--rss, --as,
  // <orig-cmd>, ...orig-args]. Build it once; the netns wrap (if any)
  // takes the entire array as its inner exec target.
  const prlimitCommand = "prlimit";
  const prlimitArgs: string[] = [
    `--rss=${memBytes}`,
    `--as=${memBytes}`,
    spec.command,
    ...(spec.args ?? []),
  ];

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
  const finalSpawn = buildNetnsSpawnArgs({
    origCommand: prlimitCommand,
    origArgs: prlimitArgs,
    launcherPath: getDefaultLauncherPath(),
  });

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
        }
      } else {
        releaseVethSlot(slot);
      }
    }
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
