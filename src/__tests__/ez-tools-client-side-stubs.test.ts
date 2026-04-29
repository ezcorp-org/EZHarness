/**
 * Phase 48 Wave 2 — fill_form / navigate_to client-side tool stubs.
 *
 * These tools are NOT executed server-side. The runtime hands the LLM's
 * tool call to the panel via an `ez:client-tool` event; the panel's
 * client-tool dispatcher resolves the call locally and POSTs back.
 *
 * After the Wave 2 fix-wiring change the tools no longer return a
 * synchronous `EZ_CLIENT_TOOL_DEFERRED_MARKER` placeholder — they
 * suspend on the `ez-client-tool-registry`'s Promise until the panel's
 * POST handler calls `resolveEzClientTool(toolCallId, dispatchResult)`.
 * The full round-trip contract is pinned in
 * `ez-client-tool-roundtrip.test.ts`. THIS suite stays focused on the
 * stub-shape invariants:
 *
 *  - both tools carry `clientSide: true` and live in the 'ez' category
 *  - calling `execute` emits a single `ez:client-tool` event with the
 *    correct shape (conversationId, toolCallId, toolName, input)
 *  - schema-level rejections (missing formId, external URL, control-char
 *    paths, invalid path types) return an isError result BEFORE
 *    emitting any event — i.e. defense-in-depth even if the panel
 *    forgets to validate again
 *  - if no bus is wired, the execute body returns an error rather than
 *    suspending forever
 *  - the `isValidInAppPath` helper enforces the in-app path policy
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";
import {
  createFillFormTool,
  createNavigateToTool,
  isValidInAppPath,
} from "../runtime/tools/ez";
import {
  resolveEzClientTool,
  _resetPendingEzClientToolsForTests,
} from "../runtime/ez-client-tool-registry";
import { expectDetails, expectText } from "./helpers/expect-tool-result";

interface ClientToolDetails {
  clientSide?: boolean;
  toolName?: string;
  formId?: string;
  path?: string;
  isError?: boolean;
  code?: string;
}

beforeEach(() => {
  _resetPendingEzClientToolsForTests();
});

afterEach(() => {
  _resetPendingEzClientToolsForTests();
});

function bus(): EventBus<AgentEvents> {
  return new EventBus<AgentEvents>();
}

function captureClientTool(b: EventBus<AgentEvents>): AgentEvents["ez:client-tool"][] {
  const events: AgentEvents["ez:client-tool"][] = [];
  b.on("ez:client-tool", (e) => events.push(e));
  return events;
}

/** Yield once to the microtask queue so the execute body's emit + register
 *  steps run before we inspect the bus / registry. Mirrors the helper used
 *  in ez-client-tool-roundtrip.test.ts. */
async function tick(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 0));
}

describe("fill_form (client-side stub)", () => {
  test("flagged clientSide=true and category='ez'", () => {
    const tool = createFillFormTool({ conversationId: "conv-x", bus: bus() });
    expect(tool.clientSide).toBe(true);
    expect(tool.category).toBe("ez");
    expect(tool.name).toBe("fill_form");
  });

  test("execute emits one ez:client-tool event with the input echoed, then resolves through the registry", async () => {
    const b = bus();
    const events = captureClientTool(b);
    const tool = createFillFormTool({ conversationId: "conv-x", bus: b });

    // Spawn the call — DO NOT await synchronously, the tool now suspends
    // until resolveEzClientTool is called.
    const pending = tool.execute("call-1", { formId: "agent-new", values: { name: "Foo" } });

    await tick();
    expect(events.length).toBe(1);
    expect(events[0]).toEqual({
      conversationId: "conv-x",
      toolCallId: "call-1",
      toolName: "fill_form",
      input: { formId: "agent-new", values: { name: "Foo" } },
    });

    // Wake the suspended Promise with a panel-shaped success result.
    expect(
      resolveEzClientTool("call-1", {
        ok: true,
        toolName: "fill_form",
        toolCallId: "call-1",
        detail: { formId: "agent-new" },
      }),
    ).toBe(true);

    const result = await pending;
    const details = expectDetails<ClientToolDetails>(result);
    expect(details.clientSide).toBe(true);
    expect(details.toolName).toBe("fill_form");
    expect(details.formId).toBe("agent-new");
    expect(details.isError).toBeUndefined();
    // The panel's success message is normalized to "<tool> completed."
    expectText(result, "fill_form");
  });

  test("missing formId rejects without emitting", async () => {
    const b = bus();
    const events = captureClientTool(b);
    const tool = createFillFormTool({ conversationId: "conv-x", bus: b });

    const result = await tool.execute("call-2", { values: { name: "Foo" } });
    expect(expectDetails<ClientToolDetails>(result).isError).toBe(true);
    expect(events.length).toBe(0);
  });

  test("no bus wired → error result, no suspend", async () => {
    const tool = createFillFormTool({ conversationId: "conv-x" });
    const result = await tool.execute("call-3", { formId: "x", values: {} });
    expect(expectDetails<ClientToolDetails>(result).isError).toBe(true);
    expectText(result, "bus not wired");
  });
});

describe("navigate_to (client-side stub)", () => {
  test("flagged clientSide=true and category='ez'", () => {
    const tool = createNavigateToTool({ conversationId: "conv-x", bus: bus() });
    expect(tool.clientSide).toBe(true);
    expect(tool.category).toBe("ez");
    expect(tool.name).toBe("navigate_to");
  });

  test("execute emits one ez:client-tool event with the path, then resolves through the registry", async () => {
    const b = bus();
    const events = captureClientTool(b);
    const tool = createNavigateToTool({ conversationId: "conv-x", bus: b });

    const pending = tool.execute("nav-1", { path: "/marketplace?q=pdf" });

    await tick();
    expect(events.length).toBe(1);
    expect(events[0]).toEqual({
      conversationId: "conv-x",
      toolCallId: "nav-1",
      toolName: "navigate_to",
      input: { path: "/marketplace?q=pdf" },
    });

    expect(
      resolveEzClientTool("nav-1", {
        ok: true,
        toolName: "navigate_to",
        toolCallId: "nav-1",
        detail: { path: "/marketplace?q=pdf" },
      }),
    ).toBe(true);

    const result = await pending;
    const details = expectDetails<ClientToolDetails>(result);
    expect(details.clientSide).toBe(true);
    expect(details.toolName).toBe("navigate_to");
    expect(details.path).toBe("/marketplace?q=pdf");
    expect(details.isError).toBeUndefined();
    expectText(result, "navigate_to");
  });

  test("rejects external URLs BEFORE emitting an event", async () => {
    const b = bus();
    const events = captureClientTool(b);
    const tool = createNavigateToTool({ conversationId: "conv-x", bus: b });

    for (const bad of ["https://evil.com", "//cdn.evil.com/pwn", "javascript:alert(1)", "ftp://x"]) {
      const result = await tool.execute("nav-bad", { path: bad });
      expect(expectDetails<ClientToolDetails>(result).isError).toBe(true);
    }
    expect(events.length).toBe(0);
  });

  test("rejects empty / non-string / control-char paths", async () => {
    const b = bus();
    const events = captureClientTool(b);
    const tool = createNavigateToTool({ conversationId: "conv-x", bus: b });

    for (const bad of ["", "  ", "marketplace", "/with\nnewline"]) {
      const result = await tool.execute("nav-bad", { path: bad });
      expect(expectDetails<ClientToolDetails>(result).isError).toBe(true);
    }
    expect(events.length).toBe(0);
  });

  test("isValidInAppPath helper", () => {
    expect(isValidInAppPath("/foo")).toBe(true);
    expect(isValidInAppPath("/foo/bar?baz=1")).toBe(true);
    expect(isValidInAppPath("//evil")).toBe(false);
    expect(isValidInAppPath("https://evil.com")).toBe(false);
    expect(isValidInAppPath("")).toBe(false);
    expect(isValidInAppPath("relative")).toBe(false);
    expect(isValidInAppPath(null as unknown as string)).toBe(false);
    expect(isValidInAppPath(123 as unknown as string)).toBe(false);
  });
});
