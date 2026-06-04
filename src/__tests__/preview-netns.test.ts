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
import { test, expect, describe, beforeEach, mock } from "bun:test";

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

const netns = await import("../runtime/preview/preview-netns");

beforeEach(() => {
  netnsAvailable = { available: true, reason: undefined };
  vethAvailable = { available: true, reason: undefined };
  slotPool = [];
  nextSlot = 1;
  netns._resetPreviewCapabilitiesForTests();
  netns._resetPreviewNetnsForTests();
});

describe("previewCapabilities (D2 fail-closed)", () => {
  test("static is always available; dynamic available when both probes pass", () => {
    const caps = netns.previewCapabilities();
    expect(caps.static).toBe(true);
    expect(caps.dynamic).toBe(true);
    expect(caps.reason).toBeNull();
  });

  test("dynamic fails closed (static still works) when netns is unavailable", () => {
    netnsAvailable = { available: false, reason: "not linux" };
    netns._resetPreviewCapabilitiesForTests();
    const caps = netns.previewCapabilities();
    expect(caps.static).toBe(true);
    expect(caps.dynamic).toBe(false);
    expect(caps.reason).toBe("not linux");
  });

  test("dynamic fails closed when veth/CAP_NET_ADMIN is unavailable", () => {
    vethAvailable = { available: false, reason: "missing binary: nft" };
    netns._resetPreviewCapabilitiesForTests();
    const caps = netns.previewCapabilities();
    expect(caps.dynamic).toBe(false);
    expect(caps.reason).toBe("missing binary: nft");
  });

  test("caches the result (probe not re-evaluated until reset)", () => {
    expect(netns.previewCapabilities().dynamic).toBe(true);
    netnsAvailable = { available: false, reason: "changed" };
    // No reset -> still cached true.
    expect(netns.previewCapabilities().dynamic).toBe(true);
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
