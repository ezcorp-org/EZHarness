/**
 * Integration test for the model-aware watchdog idle window.
 *
 * The unit test (executor-watchdog-inflight-tools.test.ts) proves
 * resolveIdleThreshold's mapping using a hand-rolled `{ state: {...} }`
 * stub. THIS test closes the seam that stub elides: it registers a REAL
 * `Agent` from @earendil-works/pi-agent-core into the watchdog's
 * `activeAgents` map (exactly what the executor does in production) and
 * drives the REAL subscribe-bridge, so we verify that:
 *
 *   1. `agent.state.model.reasoning` + `agent.state.thinkingLevel` resolve
 *      through pi-agent-core's actual `state` getter and pi-ai's real
 *      `Model` shape — not a fake — so a registry/library change that drops
 *      or renames either field fails HERE, loudly.
 *   2. A reasoning run that goes silent past the old 90s ceiling is NOT
 *      killed — it survives to its widened window (300s medium / 900s high).
 *   3. A non-reasoning run still dies at the tight 90s ceiling (no regress).
 *   4. The bridge's `bumpActivity` (fired on a real pi-agent event) and the
 *      watchdog's widened window cooperate: activity at T resets the window,
 *      so the kill clock runs from the last real signal — not run start.
 *
 * In production the Agent the watchdog reads from `activeAgents` and the
 * Agent the bridge subscribes to are the SAME instance. We can't drive a
 * real Agent's event stream without a real model, so the harness splits
 * them: a real Agent supplies the state the watchdog reads, and a fake
 * pi-agent stream injects the synthetic events the bridge bumps activity on.
 * Both code paths under test (resolveIdleThreshold, subscribeBridge) are
 * the real, unmocked implementations.
 *
 * Harness/idioms mirror openai-image-gen-2-watchdog-e2e.integration.test.ts.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

// ── Mocks (must precede SUT import) ────────────────────────────────────

mock.module("../db/queries/active-runs", () => ({
  updateHeartbeat: async () => {},
  updatePartialResponse: async () => {},
  markInterrupted: async () => {},
  cleanupOrphanedRuns: async () => 0,
  interruptAllRuns: async () => 0,
  getActiveRun: async () => null,
}));

mock.module("../db/queries/runs", () => ({
  finalizeRunRow: async () => 1,
  terminalizeOrphanedRuns: async () => 0,
}));

mock.module("../db/queries/tool-calls", () => ({
  persistToolCall: async () => {},
  listToolCallOutputsForMessages: async () => [],
  getToolCallConversationById: async () => null,
}));

mock.module("../db/connection", () => ({
  getDb: () => ({ update: () => ({ set: () => ({ where: async () => {} }) }) }),
}));

mock.module("../db/queries/extensions", () => ({
  listExtensions: async () => [],
}));

import { Agent } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { subscribeBridge } from "../runtime/stream-chat/subscribe-bridge";
import type { StreamChatContext } from "../runtime/stream-chat/context";
import type { StreamChatHost } from "../runtime/stream-chat/host";
import { WatchdogManager, type WatchdogHost } from "../runtime/executor-watchdog";
import { EventBus } from "../runtime/events";
import type { AgentEvents, AgentRun } from "../types";

// ── Real pi-ai Model + pi-agent-core Agent ─────────────────────────────
//
// A minimal-but-valid Model literal (every required field of pi-ai's
// Model<TApi>). `reasoning` is the load-bearing flag the watchdog reads.

function makeModel(reasoning: boolean): Model<"openai-responses"> {
  return {
    id: reasoning ? "gpt-5.5" : "gpt-4o-mini",
    name: reasoning ? "GPT-5.5" : "GPT-4o mini",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com",
    reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 272_000,
    maxTokens: 128_000,
  };
}

/** Construct a REAL Agent carrying the given model + thinking level in its
 *  state. We never call prompt()/continue(), so no streamFn/model call is
 *  ever made — the Agent exists purely as the state surface the watchdog
 *  reads via `agent.state.model.reasoning` / `agent.state.thinkingLevel`. */
function makeAgent(reasoning: boolean, thinkingLevel: ThinkingLevel): Agent {
  return new Agent({ initialState: { model: makeModel(reasoning), thinkingLevel } });
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

/** Fake pi-agent stream the bridge subscribes to, so we can inject the
 *  synthetic events that drive bumpActivity. Distinct from the real Agent
 *  registered in activeAgents (see file header). */
function makePiAgentStream() {
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

const RUN_ID = "run-reasoning-1";
const CONV_ID = "conv-reasoning-1";

interface Harness {
  events: CapturedEvent[];
  watchdog: WatchdogManager;
  piStream: ReturnType<typeof makePiAgentStream>;
  run: AgentRun;
}

function setupHarness(reasoning: boolean, thinkingLevel: ThinkingLevel): Harness {
  const bus = new EventBus<AgentEvents>();
  const events: CapturedEvent[] = [];
  for (const t of ["tool:error", "run:error"] as const) {
    bus.on(t, (data) => events.push({ type: t, data }));
  }

  const run: AgentRun = { id: RUN_ID, agentName: "chat", status: "running", startedAt: fakeNow, logs: [] };
  const runs = new Map([[RUN_ID, run]]);
  const controllers = new Map([[RUN_ID, new AbortController()]]);

  // The REAL Agent — this is the production wiring the unit test stubs.
  const activeAgents = new Map<string, Agent>([[RUN_ID, makeAgent(reasoning, thinkingLevel)]]);

  const watchdogHost: WatchdogHost = {
    runs,
    controllers,
    activeAgents,
    runConversations: new Map(),
    pendingPermissions: new Map(),
    bus,
    persist: true,
    errorMessagePersisted: new Set<string>(),
  };
  const watchdog = new WatchdogManager(watchdogHost);
  watchdog.startWatchdog(RUN_ID, CONV_ID, () => "");

  // Wire the REAL subscribe-bridge so bumpActivity runs on real events.
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
    pendingPermissions: new Map() as unknown as StreamChatHost["pendingPermissions"],
    controllers,
    runConversations: new Map(),
    activeAgents,
    runs,
    watchdog,
    stateMediator: undefined,
    spawnQuota: {} as StreamChatHost["spawnQuota"],
    executor: {} as StreamChatHost["executor"],
    errorMessagePersisted: new Set<string>(),
    permissionEngine: {} as StreamChatHost["permissionEngine"],
  };

  const piStream = makePiAgentStream();
  subscribeBridge(ctx, host, piStream as unknown as Parameters<typeof subscribeBridge>[2], CONV_ID, {}, null);

  return { events, watchdog, piStream, run };
}

// ── Reasoning models get the widened window ────────────────────────────

describe("watchdog model-aware idle window — real Agent through the bridge", () => {
  test("reasoning + medium: NOT killed at the old 90s ceiling, survives to its 300s window", async () => {
    const h = setupHarness(true, "medium");

    // Past the 90s non-reasoning ceiling — pre-fix this killed the run.
    await advanceAndTick(120_000);
    expect(h.run.status, "reasoning run must survive past 90s").toBe("running");
    expect(h.events.find((e) => e.type === "run:error")).toBeUndefined();

    // Still within the 300s reasoning window.
    await advanceAndTick(150_000); // t=270s
    expect(h.run.status).toBe("running");

    // Past 300s of pure silence → kill, with the generic idle reason.
    await advanceAndTick(60_000); // t=330s ≥ 300s
    expect(h.run.status).toBe("error");
    const re = h.events.find((e) => e.type === "run:error")!.data as AgentEvents["run:error"];
    expect(re.error).toMatch(/Watchdog: no activity for \d+s/);
  });

  test("reasoning + high: gets the widest 900s window", async () => {
    const h = setupHarness(true, "high");

    await advanceAndTick(310_000); // past the 300s medium window
    expect(h.run.status, "high-effort run must outlive the 300s medium window").toBe("running");

    await advanceAndTick(600_000); // t=910s ≥ 900s → kill
    expect(h.run.status).toBe("error");
  });

  test("non-reasoning model still dies at the tight 90s ceiling (regression guard)", async () => {
    const h = setupHarness(false, "minimal");

    await advanceAndTick(95_000);
    expect(h.run.status).toBe("error");
    const re = h.events.find((e) => e.type === "run:error")!.data as AgentEvents["run:error"];
    expect(re.error).toMatch(/Watchdog: no activity for \d+s/);
  });

  test("a real bridge event mid-run resets the widened window (bumpActivity ↔ widened ceiling cooperate)", async () => {
    const h = setupHarness(true, "medium");

    // 200s of silence — alive (within 300s window).
    await advanceAndTick(200_000);
    expect(h.run.status).toBe("running");

    // A real reasoning-summary delta arrives through the bridge, bumping
    // activity. The kill clock now restarts from here.
    h.piStream.fire({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "thinking_delta", delta: "…reasoning…" },
    });

    // 250s more (t=450s absolute) — would have tripped the 300s window if
    // measured from run start, but the bump reset it, so still alive.
    await advanceAndTick(250_000);
    expect(h.run.status, "activity bump must reset the widened window").toBe("running");

    // Now 300s of fresh silence from the bump → kill.
    await advanceAndTick(60_000); // 310s since the bump
    expect(h.run.status).toBe("error");
  });
});
