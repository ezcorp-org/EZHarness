/**
 * Phase 48 — Gap #3 fix verification (server side).
 *
 * The verification report flagged that `fill_form` and `navigate_to`
 * returned `EZ_CLIENT_TOOL_DEFERRED_MARKER` synchronously — there was no
 * mechanism to resume the agent loop with the panel's dispatched
 * result. This test pins the new contract:
 *
 *   - `createFillFormTool({...}).execute(...)` SUSPENDS until the
 *     `ez-client-tool-registry` resolves the matching `toolCallId`.
 *   - `resolveEzClientTool(toolCallId, panelResult)` wakes the suspended
 *     Promise and the tool returns a normalized AgentToolResult.
 *   - The result the LLM sees reflects `{ ok: true, detail: { formId } }`
 *     vs `{ ok: false, error, code }` in the panel's DispatchResult shape.
 *   - Abort and timeout paths reject the Promise so the LLM doesn't
 *     hang forever on a hung panel / closed browser.
 *
 * No DB / no real executor — this is a focused round-trip test on the
 * registry + tool factory boundary. The HTTP endpoint's auth/scope
 * boundary is covered by api-conversations-tool-results.server.test.ts.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";
import { createFillFormTool, createNavigateToTool } from "../runtime/tools/ez";
import {
  resolveEzClientTool,
  rejectEzClientTool,
  getPendingEzClientTool,
  _setEzClientToolTimeoutForTests,
  _resetEzClientToolTimeoutForTests,
  _resetPendingEzClientToolsForTests,
} from "../runtime/ez-client-tool-registry";

beforeEach(() => {
  _resetPendingEzClientToolsForTests();
});

afterEach(() => {
  _resetEzClientToolTimeoutForTests();
  _resetPendingEzClientToolsForTests();
});

function bus(): EventBus<AgentEvents> {
  return new EventBus<AgentEvents>();
}

describe("fill_form / navigate_to round-trip via the ez-client-tool registry", () => {
  test("fill_form Promise suspends until resolveEzClientTool is called", async () => {
    const tool = createFillFormTool({
      conversationId: "conv-1",
      bus: bus(),
      userId: "user-1",
    });

    // Capture the emitted bus event so we can reuse the toolCallId on
    // resolution. In production the panel reads it off the SSE stream.
    let observedToolCallId = "";
    const b = (tool as unknown as { _bus?: EventBus<AgentEvents> })._bus; // not exposed — fall back to fresh capture
    void b; // unused

    // Use a fresh bus we can listen to.
    const sharedBus = bus();
    const events: AgentEvents["ez:client-tool"][] = [];
    sharedBus.on("ez:client-tool", (e) => events.push(e));
    const liveTool = createFillFormTool({
      conversationId: "conv-1",
      bus: sharedBus,
      userId: "user-1",
    });

    const pending = liveTool.execute("call-fill-1", { formId: "agent-new", values: { name: "Foo" } });

    // Yield to the microtask queue so the execute body's emit + register
    // run before we inspect.
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      conversationId: "conv-1",
      toolCallId: "call-fill-1",
      toolName: "fill_form",
      input: { formId: "agent-new", values: { name: "Foo" } },
    });
    observedToolCallId = events[0]!.toolCallId;

    // The registry must hold the pending entry between emit and resolve.
    const pendingEntry = getPendingEzClientTool(observedToolCallId);
    expect(pendingEntry).toBeDefined();
    expect(pendingEntry!.conversationId).toBe("conv-1");
    expect(pendingEntry!.userId).toBe("user-1");

    // Simulate the POST handler waking the gate with the panel's success result.
    const dispatchSuccess = {
      ok: true as const,
      toolName: "fill_form",
      toolCallId: observedToolCallId,
      detail: { formId: "agent-new" },
    };
    const resolved = resolveEzClientTool(observedToolCallId, dispatchSuccess);
    expect(resolved).toBe(true);

    const result = await pending;
    // Normalized AgentToolResult: ok=true → success text, no isError, detail forwarded.
    expect(result.details).toMatchObject({
      clientSide: true,
      toolName: "fill_form",
      formId: "agent-new",
    });
    expect((result.details as Record<string, unknown>).isError).toBeUndefined();
    expect(result.content[0]!.type).toBe("text");
  });

  test("fill_form normalizes a failure DispatchResult into an isError tool result", async () => {
    const sharedBus = bus();
    const tool = createFillFormTool({
      conversationId: "conv-2",
      bus: sharedBus,
      userId: "user-2",
    });
    const pending = tool.execute("call-fill-2", { formId: "agent-new", values: { name: "X" } });

    await new Promise<void>((r) => setTimeout(r, 0));
    const dispatchFailure = {
      ok: false as const,
      toolName: "fill_form",
      toolCallId: "call-fill-2",
      error: "No handler registered for form 'agent-new'",
      code: "no-handler" as const,
    };
    expect(resolveEzClientTool("call-fill-2", dispatchFailure)).toBe(true);

    const result = await pending;
    expect((result.details as Record<string, unknown>).isError).toBe(true);
    expect((result.details as Record<string, unknown>).code).toBe("no-handler");
    expect(result.content[0]!.type).toBe("text");
    // The panel's error message reaches the LLM verbatim so it can decide
    // whether to retry or surface the failure to the user.
    if (result.content[0]!.type === "text") {
      expect(result.content[0]!.text).toContain("No handler registered");
    }
  });

  test("navigate_to suspends and resolves through the same registry", async () => {
    const sharedBus = bus();
    const events: AgentEvents["ez:client-tool"][] = [];
    sharedBus.on("ez:client-tool", (e) => events.push(e));
    const tool = createNavigateToTool({
      conversationId: "conv-nav",
      bus: sharedBus,
      userId: "user-nav",
    });

    const pending = tool.execute("call-nav-1", { path: "/marketplace?q=pdf" });

    await new Promise<void>((r) => setTimeout(r, 0));
    expect(events).toHaveLength(1);
    expect(events[0]!.toolName).toBe("navigate_to");
    expect(events[0]!.input).toEqual({ path: "/marketplace?q=pdf" });

    expect(
      resolveEzClientTool("call-nav-1", {
        ok: true,
        toolName: "navigate_to",
        toolCallId: "call-nav-1",
        detail: { path: "/marketplace?q=pdf" },
      }),
    ).toBe(true);

    const result = await pending;
    expect((result.details as Record<string, unknown>).path).toBe("/marketplace?q=pdf");
    expect((result.details as Record<string, unknown>).isError).toBeUndefined();
  });

  test("rejectEzClientTool returns a tool error result (abort path)", async () => {
    const sharedBus = bus();
    const tool = createFillFormTool({
      conversationId: "conv-3",
      bus: sharedBus,
      userId: "user-3",
    });
    const pending = tool.execute("call-fill-abort", { formId: "agent-new", values: { name: "X" } });

    await new Promise<void>((r) => setTimeout(r, 0));
    expect(rejectEzClientTool("call-fill-abort", "User aborted before answering")).toBe(true);

    const result = await pending;
    expect((result.details as Record<string, unknown>).isError).toBe(true);
    if (result.content[0]!.type === "text") {
      expect(result.content[0]!.text).toContain("User aborted before answering");
    }
  });

  test("registry timeout rejects the Promise so the LLM sees a concrete failure (not a hang)", async () => {
    _setEzClientToolTimeoutForTests(20);
    const sharedBus = bus();
    const tool = createFillFormTool({
      conversationId: "conv-timeout",
      bus: sharedBus,
      userId: "user-timeout",
    });
    const pending = tool.execute("call-fill-timeout", { formId: "agent-new", values: { name: "X" } });

    const result = await pending;
    expect((result.details as Record<string, unknown>).isError).toBe(true);
    if (result.content[0]!.type === "text") {
      expect(result.content[0]!.text).toContain("Timed out");
    }
  });

  test("late resolveEzClientTool (after the gate already cleared) is a silent no-op", () => {
    expect(resolveEzClientTool("never-registered-id", { ok: true })).toBe(false);
  });

  test("getPendingEzClientTool returns the conversationId + userId captured at register-time", async () => {
    const sharedBus = bus();
    const tool = createFillFormTool({
      conversationId: "conv-auth",
      bus: sharedBus,
      userId: "user-auth",
    });
    const pending = tool.execute("call-auth", { formId: "agent-new", values: { name: "X" } });
    await new Promise<void>((r) => setTimeout(r, 0));
    const entry = getPendingEzClientTool("call-auth");
    expect(entry).toEqual({ conversationId: "conv-auth", userId: "user-auth" });

    // Cleanup so the test doesn't hang the suite after the timeout window.
    resolveEzClientTool("call-auth", { ok: true, detail: {} });
    await pending;
  });
});
