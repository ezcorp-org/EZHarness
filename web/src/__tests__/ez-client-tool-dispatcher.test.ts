/**
 * Phase 48 Wave 3 — client-tool dispatcher behaviour.
 *
 * Pure-logic tests for `web/src/lib/ez/client-tool-dispatcher.ts`.
 * The dispatcher accepts a `goto` injection so navigation can be
 * captured/spoofed without bringing SvelteKit into the test runtime.
 *
 * The page-side form registry was retired alongside the `<EzContext>`
 * mechanism, so `fill_form` now always returns "no-handler". The
 * navigate_to path is unchanged.
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

describe("dispatch — fill_form routing (coming-soon stub)", () => {
  test("returns 'coming-soon' for any formId — page-context redesign pending", async () => {
    const deps = makeDeps();
    const evt: EzClientToolEvent = {
      conversationId: "c", toolCallId: "t1", toolName: "fill_form",
      input: { formId: "agent-new", values: { name: "Foo" } },
    };
    const r = await dispatch(evt, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("coming-soon");
      expect(r.error.toLowerCase()).toContain("coming soon");
    }
  });

  test("returns 'coming-soon' regardless of formId presence", async () => {
    const deps = makeDeps();
    const r = await dispatch(
      { conversationId: "c", toolCallId: "t", toolName: "fill_form", input: { values: {} } },
      deps,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("coming-soon");
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
