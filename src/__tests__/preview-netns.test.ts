/**
 * Secure User-Site Preview / Port Exposure — Phase 1.
 * Per-conversation netns scaffolding + capability detection (D2).
 *
 * Critical invariants under test:
 *  - previewCapabilities(): static ALWAYS true; dynamic requires BOTH
 *    netns + veth/CAP_NET_ADMIN; fails CLOSED with a reason otherwise
 *  - allocatePreviewNetns: idempotent per conversation; null when dynamic
 *    unavailable or the slot pool is exhausted; reuses the veth allocator
 *  - reapPreviewNetns: releases the slot + bookkeeping; idempotent
 *  - buildIngressAllowRule: drop-all + established + from-gateway-to-port
 *    only; validates port + gateway
 *
 * The mcp-netns probes shell out to the kernel, so we mock that module to
 * drive the available / unavailable branches deterministically.
 */
import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";

// The mcp-netns stub below is process-global; without a restore it
// leaks into mcp-netns-fallback.test.ts (which needs the REAL probes)
// whenever that file is co-scheduled after this one. Restore is
// SURGICAL (snapshot + re-register just this module) rather than a
// restoreModuleMocks() sweep: the sweep re-registers ~70 `$server/*`
// aliases, and adding a new sweep-caller before phase-2b-e2e.test.ts
// flips that file's `mock.module("$server/extensions/registry",
// async …)` registration into a busy-hang.
const REAL_MCP_NETNS = { ...(await import("../extensions/mcp-netns")) };
afterAll(() => {
  mock.module("../extensions/mcp-netns", () => REAL_MCP_NETNS);
});

// Controllable probe results + a real-ish slot allocator.
let netnsAvailable = { available: true, reason: undefined as string | undefined };
let vethAvailable = { available: true, reason: undefined as string | undefined };
let slotPool: number[] = [];
let nextSlot = 1;

mock.module("../extensions/mcp-netns", () => ({
  probeNetnsAvailability: () => netnsAvailable,
  probeVethCapability: () => vethAvailable,
  allocVethSlot: () => {
    if (slotPool.length >= 60) return null;
    const s = nextSlot++;
    slotPool.push(s);
    return s;
  },
  releaseVethSlot: (s: number) => {
    slotPool = slotPool.filter((x) => x !== s);
  },
  computeVethMcpIp: (slot: number) => `10.42.0.${slot * 4 + 2}/30`,
}));

// NOTE: we deliberately do NOT mock.module("../runtime/preview/preview-spawn")
// here — Bun's mock.module is process-global and would leak the stubbed
// `isPreviewSpawnHelperPresent` into preview-spawn.test.ts. The host has no
// installed /app setuid helper, so the REAL `isPreviewSpawnHelperPresent()`
// returns false; that's exactly the default these tests want (netns-or-
// static). Precedence branches that need helper-present inject it via
// computePreviewCapabilities's `helperPresent` dep instead.

const netns = await import("../runtime/preview/preview-netns");

beforeEach(() => {
  netnsAvailable = { available: true, reason: undefined };
  vethAvailable = { available: true, reason: undefined };
  slotPool = [];
  nextSlot = 1;
  netns._resetPreviewCapabilitiesForTests();
  netns._resetPreviewNetnsForTests();
});

describe("previewCapabilities — capability MODE (netns > uid > static)", () => {
  test("netns mode when both netns + veth probes pass (hardened)", () => {
    const caps = netns.previewCapabilities();
    expect(caps.static).toBe(true);
    expect(caps.dynamic).toBe(true);
    expect(caps.mode).toBe("netns");
    expect(caps.reason).toBeNull();
  });

  test("static (fail-closed) when netns unavailable + no setuid helper", () => {
    netnsAvailable = { available: false, reason: "not linux" };
    netns._resetPreviewCapabilitiesForTests();
    const caps = netns.previewCapabilities();
    expect(caps.static).toBe(true);
    expect(caps.dynamic).toBe(false);
    expect(caps.mode).toBe("static");
    expect(caps.reason).toContain("not linux");
  });

  test("caches the result (probe not re-evaluated until reset)", () => {
    expect(netns.previewCapabilities().mode).toBe("netns");
    netnsAvailable = { available: false, reason: "changed" };
    expect(netns.previewCapabilities().mode).toBe("netns"); // cached
  });

  // Precedence branches via the injectable computePreviewCapabilities so
  // each tier is deterministic regardless of the host.
  test("precedence: netns wins when netns+veth available", () => {
    const caps = netns.computePreviewCapabilities({
      probeNetns: () => ({ available: true }),
      probeVeth: () => ({ available: true }),
      helperPresent: () => true,
    });
    expect(caps.mode).toBe("netns");
    expect(caps.dynamic).toBe(true);
  });

  test("precedence: uid mode when netns missing but helper present", () => {
    const caps = netns.computePreviewCapabilities({
      probeNetns: () => ({ available: false, reason: "EPERM unshare" }),
      probeVeth: () => ({ available: false }),
      helperPresent: () => true,
    });
    expect(caps.mode).toBe("uid");
    expect(caps.dynamic).toBe(true);
    expect(caps.reason).toContain("portable uid mode");
  });

  test("precedence: uid mode when netns present but veth/CAP_NET_ADMIN missing", () => {
    const caps = netns.computePreviewCapabilities({
      probeNetns: () => ({ available: true }),
      probeVeth: () => ({ available: false, reason: "no CAP_NET_ADMIN" }),
      helperPresent: () => true,
    });
    expect(caps.mode).toBe("uid");
    expect(caps.dynamic).toBe(true);
  });

  test("precedence: static fail-closed when neither netns nor helper", () => {
    const caps = netns.computePreviewCapabilities({
      probeNetns: () => ({ available: false, reason: "not linux" }),
      probeVeth: () => ({ available: false }),
      helperPresent: () => false,
    });
    expect(caps.mode).toBe("static");
    expect(caps.dynamic).toBe(false);
    expect(caps.static).toBe(true);
    expect(caps.reason).toContain("setuid spawn helper not present");
  });
});

describe("per-conversation netns allocation", () => {
  test("allocates a netns + veth slot for a conversation", () => {
    const a = netns.allocatePreviewNetns("conv-1");
    expect(a).not.toBeNull();
    expect(a!.conversationId).toBe("conv-1");
    expect(a!.slot).toBe(1);
    expect(a!.netnsId).toBe("preview-conv-conv-1");
    expect(a!.vethIpv4).toBe("10.42.0.6/30");
    expect(netns.activePreviewNetnsCount()).toBe(1);
  });

  test("is idempotent — same conversation reuses its allocation (no double-spend)", () => {
    const a = netns.allocatePreviewNetns("conv-1");
    const b = netns.allocatePreviewNetns("conv-1");
    expect(b).toEqual(a!);
    expect(slotPool.length).toBe(1);
    expect(netns.activePreviewNetnsCount()).toBe(1);
  });

  test("returns null when dynamic previews are unavailable (D2)", () => {
    netnsAvailable = { available: false, reason: "not linux" };
    netns._resetPreviewCapabilitiesForTests();
    expect(netns.allocatePreviewNetns("conv-x")).toBeNull();
    expect(netns.activePreviewNetnsCount()).toBe(0);
  });

  test("mode-gate: returns null when mode is NOT 'netns' WITHOUT consuming a veth slot", () => {
    // Phase 3a added the explicit `previewCapabilities().mode !== "netns"`
    // gate: netns allocation is reserved for the hardened netns mode — uid
    // mode uses the uid pool, static mode allocates nothing. Here the netns
    // probe is up but the veth/CAP_NET_ADMIN probe is DOWN, so the resolved
    // mode is non-netns (static on this host — no setuid helper). The gate
    // must short-circuit to null BEFORE touching the slot allocator, so the
    // pool is left untouched (this distinguishes the mode-gate from
    // slot-exhaustion: a wrongly-gated impl would burn a slot first).
    netnsAvailable = { available: true, reason: undefined };
    vethAvailable = { available: false, reason: "no CAP_NET_ADMIN" };
    netns._resetPreviewCapabilitiesForTests();

    expect(netns.previewCapabilities().mode).not.toBe("netns");
    expect(netns.allocatePreviewNetns("conv-gated")).toBeNull();
    expect(netns.activePreviewNetnsCount()).toBe(0);
    // No slot was consumed — the gate ran before allocVethSlot().
    expect(slotPool.length).toBe(0);
  });

  test("returns null when the slot pool is exhausted", () => {
    for (let i = 0; i < 60; i++) expect(netns.allocatePreviewNetns(`c-${i}`)).not.toBeNull();
    expect(netns.allocatePreviewNetns("c-overflow")).toBeNull();
  });

  test("returns null for an empty conversation id", () => {
    expect(netns.allocatePreviewNetns("")).toBeNull();
  });

  test("getPreviewNetns returns the current allocation", () => {
    expect(netns.getPreviewNetns("conv-1")).toBeUndefined();
    const a = netns.allocatePreviewNetns("conv-1");
    expect(netns.getPreviewNetns("conv-1")).toEqual(a!);
  });
});

describe("reapPreviewNetns", () => {
  test("releases the slot + bookkeeping and is idempotent", () => {
    netns.allocatePreviewNetns("conv-1");
    expect(slotPool.length).toBe(1);
    expect(netns.reapPreviewNetns("conv-1")).toBe(true);
    expect(slotPool.length).toBe(0);
    expect(netns.activePreviewNetnsCount()).toBe(0);
    // second reap is a no-op
    expect(netns.reapPreviewNetns("conv-1")).toBe(false);
  });

  test("frees a slot so a new conversation can reuse the pool", () => {
    for (let i = 0; i < 60; i++) netns.allocatePreviewNetns(`c-${i}`);
    expect(netns.allocatePreviewNetns("c-new")).toBeNull();
    netns.reapPreviewNetns("c-0");
    expect(netns.allocatePreviewNetns("c-new")).not.toBeNull();
  });
});

describe("buildIngressAllowRule", () => {
  test("drops all input except established + from-gateway-to-port", () => {
    const rule = netns.buildIngressAllowRule(5173);
    expect(rule).toContain("policy drop;");
    expect(rule).toContain("ct state established,related accept");
    expect(rule).toContain("ip saddr 10.42.0.1 tcp dport 5173 ct state new accept");
  });

  test("honors a custom gateway", () => {
    const rule = netns.buildIngressAllowRule(8080, "10.42.0.5");
    expect(rule).toContain("ip saddr 10.42.0.5 tcp dport 8080 ct state new accept");
  });

  test("rejects invalid ports + gateways", () => {
    expect(() => netns.buildIngressAllowRule(0)).toThrow();
    expect(() => netns.buildIngressAllowRule(70000)).toThrow();
    expect(() => netns.buildIngressAllowRule(-1)).toThrow();
    expect(() => netns.buildIngressAllowRule(5173, "not-an-ip")).toThrow();
  });
});
