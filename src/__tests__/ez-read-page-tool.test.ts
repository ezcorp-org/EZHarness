/**
 * read_page Ez tool + the shared client-tool scaffolding it rides on.
 *
 * read_page is the on-demand page-context tool: like fill_form /
 * navigate_to it is `clientSide: true` — the runtime emits an
 * `ez:client-tool` event and suspends until the Ez panel POSTs the
 * serialized page back. This suite pins:
 *
 *   - the tool's stub-shape invariants (clientSide, category, name, the
 *     lenient summary/full `detail` defaulting)
 *   - the shared `runEzClientTool` suspend/emit/resolve/abort machinery
 *   - the shared `panelResultToToolResult` mapper, INCLUDING the new
 *     detail→fenced-JSON rendering that puts page context on the
 *     LLM-visible text channel (content[]) rather than card-only details{}
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";
import { createReadPageTool, isEzClientTool } from "../runtime/tools/ez";
import {
  panelResultToToolResult,
  runEzClientTool,
  EZ_CLIENT_TOOL_DEFERRED_MARKER,
  type ClientToolContext,
} from "../runtime/tools/ez/client-tool";
import {
  resolveEzClientTool,
  rejectEzClientTool,
  _resetPendingEzClientToolsForTests,
} from "../runtime/ez-client-tool-registry";
import { expectDetails, expectText } from "./helpers/expect-tool-result";

interface ReadPageDetails {
  clientSide?: boolean;
  toolName?: string;
  detail?: string;
  path?: string;
  title?: string;
  isError?: boolean;
  code?: string;
  deferred?: boolean;
}

function bus(): EventBus<AgentEvents> {
  return new EventBus<AgentEvents>();
}

function captureClientTool(b: EventBus<AgentEvents>): AgentEvents["ez:client-tool"][] {
  const events: AgentEvents["ez:client-tool"][] = [];
  b.on("ez:client-tool", (e) => events.push(e));
  return events;
}

/** Yield to the microtask/timer queue so the execute body's emit + register
 *  run before we inspect the bus / resolve the registry. */
async function tick(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 0));
}

beforeEach(() => {
  _resetPendingEzClientToolsForTests();
});
afterEach(() => {
  _resetPendingEzClientToolsForTests();
});

describe("read_page (client-side tool)", () => {
  test("flagged clientSide=true, category='ez', name='read_page'", () => {
    const tool = createReadPageTool({ conversationId: "conv-x", bus: bus() });
    expect(tool.clientSide).toBe(true);
    expect(tool.category).toBe("ez");
    expect(tool.name).toBe("read_page");
    // isEzClientTool now recognises read_page alongside fill_form/navigate_to.
    expect(isEzClientTool("read_page")).toBe(true);
    expect(isEzClientTool("summarize_conversation")).toBe(false);
  });

  test("declares an optional summary|full detail param (no required args)", () => {
    const tool = createReadPageTool({ conversationId: "conv-x", bus: bus() });
    const params = tool.parameters as { required?: string[]; properties?: Record<string, { enum?: string[] }> };
    expect(params.required ?? []).toEqual([]);
    expect(params.properties?.detail?.enum).toEqual(["summary", "full"]);
  });

  test("execute emits one ez:client-tool event defaulting detail to 'summary', then resolves with page context", async () => {
    const b = bus();
    const events = captureClientTool(b);
    const tool = createReadPageTool({ conversationId: "conv-x", bus: b });

    const pending = tool.execute("rp-1", {});
    await tick();
    expect(events.length).toBe(1);
    expect(events[0]).toEqual({
      conversationId: "conv-x",
      toolCallId: "rp-1",
      toolName: "read_page",
      input: { detail: "summary" },
    });

    expect(
      resolveEzClientTool("rp-1", {
        ok: true,
        toolName: "read_page",
        toolCallId: "rp-1",
        detail: { path: "/new-project", title: "New Project" },
      }),
    ).toBe(true);

    const result = await pending;
    const details = expectDetails<ReadPageDetails>(result);
    expect(details.clientSide).toBe(true);
    expect(details.toolName).toBe("read_page");
    expect(details.path).toBe("/new-project");
    expect(details.isError).toBeUndefined();
    // The page context must reach the LLM on the TEXT channel (fenced JSON),
    // not only in card-metadata details{}.
    const text = expectText(result, "read_page completed.");
    expect(text).toContain("```json");
    expect(text).toContain("/new-project");
  });

  test("detail:'full' is forwarded verbatim; any other value falls back to 'summary'", async () => {
    for (const [input, expected] of [
      ["full", "full"],
      ["garbage", "summary"],
      [undefined, "summary"],
    ] as const) {
      _resetPendingEzClientToolsForTests();
      const b = bus();
      const events = captureClientTool(b);
      const tool = createReadPageTool({ conversationId: "conv-x", bus: b });
      const pending = tool.execute("rp-detail", input === undefined ? {} : { detail: input });
      await tick();
      expect(events[0]!.input).toEqual({ detail: expected });
      resolveEzClientTool("rp-detail", { ok: true, detail: {} });
      await pending;
    }
  });

  test("no bus wired → error result, no suspend", async () => {
    const tool = createReadPageTool({ conversationId: "conv-x" });
    const result = await tool.execute("rp-nobus", { detail: "full" });
    expect(expectDetails<ReadPageDetails>(result).isError).toBe(true);
    expectText(result, "bus not wired");
  });

  test("abort while suspended → error result carrying the tool's errorDetails", async () => {
    const b = bus();
    const tool = createReadPageTool({ conversationId: "conv-x", bus: b });
    const controller = new AbortController();
    const pending = tool.execute("rp-abort", { detail: "full" }, controller.signal);
    await tick();
    controller.abort();
    const result = await pending;
    const details = expectDetails<ReadPageDetails>(result);
    expect(details.isError).toBe(true);
    expect(details.deferred).toBe(true);
    expect(details.detail).toBe("full"); // errorDetails merged
    expectText(result, "Aborted while waiting for read_page");
  });
});

describe("panelResultToToolResult (shared mapper)", () => {
  test("ok + detail → 'completed' text with a fenced JSON block + detail spread into details", () => {
    const r = panelResultToToolResult({ ok: true, detail: { a: 1, b: "x" } }, "tool_x");
    const text = expectText(r, "tool_x completed.");
    expect(text).toContain("```json");
    expect(text).toContain('"a": 1');
    expect(expectDetails<{ a: number; b: string; clientSide?: boolean }>(r).a).toBe(1);
    expect(expectDetails<{ clientSide?: boolean }>(r).clientSide).toBe(true);
  });

  test("ok + empty/absent detail → bare 'completed' text, no JSON block", () => {
    const empty = panelResultToToolResult({ ok: true, detail: {} }, "tool_x");
    expect(expectText(empty)).toBe("tool_x completed.");
    const absent = panelResultToToolResult({ ok: true }, "tool_x");
    expect(expectText(absent)).toBe("tool_x completed.");
  });

  test("failure DispatchResult → isError with code + detail, error message surfaced verbatim", () => {
    const r = panelResultToToolResult(
      { ok: false, error: "no form found", code: "no-form", detail: { formId: "f1" } },
      "fill_form",
    );
    const d = expectDetails<{ isError?: boolean; code?: string; formId?: string }>(r);
    expect(d.isError).toBe(true);
    expect(d.code).toBe("no-form");
    expect(d.formId).toBe("f1");
    expectText(r, "no form found");
  });

  test("failure without an error message → '<tool> failed'", () => {
    const r = panelResultToToolResult({ ok: false }, "navigate_to");
    expectText(r, "navigate_to failed");
    expect(expectDetails<{ code?: string }>(r).code).toBeUndefined();
  });

  test("bare string result → text passthrough", () => {
    const r = panelResultToToolResult("some raw string", "tool_x");
    expect(expectText(r)).toBe("some raw string");
  });

  test("non-ok object → JSON.stringify passthrough", () => {
    const r = panelResultToToolResult({ weird: true }, "tool_x");
    expect(expectText(r)).toBe(JSON.stringify({ weird: true }));
  });

  test("unserializable object (circular) → String() fallback, never throws", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const r = panelResultToToolResult(circular, "tool_x");
    expect(expectText(r)).toBe(String(circular));
  });
});

describe("runEzClientTool (shared suspend/emit machinery)", () => {
  const ctx = (b?: EventBus<AgentEvents>): ClientToolContext => ({
    conversationId: "conv-run",
    bus: b,
    userId: "u-run",
  });

  test("no bus → immediate error, never suspends", async () => {
    const r = await runEzClientTool({
      ctx: ctx(undefined),
      toolCallId: "run-nobus",
      toolName: "read_page",
      input: { detail: "summary" },
    });
    expect(expectDetails<{ isError?: boolean }>(r).isError).toBe(true);
    expectText(r, "bus not wired");
  });

  test("emit → resolve round-trip returns the mapped panel result", async () => {
    const b = bus();
    const events = captureClientTool(b);
    const pending = runEzClientTool({
      ctx: ctx(b),
      toolCallId: "run-ok",
      toolName: "read_page",
      input: { detail: "summary" },
    });
    await tick();
    expect(events[0]).toEqual({
      conversationId: "conv-run",
      toolCallId: "run-ok",
      toolName: "read_page",
      input: { detail: "summary" },
    });
    resolveEzClientTool("run-ok", { ok: true, detail: { path: "/p" } });
    const r = await pending;
    expect(expectDetails<{ path?: string }>(r).path).toBe("/p");
  });

  test("reject (abort/timeout path) → error result with deferred + errorDetails merged", async () => {
    const b = bus();
    const pending = runEzClientTool({
      ctx: ctx(b),
      toolCallId: "run-reject",
      toolName: "read_page",
      input: { detail: "full" },
      errorDetails: { detail: "full" },
    });
    await tick();
    rejectEzClientTool("run-reject", "panel closed the browser");
    const r = await pending;
    const d = expectDetails<{ isError?: boolean; deferred?: boolean; detail?: string }>(r);
    expect(d.isError).toBe(true);
    expect(d.deferred).toBe(true);
    expect(d.detail).toBe("full");
    expectText(r, "panel closed the browser");
  });

  test("EZ_CLIENT_TOOL_DEFERRED_MARKER is exported (module load coverage)", () => {
    expect(typeof EZ_CLIENT_TOOL_DEFERRED_MARKER).toBe("string");
  });
});
