/**
 * Integration tests proving the hot-fix preserves pre-Tier-2 behavior
 * for undeclared built-ins (zero regression) AND provides the bulkhead
 * for built-ins that declare a budget.
 *
 * Scope (task #3 — hot-fix on top of the prior PR's Tier 2 watchdog):
 *
 *   1. Pre-Tier-2 baseline reproduction. An undeclared built-in
 *      running for 60s with no events is NOT killed. Reason: the new
 *      `DEFAULT_BUILTIN_CALL_TIMEOUT_MS == WATCHDOG_IDLE_MS == 90_000`,
 *      so the tool-in-flight deferral covers exactly the same idle
 *      window that pre-Tier-2 already tolerated. This is the byte-
 *      identical-to-pre-fix-world claim, locked in.
 *
 *   2. Slow Bash inside its declared budget completes cleanly. With
 *      `callTimeoutMs: 600_000` (the value shipped on the shell
 *      built-in), a 5-minute simulated execution returns successfully
 *      with no `tool:error` and no `run:error` — the bulkhead works.
 *
 *   3. Slow Bash exceeding its declared budget produces a properly-
 *      shaped `tool:error`. An 11-minute hang past the 600_000ms budget
 *      eventually trips the watchdog with the expected "exceeded its
 *      600000ms call timeout" reason — the same legibility fix the
 *      Tier 2 PR shipped for extensions, now applied to built-ins.
 *
 * Style: mirrors `watchdog-tool-error-emission.integration.test.ts` and
 * `openai-image-gen-2-watchdog-e2e.integration.test.ts` from the prior
 * PR — same fake-clock + setInterval-capture harness, same module
 * mocking strategy, same `subscribeBridge` wire-up. The only material
 * difference is what's in `ctx.builtinToolDefsMap`: built-ins live there;
 * extensions live in the registry.
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
import type { BuiltinToolDef } from "../runtime/tools/types";
import { createReadPageTool } from "../runtime/tools/ez";
import {
  ezClientToolWatchdogBudgetMs,
  _setEzClientToolTimeoutForTests,
  _resetEzClientToolTimeoutForTests,
} from "../runtime/tools/ez/client-tool";
import {
  resolveRemoteTool,
  _resetPendingRemoteToolsForTests,
} from "../runtime/remote-tool-registry";
import { Type } from "@earendil-works/pi-ai";

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
  // The Ez suite below installs a shortened gate + leaves entries behind
  // on its abort path; clear both so no real 5-minute timer outlives a test.
  _resetEzClientToolTimeoutForTests();
  _resetPendingRemoteToolsForTests();
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

const RUN_ID = "run-builtin-1";
const CONV_ID = "conv-builtin-1";

interface BuiltinHarness {
  bus: EventBus<AgentEvents>;
  events: CapturedEvent[];
  watchdog: WatchdogManager;
  ctx: StreamChatContext;
  host: StreamChatHost;
  piAgent: ReturnType<typeof makePiAgent>;
  run: AgentRun;
}

/** Build a minimal valid `BuiltinToolDef`. Only the fields the bridge
 *  reads need to be meaningful; the rest is scaffolding so TS compiles. */
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

function setupHarness(builtinToolDefsMap: Map<string, BuiltinToolDef>): BuiltinHarness {
  const bus = new EventBus<AgentEvents>();
  const events: CapturedEvent[] = [];
  for (const t of ["tool:start", "tool:complete", "tool:error", "run:error"] as const) {
    bus.on(t, (data) => events.push({ type: t, data }));
  }

  const run: AgentRun = { id: RUN_ID, agentName: "test", status: "running", startedAt: fakeNow, logs: [] };
  const runs = new Map([[RUN_ID, run]]);
  const controllers = new Map([[RUN_ID, new AbortController()]]);
  const pendingPermissions = new Map();

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
    pendingPermissions: pendingPermissions as unknown as StreamChatHost["pendingPermissions"],
    controllers,
    runConversations: new Map(),
    activeAgents: new Map(),
    runs,
    watchdog,
    stateMediator: undefined,
    spawnQuota: {} as StreamChatHost["spawnQuota"],
    executor: {} as StreamChatHost["executor"],
    permissionEngine: {} as StreamChatHost["permissionEngine"],
  };

  const piAgent = makePiAgent();
  subscribeBridge(ctx, host, piAgent as unknown as Parameters<typeof subscribeBridge>[2], CONV_ID, {}, null);

  return { bus, events, watchdog, ctx, host, piAgent, run };
}

// ── 1. Pre-Tier-2 baseline reproduction ────────────────────────────────

describe("undeclared built-in: zero-regression vs. pre-Tier-2 watchdog behavior", () => {
  test("60s in-flight undeclared built-in is NOT killed (default budget covers the run-level idle window)", async () => {
    // The point of the hot-fix: pre-Tier-2, an undeclared built-in
    // running 60s with no events would NOT trip the run-level idle
    // watchdog (60s < 90s WATCHDOG_IDLE_MS). The Tier 2 PR introduced a
    // 60s default that would have killed this case. The hot-fix lifts
    // the default back to WATCHDOG_IDLE_MS so the behavior is restored
    // exactly. This test pins that restoration.
    //
    // Setup: a built-in (`readFile`) registered in the
    // builtinToolDefsMap WITHOUT a callTimeoutMs declaration. The
    // bridge resolves the budget to DEFAULT_BUILTIN_CALL_TIMEOUT_MS and
    // hands it to the watchdog. We drive 60s of pi-agent silence and
    // verify the run is still running.
    const builtinMap = new Map<string, BuiltinToolDef>();
    builtinMap.set("readFile", makeBuiltinDef({ name: "readFile" /* undeclared */ }));
    const h = setupHarness(builtinMap);

    h.piAgent.fire({ type: "turn_start" });
    h.piAgent.fire({
      type: "tool_execution_start",
      toolCallId: "tc-rf-1",
      toolName: "readFile",
      args: { path: "/tmp/x.txt" },
    });

    // Drive 60s of in-flight silence — four 15s ticks. Each tick lands
    // BEFORE the 90s default budget elapses, so the deferral keeps
    // bumping activity. No kill, no errors.
    for (let i = 0; i < 4; i++) {
      await advanceAndTick(15_000);
      expect(h.run.status, `tick ${i}: run was killed at ${(i + 1) * 15}s`).toBe("running");
    }

    expect(h.events.find((e) => e.type === "run:error")).toBeUndefined();
    expect(h.events.find((e) => e.type === "tool:error")).toBeUndefined();
  });

  test("default constant equals 90_000ms — the value any future test in this cluster relies on", () => {
    // Belt-and-braces. If a future PR drops the constant back below
    // WATCHDOG_IDLE_MS, the 60s no-regression test above would still
    // pass (60 < 90 < new_default — no contradiction), masking the
    // regression. This sentinel makes the failure loud at the constant
    // boundary instead.
    expect(DEFAULT_BUILTIN_CALL_TIMEOUT_MS).toBe(90_000);
  });
});

// ── 2. Slow Bash inside its declared budget ────────────────────────────

describe("declared callTimeoutMs=600_000 (Bash): tool inside budget completes cleanly", () => {
  test("5-minute simulated shell execution returns successfully — no spurious watchdog errors", async () => {
    // The shell built-in ships with callTimeoutMs: 600_000. A normal
    // long-running build (5 min) MUST NOT be killed mid-flight. Drive
    // 5 minutes of pi-agent silence, then fire tool_execution_end with
    // a successful result. Verify tool:complete fired and no errors
    // were synthesized.
    const builtinMap = new Map<string, BuiltinToolDef>();
    builtinMap.set("shell", makeBuiltinDef({ name: "shell", callTimeoutMs: 600_000, cardType: "terminal" }));
    const h = setupHarness(builtinMap);

    h.piAgent.fire({ type: "turn_start" });
    h.piAgent.fire({
      type: "tool_execution_start",
      toolCallId: "tc-sh-ok",
      toolName: "shell",
      args: { command: "bun test" },
    });

    // 5 minutes of silence = 20 ticks of 15s. Each tick is well within
    // the 600s budget, so the deferral keeps bumping activity.
    for (let i = 0; i < 20; i++) {
      await advanceAndTick(15_000);
      expect(h.run.status, `tick ${i}: shell killed at ${(i + 1) * 15}s`).toBe("running");
    }

    // Tool finishes normally.
    h.piAgent.fire({
      type: "tool_execution_end",
      toolCallId: "tc-sh-ok",
      toolName: "shell",
      isError: false,
      result: { content: [{ type: "text", text: "build complete" }] },
    });
    await h.ctx.dbQueue;

    expect(h.events.find((e) => e.type === "tool:complete")).toBeDefined();
    expect(persisted.find((r) => r.id === "tc-sh-ok")).toBeDefined();
    expect(h.events.find((e) => e.type === "tool:error")).toBeUndefined();
    expect(h.events.find((e) => e.type === "run:error")).toBeUndefined();
    expect(h.run.status).toBe("running");
  });
});

// ── 3. Slow Bash exceeding its declared budget ─────────────────────────

describe("declared callTimeoutMs=600_000 (Bash): tool exceeding budget produces tool:error", () => {
  test("11-minute hang past 600_000ms produces a properly-shaped tool:error + run:error with the right cause", async () => {
    // Worst case: a shell command genuinely deadlocks. The deferral
    // expires at 600s, then the run-level idle clock counts up from
    // the last successful defer's bump. Once idleMs >= 90s, the kill
    // fires. Verify the tool:error payload carries the declared budget
    // in its reason string — proves the watchdog distinguished the
    // declared deadline from the generic idle string.
    const builtinMap = new Map<string, BuiltinToolDef>();
    builtinMap.set("shell", makeBuiltinDef({ name: "shell", callTimeoutMs: 600_000, cardType: "terminal" }));
    const h = setupHarness(builtinMap);

    h.piAgent.fire({ type: "turn_start" });
    h.piAgent.fire({
      type: "tool_execution_start",
      toolCallId: "tc-sh-hang",
      toolName: "shell",
      args: { command: "sleep infinity" },
    });

    // Drive the full 600s deferral window, 15s ticks. 40 ticks → 600s.
    // Each tick defers + bumps activity. The 41st tick (at 615s) sees
    // the tool past budget, so the deferral lifts.
    for (let i = 0; i < 40; i++) {
      await advanceAndTick(15_000);
      expect(h.run.status, `tick ${i}: shell killed early at ${(i + 1) * 15}s`).toBe("running");
    }
    // t=600s. Tool just hit its budget. Last activity bump was at
    // t=585s (the previous tick's defer). The kill doesn't fire on
    // this tick — idleMs from 585s = 0 (we already advanced before
    // this point). Drive forward until idleMs >= 90s.
    await advanceAndTick(15_000); // t=615s, idleMs = 30s, no kill (defer lifted but idle too low)
    expect(h.run.status).toBe("running");

    // Need ~75s more to push idleMs past 90s.
    await advanceAndTick(15_000); // t=630s
    await advanceAndTick(15_000); // t=645s
    await advanceAndTick(15_000); // t=660s
    await advanceAndTick(15_000); // t=675s — idleMs from 585s = 90s → KILL
    await advanceAndTick(15_000); // ensure the kill tick has settled

    expect(h.run.status).toBe("error");

    const toolErr = h.events.find((e) => e.type === "tool:error");
    expect(toolErr, "tool:error must fire so the chat renders a failure card instead of bare abort text").toBeDefined();
    const td = toolErr!.data as AgentEvents["tool:error"];

    // Full payload-shape pin against AgentEvents["tool:error"].
    expect(td.conversationId).toBe(CONV_ID);
    expect(td.extensionId).toBe(""); // built-ins use the empty extensionId convention
    expect(td.toolName).toBe("shell");
    expect(td.invocationId).toBe("tc-sh-hang");
    expect(td.cardType).toBe("terminal");
    expect(typeof td.duration).toBe("number");
    expect(td.duration).toBeGreaterThanOrEqual(600_000);
    // The decisive assertion: the reason carries the DECLARED budget
    // (600_000), not the default (90_000). Proves the bridge resolved
    // toolDef.callTimeoutMs over DEFAULT_BUILTIN_CALL_TIMEOUT_MS at
    // tool_execution_start time.
    expect(td.error).toMatch(/exceeded.*600000.*call timeout/i);

    // run:error follows tool:error (chat ordering: per-tool card, then
    // terminal banner) and carries the same reason.
    const runErr = h.events.find((e) => e.type === "run:error");
    expect(runErr).toBeDefined();
    const rd = runErr!.data as AgentEvents["run:error"];
    expect(rd.error).toMatch(/exceeded.*600000.*call timeout/i);
    expect(rd.conversationId).toBe(CONV_ID);

    const toolErrIdx = h.events.findIndex((e) => e.type === "tool:error");
    const runErrIdx = h.events.findIndex((e) => e.type === "run:error");
    expect(toolErrIdx).toBeLessThan(runErrIdx);
  });
});

// ── 4. Ez client-side tools: the panel round-trip outlives the idle window ─
//
// The live defect: `read_page` / `fill_form` / `navigate_to` suspend
// server-side until the Ez panel POSTs a result. The wait is bounded by
// the ez-client-tool registry's 5-minute gate — but the defs declared no
// `callTimeoutMs`, so the bridge handed the watchdog the 90s default and
// the run was killed mid-wait. Fast local panel → invisible; slow link or
// a user who takes >90s → the turn dies, and the gate's own rejection
// (the concrete error the LLM could have recovered from) never fires.
//
// These arms drive the REAL def through the REAL bridge + watchdog + gate:
//   4a. the run survives the gate's whole 5-minute window and completes
//       when the panel finally answers;
//   4b. when the panel never answers, the GATE wins the race — the LLM
//       gets "Timed out waiting for Ez client tool result" and the run
//       lives on;
//   4c. the watchdog is still the backstop — if the gate itself never
//       fires, the declared budget (not an indefinite deferral) still
//       kills the wedged run, and the kill unblocks the suspended tool.

describe("Ez client-side tool: watchdog defers for the whole panel round-trip", () => {
  interface WiredReadPage {
    h: BuiltinHarness;
    def: BuiltinToolDef;
    pending: Promise<{ content: unknown[]; details?: unknown }>;
    toolCallId: string;
  }

  /** Stand up the harness around the REAL `read_page` def, start the real
   *  (suspending) execute against the run's own abort signal, and tell the
   *  bridge the call is in flight — the exact sequence streamChat produces. */
  function wireReadPage(): WiredReadPage {
    const toolCallId = "tc-read-page";
    const def = createReadPageTool({ conversationId: CONV_ID, userId: "u-ez" });
    const builtinMap = new Map<string, BuiltinToolDef>();
    builtinMap.set(def.name, def);
    const h = setupHarness(builtinMap);

    // The bus only exists once the harness is built, so the executing
    // copy of the def is built here; both copies come from the same
    // factory, so they carry the same declared budget.
    const liveDef = createReadPageTool({
      conversationId: CONV_ID,
      userId: "u-ez",
      bus: h.bus,
    });
    const pending = liveDef.execute(
      toolCallId,
      { detail: "summary" },
      h.ctx.controller.signal,
    ) as Promise<{ content: unknown[]; details?: unknown }>;

    h.piAgent.fire({ type: "turn_start" });
    h.piAgent.fire({
      type: "tool_execution_start",
      toolCallId,
      toolName: def.name,
      args: { detail: "summary" },
    });
    return { h, def, pending, toolCallId };
  }

  /** End the tool exactly as pi-agent-core would: `isError` mirrors the
   *  tool result's own `details.isError`, so nothing here fakes a verdict. */
  function fireToolEnd(
    h: BuiltinHarness,
    toolCallId: string,
    toolName: string,
    result: { content: unknown[]; details?: unknown },
  ): void {
    const isError = (result.details as { isError?: boolean } | undefined)?.isError === true;
    h.piAgent.fire({ type: "tool_execution_end", toolCallId, toolName, isError, result });
  }

  test("4a. run survives the gate's full 5-minute wait, then completes on the panel's POST", async () => {
    const { h, def, pending, toolCallId } = wireReadPage();

    // 20 ticks × 15s = 300s, the whole gate window. Pre-fix the run was
    // killed on the tick after 90s with "exceeded its 90000ms call timeout".
    for (let i = 0; i < 20; i++) {
      await advanceAndTick(15_000);
      expect(h.run.status, `tick ${i}: run killed at ${(i + 1) * 15}s of a legitimate wait`).toBe("running");
    }
    expect(h.events.find((e) => e.type === "run:error")).toBeUndefined();
    expect(h.events.find((e) => e.type === "tool:error")).toBeUndefined();

    // The panel finally answers (user was reading, or the link was slow).
    expect(
      resolveRemoteTool(toolCallId, {
        ok: true,
        detail: { route: "/agents/new", title: "New agent" },
      }),
    ).toBe(true);
    const result = await pending;
    fireToolEnd(h, toolCallId, def.name, result);
    await h.ctx.dbQueue;

    // The LLM gets the page context, the run is intact.
    expect(h.events.find((e) => e.type === "tool:complete")).toBeDefined();
    expect(h.events.find((e) => e.type === "run:error")).toBeUndefined();
    expect(h.run.status).toBe("running");
    expect(JSON.stringify(result.content)).toContain("/agents/new");
  });

  test("4b. panel never answers → the GATE rejects first; the run lives and the LLM sees why", async () => {
    // Shrink the gate so its (real, not faked) timer fires inside the
    // test. The def is built AFTER the override, so its watchdog budget
    // shrinks with it — one knob, no second literal to keep in sync.
    _setEzClientToolTimeoutForTests(25);
    const { h, def, pending, toolCallId } = wireReadPage();
    expect(def.callTimeoutMs).toBe(ezClientToolWatchdogBudgetMs());

    // The gate's rejection arrives on its own (real) timer while the
    // watchdog is still deferring — no watchdog tick is needed at all.
    const result = await pending;
    fireToolEnd(h, toolCallId, def.name, result);

    const text = JSON.stringify(result.content);
    expect(text).toContain("Timed out waiting for Ez client tool result");
    // The decisive ordering pin: the failure the model reads is the
    // gate's concrete tool error, NOT the watchdog's run-level kill.
    expect(text).not.toMatch(/exceeded.*call timeout/i);
    expect((result.details as { isError?: boolean }).isError).toBe(true);

    // The run itself is untouched — the model can apologise, retry, or
    // ask the user to open the Ez panel.
    await advanceAndTick(15_000);
    expect(h.run.status).toBe("running");
    expect(h.events.find((e) => e.type === "run:error")).toBeUndefined();
    const toolErr = h.events.find((e) => e.type === "tool:error");
    expect(toolErr, "the bridge relays the gate's error as the tool's own failure").toBeDefined();
    expect(JSON.stringify((toolErr!.data as AgentEvents["tool:error"]).error)).toContain("Timed out");
  });

  test("4c. gate wedged → the watchdog is still the backstop, and its kill unblocks the tool", async () => {
    // Defends the design choice: a BOUNDED budget, not `requiresUserInput`.
    // If the gate's own timer never fires (leaked entry, a refactor that
    // drops it), the watchdog must still reap the run — that leak
    // detection is exactly what an indefinite deferral would throw away.
    const { h, def, pending, toolCallId } = wireReadPage();
    const budget = def.callTimeoutMs!;
    expect(budget).toBeGreaterThan(DEFAULT_BUILTIN_CALL_TIMEOUT_MS);
    const startedAt = fakeNow;

    // Advance past the declared budget…
    while (fakeNow - startedAt < budget) {
      await advanceAndTick(15_000);
      expect(h.run.status, "killed before its declared budget").toBe("running");
    }
    // …then across the idle window that follows the lapsed deferral.
    for (let i = 0; i < 8 && h.run.status === "running"; i++) {
      await advanceAndTick(15_000);
    }

    expect(h.run.status).toBe("error");
    const toolErr = h.events.find((e) => e.type === "tool:error")!;
    expect(toolErr).toBeDefined();
    const td = toolErr.data as AgentEvents["tool:error"];
    expect(td.toolName).toBe(def.name);
    expect(td.invocationId).toBe(toolCallId);
    expect(td.error).toMatch(new RegExp(`exceeded.*${budget}.*call timeout`, "i"));
    // Not the 90s default — the budget the def declared.
    expect(td.error).not.toContain(`${DEFAULT_BUILTIN_CALL_TIMEOUT_MS}ms`);

    // The kill aborts the run controller, and the tool's abort listener
    // collapses the gate — the suspended execute unblocks instead of
    // leaking a promise for the process lifetime.
    const result = await pending;
    expect(JSON.stringify(result.content)).toContain(
      "Aborted while waiting for read_page client result",
    );
  });
});
