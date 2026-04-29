/**
 * Phase 48 Wave 3 — registry semantics.
 *
 * Pure-logic tests for `web/src/lib/ez/registry.ts`. The registry has
 * no Svelte runes or DOM — it's a token-keyed map with subscribe
 * fan-out — so this suite runs cleanly under `bun test` (no jsdom).
 *
 * What we assert:
 *   - register/deregister round-trip via the returned token
 *   - readSnapshot returns a fresh array (mutation-safe)
 *   - subscribe fires after every register/deregister
 *   - findFormHandler resolves the right entry across multiple mounts
 *   - re-mounting the same routeId twice does NOT collapse entries
 *     (each mount gets its own token)
 *   - deregister with a stale/unknown token is a silent no-op
 */
import { test, expect, describe, beforeEach } from "bun:test";
import {
  registerContext,
  deregisterContext,
  readSnapshot,
  subscribe,
  findFormHandler,
  __resetForTests,
} from "../lib/ez/registry";

beforeEach(() => __resetForTests());

describe("registry — basic round-trip", () => {
  test("register adds an entry and readSnapshot returns it", () => {
    const token = registerContext({
      routeId: "/agents/new",
      data: { foo: 1 },
      forms: {},
    });
    expect(typeof token).toBe("symbol");
    expect(readSnapshot()).toHaveLength(1);
    expect(readSnapshot()[0]?.data).toEqual({ foo: 1 });
  });

  test("deregister removes the entry by token", () => {
    const t = registerContext({ routeId: "/x", data: {}, forms: {} });
    expect(readSnapshot()).toHaveLength(1);
    deregisterContext(t);
    expect(readSnapshot()).toHaveLength(0);
  });

  test("deregister with an unknown token is a no-op (does not throw)", () => {
    const stale = Symbol("stale");
    expect(() => deregisterContext(stale)).not.toThrow();
    expect(readSnapshot()).toHaveLength(0);
  });

  test("readSnapshot returns a fresh array every call (mutation safe)", () => {
    registerContext({ routeId: "/a", data: { a: 1 }, forms: {} });
    const a = readSnapshot();
    const b = readSnapshot();
    expect(a).not.toBe(b);
    a.length = 0;
    expect(readSnapshot()).toHaveLength(1); // mutation didn't leak
  });
});

describe("registry — multi-page mount/unmount cleanup", () => {
  test("re-mounting the same routeId twice keeps both entries (until each deregisters)", () => {
    const t1 = registerContext({ routeId: "/agents/new", data: { v: 1 }, forms: {} });
    const t2 = registerContext({ routeId: "/agents/new", data: { v: 2 }, forms: {} });
    expect(readSnapshot()).toHaveLength(2);
    deregisterContext(t1);
    expect(readSnapshot()).toHaveLength(1);
    expect(readSnapshot()[0]?.data).toEqual({ v: 2 });
    deregisterContext(t2);
    expect(readSnapshot()).toHaveLength(0);
  });

  test("rapid mount/unmount across pages does not leak entries", () => {
    // Simulate fast navigation: mount A, mount B, deregister A, deregister B.
    const a = registerContext({ routeId: "/page-a", data: { a: 1 }, forms: {} });
    const b = registerContext({ routeId: "/page-b", data: { b: 2 }, forms: {} });
    expect(readSnapshot()).toHaveLength(2);
    deregisterContext(a);
    deregisterContext(b);
    expect(readSnapshot()).toHaveLength(0);
  });
});

describe("registry — subscribe fan-out", () => {
  test("subscribe fires on register and deregister", () => {
    let calls = 0;
    const unsub = subscribe(() => { calls++; });
    const t = registerContext({ routeId: "/x", data: {}, forms: {} });
    expect(calls).toBe(1);
    deregisterContext(t);
    expect(calls).toBe(2);
    unsub();
    registerContext({ routeId: "/y", data: {}, forms: {} });
    expect(calls).toBe(2); // unsubscribed
  });
});

describe("registry — form handler lookup", () => {
  test("findFormHandler returns the matching entry's handler", () => {
    const fillA = (_: Record<string, unknown>) => {};
    const fillB = (_: Record<string, unknown>) => {};
    registerContext({ routeId: "/a", data: {}, forms: { "form-a": { schema: { x: "string" }, fill: fillA } } });
    registerContext({ routeId: "/b", data: {}, forms: { "form-b": { schema: {}, fill: fillB } } });
    expect(findFormHandler("form-a")?.fill).toBe(fillA);
    expect(findFormHandler("form-b")?.fill).toBe(fillB);
    expect(findFormHandler("missing")).toBeUndefined();
  });

  test("findFormHandler returns undefined when nothing is registered", () => {
    expect(findFormHandler("anything")).toBeUndefined();
  });
});
