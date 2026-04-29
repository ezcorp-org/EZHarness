/**
 * Phase 48 Wave 3 — context serializer behaviour.
 *
 * Pure-logic tests for `web/src/lib/ez/context-serializer.ts`. The
 * serializer never touches the registry directly — callers pass in a
 * snapshot — so we feed it plain objects and assert payload shape +
 * the dev-warn behaviour around the ~500-token cap.
 */
import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import {
  buildEzContextPayload,
  buildRouteContext,
  estimateTokens,
  TOKEN_BUDGET,
  TOKEN_BUDGET_CHARS,
  type EzPageLike,
} from "../lib/ez/context-serializer";
import type { ContextEntry } from "../lib/ez/registry";

function fakePage(over: Partial<EzPageLike> = {}): EzPageLike {
  return {
    url: { pathname: "/", search: "" },
    route: { id: null },
    params: {},
    ...over,
  };
}

describe("buildRouteContext — Tier 1 always-on metadata", () => {
  test("flattens url, routeId, params into a plain object", () => {
    const page = fakePage({
      url: { pathname: "/project/p1/chat/c1", search: "?x=1" },
      route: { id: "/(app)/project/[id]/chat/[convId]" },
      params: { id: "p1", convId: "c1" },
    });
    const ctx = buildRouteContext(page);
    expect(ctx.url).toBe("/project/p1/chat/c1?x=1");
    expect(ctx.routeId).toBe("/(app)/project/[id]/chat/[convId]");
    expect(ctx.params).toEqual({ id: "p1", convId: "c1" });
    expect(ctx.projectId).toBe("p1");
    expect(ctx.conversationId).toBe("c1");
    expect(ctx.agentId).toBeUndefined();
  });

  test("derives agentId on /agents/[id] routes", () => {
    const page = fakePage({
      url: { pathname: "/agents/abc" },
      route: { id: "/(app)/agents/[id]" },
      params: { id: "abc" },
    });
    const ctx = buildRouteContext(page);
    expect(ctx.agentId).toBe("abc");
    expect(ctx.projectId).toBeUndefined();
  });

  test("does NOT misinterpret `id` on routes that aren't projects/agents", () => {
    const page = fakePage({
      url: { pathname: "/extensions/foo" },
      route: { id: "/(app)/extensions/[id]" },
      params: { id: "foo" },
    });
    const ctx = buildRouteContext(page);
    expect(ctx.projectId).toBeUndefined();
    expect(ctx.agentId).toBeUndefined();
    expect(ctx.params.id).toBe("foo");
  });

  test("supports URL instances as well as `{pathname, search}` objects", () => {
    const page = fakePage({
      url: new URL("https://example.test/marketplace?q=pdf"),
      route: { id: "/(app)/marketplace" },
      params: {},
    });
    const ctx = buildRouteContext(page);
    expect(ctx.url).toBe("/marketplace?q=pdf");
  });
});

describe("buildEzContextPayload — Tier 2 opt-in data + form ids", () => {
  test("flattens entries' data into a single object and collects all formIds", () => {
    const snapshot: ContextEntry[] = [
      { routeId: "/agents/new", data: { agentNames: ["a", "b"] }, forms: { "agent-new": { schema: { name: "string" }, fill: () => {} } } },
      { routeId: "/agents/new", data: { extra: 1 }, forms: { "agent-new-secondary": { schema: {}, fill: () => {} } } },
    ];
    const payload = buildEzContextPayload(fakePage(), snapshot);
    expect(payload.data).toEqual({ agentNames: ["a", "b"], extra: 1 });
    expect(payload.formIds).toEqual(["agent-new", "agent-new-secondary"]);
  });

  test("empty snapshot → data {} and formIds []", () => {
    const payload = buildEzContextPayload(fakePage(), []);
    expect(payload.data).toEqual({});
    expect(payload.formIds).toEqual([]);
    expect(payload.route.url).toBe("/");
  });

  test("entry with circular data is skipped, others continue", () => {
    const a: Record<string, unknown> = { a: 1 };
    a.self = a; // circular
    const snapshot: ContextEntry[] = [
      { routeId: "/x", data: a, forms: {} },
      { routeId: "/y", data: { y: 2 }, forms: {} },
    ];
    const payload = buildEzContextPayload(fakePage(), snapshot);
    expect(payload.data).toEqual({ y: 2 });
  });
});

describe("estimateTokens — char-based approximation", () => {
  test("ratio is ~1 token per 4 chars", () => {
    expect(estimateTokens("aaaa")).toBe(2); // JSON.stringify wraps in quotes → 6 chars → ceil(6/4)=2
    expect(estimateTokens({})).toBe(1); // "{}" -> 2/4 -> 1
    expect(estimateTokens({ a: "bbbbbbbb" })).toBeGreaterThan(2);
  });
});

describe("buildEzContextPayload — token-budget warning", () => {
  let warnSpy: ReturnType<typeof mock>;
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    warnSpy = mock(() => {});
    console.warn = warnSpy as unknown as typeof console.warn;
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnv;
  });

  test("dev-warns once when an entry would push past the 500-token cap", () => {
    const big = "x".repeat(TOKEN_BUDGET_CHARS + 100); // single payload > budget
    const snapshot: ContextEntry[] = [
      { routeId: "/x", data: { huge: big }, forms: {} },
    ];
    const payload = buildEzContextPayload(fakePage(), snapshot);
    expect(payload.data).toEqual({}); // dropped
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const args = warnSpy.mock.calls[0] ?? [];
    expect(String(args[0] ?? "")).toContain(`${TOKEN_BUDGET}`);
  });

  test("under-budget payloads do NOT warn", () => {
    const snapshot: ContextEntry[] = [
      { routeId: "/x", data: { tiny: "ok" }, forms: {} },
    ];
    buildEzContextPayload(fakePage(), snapshot);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("only one warn even if multiple entries overflow", () => {
    const big = "x".repeat(TOKEN_BUDGET_CHARS);
    const snapshot: ContextEntry[] = [
      { routeId: "/a", data: { huge: big }, forms: {} },
      { routeId: "/b", data: { huge: big }, forms: {} },
      { routeId: "/c", data: { huge: big }, forms: {} },
    ];
    buildEzContextPayload(fakePage(), snapshot);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe("buildEzContextPayload — production silence", () => {
  let warnSpy: ReturnType<typeof mock>;
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    warnSpy = mock(() => {});
    console.warn = warnSpy as unknown as typeof console.warn;
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnv;
  });

  test("over-budget in production does NOT warn", () => {
    const big = "x".repeat(TOKEN_BUDGET_CHARS + 10);
    const snapshot: ContextEntry[] = [
      { routeId: "/x", data: { huge: big }, forms: {} },
    ];
    buildEzContextPayload(fakePage(), snapshot);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
