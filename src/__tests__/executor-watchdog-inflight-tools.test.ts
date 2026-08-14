/**
 * Unit tests for WatchdogManager's in-flight tool tracking, the unified
 * deferral helper, and the tool:error fan-out emitted on kill.
 *
 * Scope (task #4): the manager itself — not the subscribe-bridge wiring
 * that calls into it (covered by #5 integration test) and not the
 * end-to-end openai-image-gen-2 scenario (covered by #6).
 *
 * Pinned acceptance criteria:
 *   AC1 — public surface noteToolStart / noteToolEnd records and removes
 *         entries keyed by (runId, toolCallId).
 *   AC2 — tick defers while any tracked call's elapsed < callTimeoutMs;
 *         once every entry has exceeded its budget, normal idle logic
 *         resumes and the kill path runs.
 *   AC3 — on kill, tool:error is emitted for every still-in-flight tool
 *         BEFORE run:error, with the payload shape mandated by
 *         src/types.ts:256.
 *   AC5 — pendingPermissions deferral path still works after the
 *         deferralReason() refactor (regression-free, unified helper).
 *
 * Time-mocking strategy: the watchdog uses real setInterval. We capture
 * the interval callback by stubbing globalThis.setInterval (the same
 * pattern as src/__tests__/background-timers.test.ts), then drive the
 * tick deterministically by advancing Date.now() ourselves.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

// ── Mocks (must precede SUT import) ────────────────────────────────────
//
// The watchdog calls into `db/queries/active-runs` for heartbeat /
// markInterrupted. We stub those to no-op so the unit test runs without
// a DB. `host.persist=true` is required to start the watchdog.

/** Every runId passed to updateHeartbeat, in call order — the defer branch
 *  writes one per tick on purpose (see the heartbeat-cadence test). */
const heartbeatWrites: string[] = [];
mock.module("../db/queries/active-runs", () => ({
  updateHeartbeat: async (runId: string) => { heartbeatWrites.push(runId); },
  updatePartialResponse: async () => {},
  markInterrupted: async () => {},
  cleanupOrphanedRuns: async () => 0,
  interruptAllRuns: async () => 0,
  getActiveRun: async () => null,
}));

/**
 * Captured watchdog log lines, in emission order across BOTH streams
 * (info → stdout, error → stderr), so ordering assertions between a
 * deferral-exit line and the trip line are meaningful.
 *
 * Read off the real writes rather than a `mock.module("../logger")`:
 * `executor-watchdog.ts` binds `logger.child("executor.watchdog")` at
 * module-evaluation time, so a module mock installed after the import
 * never reaches the already-created child. The one ambient input this
 * depends on — `LOG_LEVEL`, read per emit — is pinned in `beforeEach`,
 * so nothing here measures the host.
 */
interface CapturedLog { level: string; msg: string; fields: Record<string, unknown> }
const logLines: CapturedLog[] = [];
const WATCHDOG_SUBSYSTEM = '"subsystem":"executor.watchdog"';

function parseLogLine(chunk: unknown): CapturedLog | null {
  if (typeof chunk !== "string" || !chunk.includes(WATCHDOG_SUBSYSTEM)) return null;
  try {
    const o = JSON.parse(chunk) as { level: string; msg: string } & Record<string, unknown>;
    return { level: o.level, msg: o.msg, fields: o };
  } catch {
    return null;
  }
}

import {
  DEFAULT_BUILTIN_CALL_TIMEOUT_MS,
  WatchdogManager,
  type InflightToolInfo,
  type WatchdogHost,
} from "../runtime/executor-watchdog";
import { EventBus } from "../runtime/events";
import type { AgentEvents, AgentRun } from "../types";

// ── Fake clock + setInterval capture ───────────────────────────────────
//
// We stub globalThis.setInterval so the watchdog's tick is captured but
// never auto-fires. Tests then drive ticks by calling capturedTicks[i]()
// after advancing fakeNow.
//
// Date.now is also overridden so the tick reads our controlled time.

let originalSetInterval: typeof setInterval;
let originalDateNow: () => number;
let fakeNow = 0;
let capturedTicks: Array<() => void> = [];
let stdoutSpy: ReturnType<typeof spyOn> | undefined;
let stderrSpy: ReturnType<typeof spyOn> | undefined;
let originalLogLevel: string | undefined;

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
  logLines.length = 0;
  heartbeatWrites.length = 0;

  // Pin the one ambient input the logger reads per emit, so a box with
  // LOG_LEVEL=warn can't silently empty the capture.
  originalLogLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "info";
  // Capture (and swallow) only OUR lines; everything else — including the
  // test reporter's own output — passes straight through.
  const tap = (stream: NodeJS.WriteStream) => {
    // Bind the real write BEFORE spying, or the pass-through recurses.
    const passThrough = stream.write.bind(stream) as (...a: unknown[]) => boolean;
    return spyOn(stream, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      const parsed = parseLogLine(chunk);
      if (parsed) {
        logLines.push(parsed);
        return true;
      }
      return passThrough(chunk, ...rest);
    }) as never);
  };
  stdoutSpy = tap(process.stdout);
  stderrSpy = tap(process.stderr);
});

afterEach(() => {
  globalThis.setInterval = originalSetInterval;
  Date.now = originalDateNow;
  capturedTicks = [];
  // Restore the stream spies unconditionally — a leaked stdout spy would
  // poison every sibling test in this process (prototype-spy-leak lesson).
  stdoutSpy?.mockRestore();
  stderrSpy?.mockRestore();
  stdoutSpy = undefined;
  stderrSpy = undefined;
  if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = originalLogLevel;
});

/** Advance the fake clock and (when ticks have been captured) drive the
 *  watchdog tick once. Awaits a microtask so the async tick body
 *  (markInterrupted, updateHeartbeat) settles before assertions. */
async function advanceAndTick(deltaMs: number): Promise<void> {
  fakeNow += deltaMs;
  for (const fn of capturedTicks) fn();
  // Drain pending microtasks so awaited promises in tick() resolve.
  await new Promise<void>((r) => queueMicrotask(r));
}

// ── Test scaffolding ───────────────────────────────────────────────────

interface CapturedEvent<K extends keyof AgentEvents & string = keyof AgentEvents & string> {
  type: K;
  data: AgentEvents[K];
}

function makeRun(id: string, startedAt: number): AgentRun {
  return {
    id,
    agentName: "test-agent",
    status: "running",
    startedAt,
    logs: [],
  };
}

interface Harness {
  manager: WatchdogManager;
  host: WatchdogHost;
  bus: EventBus<AgentEvents>;
  events: CapturedEvent[];
  runs: Map<string, AgentRun>;
  controllers: Map<string, AbortController>;
  pendingPermissions: Map<string, { conversationId: string; runId?: string }>;
  errorMessagePersisted: Set<string>;
}

function makeHarness(): Harness {
  const bus = new EventBus<AgentEvents>();
  const events: CapturedEvent[] = [];
  // Capture the four event types the watchdog emits (run:error and
  // tool:error are the only ones we assert on; the others document
  // intent if they ever start firing unexpectedly).
  for (const type of ["tool:error", "run:error", "run:complete", "run:cancel"] as const) {
    bus.on(type, (data) => events.push({ type, data } as CapturedEvent));
  }

  const runs = new Map<string, AgentRun>();
  const controllers = new Map<string, AbortController>();
  const pendingPermissions = new Map<string, { conversationId: string; runId?: string }>();

  const errorMessagePersisted = new Set<string>();
  const host: WatchdogHost = {
    runs,
    controllers,
    activeAgents: new Map(),
    runConversations: new Map(),
    pendingPermissions,
    bus,
    persist: true,
    errorMessagePersisted,
  };

  return {
    manager: new WatchdogManager(host),
    host,
    bus,
    events,
    runs,
    controllers,
    pendingPermissions,
    errorMessagePersisted,
  };
}

const RUN_ID = "run-1";
const CONV_ID = "conv-1";
const TOOL_CALL_ID = "tool-call-1";

function info(overrides: Partial<InflightToolInfo> = {}): InflightToolInfo {
  return {
    toolName: "ext__op",
    conversationId: CONV_ID,
    extensionId: "ext",
    startedAt: fakeNow,
    callTimeoutMs: 180_000,
    ...overrides,
  };
}

function startRun(h: Harness): AgentRun {
  const run = makeRun(RUN_ID, fakeNow);
  h.runs.set(RUN_ID, run);
  h.controllers.set(RUN_ID, new AbortController());
  h.manager.startWatchdog(RUN_ID, CONV_ID, () => "");
  return run;
}

// ── Layer 1: pure state-machine tests for the inflight map ─────────────

describe("WatchdogManager inflight tracking — state machine (AC1)", () => {
  test("noteToolStart records the entry; second start for the same id overwrites", () => {
    const h = makeHarness();
    h.manager.noteToolStart(RUN_ID, TOOL_CALL_ID, info({ toolName: "first" }));
    h.manager.noteToolStart(RUN_ID, TOOL_CALL_ID, info({ toolName: "second", callTimeoutMs: 999 }));

    // We assert behavior: with the second entry's tiny budget, advancing
    // past it surfaces the tool name in the kill reason — proves the
    // overwrite stuck.
    startRun(h);
    fakeNow += 999 + 90_000; // exceed callTimeoutMs AND idle threshold
    capturedTicks[0]?.();
    return new Promise<void>((resolve) => queueMicrotask(() => {
      const toolError = h.events.find((e) => e.type === "tool:error");
      expect(toolError).toBeDefined();
      const data = toolError!.data as AgentEvents["tool:error"];
      expect(data.toolName).toBe("second");
      resolve();
    }));
  });

  test("noteToolEnd removes the entry and is a no-op for unknown ids", () => {
    const h = makeHarness();
    // Unknown run + unknown call — must not throw.
    expect(() => h.manager.noteToolEnd("nope", "also-nope")).not.toThrow();

    h.manager.noteToolStart(RUN_ID, TOOL_CALL_ID, info());
    h.manager.noteToolEnd(RUN_ID, TOOL_CALL_ID);

    // A second noteToolEnd on the same id is a safe no-op (the bridge
    // calls it on every tool_execution_end without checking that we
    // recorded a start).
    expect(() => h.manager.noteToolEnd(RUN_ID, TOOL_CALL_ID)).not.toThrow();
  });

  test("multiple inflight tool calls per run coexist; ending one leaves the other in flight", async () => {
    const h = makeHarness();
    const run = startRun(h);

    const longInfo = info({ toolName: "ext__long", callTimeoutMs: 200_000, startedAt: fakeNow });
    const shortInfo = info({ toolName: "ext__short", callTimeoutMs: 5_000, startedAt: fakeNow });
    h.manager.noteToolStart(RUN_ID, "tc-long", longInfo);
    h.manager.noteToolStart(RUN_ID, "tc-short", shortInfo);

    // Drop the short one — the run still has the long one in flight, so
    // the deferral should hold past 90s of idleness.
    h.manager.noteToolEnd(RUN_ID, "tc-short");

    await advanceAndTick(95_000); // past WATCHDOG_IDLE_MS
    expect(h.events.find((e) => e.type === "run:error")).toBeUndefined();
    expect(run.status).toBe("running");
  });

  test("clearRun wipes inflight state for that run, untouched runs persist", () => {
    const h = makeHarness();

    h.manager.noteToolStart("a", "ta", info({ toolName: "a-tool" }));
    h.manager.noteToolStart("b", "tb", info({ toolName: "b-tool" }));
    h.manager.clearRun("a");

    // Use run "b" via a fresh watchdog cycle and confirm it still defers;
    // run "a" should NOT defer (state was cleared).
    const runB = makeRun("b", fakeNow);
    h.runs.set("b", runB);
    h.controllers.set("b", new AbortController());
    h.manager.startWatchdog("b", "conv-b", () => "");

    fakeNow += 95_000;
    capturedTicks[0]?.();
    return new Promise<void>((resolve) => queueMicrotask(() => {
      // Run b's tool is still in flight (200_000 budget) — must NOT be killed.
      expect(h.events.find((e) => e.type === "run:error")).toBeUndefined();
      expect(runB.status).toBe("running");
      resolve();
    }));
  });

  test("destroy wipes all inflight state across all runs", async () => {
    const h = makeHarness();
    h.manager.noteToolStart("a", "ta", info());
    h.manager.noteToolStart("b", "tb", info());
    h.manager.destroy();

    // After destroy, starting a fresh watchdog and advancing past idle
    // should kill — there are no inflight entries left to defer.
    const run = makeRun(RUN_ID, fakeNow);
    h.runs.set(RUN_ID, run);
    h.controllers.set(RUN_ID, new AbortController());
    h.manager.startWatchdog(RUN_ID, CONV_ID, () => "");

    await advanceAndTick(95_000);
    expect(h.events.find((e) => e.type === "run:error")).toBeDefined();
  });
});

// ── Layer 2: deferral + kill behavior (AC2, AC3, AC5) ──────────────────

describe("Watchdog deferral via inflight tools (AC2)", () => {
  test("defers the kill while a tracked tool is within its callTimeoutMs", async () => {
    const h = makeHarness();
    const run = startRun(h);
    h.manager.noteToolStart(RUN_ID, TOOL_CALL_ID, info({ callTimeoutMs: 180_000 }));

    // Tick at 95s — past WATCHDOG_IDLE_MS (90s) but still well within
    // the 180s tool budget. Must defer.
    await advanceAndTick(95_000);

    expect(h.events).toHaveLength(0);
    expect(run.status).toBe("running");
  });

  test("kills once the tool exceeds its callTimeoutMs AND idle threshold passes", async () => {
    const h = makeHarness();
    const run = startRun(h);
    h.manager.noteToolStart(RUN_ID, TOOL_CALL_ID, info({ callTimeoutMs: 180_000 }));

    // Drive a series of ticks. The deferral keeps bumping activity, so
    // the kill clock effectively starts when the tool budget expires.
    // Sequence: 80s (defer, bumpActivity=80s), 160s (defer,
    // bumpActivity=160s), 195s (tool expired so no defer; idleMs=35s,
    // no kill), 260s (no defer; idleMs=100s ≥ 90s → KILL).
    await advanceAndTick(80_000);
    expect(run.status).toBe("running");

    await advanceAndTick(80_000); // now=160s
    expect(run.status).toBe("running");

    await advanceAndTick(35_000); // now=195s — past tool budget, idleMs=35s
    expect(run.status).toBe("running");

    await advanceAndTick(65_000); // now=260s — idleMs since last bump (160s) = 100s
    expect(run.status).toBe("error");
    const runError = h.events.find((e) => e.type === "run:error");
    expect(runError).toBeDefined();
  });

  test("once every tracked tool has exceeded its budget, the kill reason names the offender", async () => {
    const h = makeHarness();
    const run = startRun(h);
    // Single short-budget tool so we can pin the reason text.
    h.manager.noteToolStart(RUN_ID, TOOL_CALL_ID, info({
      toolName: "ext__slow",
      callTimeoutMs: 50_000,
    }));

    // 50s tool budget + 90s idle clock. Tick at 60s lifts the deferral
    // (tool over budget) but doesn't kill yet; tick at 155s does.
    await advanceAndTick(60_000);
    expect(run.status).toBe("running");

    await advanceAndTick(95_000); // total=155s; idleMs since last bump (none — 60s tick didn't bump) ≥ 90s
    expect(run.status).toBe("error");

    const toolError = h.events.find((e) => e.type === "tool:error")!;
    const data = toolError.data as AgentEvents["tool:error"];
    // Reason MUST mention the tool that blew its budget — that's the
    // user-facing payoff over the bare "no activity for 90s" string.
    expect(data.error).toContain("ext__slow");
    expect(data.error).toContain("50000");
    expect(data.error).toMatch(/exceeded.*call timeout/i);
  });

  test("requiresUserInput tool defers the idle kill indefinitely (past callTimeoutMs)", async () => {
    // Locks the contract for human-in-the-loop tools (ToolDefinition.
    // requiresUserInput): the watchdog never fires the elapsed-budget
    // kill while such a tool is in flight, no matter how small the
    // declared callTimeoutMs is or how much wall-clock elapses.
    const h = makeHarness();
    const run = startRun(h);
    h.manager.noteToolStart(RUN_ID, TOOL_CALL_ID, info({
      toolName: "ask-user__ask_user_question",
      callTimeoutMs: 50_000, // tiny budget — would normally fire fast
      requiresUserInput: true,
    }));

    // Drive the clock to 30 minutes — 36x the would-be budget and 20x
    // the idle threshold. With requiresUserInput, deferralReason
    // returns the "awaiting user input" branch every tick, bumping
    // activity, so neither the budget-based nor the idle-based kill
    // ever fires.
    await advanceAndTick(600_000);
    await advanceAndTick(600_000);
    await advanceAndTick(600_000);

    expect(run.status).toBe("running");
    expect(h.events.filter((e) => e.type === "run:error")).toHaveLength(0);
    expect(h.events.filter((e) => e.type === "tool:error")).toHaveLength(0);

    // Sanity: once the tool ends, the next idle tick kills as usual —
    // the deferral was load-bearing, not a permanent exemption.
    h.manager.noteToolEnd(RUN_ID, TOOL_CALL_ID);
    await advanceAndTick(95_000);
    expect(run.status).toBe("error");
  });

  test("when no tool exceeded its budget but idle still tripped, reason is the generic idle string", async () => {
    // Setup: NO inflight tools at all. Deferral never engages. The kill
    // reason should be the generic "no activity for Ns" string, not a
    // tool-specific one.
    const h = makeHarness();
    const run = startRun(h);

    await advanceAndTick(95_000);

    expect(run.status).toBe("error");
    const runError = h.events.find((e) => e.type === "run:error")!;
    const data = runError.data as AgentEvents["run:error"];
    expect(data.error).toMatch(/Watchdog: no activity for \d+s/);
    expect(data.error).not.toMatch(/exceeded.*call timeout/i);
    // No tool:error — there are no inflight entries to fan out for.
    expect(h.events.filter((e) => e.type === "tool:error")).toHaveLength(0);
  });
});

describe("Watchdog tool:error fan-out on kill (AC3)", () => {
  test("emits tool:error for each in-flight tool BEFORE run:error, with the exact wire shape", async () => {
    const h = makeHarness();
    const run = startRun(h);

    // Two inflight tools, both will exceed their budgets before we kill.
    h.manager.noteToolStart(RUN_ID, "tc-a", info({
      toolName: "img__generate",
      extensionId: "openai-image-gen-2",
      callTimeoutMs: 30_000,
      cardType: "image-card",
      cardLayout: "dock",
    }));
    h.manager.noteToolStart(RUN_ID, "tc-b", info({
      toolName: "img__edit",
      extensionId: "openai-image-gen-2",
      callTimeoutMs: 30_000,
      // No cardType / cardLayout — verify they're omitted (not undefined) on the wire.
    }));

    // Drive past tool budgets, then past idle threshold from start.
    await advanceAndTick(35_000); // both tools expired, deferral lifts; idleMs=35s, no kill
    await advanceAndTick(65_000); // total=100s, idleMs=65s, no kill
    await advanceAndTick(30_000); // total=130s, idleMs=95s ≥ 90s → KILL

    expect(run.status).toBe("error");

    // Two tool:error events plus one run:error.
    const toolErrors = h.events.filter((e) => e.type === "tool:error");
    const runErrors = h.events.filter((e) => e.type === "run:error");
    expect(toolErrors).toHaveLength(2);
    expect(runErrors).toHaveLength(1);

    // Order: every tool:error MUST land before run:error. The chat
    // renders tool-error cards inline; run:error is the terminal banner.
    const firstRunErrorIndex = h.events.findIndex((e) => e.type === "run:error");
    const lastToolErrorIndex = h.events.map((e) => e.type).lastIndexOf("tool:error");
    expect(lastToolErrorIndex).toBeLessThan(firstRunErrorIndex);

    // Per-event payload shape — must match AgentEvents["tool:error"] exactly.
    const byInvocation = new Map<string, AgentEvents["tool:error"]>(
      toolErrors.map((e) => {
        const d = e.data as AgentEvents["tool:error"];
        return [d.invocationId!, d];
      }),
    );

    const a = byInvocation.get("tc-a")!;
    expect(a.conversationId).toBe(CONV_ID);
    expect(a.extensionId).toBe("openai-image-gen-2");
    expect(a.toolName).toBe("img__generate");
    expect(a.invocationId).toBe("tc-a");
    expect(a.cardType).toBe("image-card");
    expect(a.cardLayout).toBe("dock");
    expect(typeof a.duration).toBe("number");
    expect(a.duration).toBeGreaterThan(0);
    expect(a.error).toMatch(/exceeded.*call timeout/i);

    const b = byInvocation.get("tc-b")!;
    expect(b.toolName).toBe("img__edit");
    // cardType/cardLayout MUST be absent (not undefined) when not provided.
    // Important wire-cleanliness contract: undefined keys serialize to
    // explicit undefined in some serializers and break the chat client's
    // strict-shape assumptions.
    expect("cardType" in b).toBe(false);
    expect("cardLayout" in b).toBe(false);

    // run:error reason matches whichever tool was checked first — both
    // exceeded the same budget, so we just check it carries the
    // exceeded-budget shape rather than which specific tool name.
    const runErrorData = runErrors[0]!.data as AgentEvents["run:error"];
    expect(runErrorData.conversationId).toBe(CONV_ID);
    expect(runErrorData.error).toMatch(/exceeded.*call timeout/i);
  });

  test("aborts the in-flight controller after kill so awaiters unblock, then reaps the map entry", async () => {
    const h = makeHarness();
    startRun(h);
    // Capture the controller reference BEFORE the trip: the map-hygiene
    // trip branch now deletes controllers/activeAgents/runConversations
    // after aborting (a wedged run may never reach finalizeCleanup), so
    // post-trip the map no longer holds it — but the captured controller
    // must still be aborted so awaiters unblock.
    const controller = h.controllers.get(RUN_ID)!;
    h.manager.noteToolStart(RUN_ID, TOOL_CALL_ID, info({ callTimeoutMs: 10_000 }));

    await advanceAndTick(15_000); // past budget
    await advanceAndTick(95_000); // past idle

    expect(controller.signal.aborted).toBe(true);
    expect(h.controllers.has(RUN_ID)).toBe(false);
  });
});

describe("Watchdog pendingPermissions deferral regression (AC5)", () => {
  test("a pending permission gate defers the idle kill — even with NO inflight tools tracked", async () => {
    // This locks in the AC5 regression contract: the deferralReason()
    // refactor must keep the original pendingPermissions behavior intact.
    // If anyone later inlines the helper or removes the permission branch,
    // this test fails.
    const h = makeHarness();
    const run = startRun(h);
    h.pendingPermissions.set("perm-1", { conversationId: CONV_ID });

    await advanceAndTick(95_000);

    expect(run.status).toBe("running");
    expect(h.events.find((e) => e.type === "run:error")).toBeUndefined();
  });

  test("clearing the permission gate (and no tools) lets the next idle window kill", async () => {
    const h = makeHarness();
    const run = startRun(h);
    h.pendingPermissions.set("perm-1", { conversationId: CONV_ID });

    await advanceAndTick(80_000); // defer engaged, bumpActivity refreshed at t=80s
    h.pendingPermissions.delete("perm-1");

    // Idle clock starts from the last bump at 80s. Need 90s more to
    // trip → 170s total.
    await advanceAndTick(95_000); // t=175s, idleMs=95s, no inflight, no perm → KILL
    expect(run.status).toBe("error");
  });

  test("permission gate scoped to a different conversation does NOT defer this run", async () => {
    const h = makeHarness();
    const run = startRun(h);
    // Permission belongs to a different conversation — must not affect us.
    h.pendingPermissions.set("perm-other", { conversationId: "conv-other" });

    await advanceAndTick(95_000);
    expect(run.status).toBe("error");
  });
});

// ── Per-run permission deferral ────────────────────────────────────────
//
// A conversation can host two concurrent runs (the send route has no
// active-run check; the goal evaluator re-enters streamChat). Matching a
// pending gate on `conversationId` alone therefore let run A's open
// consent card suppress run B's idle kill for as long as the card stood —
// unbounded, because a gate has no time budget of its own. Gates that
// carry a `runId` now match only their own run; gates from paths with no
// run to attribute (extension tool executor, workflow host) keep the
// historical conversation-wide match.

describe("Watchdog permission deferral is per-run when the gate names one", () => {
  test("a gate stamped with THIS run's id still defers", async () => {
    const h = makeHarness();
    const run = startRun(h);
    h.pendingPermissions.set("perm-1", { conversationId: CONV_ID, runId: RUN_ID });

    await advanceAndTick(95_000);

    expect(run.status).toBe("running");
    expect(h.events.find((e) => e.type === "run:error")).toBeUndefined();
  });

  test("a SIBLING run's gate in the same conversation does NOT shield this run", async () => {
    const h = makeHarness();
    const run = startRun(h);
    // Same conversation, different run — the exact shape that used to
    // park run B behind run A's unanswered card.
    h.pendingPermissions.set("perm-sibling", {
      conversationId: CONV_ID,
      runId: "run-sibling",
    });

    await advanceAndTick(95_000);
    expect(run.status).toBe("error");
  });

  test("a gate with NO runId keeps the conversation-scoped match", async () => {
    const h = makeHarness();
    const run = startRun(h);
    // The extension / workflow paths leave runId unset on purpose.
    h.pendingPermissions.set("perm-unattributed", { conversationId: CONV_ID });

    await advanceAndTick(95_000);
    expect(run.status).toBe("running");
  });
});

// ── Model-aware idle window (reasoning models) ─────────────────────────
//
// The watchdog widens its idle-kill ceiling for reasoning models, keyed
// off the intrinsic `model.reasoning` flag + the agent's `thinkingLevel`
// reachable on host.activeAgents.get(runId).state. Non-reasoning runs
// keep the tight 90s window. Defaults: reasoning→300s, high/xhigh→900s.

/** Minimal fake pi-agent Agent exposing what resolveIdleThreshold reads
 *  (state.model.reasoning + state.thinkingLevel) plus the abort() the kill
 *  path invokes on activeAgents. */
function fakeAgent(reasoning: boolean, thinkingLevel: string): { state: unknown; abort: () => void } {
  return { state: { model: { reasoning }, thinkingLevel }, abort: () => {} };
}

describe("Watchdog model-aware idle window (reasoning models)", () => {
  test("non-reasoning model is killed at the tight 90s window (regression guard)", async () => {
    const h = makeHarness();
    h.host.activeAgents.set(RUN_ID, fakeAgent(false, "off") as never);
    const run = startRun(h);

    await advanceAndTick(95_000); // > 90s, < 300s
    expect(run.status).toBe("error");
  });

  test("reasoning + medium stays alive past 90s and is killed only after 300s", async () => {
    const h = makeHarness();
    h.host.activeAgents.set(RUN_ID, fakeAgent(true, "medium") as never);
    const run = startRun(h);

    await advanceAndTick(120_000); // past the 90s non-reasoning window
    expect(run.status).toBe("running");

    await advanceAndTick(190_000); // total 310s ≥ 300s → KILL
    expect(run.status).toBe("error");
    const runError = h.events.find((e) => e.type === "run:error")!;
    // Generic idle reason, with the real elapsed seconds.
    expect((runError.data as AgentEvents["run:error"]).error).toMatch(
      /Watchdog: no activity for \d+s/,
    );
  });

  test("reasoning + high gets the widest 900s window", async () => {
    const h = makeHarness();
    h.host.activeAgents.set(RUN_ID, fakeAgent(true, "high") as never);
    const run = startRun(h);

    await advanceAndTick(310_000); // past the 300s medium window
    expect(run.status).toBe("running");

    await advanceAndTick(600_000); // total 910s ≥ 900s → KILL
    expect(run.status).toBe("error");
  });

  test("reasoning + xhigh is treated like high (widest window)", async () => {
    const h = makeHarness();
    h.host.activeAgents.set(RUN_ID, fakeAgent(true, "xhigh") as never);
    const run = startRun(h);

    await advanceAndTick(310_000);
    expect(run.status).toBe("running"); // would have died at 300s if mis-tiered
  });

  test("missing activeAgents entry falls back to the 90s window (no crash, no widen)", async () => {
    const h = makeHarness();
    // No agent registered for RUN_ID — resolveIdleThreshold must default.
    const run = startRun(h);

    await advanceAndTick(95_000);
    expect(run.status).toBe("error");
  });
});

// ── Deferral logging + heartbeat cadence ───────────────────────────────
//
// A suspended Ez client tool defers for up to its 5-minute budget. At one
// log line per 15s tick that was ~22 identical "Watchdog deferred" lines
// per call, times every concurrent panel user — the events that matter
// (entry, exit, trip) drowned in the tail. The deferral now logs on state
// CHANGE only. The heartbeat write in the same branch deliberately stays
// per-tick; the test below pins that so an "optimization" has to argue
// with the stuck-run banner first.

const deferEntries = () => logLines.filter((l) => l.msg === "Watchdog deferring");
const deferExits = () => logLines.filter((l) => l.msg === "Watchdog deferral ended");

describe("Watchdog deferral logging (one line per state change)", () => {
  test("a long deferral logs ONE entry line, not one per tick", async () => {
    const h = makeHarness();
    const run = startRun(h);
    h.manager.noteToolStart(RUN_ID, TOOL_CALL_ID, info({
      toolName: "read_page",
      callTimeoutMs: 330_000,
    }));

    // 20 ticks of deferral — the whole Ez client-tool gate window.
    for (let i = 0; i < 20; i++) await advanceAndTick(15_000);

    expect(run.status).toBe("running");
    expect(deferEntries()).toHaveLength(1);
    expect(deferEntries()[0]!.fields.reason).toBe("tool read_page in flight");
    expect(deferEntries()[0]!.fields.runId).toBe(RUN_ID);
    // Still deferring → no exit line yet.
    expect(deferExits()).toHaveLength(0);
  });

  test("the exit line fires once when the deferral lifts, carrying how long it held", async () => {
    const h = makeHarness();
    startRun(h);
    h.manager.noteToolStart(RUN_ID, TOOL_CALL_ID, info({ callTimeoutMs: 330_000 }));

    await advanceAndTick(15_000); // enter the deferral (t+15s)
    await advanceAndTick(15_000);
    await advanceAndTick(15_000); // t+45s, still deferring
    h.manager.noteToolEnd(RUN_ID, TOOL_CALL_ID);
    await advanceAndTick(15_000); // t+60s — tool gone, deferral lifts

    expect(deferEntries()).toHaveLength(1);
    expect(deferExits()).toHaveLength(1);
    // Held from the first deferring tick (t+15s) to the lift (t+60s).
    expect(deferExits()[0]!.fields.deferredMs).toBe(45_000);
    expect(deferExits()[0]!.fields.reason).toBe("tool ext__op in flight");

    // Re-entry logs again — the state machine resets, it isn't "once ever".
    h.manager.noteToolStart(RUN_ID, "tc-2", info({ callTimeoutMs: 330_000, startedAt: fakeNow }));
    await advanceAndTick(15_000);
    expect(deferEntries()).toHaveLength(2);
  });

  test("a CHANGE of deferral cause logs a second entry line", async () => {
    // Permission gate first (deferralReason checks it first), then a tool
    // in flight. Two genuinely different states → two lines.
    const h = makeHarness();
    startRun(h);
    h.pendingPermissions.set("perm-1", { conversationId: CONV_ID });

    await advanceAndTick(15_000);
    expect(deferEntries()).toHaveLength(1);
    expect(deferEntries()[0]!.fields.reason).toBe("pending permission");

    h.pendingPermissions.delete("perm-1");
    h.manager.noteToolStart(RUN_ID, TOOL_CALL_ID, info({ startedAt: fakeNow, callTimeoutMs: 330_000 }));
    await advanceAndTick(15_000);

    expect(deferEntries()).toHaveLength(2);
    expect(deferEntries()[1]!.fields.reason).toBe("tool ext__op in flight");
    // The cause changed, it never lifted — so no exit line.
    expect(deferExits()).toHaveLength(0);
  });

  test("the exit line lands BEFORE the trip when the budget lapses into a kill", async () => {
    const h = makeHarness();
    const run = startRun(h);
    h.manager.noteToolStart(RUN_ID, TOOL_CALL_ID, info({ callTimeoutMs: 30_000 }));

    await advanceAndTick(15_000); // deferring
    // Past the budget, then past the idle window, so the same run both
    // exits the deferral and trips.
    for (let i = 0; i < 10 && run.status === "running"; i++) await advanceAndTick(15_000);

    expect(run.status).toBe("error");
    const exitIdx = logLines.findIndex((l) => l.msg === "Watchdog deferral ended");
    const tripIdx = logLines.findIndex((l) => l.msg === "Watchdog tripped, interrupting run");
    expect(exitIdx).toBeGreaterThanOrEqual(0);
    expect(tripIdx).toBeGreaterThan(exitIdx);
    // On-call reads "held Ns, then tripped" — the duration is the point.
    // The 30s budget spans exactly two ticks: the first (t+15s) defers and
    // starts the clock, the second (t+30s) finds the budget spent and
    // lifts, so the hold is one tick.
    expect(deferExits()[0]!.fields.deferredMs).toBe(15_000);
  });

  test("teardown clears the deferral state, so a reused runId logs its entry again", async () => {
    const h = makeHarness();
    startRun(h);
    h.manager.noteToolStart(RUN_ID, TOOL_CALL_ID, info({ callTimeoutMs: 330_000 }));
    await advanceAndTick(15_000);
    expect(deferEntries()).toHaveLength(1);

    h.manager.clearRun(RUN_ID);
    // Same id, fresh run + fresh watchdog cycle.
    const run2 = makeRun(RUN_ID, fakeNow);
    h.runs.set(RUN_ID, run2);
    h.manager.startWatchdog(RUN_ID, CONV_ID, () => "");
    h.manager.noteToolStart(RUN_ID, TOOL_CALL_ID, info({ startedAt: fakeNow, callTimeoutMs: 330_000 }));
    await advanceAndTick(15_000);

    expect(deferEntries()).toHaveLength(2);
  });

  test("the heartbeat write stays PER TICK while deferring (stuck-run banner depends on it)", async () => {
    // Deliberate cost: `active_runs.last_heartbeat` feeds `stalenessMs` on
    // GET /active-run, and the chat shows "this run may be stuck" at 30s.
    // Throttling this write to HEARTBEAT_REFRESH_MS (30s) would let
    // staleness reach ~45s and flash that banner at a user whose client
    // tool is merely still waiting on the panel.
    const h = makeHarness();
    startRun(h);
    h.manager.noteToolStart(RUN_ID, TOOL_CALL_ID, info({ callTimeoutMs: 330_000 }));

    for (let i = 0; i < 6; i++) await advanceAndTick(15_000);

    // One write per deferring tick — 6 ticks, 6 writes (a 30s throttle
    // would have produced 3).
    expect(heartbeatWrites.filter((id) => id === RUN_ID)).toHaveLength(6);
  });
});

// ── Worst-case hold (the table in docs/features/chat/runs-lifecycle.md) ─

describe("Worst-case hold for a wedged tool call", () => {
  /** Drive 15s ticks until the run trips; return the elapsed fake ms.
   *  `thinking` selects the model-aware idle window via a fake Agent. */
  async function timeToKill(
    callTimeoutMs: number,
    thinking?: "medium" | "high",
  ): Promise<number> {
    const h = makeHarness();
    const startedAt = fakeNow;
    if (thinking) h.host.activeAgents.set(RUN_ID, fakeAgent(true, thinking) as never);
    const run = startRun(h);
    h.manager.noteToolStart(RUN_ID, TOOL_CALL_ID, info({ callTimeoutMs, startedAt }));
    for (let i = 0; i < 200 && run.status === "running"; i++) {
      await advanceAndTick(15_000);
    }
    expect(run.status).toBe("error");
    return fakeNow - startedAt;
  }

  test("a 330s budget (the Ez client tools) holds a non-reasoning run for 405s", async () => {
    // Pins the published number instead of trusting arithmetic. The
    // deferral bumps activity every tick, so the kill is the LAST DEFERRING
    // TICK plus a whole idle window — not `startedAt + callTimeoutMs`.
    // 330s budget → last defer at 315s → +90s idle → trip at 405s, i.e.
    // budget + idle MINUS one tick when the call starts on a tick boundary.
    expect(await timeToKill(330_000)).toBe(405_000);
    // The doc's bound: budget + idle ± one tick, whatever the phase.
    expect(405_000).toBeGreaterThanOrEqual(330_000 + 90_000 - 15_000);
    expect(405_000).toBeLessThan(330_000 + 90_000 + 15_000);
  });

  test("the pre-fix 90s budget killed the same run at 165s — the left column of that table", async () => {
    // The bug, reproduced: an Ez client tool on the undeclared default died
    // at 165s, well inside the gate's own 300s, so the gate's concrete
    // "Timed out waiting for Ez client tool result" could never fire.
    expect(await timeToKill(DEFAULT_BUILTIN_CALL_TIMEOUT_MS)).toBe(165_000);
  });

  test("the reasoning rows of the table hold too (wider idle window, same shape)", async () => {
    // Every remaining cell of the published table, measured. The reasoning
    // tiers cost the most because the idle window — not the budget — is the
    // dominant term.
    expect(await timeToKill(330_000, "medium")).toBe(615_000);
    expect(await timeToKill(DEFAULT_BUILTIN_CALL_TIMEOUT_MS, "medium")).toBe(375_000);
    expect(await timeToKill(330_000, "high")).toBe(1_215_000);
    expect(await timeToKill(DEFAULT_BUILTIN_CALL_TIMEOUT_MS, "high")).toBe(975_000);
  });
});

// ── Constants ──────────────────────────────────────────────────────────

describe("Public constants", () => {
  test("DEFAULT_BUILTIN_CALL_TIMEOUT_MS is exported as a positive number", () => {
    expect(typeof DEFAULT_BUILTIN_CALL_TIMEOUT_MS).toBe("number");
    expect(DEFAULT_BUILTIN_CALL_TIMEOUT_MS).toBeGreaterThan(0);
    // Sanity: the watchdog's own idle threshold is 90s; the per-tool
    // default must be sensible on the same order of magnitude (not
    // microseconds, not days).
    expect(DEFAULT_BUILTIN_CALL_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
    expect(DEFAULT_BUILTIN_CALL_TIMEOUT_MS).toBeLessThanOrEqual(600_000);
  });
});

// ── Lifecycle ──────────────────────────────────────────────────────────

describe("Watchdog tick lifecycle interactions", () => {
  test("startWatchdog with persist=false is a no-op (no interval registered, no inflight ever observed)", () => {
    const h = makeHarness();
    (h.host as { persist: boolean }).persist = false;
    const run = makeRun(RUN_ID, fakeNow);
    h.runs.set(RUN_ID, run);
    h.controllers.set(RUN_ID, new AbortController());

    h.manager.startWatchdog(RUN_ID, CONV_ID, () => "");
    expect(capturedTicks).toHaveLength(0);
  });

  test("tick is a no-op when the run has already left 'running' status", async () => {
    const h = makeHarness();
    const run = startRun(h);
    run.status = "success"; // simulate completion before the tick fires

    await advanceAndTick(95_000);

    expect(h.events).toHaveLength(0);
  });
});
