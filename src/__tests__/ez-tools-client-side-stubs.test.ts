/**
 * Phase 48 Wave 2 — fill_form / navigate_to client-side tool stubs.
 *
 * These tools are NOT executed server-side. The runtime hands the LLM's
 * tool call to the panel via an `ez:client-tool` event; the panel's
 * client-tool dispatcher (Wave 3) resolves the call locally.
 *
 * What this suite asserts about Wave 2's stubs:
 *  - both tools carry `clientSide: true`
 *  - both tools live in the 'ez' category
 *  - calling `execute` emits a single `ez:client-tool` event with the
 *    correct shape (conversationId, toolCallId, toolName, input)
 *  - the execute body returns a deferred-marker placeholder (not a
 *    real result — the panel POSTs the resolution back later)
 *  - navigate_to rejects external URLs and returns an error result
 *    BEFORE emitting the event (defense-in-depth even if the panel
 *    forgets to validate again)
 *  - if no bus is wired, the execute body returns an error rather than
 *    silently dropping the call
 */
import { test, expect, describe } from "bun:test";
import { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";
import {
  createFillFormTool,
  createNavigateToTool,
  isValidInAppPath,
  EZ_CLIENT_TOOL_DEFERRED_MARKER,
} from "../runtime/tools/ez";
import { expectDetails, expectText } from "./helpers/expect-tool-result";

interface ClientToolDetails {
  clientSide?: boolean;
  toolName?: string;
  deferred?: boolean;
  formId?: string;
  path?: string;
  isError?: boolean;
}

function bus(): EventBus<AgentEvents> {
  return new EventBus<AgentEvents>();
}

function captureClientTool(b: EventBus<AgentEvents>): AgentEvents["ez:client-tool"][] {
  const events: AgentEvents["ez:client-tool"][] = [];
  b.on("ez:client-tool", (e) => events.push(e));
  return events;
}

describe("fill_form (client-side stub)", () => {
  test("flagged clientSide=true and category='ez'", () => {
    const tool = createFillFormTool({ conversationId: "conv-x", bus: bus() });
    expect(tool.clientSide).toBe(true);
    expect(tool.category).toBe("ez");
    expect(tool.name).toBe("fill_form");
  });

  test("execute emits one ez:client-tool event with the input echoed", async () => {
    const b = bus();
    const events = captureClientTool(b);
    const tool = createFillFormTool({ conversationId: "conv-x", bus: b });

    const result = await tool.execute("call-1", { formId: "agent-new", values: { name: "Foo" } });

    expect(events.length).toBe(1);
    expect(events[0]).toEqual({
      conversationId: "conv-x",
      toolCallId: "call-1",
      toolName: "fill_form",
      input: { formId: "agent-new", values: { name: "Foo" } },
    });
    expect(expectText(result)).toBe(EZ_CLIENT_TOOL_DEFERRED_MARKER);
    const details = expectDetails<ClientToolDetails>(result);
    expect(details.deferred).toBe(true);
    expect(details.clientSide).toBe(true);
    expect(details.toolName).toBe("fill_form");
  });

  test("missing formId rejects without emitting", async () => {
    const b = bus();
    const events = captureClientTool(b);
    const tool = createFillFormTool({ conversationId: "conv-x", bus: b });

    const result = await tool.execute("call-2", { values: { name: "Foo" } });
    expect(expectDetails<ClientToolDetails>(result).isError).toBe(true);
    expect(events.length).toBe(0);
  });

  test("no bus wired → error result, no event emitted", async () => {
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

  test("execute emits one ez:client-tool event with the path", async () => {
    const b = bus();
    const events = captureClientTool(b);
    const tool = createNavigateToTool({ conversationId: "conv-x", bus: b });

    const result = await tool.execute("nav-1", { path: "/marketplace?q=pdf" });

    expect(events.length).toBe(1);
    expect(events[0]).toEqual({
      conversationId: "conv-x",
      toolCallId: "nav-1",
      toolName: "navigate_to",
      input: { path: "/marketplace?q=pdf" },
    });
    expect(expectText(result)).toBe(EZ_CLIENT_TOOL_DEFERRED_MARKER);
    const details = expectDetails<ClientToolDetails>(result);
    expect(details.deferred).toBe(true);
    expect(details.path).toBe("/marketplace?q=pdf");
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
