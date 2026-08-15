/**
 * The generic remote-tool engine (`runtime/tools/remote-tool.ts`) — the
 * suspend/emit/normalize machinery the Ez client tools and the caller-executed
 * tools both ride.
 *
 * What is worth pinning here, as opposed to in either family's own suite:
 *
 *   - `content[]` IS THE ONLY CHANNEL THE LLM READS. `details{}` is card
 *     metadata the model never sees, so a client's `detail` object has to be
 *     rendered into the text or the tool returns nothing usable — that is the
 *     whole reason the fenced-JSON block exists.
 *   - The output cap applies to the TEXT, per family. Caller results come
 *     from a machine outside this deployment; Ez results are shaped by this
 *     app's own UI, so only the first is capped, and the cap is a parameter
 *     rather than a constant so that stays a decision instead of an accident.
 *   - Register-BEFORE-emit: a same-tick POST from the client must find a
 *     pending entry, which it only can if registration precedes the emit.
 *   - The watchdog budget is DERIVED from a gate timeout, never restated.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { EventBus } from "../runtime/events";
import {
  getPendingRemoteTool,
  resolveRemoteTool,
  _resetPendingRemoteToolsForTests,
} from "../runtime/remote-tool-registry";
import {
  remoteResultToToolResult,
  remoteToolWatchdogBudgetMs,
  runRemoteTool,
  REMOTE_TOOL_WATCHDOG_MARGIN_MS,
} from "../runtime/tools/remote-tool";
import { WATCHDOG_TICK_MS } from "../runtime/executor-watchdog";
import type { AgentEvents } from "../types";
import { expectDetails, expectText } from "./helpers/expect-tool-result";

afterEach(() => {
  _resetPendingRemoteToolsForTests();
});

const CALLER_MARKER = { callerSide: true };

// ── Result normalization ───────────────────────────────────────────────

describe("remoteResultToToolResult", () => {
  test("an ok result renders its detail as fenced JSON on the text channel", () => {
    const r = remoteResultToToolResult(
      { ok: true, detail: { route: "/inbox", unread: 3 } },
      "read_screen",
      { marker: CALLER_MARKER },
    );
    const text = r.content[0]!.text;
    expect(text).toContain("read_screen completed.");
    expect(text).toContain("```json");
    expect(text).toContain('"route": "/inbox"');
    // …and the same detail is flattened into details{} for the card.
    expect(r.details).toMatchObject({ callerSide: true, toolName: "read_screen", unread: 3 });
  });

  test("an ok result with no detail says so without an empty code fence", () => {
    const r = remoteResultToToolResult({ ok: true }, "ping", { marker: CALLER_MARKER });
    expect(r.content[0]!.text).toBe("ping completed.");
    expect(r.content[0]!.text).not.toContain("```");
  });

  test("a failed result surfaces the client's error text and flags isError", () => {
    const r = remoteResultToToolResult(
      { ok: false, error: "no such window", code: "ENOWIN", detail: { window: "x" } },
      "focus_window",
      { marker: CALLER_MARKER },
    );
    expect(r.content[0]!.text).toBe("no such window");
    expect(r.details).toMatchObject({
      isError: true,
      callerSide: true,
      code: "ENOWIN",
      window: "x",
    });
  });

  test("a failed result with no error text falls back to a named failure", () => {
    const r = remoteResultToToolResult({ ok: false }, "focus_window", {
      marker: CALLER_MARKER,
    });
    expect(r.content[0]!.text).toBe("focus_window failed");
  });

  test("an unrecognized shape still reaches the model as text", () => {
    expect(
      remoteResultToToolResult("just a string", "odd", { marker: CALLER_MARKER })
        .content[0]!.text,
    ).toBe("just a string");
    expect(
      remoteResultToToolResult({ some: "object" }, "odd", { marker: CALLER_MARKER })
        .content[0]!.text,
    ).toBe('{"some":"object"}');
    // `ok` present but not a boolean is NOT the structured shape.
    expect(
      remoteResultToToolResult({ ok: "yes" }, "odd", { marker: CALLER_MARKER })
        .content[0]!.text,
    ).toBe('{"ok":"yes"}');
  });

  test("an unserializable value degrades to String() instead of throwing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const r = remoteResultToToolResult(cyclic, "odd", { marker: CALLER_MARKER });
    expect(r.content[0]!.text).toBe("[object Object]");
    expect(r.details).toEqual({ callerSide: true, toolName: "odd" });
  });
});

describe("the output cap", () => {
  const long = "x".repeat(200);

  test("uncapped when maxTextBytes is omitted — the Ez family's posture", () => {
    const r = remoteResultToToolResult(long, "read_page", { marker: { clientSide: true } });
    expect(r.content[0]!.text).toBe(long);
  });

  test("caps the ok branch's rendered detail", () => {
    const r = remoteResultToToolResult(
      { ok: true, detail: { blob: long } },
      "dump",
      { marker: CALLER_MARKER, maxTextBytes: 64 },
    );
    const text = r.content[0]!.text;
    expect(text.startsWith("dump completed.")).toBe(true);
    expect(text).toContain("[output truncated");
    // details{} is card metadata, not context — the cap is about what the
    // model reads, so the full detail still rides there.
    expect(expectDetails<{ blob: string }>({ content: r.content, details: r.details }).blob)
      .toHaveLength(200);
  });

  test("caps the error branch and the unknown-shape branch too", () => {
    expect(
      remoteResultToToolResult({ ok: false, error: long }, "dump", {
        marker: CALLER_MARKER,
        maxTextBytes: 32,
      }).content[0]!.text,
    ).toContain("[output truncated");
    expect(
      remoteResultToToolResult(long, "dump", { marker: CALLER_MARKER, maxTextBytes: 32 })
        .content[0]!.text,
    ).toContain("[output truncated");
  });

  test("text at or under the cap is passed through untouched", () => {
    const r = remoteResultToToolResult("short", "dump", {
      marker: CALLER_MARKER,
      maxTextBytes: 64,
    });
    expect(r.content[0]!.text).toBe("short");
  });
});

// ── The suspend/emit machinery ─────────────────────────────────────────

function runCaller(args: {
  bus?: EventBus<AgentEvents>;
  toolCallId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}) {
  const toolCallId = args.toolCallId ?? "call-1";
  return runRemoteTool({
    eventName: "caller:tool-call",
    event: {
      conversationId: "conv-1",
      runId: "run-1",
      toolCallId,
      toolName: "open_app",
      input: { app: "Mail" },
      userId: "user-1",
    },
    bus: args.bus,
    origin: "caller",
    toolCallId,
    toolName: "open_app",
    input: { app: "Mail" },
    conversationId: "conv-1",
    userId: "user-1",
    runId: "run-1",
    timeoutMs: args.timeoutMs ?? 60_000,
    messages: {
      timeout: "client never answered",
      aborted: "run cancelled",
      noBus: "caller-tool bus not wired",
    },
    ...(args.signal ? { signal: args.signal } : {}),
    result: { marker: CALLER_MARKER, maxTextBytes: 65_536 },
    errorDetails: { app: "Mail" },
  });
}

describe("runRemoteTool", () => {
  test("registers BEFORE emitting, so a same-tick answer lands", async () => {
    const bus = new EventBus<AgentEvents>();
    let seenWhileEmitting: unknown;
    bus.on("caller:tool-call", (data) => {
      // The client answers synchronously inside the emit — only possible if
      // the pending entry already exists.
      seenWhileEmitting = getPendingRemoteTool(data.toolCallId);
      resolveRemoteTool(data.toolCallId, { ok: true, detail: { launched: data.input } });
    });

    const result = await runCaller({ bus });
    expect(seenWhileEmitting).toMatchObject({ origin: "caller", toolName: "open_app", runId: "run-1" });
    expectText(result, '"app": "Mail"');
    // The entry is cleared in `finally` however it settled.
    expect(getPendingRemoteTool("call-1")).toBeUndefined();
  });

  test("emits the family's own payload, including the owner id", async () => {
    const bus = new EventBus<AgentEvents>();
    const events: AgentEvents["caller:tool-call"][] = [];
    bus.on("caller:tool-call", (data) => {
      events.push(data);
      resolveRemoteTool(data.toolCallId, { ok: true });
    });
    await runCaller({ bus });
    expect(events).toEqual([
      {
        conversationId: "conv-1",
        runId: "run-1",
        toolCallId: "call-1",
        toolName: "open_app",
        input: { app: "Mail" },
        userId: "user-1",
      },
    ]);
  });

  test("no bus → a concrete error instead of parking for the whole timeout", async () => {
    const result = await runCaller({ bus: undefined });
    expectText(result, "caller-tool bus not wired");
    expect(expectDetails<{ isError?: boolean; callerSide?: boolean }>(result).isError).toBe(true);
    expect(expectDetails<{ callerSide?: boolean }>(result).callerSide).toBe(true);
    expect(getPendingRemoteTool("call-1")).toBeUndefined();
  });

  test("abort mid-wait resolves to a tool error carrying the identifying args", async () => {
    const bus = new EventBus<AgentEvents>();
    const controller = new AbortController();
    bus.on("caller:tool-call", () => controller.abort());

    const result = await runCaller({ bus, signal: controller.signal });
    expectText(result, "run cancelled");
    expect(expectDetails<{ deferred?: boolean; app?: string }>(result)).toMatchObject({
      isError: true,
      deferred: true,
      app: "Mail",
    });
    expect(getPendingRemoteTool("call-1")).toBeUndefined();
  });

  test("timeout resolves to a tool error the model can act on", async () => {
    const bus = new EventBus<AgentEvents>();
    // Nobody listens: the registry's own timer is the only thing that settles
    // this. 1 ms because the assertion is on the OUTCOME, not the duration.
    const result = await runCaller({ bus, timeoutMs: 1 });
    expectText(result, "client never answered");
    expect(expectDetails<{ deferred?: boolean }>(result).deferred).toBe(true);
  });
});

describe("the watchdog budget", () => {
  test("is the gate timeout plus the shared margin, derived not restated", () => {
    expect(remoteToolWatchdogBudgetMs(120_000)).toBe(
      120_000 + REMOTE_TOOL_WATCHDOG_MARGIN_MS,
    );
    expect(remoteToolWatchdogBudgetMs(5_000)).toBe(5_000 + REMOTE_TOOL_WATCHDOG_MARGIN_MS);
  });

  test("the margin covers at least two watchdog ticks", () => {
    // Machine-checks the claim the margin's docblock makes: the deferral is
    // re-evaluated once per tick, so a margin under two ticks can let the
    // watchdog kill the run before the registry's own rejection propagates.
    expect(REMOTE_TOOL_WATCHDOG_MARGIN_MS).toBeGreaterThanOrEqual(2 * WATCHDOG_TICK_MS);
  });
});
