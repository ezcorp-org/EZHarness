/**
 * Phase 48 Wave 3 — client-tool dispatcher behaviour.
 *
 * Pure-logic tests for `web/src/lib/ez/client-tool-dispatcher.ts`.
 * The dispatcher accepts a `findHandler` injection so we can wire the
 * test directly without mutating the global registry; same for `goto`.
 */
import { test, expect, describe } from "bun:test";
import {
  dispatch,
  isAllowedNavigateTarget,
  type EzClientToolEvent,
  type DispatcherDeps,
} from "../lib/ez/client-tool-dispatcher";

function makeDeps(over: Partial<DispatcherDeps> = {}): DispatcherDeps {
  return {
    goto: async () => {},
    findHandler: () => undefined,
    ...over,
  };
}

describe("isAllowedNavigateTarget — same-origin allowlist", () => {
  test("accepts canonical app routes", () => {
    expect(isAllowedNavigateTarget("/marketplace")).toBe(true);
    expect(isAllowedNavigateTarget("/marketplace?q=pdf")).toBe(true);
    expect(isAllowedNavigateTarget("/agents/new")).toBe(true);
    expect(isAllowedNavigateTarget("/project/abc/chat/xyz")).toBe(true);
    expect(isAllowedNavigateTarget("/settings")).toBe(true);
    expect(isAllowedNavigateTarget("/docs/api")).toBe(true);
  });

  test("rejects external URLs", () => {
    expect(isAllowedNavigateTarget("https://example.com/")).toBe(false);
    expect(isAllowedNavigateTarget("//evil.test")).toBe(false);
    expect(isAllowedNavigateTarget("javascript:alert(1)")).toBe(false);
    expect(isAllowedNavigateTarget("file:///etc/passwd")).toBe(false);
  });

  test("rejects unrecognised in-app prefixes", () => {
    expect(isAllowedNavigateTarget("/random-stuff")).toBe(false);
    expect(isAllowedNavigateTarget("/login")).toBe(false);
    expect(isAllowedNavigateTarget("")).toBe(false);
  });

  test("rejects strings with control characters", () => {
    expect(isAllowedNavigateTarget("/agents\nFoo")).toBe(false);
  });
});

describe("dispatch — fill_form routing", () => {
  test("calls the registered handler with the values payload", async () => {
    let received: Record<string, unknown> | null = null;
    const deps = makeDeps({
      findHandler: (formId: string) => {
        if (formId !== "agent-new") return undefined;
        return {
          schema: { name: "string" },
          fill: (v) => { received = v; },
        };
      },
    });
    const evt: EzClientToolEvent = {
      conversationId: "c", toolCallId: "t1", toolName: "fill_form",
      input: { formId: "agent-new", values: { name: "Foo" } },
    };
    const r = await dispatch(evt, deps);
    expect(r.ok).toBe(true);
    expect(received).toEqual({ name: "Foo" });
  });

  test("returns 'no-handler' error when no handler is registered for the formId", async () => {
    const deps = makeDeps({ findHandler: () => undefined });
    const evt: EzClientToolEvent = {
      conversationId: "c", toolCallId: "t2", toolName: "fill_form",
      input: { formId: "missing", values: { x: 1 } },
    };
    const r = await dispatch(evt, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("no-handler");
      expect(r.error).toContain("missing");
    }
  });

  test("returns 'invalid-input' when formId is missing or empty", async () => {
    const deps = makeDeps();
    const r1 = await dispatch({ conversationId: "c", toolCallId: "t", toolName: "fill_form", input: { values: {} } }, deps);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.code).toBe("invalid-input");

    const r2 = await dispatch({ conversationId: "c", toolCallId: "t", toolName: "fill_form", input: { formId: "x" } }, deps);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe("invalid-input");
  });

  test("captures handler exceptions and reports them as 'rejected'", async () => {
    const deps = makeDeps({
      findHandler: () => ({
        schema: {},
        fill: () => { throw new Error("boom"); },
      }),
    });
    const r = await dispatch(
      { conversationId: "c", toolCallId: "t", toolName: "fill_form", input: { formId: "x", values: {} } },
      deps,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("rejected");
      expect(r.error).toContain("boom");
    }
  });
});

describe("dispatch — navigate_to routing", () => {
  test("allows same-origin in-app paths and calls goto", async () => {
    const calls: string[] = [];
    const deps = makeDeps({ goto: async (p: string) => { calls.push(p); } });
    const r = await dispatch(
      { conversationId: "c", toolCallId: "t", toolName: "navigate_to", input: { path: "/marketplace?q=pdf" } },
      deps,
    );
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["/marketplace?q=pdf"]);
  });

  test("rejects external URLs without calling goto", async () => {
    let called = false;
    const deps = makeDeps({ goto: async () => { called = true; } });
    const r = await dispatch(
      { conversationId: "c", toolCallId: "t", toolName: "navigate_to", input: { path: "https://evil.test/" } },
      deps,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("rejected");
    expect(called).toBe(false);
  });

  test("rejects unknown in-app prefixes (e.g. /login)", async () => {
    let called = false;
    const deps = makeDeps({ goto: async () => { called = true; } });
    const r = await dispatch(
      { conversationId: "c", toolCallId: "t", toolName: "navigate_to", input: { path: "/login" } },
      deps,
    );
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
  });

  test("captures goto exceptions and reports them as 'rejected'", async () => {
    const deps = makeDeps({ goto: async () => { throw new Error("fail"); } });
    const r = await dispatch(
      { conversationId: "c", toolCallId: "t", toolName: "navigate_to", input: { path: "/marketplace" } },
      deps,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("rejected");
      expect(r.error).toContain("fail");
    }
  });
});

describe("dispatch — unknown tool", () => {
  test("returns 'unknown-tool' for tool names not in the client allowlist", async () => {
    const deps = makeDeps();
    const r = await dispatch(
      { conversationId: "c", toolCallId: "t", toolName: "summarize_conversation", input: {} },
      deps,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unknown-tool");
  });
});
