/**
 * Integration test for the wired-up flow:
 *
 *   pi-agent `tool_execution_start` event
 *     → subscribe-bridge resolves manifest.callTimeoutMs via ExtensionRegistry
 *     → WatchdogManager.noteToolStart records the inflight entry
 *     → WatchdogManager tick defers past WATCHDOG_IDLE_MS (90s)
 *     → tick eventually kills, emitting `tool:error` per still-inflight call
 *       with the payload shape from src/types.ts:256.
 *
 * Scope (task #5): the bridge → watchdog handshake (AC4) and the
 * watchdog's kill emission shape on REAL routing (AC3) — i.e. the bug
 * the user reported was that the chat showed only "Error: Request was
 * aborted" because no `tool:error` ever fired. This test pins the
 * end-to-end fix for that bug at the unit-of-deployment boundary
 * (subscribe-bridge + WatchdogManager), without booting a full
 * AgentExecutor / pi-agent run.
 *
 * Companion to:
 *   - executor-watchdog-inflight-tools.test.ts (manager state-machine, #4)
 *   - openai-image-gen-2-watchdog-e2e.integration.test.ts (full e2e, #6)
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

// ── Module mocks (must precede SUT imports) ────────────────────────────

// Watchdog DB calls — no-op so persist=true doesn't hit a real DB.
mock.module("../db/queries/active-runs", () => ({
  updateHeartbeat: async () => {},
  updatePartialResponse: async () => {},
  markInterrupted: async () => {},
  cleanupOrphanedRuns: async () => 0,
  interruptAllRuns: async () => 0,
  getActiveRun: async () => null,
}));

// Bridge persists tool_calls rows when host.persist=true. We capture into
// a closure so we can also assert the bridge ran the success/end path.
const persisted: Array<Record<string, unknown>> = [];
mock.module("../db/queries/tool-calls", () => ({
  persistToolCall: async (row: Record<string, unknown>) => { persisted.push(row); },
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

import { subscribeBridge } from "../runtime/stream-chat/subscribe-bridge";
import type { StreamChatContext } from "../runtime/stream-chat/context";
import type { StreamChatHost } from "../runtime/stream-chat/host";
import { ExtensionRegistry } from "../extensions/registry";
import {
  DEFAULT_BUILTIN_CALL_TIMEOUT_MS,
  WatchdogManager,
  type WatchdogHost,
} from "../runtime/executor-watchdog";
import { EventBus } from "../runtime/events";
import type { AgentEvents, AgentRun } from "../types";
import type { ExtensionManifestV2 } from "../extensions/types";

// ── Fake clock + setInterval capture ───────────────────────────────────

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
  fakeNow = 1_000_000;
  Date.now = () => fakeNow;
  capturedTicks = [];
  persisted.length = 0;
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

// ── Harness helpers ────────────────────────────────────────────────────

interface CapturedEvent { type: keyof AgentEvents & string; data: unknown }

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

function registerFakeExtension(
  toolName: string,
  extId: string,
  callTimeoutMs: number | undefined,
  cardType?: string,
  cardLayout?: "inline" | "dock",
): void {
  const registry = ExtensionRegistry.getInstance();
  registry.registerToolForTest(toolName, {
    name: toolName,
    description: "test tool",
    inputSchema: { type: "object" },
    extensionId: extId,
    extensionName: extId,
    originalName: toolName.split("__")[1] ?? toolName,
    ...(cardType ? { cardType } : {}),
    ...(cardLayout ? { cardLayout } : {}),
  });
  const manifest: ExtensionManifestV2 = {
    name: extId,
    version: "1.0.0",
    runtime: { type: "node", entry: "x" },
    permissions: {},
    tools: [],
    ...(callTimeoutMs !== undefined ? { resources: { callTimeoutMs } } : {}),
  } as unknown as ExtensionManifestV2;
  registry.setManifestForTest(extId, manifest);
}

interface IntegrationHarness {
  bus: EventBus<AgentEvents>;
  events: CapturedEvent[];
  watchdog: WatchdogManager;
  ctx: StreamChatContext;
  host: StreamChatHost;
  piAgent: ReturnType<typeof makePiAgent>;
  run: AgentRun;
  conversationId: string;
  controllers: Map<string, AbortController>;
  runs: Map<string, AgentRun>;
}

const RUN_ID = "run-int-1";
const CONV_ID = "conv-int-1";

function buildHarness(): IntegrationHarness {
  const bus = new EventBus<AgentEvents>();
  const events: CapturedEvent[] = [];
  for (const type of ["tool:start", "tool:error", "tool:complete", "run:error"] as const) {
    bus.on(type, (data) => events.push({ type, data }));
  }

  const run: AgentRun = {
    id: RUN_ID,
    agentName: "test",
    status: "running",
    startedAt: fakeNow,
    logs: [],
  };
  const runs = new Map([[RUN_ID, run]]);
  const controllers = new Map([[RUN_ID, new AbortController()]]);
  const pendingPermissions = new Map<string, { conversationId: string; toolCallId: string; toolName: string; input: unknown }>();

  const watchdogHost: WatchdogHost = {
    runs,
    controllers,
    activeAgents: new Map(),
    runConversations: new Map(),
    pendingPermissions: pendingPermissions as unknown as Map<string, { conversationId: string }>,
    bus,
    persist: true,
  };
  const watchdog = new WatchdogManager(watchdogHost);
  watchdog.startWatchdog(RUN_ID, CONV_ID, () => "");

  const ctx = {
    run,
    controller: controllers.get(RUN_ID)!,
    system: undefined,
    agentTools: [],
    toolAbortControllers: new Map(),
    builtinToolDefsMap: new Map(),
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
    pendingPermissions: pendingPermissions as unknown as StreamChatHost["pendingPermissions"],
    controllers,
    runConversations: new Map(),
    activeAgents: new Map(),
    runs,
    watchdog,
    stateMediator: undefined,
    spawnQuota: {} as StreamChatHost["spawnQuota"],
    executor: {} as StreamChatHost["executor"],
  };

  const piAgent = makePiAgent();
  subscribeBridge(ctx, host, piAgent as unknown as Parameters<typeof subscribeBridge>[2], CONV_ID, {}, null);

  return { bus, events, watchdog, ctx, host, piAgent, run, conversationId: CONV_ID, controllers, runs };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("subscribe-bridge → WatchdogManager: extension callTimeoutMs from manifest (AC4)", () => {
  test("manifest callTimeoutMs=180000 defers the kill past WATCHDOG_IDLE_MS (the openai-image-gen-2 scenario)", async () => {
    // This is the canonical bug the Tier 2 fix targets: a tool that
    // legitimately takes 90–180s gets killed by the run-level watchdog
    // because pi-agent emits no events while awaiting the tool result.
    // With the fix, the watchdog reads callTimeoutMs from the manifest
    // and defers — and DOES NOT emit a spurious tool:error.
    registerFakeExtension("openai-image-gen-2__generate", "openai-image-gen-2", 180_000);
    const h = buildHarness();

    h.piAgent.fire({ type: "turn_start" });
    h.piAgent.fire({
      type: "tool_execution_start",
      toolCallId: "tc-1",
      toolName: "openai-image-gen-2__generate",
      args: { prompt: "an otter" },
    });

    // 95s — past the run-level idle threshold (90s) but well within the
    // tool's declared 180s budget. Pre-fix: this killed the run. Post-
    // fix: deferral keeps the run alive; no errors emitted.
    await advanceAndTick(95_000);

    expect(h.run.status).toBe("running");
    expect(h.events.find((e) => e.type === "run:error")).toBeUndefined();
    expect(h.events.find((e) => e.type === "tool:error")).toBeUndefined();
  });

  test("manifest callTimeoutMs=30000 (short budget) kills with a tool-specific tool:error AND run:error after the budget elapses", async () => {
    registerFakeExtension(
      "fast-ext__quick",
      "fast-ext",
      30_000,
      "result-card",
      "dock",
    );
    const h = buildHarness();

    h.piAgent.fire({ type: "turn_start" });
    h.piAgent.fire({
      type: "tool_execution_start",
      toolCallId: "tc-fast-1",
      toolName: "fast-ext__quick",
      args: {},
    });

    // Tool budget elapses at t=30s; deferral lifts. Idle clock starts
    // counting from the last successful defer's bump. ~95s of further
    // idle past that is needed to trip; we batch-advance.
    await advanceAndTick(35_000); // past tool budget — defer lifts
    await advanceAndTick(95_000); // idle clock trips → KILL

    expect(h.run.status).toBe("error");

    const toolErr = h.events.find((e) => e.type === "tool:error")!;
    expect(toolErr).toBeDefined();
    const td = toolErr.data as AgentEvents["tool:error"];

    // Payload shape — every field src/types.ts:256 declares.
    expect(td.conversationId).toBe(CONV_ID);
    expect(td.extensionId).toBe("fast-ext"); // resolved from registry, NOT empty
    expect(td.toolName).toBe("fast-ext__quick");
    expect(td.invocationId).toBe("tc-fast-1");
    expect(td.cardType).toBe("result-card");
    expect(td.cardLayout).toBe("dock");
    expect(typeof td.duration).toBe("number");
    expect(td.duration).toBeGreaterThan(0);
    expect(td.error).toMatch(/exceeded.*30000.*call timeout/i);

    // run:error follows tool:error and carries the same reason.
    const runErr = h.events.find((e) => e.type === "run:error")!;
    expect(runErr).toBeDefined();
    const rd = runErr.data as AgentEvents["run:error"];
    expect(rd.conversationId).toBe(CONV_ID);
    expect(rd.error).toMatch(/exceeded.*30000.*call timeout/i);

    // Ordering: tool:error MUST land before run:error. The chat renders
    // per-tool failure cards inline; run:error is the terminal banner.
    const toolErrIdx = h.events.findIndex((e) => e.type === "tool:error");
    const runErrIdx = h.events.findIndex((e) => e.type === "run:error");
    expect(toolErrIdx).toBeLessThan(runErrIdx);
  });

  test("extension with NO manifest callTimeoutMs falls back to DEFAULT_BUILTIN_CALL_TIMEOUT_MS", async () => {
    // Sanity check on the fallback path: an extension that omits the
    // resources.callTimeoutMs field gets the default. The watchdog
    // shouldn't kill at 90s (it would without the fix), but it WILL kill
    // shortly after the default elapses.
    registerFakeExtension("nomanifest-ext__op", "nomanifest-ext", undefined);
    const h = buildHarness();

    h.piAgent.fire({ type: "turn_start" });
    h.piAgent.fire({
      type: "tool_execution_start",
      toolCallId: "tc-2",
      toolName: "nomanifest-ext__op",
      args: {},
    });

    // Within the default budget (60s) → should NOT kill at 90s idle.
    await advanceAndTick(40_000);
    expect(h.run.status).toBe("running");

    // Past the default budget → eventually kills.
    await advanceAndTick(30_000); // total 70s — defer lifts
    await advanceAndTick(95_000); // idle clock trips
    expect(h.run.status).toBe("error");

    const td = h.events.find((e) => e.type === "tool:error")!.data as AgentEvents["tool:error"];
    expect(td.error).toMatch(new RegExp(`exceeded its ${DEFAULT_BUILTIN_CALL_TIMEOUT_MS}ms`, "i"));
  });
});

describe("subscribe-bridge → WatchdogManager: built-in tools (AC4 amended — built-ins also tracked)", () => {
  test("built-in tool (no `__` in name) is tracked with DEFAULT_BUILTIN_CALL_TIMEOUT_MS, extensionId='' on tool:error", async () => {
    // AC4 was amended to extend tracking to built-ins. Verify a built-in
    // gets the deferral + kill-emit treatment with the right defaults.
    const h = buildHarness();

    h.piAgent.fire({ type: "turn_start" });
    h.piAgent.fire({
      type: "tool_execution_start",
      toolCallId: "tc-builtin-1",
      toolName: "Bash",
      args: { command: "sleep 100" },
    });

    // Within the 60s default — defer past 90s idle.
    await advanceAndTick(40_000);
    expect(h.run.status).toBe("running");

    // Past the default → kill.
    await advanceAndTick(25_000); // total ≈ 65s, defer lifts
    await advanceAndTick(95_000);
    expect(h.run.status).toBe("error");

    const td = h.events.find((e) => e.type === "tool:error")!.data as AgentEvents["tool:error"];
    expect(td.toolName).toBe("Bash");
    expect(td.extensionId).toBe(""); // built-ins use the empty extensionId convention
    expect(td.invocationId).toBe("tc-builtin-1");
  });
});

describe("subscribe-bridge → WatchdogManager: invoke_agent is excluded (no double-tracking)", () => {
  test("invoke_agent does NOT register an inflight entry; idle timer behaves normally", async () => {
    // invoke_agent has its own agent:spawn/agent:complete lifecycle.
    // The bridge short-circuits before reaching noteToolStart for it
    // (line 113 of subscribe-bridge.ts). Verify by firing the event
    // and checking that the deferral does NOT engage — the run gets
    // killed by the normal idle path because the activity clock is
    // never bumped by a deferred tick.
    const h = buildHarness();

    h.piAgent.fire({ type: "turn_start" });
    h.piAgent.fire({
      type: "tool_execution_start",
      toolCallId: "tc-ia",
      toolName: "invoke_agent",
      args: { agent: "child", task: "x" },
    });

    // No deferral should engage, so a 95s wait kills with the GENERIC
    // idle reason — not a tool-specific one.
    await advanceAndTick(95_000);

    expect(h.run.status).toBe("error");
    const re = h.events.find((e) => e.type === "run:error")!.data as AgentEvents["run:error"];
    expect(re.error).toMatch(/Watchdog: no activity for \d+s/);
    expect(re.error).not.toMatch(/exceeded.*call timeout/i);
    // No tool:error should be synthesized on kill (we never tracked it).
    expect(h.events.find((e) => e.type === "tool:error")).toBeUndefined();
  });
});

describe("subscribe-bridge → WatchdogManager: tool_execution_end clears inflight (AC1, AC2)", () => {
  test("tool completes normally → noteToolEnd drops entry → next idle window kills cleanly with no spurious tool:error", async () => {
    registerFakeExtension("ext-a__op", "ext-a", 180_000);
    const h = buildHarness();

    h.piAgent.fire({ type: "turn_start" });
    h.piAgent.fire({
      type: "tool_execution_start",
      toolCallId: "tc-end-1",
      toolName: "ext-a__op",
      args: {},
    });
    h.piAgent.fire({
      type: "tool_execution_end",
      toolCallId: "tc-end-1",
      toolName: "ext-a__op",
      isError: false,
      result: { content: [{ type: "text", text: "ok" }] },
    });

    // Drain dbQueue so persistToolCall lands (proves the bridge ran the
    // success branch — guards against a regression where end-handling
    // accidentally short-circuits before hitting our wired noteToolEnd).
    await h.ctx.dbQueue;
    expect(h.events.find((e) => e.type === "tool:complete")).toBeDefined();
    expect(persisted.find((r) => r.id === "tc-end-1")).toBeDefined();

    // Now there are no inflight tools. A 95s idle MUST kill — no
    // spurious tool:error should be synthesized for the completed call.
    await advanceAndTick(95_000);

    expect(h.run.status).toBe("error");
    expect(h.events.filter((e) => e.type === "tool:error")).toHaveLength(0);
  });

  test("two tools start, one ends, watchdog kills → ONLY the still-inflight one gets tool:error", async () => {
    registerFakeExtension("ext-a__short", "ext-a", 30_000);
    registerFakeExtension("ext-b__short", "ext-b", 30_000);
    const h = buildHarness();

    h.piAgent.fire({ type: "turn_start" });
    h.piAgent.fire({
      type: "tool_execution_start",
      toolCallId: "tc-a",
      toolName: "ext-a__short",
      args: {},
    });
    h.piAgent.fire({
      type: "tool_execution_start",
      toolCallId: "tc-b",
      toolName: "ext-b__short",
      args: {},
    });
    h.piAgent.fire({
      type: "tool_execution_end",
      toolCallId: "tc-a",
      toolName: "ext-a__short",
      isError: false,
      result: { content: [{ type: "text", text: "done" }] },
    });
    await h.ctx.dbQueue;

    // Only tc-b is in flight now. Drive past its budget + idle.
    await advanceAndTick(35_000);
    await advanceAndTick(95_000);
    expect(h.run.status).toBe("error");

    const toolErrors = h.events.filter((e) => e.type === "tool:error");
    expect(toolErrors).toHaveLength(1);
    const td = toolErrors[0]!.data as AgentEvents["tool:error"];
    expect(td.invocationId).toBe("tc-b");
    expect(td.toolName).toBe("ext-b__short");
    expect(td.extensionId).toBe("ext-b");
  });
});
