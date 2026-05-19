/**
 * Phase 58 / MCP-05 — Plan 58-03 — Bridge + conntrack + orphan-sweep helpers.
 *
 * Three pure helpers consumed by `mcp-netns.ts:initStage2` at host boot:
 *
 *   - `ensureBridge({ subnetOverride? })` — idempotent create of
 *     `br-ezcorp-mcp` (10.42.0.0/24 default; CIDR override accepted).
 *     IPv6 disable applied on the bridge as a defensive while-we're-here
 *     hardening (Pitfall 4 — the load-bearing per-iface IPv6 disable
 *     lives in the launcher; this is belt-and-suspenders).
 *
 *   - `ensureConntrackCeiling(min = 262144)` — floor-guarantee for
 *     `/proc/sys/net/netfilter/nf_conntrack_max`. Debian bookworm with
 *     ≥4GB RAM already defaults to 262144, so this is idempotent
 *     only-write-if-lower on most production hosts.
 *
 *   - `sweepOrphanVeths(userId)` — boot-time walk of `ip -o link show`
 *     output. Deletes every interface whose name matches Plan 02's
 *     `mcp-<8hex>` host-side veth shape (12 chars; the kernel auto-
 *     cleans the namespace-side peer when its mate goes). Emits
 *     `MCP_VETH_ORPHAN_SWEPT` once per boot — even when zero orphans
 *     were found — so operators see "the sweep ran" as a positive
 *     signal.
 *
 * Test seam `_setBridgeOverridesForTests` mirrors Plan 55-02's
 * `_setBwrapProbeOverridesForTests` shape: production code stays clean
 * (no Bun-global mocking), and unit tests inject fake spawnSync /
 * readFileSync / existsSync to drive every failure branch.
 */

import { existsSync as realExistsSync, readFileSync as realReadFileSync } from "node:fs";
import { insertAuditEntry } from "../db/queries/audit-log";
import { EXT_AUDIT_ACTIONS } from "./audit-actions";

export const BRIDGE_NAME = "br-ezcorp-mcp";
export const BRIDGE_CIDR_DEFAULT = "10.42.0.1/24";

// Pitfall 1 correction: host-side name is `mcp-<8hex>` (12 chars),
// NOT `mcp-<8hex>-host` (17 chars - fails IFNAMSIZ=15). CONTEXT.md
// proposed -host suffix; RESEARCH Pitfall 1 corrected to no-suffix.
export const VETH_HOST_NAME_PATTERN = /^mcp-[a-f0-9]{8}$/;

/** Default conntrack floor — Debian bookworm with ≥4GB RAM already
 *  defaults here, so the bump is idempotent on most production hosts. */
const CONNTRACK_MAX_FLOOR = 262144;
const CONNTRACK_MAX_PROC = "/proc/sys/net/netfilter/nf_conntrack_max";

interface BridgeOverrides {
  /** Fake Bun.spawnSync for unit tests. */
  spawnSync?: typeof Bun.spawnSync;
  /** Fake node:fs readFileSync for unit tests. */
  readFileSync?: (path: string) => string;
  /** Fake node:fs existsSync for unit tests. */
  existsSync?: (path: string) => boolean;
}

let bridgeOverrides: BridgeOverrides | null = null;

/**
 * Inject test-only overrides. Pass `null` to clear.
 */
export function _setBridgeOverridesForTests(o: BridgeOverrides | null): void {
  bridgeOverrides = o;
}

function spawn(): typeof Bun.spawnSync {
  return bridgeOverrides?.spawnSync ?? Bun.spawnSync;
}

function readFile(path: string): string {
  if (bridgeOverrides?.readFileSync) return bridgeOverrides.readFileSync(path);
  return realReadFileSync(path, "utf8");
}

function pathExists(path: string): boolean {
  if (bridgeOverrides?.existsSync) return bridgeOverrides.existsSync(path);
  return realExistsSync(path);
}

/**
 * Idempotent bridge create. Returns `{ ok, subnet, reason? }`.
 *
 * Flow:
 *   1. `ip link show br-ezcorp-mcp` — success → bridge already up, no-op.
 *   2. `ip link add name br-ezcorp-mcp type bridge` — failure (e.g.
 *      CAP_NET_ADMIN missing) → `{ ok: false, reason: <stderr> }`.
 *   3. `ip addr add <cidr> dev br-ezcorp-mcp` — best-effort.
 *   4. `ip link set br-ezcorp-mcp up` — best-effort.
 *   5. `sysctl -w net.ipv6.conf.<bridge>.disable_ipv6=1` — best-effort
 *      defensive IPv6 disable on the bridge interface.
 *
 * The "best-effort" steps after a successful `ip link add` don't gate
 * the return — the bridge is created; ip-addr-add failure typically
 * means the address is already present (re-run scenario).
 */
export function ensureBridge(opts?: { subnetOverride?: string }): {
  ok: boolean;
  subnet: string;
  reason?: string;
} {
  const cidr = opts?.subnetOverride ?? BRIDGE_CIDR_DEFAULT;
  const sp = spawn();

  const check = sp({
    cmd: ["ip", "link", "show", BRIDGE_NAME],
    stdout: "ignore",
    stderr: "ignore",
  });
  if (check.success) return { ok: true, subnet: cidr };

  const add = sp({
    cmd: ["ip", "link", "add", "name", BRIDGE_NAME, "type", "bridge"],
    stdout: "ignore",
    stderr: "pipe",
  });
  if (!add.success) {
    const stderrStr = add.stderr
      ? new TextDecoder().decode(add.stderr as Uint8Array).trim()
      : "unknown";
    return { ok: false, subnet: cidr, reason: `bridge add failed: ${stderrStr}` };
  }

  sp({
    cmd: ["ip", "addr", "add", cidr, "dev", BRIDGE_NAME],
    stdout: "ignore",
    stderr: "ignore",
  });
  sp({
    cmd: ["ip", "link", "set", BRIDGE_NAME, "up"],
    stdout: "ignore",
    stderr: "ignore",
  });
  sp({
    cmd: ["sysctl", "-w", `net.ipv6.conf.${BRIDGE_NAME}.disable_ipv6=1`],
    stdout: "ignore",
    stderr: "ignore",
  });
  return { ok: true, subnet: cidr };
}

/**
 * Idempotent floor-guarantee for `nf_conntrack_max`. Only writes when
 * the current value is below `min`. On non-Linux (`/proc` absent) or
 * when the sysctl write fails, returns `{ ok: false }` with `before` /
 * `after` reflecting the observable state (no spurious "after" claim).
 */
export function ensureConntrackCeiling(min: number = CONNTRACK_MAX_FLOOR): {
  ok: boolean;
  before: number;
  after: number;
} {
  if (!pathExists(CONNTRACK_MAX_PROC)) {
    return { ok: false, before: 0, after: 0 };
  }
  let before = 0;
  try {
    before = Number.parseInt(readFile(CONNTRACK_MAX_PROC).trim(), 10) || 0;
  } catch {
    return { ok: false, before: 0, after: 0 };
  }
  if (before >= min) {
    return { ok: true, before, after: before };
  }
  const sp = spawn();
  const write = sp({
    cmd: ["sysctl", "-w", `net.netfilter.nf_conntrack_max=${min}`],
    stdout: "ignore",
    stderr: "ignore",
  });
  if (!write.success) {
    return { ok: false, before, after: before };
  }
  return { ok: true, before, after: min };
}

/**
 * Boot-time orphan sweep. Walks `ip -o link show`, regex-matches each
 * interface name against `VETH_HOST_NAME_PATTERN`, deletes every match,
 * and emits ONE `MCP_VETH_ORPHAN_SWEPT` audit row per call — even when
 * zero orphans were found (operator visibility contract — "the sweep
 * ran" is a positive signal).
 *
 * On `ip link show` failure (CAP_NET_ADMIN missing or kernel locked
 * down), returns `{ count: 0, names: [], error }`. The caller
 * (`initStage2`) maps the error to the cascade-to-Stage-1 fallback +
 * `MCP_NETNS_FALLBACK` boot row.
 *
 * `ip -o link show` line shape (typical):
 *   `12: mcp-deadbeef@if13: <BROADCAST,MULTICAST,UP> mtu 1500 ...`
 *
 * The regex strips the leading index + colon and the trailing `@peer`
 * suffix before matching against VETH_HOST_NAME_PATTERN.
 */
export async function sweepOrphanVeths(
  userId: string | null,
): Promise<{ count: number; names: string[]; error?: string }> {
  const sp = spawn();
  const list = sp({
    cmd: ["ip", "-o", "link", "show"],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!list.success) {
    const stderrStr = list.stderr
      ? new TextDecoder().decode(list.stderr as Uint8Array).trim()
      : "unknown";
    return {
      count: 0,
      names: [],
      error: `ip link show failed: ${stderrStr}`,
    };
  }
  const stdoutStr = list.stdout
    ? new TextDecoder().decode(list.stdout as Uint8Array)
    : "";
  const names: string[] = [];
  for (const line of stdoutStr.split("\n")) {
    if (!line.trim()) continue;
    // Format: `<idx>: <name>[@peer]: <flags...>`. Pull out the second
    // colon-separated field and strip the optional `@peer` suffix.
    const match = line.match(/^\s*\d+:\s+([^:@\s]+)(?:@[^:\s]+)?:/);
    if (!match) continue;
    const name = match[1];
    if (name && VETH_HOST_NAME_PATTERN.test(name)) {
      names.push(name);
    }
  }
  for (const name of names) {
    sp({
      cmd: ["ip", "link", "delete", name],
      stdout: "ignore",
      stderr: "ignore",
    });
  }
  // Operator-visibility contract: emit ONE row per boot, even count=0.
  try {
    await insertAuditEntry(userId, EXT_AUDIT_ACTIONS.MCP_VETH_ORPHAN_SWEPT, undefined, {
      permission: "network",
      oldValue: null,
      newValue: null,
      actor: "system",
      count: names.length,
      names,
    });
  } catch {
    // Fire-and-forget — boot must not fail on audit write hiccup.
  }
  return { count: names.length, names };
}
