/**
 * Per-conversation network-namespace scaffolding + capability detection
 * for secure previews (Secure User-Site Preview / Port Exposure, Phase 1
 * — see tasks/preview-port-exposure.md §2 + DECISION D2).
 *
 * The "only the requester" guarantee is structural: each conversation
 * that runs shell-capable tools gets its OWN netns (veth into
 * `br-ezcorp-mcp`, 10.42.0.0/24). A dev server listening inside that
 * netns belongs, by construction, to that conversation's user — no
 * PID-ancestry guessing. The proxy reaches a site by connecting to the
 * netns's veth IP:port; an ingress nft rule allows only `established +
 * from 10.42.0.1 to <devport>` and drops the rest.
 *
 * D2 (LOCKED): hosts WITHOUT netns / CAP_NET_ADMIN FAIL CLOSED for
 * dynamic previews (static still works), with a clear message. No
 * cgroup-attribution fallback. `previewCapabilities()` is the
 * boot/runtime probe that encodes this.
 *
 * Phase 1 scope (this module):
 *   - `previewCapabilities()` — fully testable capability detection.
 *   - the per-conversation netns allocation/reaping API SURFACE
 *     (in-memory registry over the existing veth-slot allocator).
 *   - `buildIngressAllowRule()` — the pure nft rule construction.
 * Actual dynamic passthrough (entering the netns, fetch-proxying) is
 * Phase 3; the alloc/reap functions here build the bookkeeping + reuse
 * the veth-slot allocator but do NOT yet create live veth pairs (that is
 * the Phase 3 wiring, flagged in the SUMMARY).
 */

import {
  probeNetnsAvailability,
  probeVethCapability,
  allocVethSlot,
  releaseVethSlot,
  computeVethMcpIp,
} from "../../extensions/mcp-netns";

/** The bridge gateway IP — the ONLY source allowed to reach a preview
 *  dev server's port (the proxy connects from here). Fixed by the
 *  br-ezcorp-mcp bridge on 10.42.0.0/24. */
export const PREVIEW_BRIDGE_GATEWAY = "10.42.0.1";

export interface PreviewCapabilities {
  /** Static previews work on EVERY host (no netns needed) — always true. */
  static: boolean;
  /** Dynamic previews require netns + CAP_NET_ADMIN. D2: fail-closed. */
  dynamic: boolean;
  /** Human-readable reason dynamic is unavailable (null when available).
   *  Surfaced to the user + logged (no silent degradation per policy). */
  reason: string | null;
}

let capabilitiesCache: PreviewCapabilities | null = null;

/**
 * Detect preview capabilities. Static is unconditional. Dynamic requires
 * BOTH the user+mount namespace probe (`probeNetnsAvailability`) AND the
 * veth/CAP_NET_ADMIN probe (`probeVethCapability`) to be available — if
 * either fails, dynamic is DISABLED (fail-closed, D2) with the first
 * failing probe's reason. Result is cached for the process lifetime
 * (the underlying probes are themselves cached + shell out at most once).
 */
export function previewCapabilities(): PreviewCapabilities {
  if (capabilitiesCache !== null) return capabilitiesCache;
  capabilitiesCache = computePreviewCapabilities();
  return capabilitiesCache;
}

function computePreviewCapabilities(): PreviewCapabilities {
  const netns = probeNetnsAvailability();
  if (!netns.available) {
    return { static: true, dynamic: false, reason: netns.reason ?? "user+mount namespace unavailable" };
  }
  const veth = probeVethCapability();
  if (!veth.available) {
    return { static: true, dynamic: false, reason: veth.reason ?? "veth / CAP_NET_ADMIN unavailable" };
  }
  return { static: true, dynamic: true, reason: null };
}

/** Test-only: drop the cached capabilities so a test can re-probe. */
export function _resetPreviewCapabilitiesForTests(): void {
  capabilitiesCache = null;
}

// ─────────────────────────────────────────────────────────────────────
// Per-conversation netns registry (API surface — Phase 1).
//
// In-memory map convId -> allocation. Lazy: a conversation gets a netns
// on first request, reaped on conversation close / idle / stop. Reuses
// the existing veth-slot allocator (60-slot concurrent cap) so previews
// and MCPs share one accounting source (no double-spend of the /24).
// ─────────────────────────────────────────────────────────────────────

export interface PreviewNetnsAllocation {
  conversationId: string;
  /** The veth slot (1..63) backing this conversation's netns. */
  slot: number;
  /** Opaque netns id stored on the preview_sessions row (`netns_id`). */
  netnsId: string;
  /** MCP/dev-server-side veth IP (e.g. "10.42.0.6/30") — the proxy's
   *  connect target for this conversation's dynamic previews. */
  vethIpv4: string;
}

const allocations = new Map<string, PreviewNetnsAllocation>();

/**
 * Allocate (or return the existing) netns for a conversation. Idempotent:
 * a second call for the same conversation returns the same allocation
 * without consuming another slot. Returns null when:
 *   - dynamic previews are unavailable on this host (D2 fail-closed), or
 *   - the veth-slot pool is exhausted (60-slot cap; logged, not silent).
 *
 * NOTE (Phase 1): this performs the BOOKKEEPING + slot reservation only.
 * Creating the live veth pair + entering the netns is Phase 3 wiring.
 */
export function allocatePreviewNetns(conversationId: string): PreviewNetnsAllocation | null {
  if (!conversationId) return null;
  const existing = allocations.get(conversationId);
  if (existing) return existing;

  if (!previewCapabilities().dynamic) return null;

  const slot = allocVethSlot();
  if (slot === null) return null; // pool exhausted

  const alloc: PreviewNetnsAllocation = {
    conversationId,
    slot,
    netnsId: `preview-conv-${conversationId}`,
    vethIpv4: computeVethMcpIp(slot),
  };
  allocations.set(conversationId, alloc);
  return alloc;
}

/** Look up a conversation's current netns allocation, if any. */
export function getPreviewNetns(conversationId: string): PreviewNetnsAllocation | undefined {
  return allocations.get(conversationId);
}

/**
 * Reap a conversation's netns: release the veth slot + drop the
 * bookkeeping. Idempotent — reaping an unknown conversation is a no-op.
 * Returns true when an allocation was actually released.
 */
export function reapPreviewNetns(conversationId: string): boolean {
  const alloc = allocations.get(conversationId);
  if (!alloc) return false;
  releaseVethSlot(alloc.slot);
  allocations.delete(conversationId);
  return true;
}

/** Number of conversations currently holding a netns allocation. */
export function activePreviewNetnsCount(): number {
  return allocations.size;
}

/** Test-only: clear all allocations (does NOT release slots in the
 *  underlying allocator — tests that need that call
 *  `_resetVethSlotAllocatorForTests` from mcp-netns). */
export function _resetPreviewNetnsForTests(): void {
  allocations.clear();
}

// ─────────────────────────────────────────────────────────────────────
// Ingress-allow rule construction (pure — Phase 1).
//
// The bridge already drops egress except the proxy gateway. For a
// dynamic preview we add a NARROW ingress allow: only the proxy
// gateway (10.42.0.1) may reach the dev server's port, and only on an
// established connection. Everything else is dropped. Returning the rule
// as a string keeps it unit-testable; Phase 3 feeds it to `nft -f -`.
// ─────────────────────────────────────────────────────────────────────

/**
 * Build the nftables ingress-allow rule set for a dynamic preview's dev
 * port. Policy: drop all inbound to the netns EXCEPT established traffic
 * and a fresh connection from the bridge gateway to exactly `<devPort>`.
 *
 * `gateway` defaults to the fixed bridge gateway 10.42.0.1.
 */
export function buildIngressAllowRule(devPort: number, gateway: string = PREVIEW_BRIDGE_GATEWAY): string {
  if (!Number.isInteger(devPort) || devPort <= 0 || devPort > 65535) {
    throw new Error(`buildIngressAllowRule: invalid devPort ${devPort}`);
  }
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(gateway)) {
    throw new Error(`buildIngressAllowRule: invalid gateway ${gateway}`);
  }
  return [
    "table inet preview-ingress {",
    "  chain input {",
    "    type filter hook input priority 0; policy drop;",
    "    ct state established,related accept",
    `    ip saddr ${gateway} tcp dport ${devPort} ct state new accept`,
    "  }",
    "}",
  ].join("\n");
}
