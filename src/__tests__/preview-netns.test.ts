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

describe("previewCapabilities — capability MODE (uid > static)", () => {
  test("static (fail-closed) without the setuid helper, even when netns + veth probes pass", () => {
    // The probes in this file report netns + veth available; the host has
    // no installed /app setuid helper, so the real check returns false.
    const caps = netns.previewCapabilities();
    expect(caps).toEqual({
      static: true,
      dynamic: false,
      mode: "static",
      reason: "dynamic previews disabled: setuid spawn helper not present/functional",
    });
  });

  test("uid mode whenever the helper is present, whatever the netns probes say", () => {
    for (const available of [true, false]) {
      const caps = netns.computePreviewCapabilities({
        probeNetns: () => ({ available }),
        probeVeth: () => ({ available }),
        helperPresent: () => true,
      });
      expect(caps).toEqual({ static: true, dynamic: true, mode: "uid", reason: null });
    }
  });

  test("caches the result until reset", () => {
    const first = netns.previewCapabilities();
    expect(netns.previewCapabilities()).toBe(first);
  });
});

describe("per-conversation netns allocation", () => {
  test("never allocates: the netns tier is not selected, so no veth slot is spent", () => {
    expect(netns.allocatePreviewNetns("conv-1")).toBeNull();
    expect(netns.allocatePreviewNetns("")).toBeNull();
    expect(netns.getPreviewNetns("conv-1")).toBeUndefined();
    expect(netns.reapPreviewNetns("conv-1")).toBe(false);
    expect(netns.activePreviewNetnsCount()).toBe(0);
    expect(slotPool.length).toBe(0);
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
