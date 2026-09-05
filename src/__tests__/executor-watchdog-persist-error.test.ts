/**
 * Unit tests for Phase 2 of the "stuck chat" fix: the watchdog-trip
 * branch persists EXACTLY ONE visible assistant error message, and it is
 * idempotent vs. a later finalize path (no duplicate bubble).
 *
 * Contract (Locked decision 3):
 *   P1 — on a watchdog kill the trip branch invokes the per-run
 *        persistError callback ONCE, with the run's conversationId and
 *        the kill reason text.
 *   P2 — the trip branch claims the SHARED `errorMessagePersisted` slot
 *        synchronously, so a finalize path running afterwards sees the
 *        run id already claimed and DOES NOT add a duplicate.
 *   P3 — when persist=false OR no persistError callback was supplied,
 *        the trip branch still emits run:error (no regression) and
 *        writes no message.
 *   P4 — clearRun releases the shared slot (no unbounded growth / clean
 *        slate for a reused run id).
 *
 * Same fake-clock + setInterval-capture strategy as
 * executor-watchdog-inflight-tools.test.ts.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

let interrupts = 0;
let repair: () => Promise<number> = async () => 0;
mock.module("../db/queries/active-runs", () => ({
  updateHeartbeat: async () => {},
  updatePartialResponse: async () => {},
  markInterrupted: async () => {},
  cleanupOrphanedRuns: async () => 0,
  interruptAllRuns: async () => { interrupts++; return 0; },
  getActiveRun: async () => null,
}));
let finalize: () => Promise<number> = async () => 1;
mock.module("../db/queries/runs", () => ({
  finalizeRunRow: () => finalize(),
  terminalizeOrphanedRuns: () => repair(),
}));

import {
  WatchdogManager,
  type WatchdogHost,
  type WatchdogPersistError,
} from "../runtime/executor-watchdog";
import { EventBus } from "../runtime/events";
import type { AgentEvents, AgentRun } from "../types";

// ── Fake clock + setInterval capture ───────────────────────────────────

let originalSetInterval: typeof setInterval;
let originalDateNow: () => number;
let fakeNow = 0;
let capturedTicks: Array<() => void> = [];

beforeEach(() => {
  interrupts = 0;
  repair = async () => 0;
  finalize = async () => 1;
  originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((fn: (...args: unknown[]) => void) => {
    capturedTicks.push(() => fn());
    return 0 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  originalDateNow = Date.now;
  fakeNow = 1_000_000;
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
  // A second drain so the fire-and-forget persistError().catch() chain
  // (promise → .catch) settles before assertions.
  await new Promise<void>((r) => queueMicrotask(r));
}

// ── Harness ────────────────────────────────────────────────────────────

function makeRun(id: string, startedAt: number): AgentRun {
  return { id, agentName: "chat", status: "running", startedAt, logs: [] };
}

interface PersistCall {
  conversationId: string;
  errorContent: string;
}

interface Harness {
  manager: WatchdogManager;
  host: WatchdogHost;
  runs: Map<string, AgentRun>;
  controllers: Map<string, AbortController>;
  activeAgents: Map<string, { abort: () => void }>;
  runConversations: Map<string, string>;
  errorMessagePersisted: Set<string>;
  persistCalls: PersistCall[];
  events: Array<{ type: string }>;
}

function makeHarness(): Harness {
  const bus = new EventBus<AgentEvents>();
  const events: Array<{ type: string }> = [];
  for (const t of ["run:error", "tool:error"] as const) {
    bus.on(t, () => events.push({ type: t }));
  }
  const runs = new Map<string, AgentRun>();
  const controllers = new Map<string, AbortController>();
  const activeAgents = new Map<string, { abort: () => void }>();
  const runConversations = new Map<string, string>();
  const errorMessagePersisted = new Set<string>();
  const host: WatchdogHost = {
    runs,
    controllers,
    activeAgents: activeAgents as WatchdogHost["activeAgents"],
    runConversations,
    pendingPermissions: new Map(),
    bus,
    persist: true,
    errorMessagePersisted,
  };
  return {
    manager: new WatchdogManager(host),
    host,
    runs,
    controllers,
    activeAgents,
    runConversations,
    errorMessagePersisted,
    persistCalls: [],
    events,
  };
}

const RUN_ID = "run-1";
const CONV_ID = "conv-1";

test("startup active cleanup waits for terminal repair and does not run after repair failure", async () => {
  const harness = makeHarness();
  let finish!: (count: number) => void;
  repair = () => new Promise<number>((resolve) => { finish = resolve; });
  harness.manager.startOrphanCleanup();
  expect(interrupts).toBe(0);
  finish(0);
  await advanceAndTick(0);
  expect(interrupts).toBe(1);
  harness.manager.destroy();
  const failed = makeHarness();
  repair = async () => { throw new Error("repair transaction failed"); };
  failed.manager.startOrphanCleanup();
  await advanceAndTick(0);
  expect(interrupts).toBe(1);
  failed.manager.destroy();
});

test("watchdog aborts immediately but terminal notification waits for durable success", async () => {
  const harness = makeHarness();
  let settle!: (count: number) => void;
  finalize = () => new Promise<number>((resolve) => { settle = resolve; });
  const run = startWithPersist(harness);
  const controller = harness.controllers.get(RUN_ID)!;
  await advanceAndTick(95_000);
  expect(run.status).toBe("error");
  expect(controller.signal.aborted).toBe(true);
  expect(harness.events).toEqual([]);
  settle(1);
  await advanceAndTick(1);
  expect(harness.events).toEqual([{ type: "run:error" }]);
  harness.manager.destroy();
});

test("watchdog never announces a failed durable write", async () => {
  const harness = makeHarness();
  finalize = async () => { throw new Error("transaction failed"); };
  startWithPersist(harness);
  await advanceAndTick(95_000);
  expect(harness.events).toEqual([]);
  harness.manager.destroy();
});

function startWithPersist(
  h: Harness,
  persistError?: WatchdogPersistError,
): AgentRun {
  const run = makeRun(RUN_ID, fakeNow);
  h.runs.set(RUN_ID, run);
  h.controllers.set(RUN_ID, new AbortController());
  h.manager.startWatchdog(RUN_ID, CONV_ID, () => "", persistError);
  return run;
}

const recordingPersist =
  (h: Harness): WatchdogPersistError =>
  async (conversationId, errorContent) => {
    h.persistCalls.push({ conversationId, errorContent });
  };

// ── P1 ─────────────────────────────────────────────────────────────────

describe("watchdog trip persists one visible error (P1)", () => {
  test("trip branch invokes persistError once with the run's conversationId + kill reason", async () => {
    const h = makeHarness();
    const run = startWithPersist(h, recordingPersist(h));

    await advanceAndTick(95_000); // idle kill (no inflight tools)

    expect(run.status).toBe("error");
    expect(h.persistCalls).toHaveLength(1);
    expect(h.persistCalls[0]!.conversationId).toBe(CONV_ID);
    expect(h.persistCalls[0]!.errorContent).toMatch(/^Error: /);
    expect(h.persistCalls[0]!.errorContent).toMatch(
      /Watchdog: no activity for \d+s/,
    );
    // run:error still emitted (rendering path unchanged).
    expect(h.events.filter((e) => e.type === "run:error")).toHaveLength(1);
  });

  test("kill reason text from a blown tool budget is carried into the message", async () => {
    const h = makeHarness();
    const run = startWithPersist(h, recordingPersist(h));
    h.manager.noteToolStart(RUN_ID, "tc", {
      toolName: "extension-author__create_extension",
      conversationId: CONV_ID,
      extensionId: "extension-author",
      startedAt: fakeNow,
      callTimeoutMs: 30_000,
    });

    await advanceAndTick(35_000); // tool over budget, deferral lifts
    await advanceAndTick(95_000); // idle since last bump → KILL

    expect(run.status).toBe("error");
    expect(h.persistCalls).toHaveLength(1);
    expect(h.persistCalls[0]!.errorContent).toContain(
      "extension-author__create_extension",
    );
    expect(h.persistCalls[0]!.errorContent).toMatch(/exceeded.*call timeout/i);
  });
});

// ── P2 (idempotency vs. finalize) ──────────────────────────────────────

describe("trip branch idempotency vs. a later finalize (P2)", () => {
  test("trip claims the shared slot synchronously; a later finalize sees it claimed", async () => {
    const h = makeHarness();
    const run = startWithPersist(h, recordingPersist(h));

    await advanceAndTick(95_000);
    expect(run.status).toBe("error");

    // The shared slot is claimed → claimErrorPersistSlot would return
    // false for a subsequent finalizeError on the same run id.
    expect(h.errorMessagePersisted.has(RUN_ID)).toBe(true);
    expect(h.persistCalls).toHaveLength(1);

    // Simulate finalizeError's guard (claim-then-persist). It must see
    // the slot already claimed and NOT write a second message.
    const finalizeWouldPersist = !h.errorMessagePersisted.has(RUN_ID);
    expect(finalizeWouldPersist).toBe(false);
    expect(h.persistCalls).toHaveLength(1); // still exactly one
  });

  test("a second watchdog tick after the kill does NOT persist again", async () => {
    const h = makeHarness();
    const run = startWithPersist(h, recordingPersist(h));

    await advanceAndTick(95_000);
    expect(run.status).toBe("error");
    expect(h.persistCalls).toHaveLength(1);

    // run.status is now "error" so the tick early-returns; even if it
    // didn't, the slot guard prevents a second persist.
    await advanceAndTick(95_000);
    expect(h.persistCalls).toHaveLength(1);
  });

  test("if the slot is ALREADY claimed (finalize won the race), the trip branch skips persist but still emits run:error", async () => {
    const h = makeHarness();
    // Pre-claim the slot — models a finalizeError that ran first.
    h.errorMessagePersisted.add(RUN_ID);
    const run = startWithPersist(h, recordingPersist(h));

    await advanceAndTick(95_000);

    expect(run.status).toBe("error");
    expect(h.persistCalls).toHaveLength(0); // trip skipped (slot taken)
    expect(h.events.filter((e) => e.type === "run:error")).toHaveLength(1);
  });
});

// ── P3 (no-callback / persist=false → no regression) ───────────────────

describe("no persistError callback / persist off → run:error still fires (P3)", () => {
  test("no persistError supplied → trip emits run:error, writes no message", async () => {
    const h = makeHarness();
    const run = startWithPersist(h /* no persistError */);

    await advanceAndTick(95_000);

    expect(run.status).toBe("error");
    expect(h.persistCalls).toHaveLength(0);
    expect(h.errorMessagePersisted.has(RUN_ID)).toBe(false);
    expect(h.events.filter((e) => e.type === "run:error")).toHaveLength(1);
  });

  test("persist=false → startWatchdog is a no-op (no tick, no persist, no slot)", async () => {
    const h = makeHarness();
    (h.host as { persist: boolean }).persist = false;
    const run = makeRun(RUN_ID, fakeNow);
    h.runs.set(RUN_ID, run);
    h.controllers.set(RUN_ID, new AbortController());
    h.manager.startWatchdog(RUN_ID, CONV_ID, () => "", recordingPersist(h));

    expect(capturedTicks).toHaveLength(0);
    expect(h.persistCalls).toHaveLength(0);
    expect(h.errorMessagePersisted.has(RUN_ID)).toBe(false);
  });
});

// ── P4 (slot lifecycle) ────────────────────────────────────────────────

describe("shared slot lifecycle (P4)", () => {
  test("clearRun releases the shared error-persist slot", async () => {
    const h = makeHarness();
    startWithPersist(h, recordingPersist(h));

    await advanceAndTick(95_000);
    expect(h.errorMessagePersisted.has(RUN_ID)).toBe(true);

    h.manager.clearRun(RUN_ID);
    expect(h.errorMessagePersisted.has(RUN_ID)).toBe(false);
  });

  test("destroy does not throw and the manager can be reused", () => {
    const h = makeHarness();
    startWithPersist(h, recordingPersist(h));
    expect(() => h.manager.destroy()).not.toThrow();
  });

  test("a persistError that REJECTS is caught (fire-and-forget never escapes)", async () => {
    const h = makeHarness();
    const run = startWithPersist(h, async () => {
      throw new Error("db write blew up");
    });

    // The trip branch's `void persistError(...).catch(...)` must swallow
    // the rejection — the kill path completes regardless.
    await advanceAndTick(95_000);

    expect(run.status).toBe("error");
    // Slot is still claimed (we claimed BEFORE the write; a failed write
    // does not un-claim — a duplicate retry would be worse than one
    // missing bubble, and the run:error event still rendered).
    expect(h.errorMessagePersisted.has(RUN_ID)).toBe(true);
    expect(h.events.filter((e) => e.type === "run:error")).toHaveLength(1);
  });
});

// ── Map hygiene: trip reaps in-memory maps for a wedged run ─────────
//
// The watchdog exists because the suspended streamChat await may never
// reach finalizeCleanup (the normal deleter of these maps). The trip
// branch must reap controllers/activeAgents/runConversations + its own
// per-run timer state itself — while PRESERVING the shared
// errorMessagePersisted slot so a late finalizeError can't double-persist.

describe("watchdog trip — in-memory map hygiene", () => {
  test("reaps controllers, activeAgents, runConversations on the kill path", async () => {
    const h = makeHarness();
    const run = startWithPersist(h, recordingPersist(h));
    let aborted = false;
    h.activeAgents.set(RUN_ID, { abort: () => { aborted = true; } });
    h.runConversations.set(RUN_ID, CONV_ID);

    await advanceAndTick(95_000);

    expect(run.status).toBe("error");
    // Live agent aborted, then all three maps cleared so a wedged run
    // no longer leaks for the process lifetime.
    expect(aborted).toBe(true);
    expect(h.controllers.has(RUN_ID)).toBe(false);
    expect(h.activeAgents.has(RUN_ID)).toBe(false);
    expect(h.runConversations.has(RUN_ID)).toBe(false);
  });

  test("PRESERVES the errorMessagePersisted slot so a late finalizeError can't double-persist", async () => {
    const h = makeHarness();
    startWithPersist(h, recordingPersist(h));
    h.runConversations.set(RUN_ID, CONV_ID);

    await advanceAndTick(95_000);

    // Trip claimed + kept the slot (the guard the trip must not release).
    expect(h.errorMessagePersisted.has(RUN_ID)).toBe(true);
    expect(h.persistCalls).toHaveLength(1);
  });

  test("clearRun (healthy teardown) still releases the slot", () => {
    const h = makeHarness();
    startWithPersist(h, recordingPersist(h));
    h.errorMessagePersisted.add(RUN_ID);

    h.manager.clearRun(RUN_ID);

    // The normal finalizeCleanup path releases the slot (unbounded-growth
    // guard) — only the trip path preserves it.
    expect(h.errorMessagePersisted.has(RUN_ID)).toBe(false);
  });
});
