/**
 * End-to-end watchdog test pinned to the canonical user-reported bug:
 * the chat composer triggers `openai-image-gen-2__generate`, the upstream
 * Images API takes 60–180s to return, pi-agent-core emits no events while
 * awaiting the tool result, and the run-level watchdog (90s idle) kills
 * the run mid-flight. Pre-fix: the chat shows a bare
 * "Error: Request was aborted" — tool:error never fires for the
 * in-flight call. Post-fix: the watchdog reads `callTimeoutMs: 180_000`
 * from the openai-image-gen-2 manifest and defers; if the call truly
 * hangs past the manifest budget, the watchdog emits a properly-shaped
 * tool:error so the chat renders the failure as a real card with the
 * tool name, extension id, and a human-readable timeout reason.
 *
 * What this test pins (the bug it would catch):
 *   1. Pre-fix bug regression: a 100s in-progress image generation does
 *      NOT produce any tool:error or run:error. Without the Tier 2 fix,
 *      a 95s wait killed the run with a bare abort message.
 *   2. Hung-tool worst case: a generation that exceeds the 180s manifest
 *      budget DOES emit a tool:error — with extensionId="openai-image-
 *      gen-2", toolName="openai-image-gen-2__generate", invocationId
 *      matching the original tool_execution_start, error string mentioning
 *      "180000ms call timeout", and duration > 0.
 *   3. Happy path: a tool that returns successfully within budget gets
 *      noteToolEnd'd; no spurious errors are synthesized after the fact.
 *
 * Pattern: mirrors src/__tests__/openai-image-gen-2-edit-prior-image
 * .integration.test.ts in mocking style and bun:test idioms, but the
 * unit-of-deployment under test here is the runtime watchdog +
 * subscribe-bridge handshake (NOT the openai-image-gen-2 handler
 * internals — those are covered by the edit-prior-image test).
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

mock.module("../db/queries/active-runs", () => ({
  updateHeartbeat: async () => {},
  updatePartialResponse: async () => {},
  markInterrupted: async () => {},
  cleanupOrphanedRuns: async () => 0,
  interruptAllRuns: async () => 0,
  getActiveRun: async () => null,
}));

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
import { WatchdogManager, type WatchdogHost } from "../runtime/executor-watchdog";
import { EventBus } from "../runtime/events";
import type { AgentEvents, AgentRun } from "../types";
import type { ExtensionManifestV2 } from "../extensions/types";

// ── openai-image-gen-2 manifest fixture ────────────────────────────────
// Mirrors `docs/extensions/examples/openai-image-gen-2/ezcorp.config.ts`
// at the fields the watchdog/bridge actually read. callTimeoutMs is
// the load-bearing value — 180_000 ms — from line 136 of that file.
// If the upstream config drops below 90_000 OR removes the field, this
// fixture should be updated alongside.

const OIG2_EXT_ID = "openai-image-gen-2";
const OIG2_TOOL = "openai-image-gen-2__generate";
const OIG2_CALL_TIMEOUT_MS = 180_000;

function registerOig2(): void {
  const registry = ExtensionRegistry.getInstance();
  registry.registerToolForTest(OIG2_TOOL, {
    name: OIG2_TOOL,
    description: "Generate an image with GPT image",
    inputSchema: { type: "object" },
    extensionId: OIG2_EXT_ID,
    extensionName: "openai-image-gen-2",
    originalName: "generate",
    cardType: "image-card",
  });
  const manifest: ExtensionManifestV2 = {
    name: OIG2_EXT_ID,
    version: "1.0.0",
    runtime: { type: "node", entry: "x" },
    permissions: {},
    tools: [],
    resources: { callTimeoutMs: OIG2_CALL_TIMEOUT_MS },
  } as unknown as ExtensionManifestV2;
  registry.setManifestForTest(OIG2_EXT_ID, manifest);
}

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
  fakeNow = 1_700_000_000_000;
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

// ── Harness ────────────────────────────────────────────────────────────

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

const RUN_ID = "run-oig2-1";
const CONV_ID = "conv-oig2-1";

interface E2EHarness {
  bus: EventBus<AgentEvents>;
  events: CapturedEvent[];
  watchdog: WatchdogManager;
  ctx: StreamChatContext;
  host: StreamChatHost;
  piAgent: ReturnType<typeof makePiAgent>;
  run: AgentRun;
}

function setupHarness(): E2EHarness {
  const bus = new EventBus<AgentEvents>();
  const events: CapturedEvent[] = [];
  for (const t of ["tool:start", "tool:complete", "tool:error", "run:error"] as const) {
    bus.on(t, (data) => events.push({ type: t, data }));
  }

  const run: AgentRun = { id: RUN_ID, agentName: "oig2-agent", status: "running", startedAt: fakeNow, logs: [] };
  const runs = new Map([[RUN_ID, run]]);
  const controllers = new Map([[RUN_ID, new AbortController()]]);
  const pendingPermissions = new Map();

  const watchdogHost: WatchdogHost = {
    runs, controllers,
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

  return { bus, events, watchdog, ctx, host, piAgent, run };
}

// ── 1. Pre-fix bug regression ──────────────────────────────────────────

describe("openai-image-gen-2 watchdog e2e — pre-fix bug regression", () => {
  test("100s in-flight image generation does NOT trigger watchdog kill (manifest 180s budget honored)", async () => {
    // Reproduce the exact reported bug: image-gen tool kicked off,
    // upstream Images API takes 100s, pi-agent-core emits no progress
    // events. Pre-fix this killed the run at 90s with no tool:error.
    // Post-fix: the watchdog reads callTimeoutMs from the manifest and
    // defers — chat stays responsive, no spurious errors.
    registerOig2();
    const h = setupHarness();

    h.piAgent.fire({ type: "turn_start" });
    h.piAgent.fire({
      type: "tool_execution_start",
      toolCallId: "tc-img-1",
      toolName: OIG2_TOOL,
      args: { prompt: "a friendly otter wearing a tiny chef's hat" },
    });

    // Tool:start should have fired (sanity check on the wire).
    const startEvt = h.events.find((e) => e.type === "tool:start")!;
    expect(startEvt).toBeDefined();
    const startData = startEvt.data as AgentEvents["tool:start"];
    expect(startData.toolName).toBe(OIG2_TOOL);
    expect(startData.invocationId).toBe("tc-img-1");
    expect(startData.cardType).toBe("image-card");

    // Drive 100s of "in-flight" silence — no token, no tool_end. Two
    // ticks land in this window (15s, 30s, ..., 90s); each hits the
    // deferral path because we're well within the 180s budget.
    for (let i = 0; i < 7; i++) {
      await advanceAndTick(15_000);
      // After every tick the run MUST still be running. If this assert
      // fires, the watchdog killed mid-flight = original bug regressed.
      expect(h.run.status, `tick ${i}: run was killed at ${i * 15 + 15}s`).toBe("running");
    }

    // 105s elapsed, still in flight, NO errors emitted.
    expect(h.events.find((e) => e.type === "run:error")).toBeUndefined();
    expect(h.events.find((e) => e.type === "tool:error")).toBeUndefined();
  });
});

// ── 2. Hung-tool worst case ────────────────────────────────────────────

describe("openai-image-gen-2 watchdog e2e — hung tool past manifest budget", () => {
  test("tool that hangs past 180s emits a properly-shaped tool:error (the legibility fix)", async () => {
    // Worst case: upstream API or extension subprocess deadlocks. The
    // manifest budget DOES eventually elapse, and at that point the
    // watchdog should emit a tool:error that the chat can render as a
    // real failure card — NOT the bare "Request was aborted".
    registerOig2();
    const h = setupHarness();

    h.piAgent.fire({ type: "turn_start" });
    h.piAgent.fire({
      type: "tool_execution_start",
      toolCallId: "tc-img-hang",
      toolName: OIG2_TOOL,
      args: { prompt: "this generation will hang" },
    });

    // Drive through the full deferral window: 15s ticks for 180s of
    // budget (12 ticks → 180s), each deferring; the 13th tick (at 195s)
    // sees the tool past budget so deferral lifts; subsequent ticks
    // accumulate idleMs from the last bump until the 90s threshold trips.
    for (let i = 0; i < 12; i++) {
      await advanceAndTick(15_000);
      expect(h.run.status).toBe("running");
    }
    // t=180s. Tool just hit its budget; deferral has lifted. The kill
    // doesn't happen on this tick because activity was bumped at the
    // last successful defer (t=165s in fakeNow terms). Drive forward
    // until idleMs >= 90s.
    await advanceAndTick(15_000); // t=195s
    await advanceAndTick(15_000); // t=210s
    await advanceAndTick(15_000); // t=225s
    await advanceAndTick(15_000); // t=240s
    await advanceAndTick(15_000); // t=255s — idleMs from 165s = 90s → KILL
    await advanceAndTick(15_000); // ensure the kill tick has settled

    expect(h.run.status).toBe("error");

    // tool:error MUST exist for the in-flight call.
    const toolErr = h.events.find((e) => e.type === "tool:error");
    expect(toolErr, "tool:error must fire so the chat renders a failure card instead of bare abort text").toBeDefined();
    const td = toolErr!.data as AgentEvents["tool:error"];

    // Full payload-shape pin against AgentEvents["tool:error"] in src/types.ts:256.
    expect(td.conversationId).toBe(CONV_ID);
    expect(td.extensionId).toBe(OIG2_EXT_ID); // resolved from registry, NOT empty
    expect(td.toolName).toBe(OIG2_TOOL);
    expect(td.invocationId).toBe("tc-img-hang"); // same as tool:start, for client correlation
    expect(td.cardType).toBe("image-card"); // propagated from manifest tool def
    expect(typeof td.duration).toBe("number");
    expect(td.duration).toBeGreaterThanOrEqual(OIG2_CALL_TIMEOUT_MS);
    expect(td.error).toMatch(new RegExp(`Tool ${OIG2_TOOL} exceeded its ${OIG2_CALL_TIMEOUT_MS}ms call timeout`));

    // run:error follows tool:error (chat ordering: per-tool card, then terminal banner).
    const runErr = h.events.find((e) => e.type === "run:error");
    expect(runErr).toBeDefined();
    const rd = runErr!.data as AgentEvents["run:error"];
    expect(rd.error).toMatch(/exceeded.*180000.*call timeout/i);
    expect(rd.conversationId).toBe(CONV_ID);

    const toolErrIdx = h.events.findIndex((e) => e.type === "tool:error");
    const runErrIdx = h.events.findIndex((e) => e.type === "run:error");
    expect(toolErrIdx).toBeLessThan(runErrIdx);
  });
});

// ── 3. Happy path ──────────────────────────────────────────────────────

describe("openai-image-gen-2 watchdog e2e — happy path", () => {
  test("tool returns successfully within budget → noteToolEnd; no spurious watchdog errors", async () => {
    registerOig2();
    const h = setupHarness();

    h.piAgent.fire({ type: "turn_start" });
    h.piAgent.fire({
      type: "tool_execution_start",
      toolCallId: "tc-img-ok",
      toolName: OIG2_TOOL,
      args: { prompt: "a quick generation" },
    });

    // Simulate ~95s in-flight (past pre-fix's 90s kill, well within 180s budget).
    for (let i = 0; i < 6; i++) {
      await advanceAndTick(15_000);
      expect(h.run.status).toBe("running");
    }
    // ~95s in. Tool finishes successfully.
    h.piAgent.fire({
      type: "tool_execution_end",
      toolCallId: "tc-img-ok",
      toolName: OIG2_TOOL,
      isError: false,
      result: { content: [{ type: "text", text: '{"url":"/api/ext-files/openai-image-gen-2/generated/x.png"}' }] },
    });
    await h.ctx.dbQueue;

    // tool:complete fired and persisted.
    expect(h.events.find((e) => e.type === "tool:complete")).toBeDefined();
    expect(persisted.find((r) => r.id === "tc-img-ok")).toBeDefined();
    // No tool:error or run:error on the wire.
    expect(h.events.find((e) => e.type === "tool:error")).toBeUndefined();
    expect(h.events.find((e) => e.type === "run:error")).toBeUndefined();
    expect(h.run.status).toBe("running");
  });

  test("after a successful return, the next idle window kills with the GENERIC reason — proves noteToolEnd dropped the entry", async () => {
    // Regression guard: if noteToolEnd silently leaked the entry, the
    // next watchdog kill would attribute itself to OIG2 and fire a
    // bogus tool:error. We verify the reason is the GENERIC idle
    // string, not a tool-specific one.
    registerOig2();
    const h = setupHarness();

    h.piAgent.fire({ type: "turn_start" });
    h.piAgent.fire({
      type: "tool_execution_start",
      toolCallId: "tc-img-leak",
      toolName: OIG2_TOOL,
      args: { prompt: "p" },
    });
    h.piAgent.fire({
      type: "tool_execution_end",
      toolCallId: "tc-img-leak",
      toolName: OIG2_TOOL,
      isError: false,
      result: { content: [{ type: "text", text: "ok" }] },
    });
    await h.ctx.dbQueue;

    // Now drive past the run-level 90s idle. With no inflight entries,
    // the kill reason must be the generic "no activity" string.
    await advanceAndTick(95_000);

    expect(h.run.status).toBe("error");
    // No spurious tool:error from a leaked inflight entry.
    expect(h.events.filter((e) => e.type === "tool:error")).toHaveLength(0);
    const re = h.events.find((e) => e.type === "run:error")!.data as AgentEvents["run:error"];
    expect(re.error).toMatch(/Watchdog: no activity for \d+s/);
    expect(re.error).not.toMatch(/exceeded.*call timeout/i);
  });
});

// ── 4. Manifest fixture invariant ──────────────────────────────────────

describe("openai-image-gen-2 manifest fixture invariant", () => {
  test("the fixture's callTimeoutMs is at least 90s — without that, the deferral test would be a tautology", () => {
    // If the upstream openai-image-gen-2 manifest ever drops
    // callTimeoutMs below the 90s WATCHDOG_IDLE_MS, this whole feature
    // becomes a no-op for that extension. Guard the fixture so the
    // failure mode is loud.
    expect(OIG2_CALL_TIMEOUT_MS).toBeGreaterThan(90_000);
  });
});
