/**
 * Unit tests for the declarative `callTimeoutMs` field on `BuiltinToolDef`
 * and the resulting fallback chain in `subscribe-bridge.ts`'s
 * `tool_execution_start` handler.
 *
 * Scope (task #3 — hot-fix on top of the prior PR's Tier 2 watchdog):
 *   - Lock in the principled default: `DEFAULT_BUILTIN_CALL_TIMEOUT_MS`
 *     MUST equal `WATCHDOG_IDLE_MS` (= 90_000). Any future drift would
 *     silently re-introduce the regression where slow undeclared
 *     built-ins get killed before the run-level idle window expires.
 *   - Built-ins that DECLARE `callTimeoutMs` (e.g. shell @ 600_000) get
 *     the bulkhead — the watchdog defers past the idle threshold and only
 *     kills once the declared budget is blown.
 *   - The bridge's lookup precedence is: extension manifest >
 *     `BuiltinToolDef.callTimeoutMs` > the default constant. Extensions
 *     and built-ins are mutually exclusive in practice, so this is one
 *     fallback chain, not three independent paths.
 *
 * Companion to:
 *   - executor-watchdog-inflight-tools.test.ts (manager state-machine,
 *     prior PR)
 *   - watchdog-tool-error-emission.integration.test.ts (bridge → watchdog
 *     handshake for extensions, prior PR)
 *   - builtin-tool-watchdog-no-regression.integration.test.ts
 *     (pre-Tier-2 baseline reproduction, this PR)
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

// ── Module mocks (must precede SUT imports) ────────────────────────────

mock.module("../db/queries/active-runs", () => ({
  updateHeartbeat: async () => {},
  updatePartialResponse: async () => {},
  markInterrupted: async () => {},
  cleanupOrphanedRuns: async () => 0,
  interruptAllRuns: async () => 0,
  getActiveRun: async () => null,
}));

mock.module("../db/queries/tool-calls", () => ({
  persistToolCall: async () => {},
  listToolCallOutputsForMessages: async () => [],
  getToolCallConversationById: async () => null,
}));

mock.module("../db/connection", () => ({
  getDb: () => ({
    update: () => ({ set: () => ({ where: async () => {} }) }),
  }),
}));

mock.module("../db/queries/extensions", () => ({
  listExtensions: async () => [],
}));

import {
  DEFAULT_BUILTIN_CALL_TIMEOUT_MS,
  WatchdogManager,
  type InflightToolInfo,
  type WatchdogHost,
} from "../runtime/executor-watchdog";
import { subscribeBridge } from "../runtime/stream-chat/subscribe-bridge";
import type { StreamChatContext } from "../runtime/stream-chat/context";
import type { StreamChatHost } from "../runtime/stream-chat/host";
import { ExtensionRegistry } from "../extensions/registry";
import { EventBus } from "../runtime/events";
import type { AgentEvents, AgentRun } from "../types";
import type { BuiltinToolDef } from "../runtime/tools/types";
import { LONG_BLOCKING_WATCHDOG_BUDGET_MS } from "../runtime/tools/filter";
import { Type } from "@earendil-works/pi-ai";

// ── Fake clock + setInterval capture ───────────────────────────────────
//
// Same harness pattern as the prior PR's watchdog tests
// (executor-watchdog-inflight-tools.test.ts §"Fake clock"): stub
// globalThis.setInterval so the watchdog's tick is captured but never
// auto-fires; drive ticks deterministically via advanceAndTick.

let originalSetInterval: typeof setInterval;
let originalDateNow: () => number;
let fakeNow = 0;
let capturedTicks: Array<() => void> = [];

beforeEach(() => {
  originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((fn: (...args: unknown[]) => void) => {
    capturedTicks.push(() => fn());
    return 0 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;

  originalDateNow = Date.now;
  fakeNow = 1_700_000_000_000;
  Date.now = () => fakeNow;
  capturedTicks = [];
  ExtensionRegistry.resetInstance();
});

afterEach(() => {
  globalThis.setInterval = originalSetInterval;
  Date.now = originalDateNow;
  capturedTicks = [];
});

async function advanceAndTick(deltaMs: number): Promise<void> {
  fakeNow += deltaMs;
  for (const fn of capturedTicks) fn();
  await new Promise<void>((r) => queueMicrotask(r));
}

// ── Constant invariant — the centerpiece of the hot-fix ────────────────

describe("DEFAULT_BUILTIN_CALL_TIMEOUT_MS principled default", () => {
  // The bug this lock guards against: a future PR drops the constant
  // back below WATCHDOG_IDLE_MS. Any value < 90_000 reintroduces the
  // pre-fix regression where undeclared built-ins legitimately running
  // 60–89s get killed before the run-level idle window expires. Pinning
  // the constant to 90_000 (== WATCHDOG_IDLE_MS) makes undeclared
  // built-ins behave EXACTLY as pre-Tier-2: the tool-in-flight deferral
  // expires at the same instant the activity-based idle kill would have
  // fired anyway.
  test("equals WATCHDOG_IDLE_MS (90_000) — locks in pre-Tier-2 zero-regression behavior", () => {
    // 90_000 is the documented WATCHDOG_IDLE_MS in
    // src/runtime/executor-watchdog.ts. The const isn't re-exported (it's
    // an internal threshold), so we hard-code the value here AND assert
    // the equality the constant promises in its docstring. If
    // WATCHDOG_IDLE_MS itself drifts in the future, this test will fail
    // and force a conscious update — exactly what we want.
    expect(DEFAULT_BUILTIN_CALL_TIMEOUT_MS).toBe(90_000);
  });

  test("is exported as a positive number (sanity)", () => {
    // Redundant with the above, but cheap and protects against the
    // constant being typed/cast away in a refactor.
    expect(typeof DEFAULT_BUILTIN_CALL_TIMEOUT_MS).toBe("number");
    expect(DEFAULT_BUILTIN_CALL_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

// ── Watchdog-side: declared callTimeoutMs is honored ───────────────────

describe("WatchdogManager honors a declared callTimeoutMs > WATCHDOG_IDLE_MS", () => {
  // Direct test on the manager (no bridge): when noteToolStart records a
  // budget bigger than the run-level idle threshold, the run survives
  // past WATCHDOG_IDLE_MS and is killed at its declared deadline.
  test("inflight tool with callTimeoutMs=200_000 survives past 90s idle, killed at ~200s", async () => {
    const bus = new EventBus<AgentEvents>();
    const events: Array<{ type: keyof AgentEvents & string; data: unknown }> = [];
    for (const t of ["tool:error", "run:error"] as const) {
      bus.on(t, (data) => events.push({ type: t, data }));
    }

    const RUN_ID = "run-decl";
    const CONV_ID = "conv-decl";
    const TOOL_CALL_ID = "tc-decl-1";
    const run: AgentRun = { id: RUN_ID, agentName: "test", status: "running", startedAt: fakeNow, logs: [] };
    const runs = new Map([[RUN_ID, run]]);
    const controllers = new Map([[RUN_ID, new AbortController()]]);

    const watchdogHost: WatchdogHost = {
      runs,
      controllers,
      activeAgents: new Map(),
      runConversations: new Map(),
      pendingPermissions: new Map(),
      bus,
      persist: true,
    };
    const watchdog = new WatchdogManager(watchdogHost);
    watchdog.startWatchdog(RUN_ID, CONV_ID, () => "");

    const info: InflightToolInfo = {
      toolName: "shell",
      conversationId: CONV_ID,
      extensionId: "",
      startedAt: fakeNow,
      callTimeoutMs: 200_000,
    };
    watchdog.noteToolStart(RUN_ID, TOOL_CALL_ID, info);

    // Drive ticks at the watchdog's natural cadence (15s). The deferral
    // bumps activity on each tick, so the kill clock effectively starts
    // when the tool budget expires.
    for (let i = 0; i < 13; i++) {
      await advanceAndTick(15_000);
      // Up to 195s — still well past WATCHDOG_IDLE_MS (90s). Pre-fix this
      // would have killed at 90s; post-fix the deferral holds.
      expect(run.status, `tick ${i}: run was killed at ${(i + 1) * 15}s`).toBe("running");
    }
    expect(events).toHaveLength(0);

    // From t=195s, drive forward until the idle clock (counted from the
    // last successful defer's bump at t=180s) trips. 90s of further idle
    // → kill at t≈285s. Use a single big advance to land past it.
    await advanceAndTick(95_000); // t=290s, idleMs from 180s = 110s ≥ 90s → KILL
    expect(run.status).toBe("error");

    const toolErr = events.find((e) => e.type === "tool:error")!;
    expect(toolErr).toBeDefined();
    const td = toolErr.data as AgentEvents["tool:error"];
    // Reason must name the offender + the declared 200_000ms budget —
    // not the default 90_000ms — proving the declared value was honored.
    expect(td.error).toMatch(/exceeded.*200000.*call timeout/i);
    expect(td.toolName).toBe("shell");
    expect(td.invocationId).toBe(TOOL_CALL_ID);
    expect(td.duration).toBeGreaterThanOrEqual(200_000);
  });
});

// ── Bridge-side: precedence chain (manifest > builtinDef > default) ────
//
// The wire-up under test lives in subscribe-bridge.ts's
// tool_execution_start handler. We spy on noteToolStart by stubbing it
// on the watchdog and capturing the InflightToolInfo argument.

interface CapturedNote {
  runId: string;
  toolCallId: string;
  info: InflightToolInfo;
}

function makePiAgent() {
  let cb: (e: { type: string; [k: string]: unknown }) => void = () => {};
  return {
    subscribe(fn: (e: { type: string; [k: string]: unknown }) => void) {
      cb = fn;
      return () => {};
    },
    fire(e: { type: string; [k: string]: unknown }) { cb(e); },
    abort() {},
  };
}

interface BridgeHarness {
  bus: EventBus<AgentEvents>;
  ctx: StreamChatContext;
  host: StreamChatHost;
  piAgent: ReturnType<typeof makePiAgent>;
  noteCalls: CapturedNote[];
}

function buildBridgeHarness(builtinToolDefsMap: Map<string, BuiltinToolDef>): BridgeHarness {
  const bus = new EventBus<AgentEvents>();
  const RUN_ID = "run-bridge-1";
  const CONV_ID = "conv-bridge-1";

  const run: AgentRun = { id: RUN_ID, agentName: "test", status: "running", startedAt: fakeNow, logs: [] };
  const runs = new Map([[RUN_ID, run]]);
  const controllers = new Map([[RUN_ID, new AbortController()]]);

  // Capture calls to noteToolStart; pass through noteToolEnd as a no-op.
  const noteCalls: CapturedNote[] = [];
  const watchdogStub = {
    bumpActivity: (_runId: string) => {},
    noteToolStart: (runId: string, toolCallId: string, info: InflightToolInfo) => {
      noteCalls.push({ runId, toolCallId, info });
    },
    noteToolEnd: (_runId: string, _toolCallId: string) => {},
  } as unknown as StreamChatHost["watchdog"];

  const ctx = {
    run,
    controller: controllers.get(RUN_ID)!,
    system: undefined,
    agentTools: [],
    toolAbortControllers: new Map(),
    builtinToolDefsMap,
    unsubModeChange: undefined,
    allTurnsText: "",
    turnText: "",
    turnThinking: "",
    turnHasToolCalls: false,
    pendingToolArgs: new Map(),
    unsub: undefined,
    unsubAgentActivity: [],
    lastSavedMessageId: null,
    dbQueue: Promise.resolve(),
    totalUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as unknown as StreamChatContext;

  const host: StreamChatHost = {
    bus,
    persist: true,
    pendingPermissions: new Map() as unknown as StreamChatHost["pendingPermissions"],
    controllers,
    runConversations: new Map(),
    activeAgents: new Map(),
    runs,
    watchdog: watchdogStub,
    stateMediator: undefined,
    spawnQuota: {} as StreamChatHost["spawnQuota"],
    executor: {} as StreamChatHost["executor"],
    permissionEngine: {} as StreamChatHost["permissionEngine"],
  };

  const piAgent = makePiAgent();
  subscribeBridge(ctx, host, piAgent as unknown as Parameters<typeof subscribeBridge>[2], CONV_ID, {}, null);

  return { bus, ctx, host, piAgent, noteCalls };
}

/** Build a minimal valid `BuiltinToolDef`. Only the fields the bridge
 *  reads (name, cardType, cardLayout, category, callTimeoutMs) need to
 *  be meaningful; the rest are scaffolding so TS compiles. */
function makeBuiltinDef(overrides: Partial<BuiltinToolDef> & { name: string }): BuiltinToolDef {
  return {
    label: overrides.name,
    description: "test built-in",
    category: "execute",
    cardType: "default",
    parameters: Type.Unsafe({ type: "object", properties: {} }),
    execute: async () => ({ content: [{ type: "text" as const, text: "" }], details: undefined }),
    ...overrides,
  };
}

describe("subscribe-bridge fallback chain — manifest > BuiltinToolDef.callTimeoutMs > default", () => {
  test("undeclared built-in (no entry in builtinToolDefsMap) → noteToolStart receives DEFAULT_BUILTIN_CALL_TIMEOUT_MS", () => {
    // Simulates a built-in fired by the LLM whose definition isn't in
    // the per-run builtinToolDefsMap (e.g. a tool name that ducks the
    // map entirely, or a built-in that genuinely declines to declare a
    // budget). The bridge MUST fall back to DEFAULT_BUILTIN_CALL_TIMEOUT_MS.
    const h = buildBridgeHarness(new Map());

    h.piAgent.fire({ type: "turn_start" });
    h.piAgent.fire({
      type: "tool_execution_start",
      toolCallId: "tc-undeclared",
      toolName: "Bash", // bare built-in name (no `__`), unknown to the map
      args: { command: "echo hi" },
    });

    expect(h.noteCalls).toHaveLength(1);
    const captured = h.noteCalls[0]!;
    expect(captured.toolCallId).toBe("tc-undeclared");
    expect(captured.info.toolName).toBe("Bash");
    expect(captured.info.callTimeoutMs).toBe(DEFAULT_BUILTIN_CALL_TIMEOUT_MS);
    // And the constant equals 90_000 — the principled default.
    expect(captured.info.callTimeoutMs).toBe(90_000);
  });

  test("declared built-in (callTimeoutMs in BuiltinToolDef) → noteToolStart receives the declared value", () => {
    // The shell built-in declares 600_000ms. The bridge MUST forward
    // that value through to noteToolStart so the watchdog can defer up
    // to 10 minutes for shell builds.
    const builtinMap = new Map<string, BuiltinToolDef>();
    builtinMap.set("shell", makeBuiltinDef({ name: "shell", callTimeoutMs: 600_000 }));
    const h = buildBridgeHarness(builtinMap);

    h.piAgent.fire({ type: "turn_start" });
    h.piAgent.fire({
      type: "tool_execution_start",
      toolCallId: "tc-shell-1",
      toolName: "shell",
      args: { command: "bun test" },
    });

    expect(h.noteCalls).toHaveLength(1);
    expect(h.noteCalls[0]!.info.callTimeoutMs).toBe(600_000);
  });

  test("two built-ins in the map — one declares, one doesn't — each gets the right value", () => {
    // The crux of the precedence test: prove the bridge reads
    // `toolDef.callTimeoutMs` per-tool, not from some global default
    // applied uniformly. One short-budget tool (default), one long
    // (declared). Each call must land in noteToolStart with the right
    // value — proves the lookup is keyed on the toolName.
    const builtinMap = new Map<string, BuiltinToolDef>();
    builtinMap.set("readFile", makeBuiltinDef({ name: "readFile" /* undeclared */ }));
    builtinMap.set("shell", makeBuiltinDef({ name: "shell", callTimeoutMs: 600_000 }));
    const h = buildBridgeHarness(builtinMap);

    h.piAgent.fire({ type: "turn_start" });
    h.piAgent.fire({
      type: "tool_execution_start",
      toolCallId: "tc-rf",
      toolName: "readFile",
      args: { path: "x.txt" },
    });
    h.piAgent.fire({
      type: "tool_execution_start",
      toolCallId: "tc-sh",
      toolName: "shell",
      args: { command: "bun build" },
    });

    expect(h.noteCalls).toHaveLength(2);
    const byId = new Map(h.noteCalls.map((c) => [c.toolCallId, c]));
    expect(byId.get("tc-rf")!.info.callTimeoutMs).toBe(DEFAULT_BUILTIN_CALL_TIMEOUT_MS);
    expect(byId.get("tc-sh")!.info.callTimeoutMs).toBe(600_000);
  });

  test("BuiltinToolDef.callTimeoutMs=0 (or non-positive) → fallback to default (defensive)", () => {
    // Defensive guard: a buggy tool factory that sets callTimeoutMs to
    // 0 or negative shouldn't kill the run instantly. The bridge's
    // `> 0` predicate (subscribe-bridge.ts §164) folds it to the
    // default. Pin the behavior so a refactor doesn't drop the guard.
    const builtinMap = new Map<string, BuiltinToolDef>();
    builtinMap.set("buggy", makeBuiltinDef({ name: "buggy", callTimeoutMs: 0 }));
    const h = buildBridgeHarness(builtinMap);

    h.piAgent.fire({ type: "turn_start" });
    h.piAgent.fire({
      type: "tool_execution_start",
      toolCallId: "tc-buggy",
      toolName: "buggy",
      args: {},
    });

    expect(h.noteCalls).toHaveLength(1);
    expect(h.noteCalls[0]!.info.callTimeoutMs).toBe(DEFAULT_BUILTIN_CALL_TIMEOUT_MS);
  });
});

// ── F1: long-blocking orchestration tools get a widened, BOUNDED budget ─
//
// A synchronous `collect_agent_result` blocks the orchestrator's turn while
// awaiting a background child. It emits no agent:* liveness (unlike
// invoke_agent), so at the ~90s default watchdog budget the parent run was
// idle-killed mid-wait. The bridge now hands the run watchdog a BOUNDED,
// widened budget for these host-wired bare-named tools. `invoke_agent` is
// suppressed entirely (it streams its own agent:* liveness).

describe("subscribe-bridge — long-blocking orchestration tools (F1)", () => {
  test("collect_agent_result → noteToolStart gets the bounded long-blocking budget, not the 90s default", () => {
    const h = buildBridgeHarness(new Map());
    h.piAgent.fire({ type: "turn_start" });
    h.piAgent.fire({
      type: "tool_execution_start",
      toolCallId: "tc-collect",
      toolName: "collect_agent_result", // bare, host-wired
      args: { assignmentId: "a1", waitSeconds: 300 },
    });

    expect(h.noteCalls).toHaveLength(1);
    expect(h.noteCalls[0]!.info.callTimeoutMs).toBe(LONG_BLOCKING_WATCHDOG_BUDGET_MS);
    // Widened above the 90s idle default (which caused the F1 kill) but still
    // bounded (a finite ceiling, not indefinite).
    expect(LONG_BLOCKING_WATCHDOG_BUDGET_MS).toBeGreaterThan(DEFAULT_BUILTIN_CALL_TIMEOUT_MS);
    expect(Number.isFinite(LONG_BLOCKING_WATCHDOG_BUDGET_MS)).toBe(true);
  });

  test("invoke_agent → NO noteToolStart (tool:start suppressed; parent stays alive via agent:* liveness)", () => {
    const h = buildBridgeHarness(new Map());
    h.piAgent.fire({ type: "turn_start" });
    h.piAgent.fire({
      type: "tool_execution_start",
      toolCallId: "tc-invoke",
      toolName: "invoke_agent",
      args: { agentConfigId: "a1", task: "t" },
    });
    expect(h.noteCalls).toHaveLength(0);
  });

  test("the widened collect budget makes the run survive past the 90s idle kill (watchdog-level)", async () => {
    // Compose with the WatchdogManager: a collect-budgeted inflight tool must
    // NOT be killed at 90s (the F1 bug), unlike a default-budgeted tool.
    const bus = new EventBus<AgentEvents>();
    const RUN_ID = "run-collect-defer";
    const run: AgentRun = { id: RUN_ID, agentName: "test", status: "running", startedAt: fakeNow, logs: [] };
    const watchdog = new WatchdogManager({
      runs: new Map([[RUN_ID, run]]),
      controllers: new Map([[RUN_ID, new AbortController()]]),
      activeAgents: new Map(),
      runConversations: new Map(),
      pendingPermissions: new Map(),
      bus,
      persist: true,
    });
    watchdog.startWatchdog(RUN_ID, "conv-collect", () => "");
    watchdog.noteToolStart(RUN_ID, "tc-1", {
      toolName: "collect_agent_result",
      conversationId: "conv-collect",
      extensionId: "",
      startedAt: fakeNow,
      callTimeoutMs: LONG_BLOCKING_WATCHDOG_BUDGET_MS,
    });
    // Drive well past the 90s idle window; the deferral holds (F1 fixed).
    for (let i = 0; i < 10; i++) {
      await advanceAndTick(15_000); // up to 150s
      expect(run.status, `tick ${i}`).toBe("running");
    }
  });
});
