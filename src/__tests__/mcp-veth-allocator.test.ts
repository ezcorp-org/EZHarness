/**
 * Phase 58 / MCP-05 — Unit tests for the /30 IP slot allocator in mcp-netns.ts.
 *
 * The bridge `br-ezcorp-mcp` lives on `10.42.0.0/24` with gateway `10.42.0.1`.
 * Each MCP gets a /30 subnet within that /24:
 *
 *   Slot N → bridge-end IP  = `10.42.0.${N * 4 + 1}/30`
 *           MCP-end IP      = `10.42.0.${N * 4 + 2}/30`
 *
 * Slot 0 is reserved for the bridge gateway (10.42.0.1/24) and never
 * allocated. Slots 1..63 are mathematically usable; the concurrent cap
 * is 60 (4 reserved as headroom — alloc returns `null` on the 61st live
 * slot). Lowest-free wins on alloc; release is idempotent and silently
 * no-ops on un-allocated / out-of-range inputs.
 */

import { test, expect, describe, beforeEach } from "bun:test";
import {
  allocVethSlot,
  releaseVethSlot,
  computeVethBridgeIp,
  computeVethMcpIp,
  _resetVethSlotAllocatorForTests,
} from "../extensions/mcp-netns";

describe("veth slot allocator", () => {
  beforeEach(() => {
    _resetVethSlotAllocatorForTests();
  });

  test("first alloc returns 1; computeVethMcpIp(1) yields 10.42.0.6/30", () => {
    const slot = allocVethSlot();
    expect(slot).toBe(1);
    expect(computeVethBridgeIp(1)).toBe("10.42.0.5/30");
    expect(computeVethMcpIp(1)).toBe("10.42.0.6/30");
  });

  test("consecutive allocs return 1, 2, 3 in order", () => {
    expect(allocVethSlot()).toBe(1);
    expect(allocVethSlot()).toBe(2);
    expect(allocVethSlot()).toBe(3);
  });

  test("release(2) then alloc returns 2 (lowest-free wins)", () => {
    expect(allocVethSlot()).toBe(1);
    expect(allocVethSlot()).toBe(2);
    expect(allocVethSlot()).toBe(3);
    releaseVethSlot(2);
    expect(allocVethSlot()).toBe(2);
  });

  test("60 allocs succeed; 61st returns null (cap = 60 concurrent)", () => {
    const slots: Array<number | null> = [];
    for (let i = 0; i < 60; i++) {
      slots.push(allocVethSlot());
    }
    // All 60 must be non-null and distinct.
    expect(slots.every((s) => s !== null)).toBe(true);
    expect(new Set(slots).size).toBe(60);
    // 61st returns null.
    expect(allocVethSlot()).toBeNull();
  });

  test("interleaved release: alloc 1,2,3 → release(2) → alloc returns 2 → alloc returns 4", () => {
    expect(allocVethSlot()).toBe(1);
    expect(allocVethSlot()).toBe(2);
    expect(allocVethSlot()).toBe(3);
    releaseVethSlot(2);
    expect(allocVethSlot()).toBe(2);
    expect(allocVethSlot()).toBe(4);
  });

  test("release(0) is a no-op (slot 0 is bridge gateway; never allocated)", () => {
    expect(allocVethSlot()).toBe(1);
    // release(0) should not affect the in-use set.
    releaseVethSlot(0);
    // Next alloc still picks the next free slot (2), not 0.
    expect(allocVethSlot()).toBe(2);
  });

  test("release(slot) on un-allocated slot is silently a no-op (idempotent cleanup)", () => {
    expect(allocVethSlot()).toBe(1);
    // Release a slot we never allocated — must not throw.
    releaseVethSlot(50);
    // Releasing the same slot twice — must not throw.
    releaseVethSlot(1);
    releaseVethSlot(1);
    // After both releases, the next alloc picks slot 1 again.
    expect(allocVethSlot()).toBe(1);
  });

  test("computeVethBridgeIp + computeVethMcpIp produce the documented /30 shape", () => {
    // Slot 1: bridge=10.42.0.5, MCP=10.42.0.6
    expect(computeVethBridgeIp(1)).toBe("10.42.0.5/30");
    expect(computeVethMcpIp(1)).toBe("10.42.0.6/30");
    // Slot 2: bridge=10.42.0.9, MCP=10.42.0.10
    expect(computeVethBridgeIp(2)).toBe("10.42.0.9/30");
    expect(computeVethMcpIp(2)).toBe("10.42.0.10/30");
    // Slot 63 (mathematical max): bridge=10.42.0.253, MCP=10.42.0.254
    expect(computeVethBridgeIp(63)).toBe("10.42.0.253/30");
    expect(computeVethMcpIp(63)).toBe("10.42.0.254/30");
  });
});
