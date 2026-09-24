/**
 * The watchdog's kill reason says when the host slept.
 *
 * A laptop lid close freezes the process (or the Colima/Podman VM it runs
 * in); on wake the timers catch up, the idle clock has jumped by the whole
 * sleep, and the run trips at once. The bare "no activity for 600s" reads
 * like a hung model, so the reason names the sleep instead.
 *
 *   S1 — a tick gap far past WATCHDOG_TICK_MS that makes up most of the idle
 *        time → reason mentions the sleep and how long.
 *   S2 — ordinary idling (ticks on time) → the reason is unchanged.
 *   S3 — a sleep followed by real activity is forgotten: a later genuine
 *        idle trip does not blame the sleep.
 *
 * Same fake-clock + setInterval-capture harness as
 * executor-watchdog-persist-error.test.ts.
 */

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

let _interrupts = 0;
let repair: () => Promise<number> = async () => 0;
mock.module("../db/queries/active-runs", () => ({
  updateHeartbeat: async () => {},
  updatePartialResponse: async () => {},
  markInterrupted: async () => {},
  cleanupOrphanedRuns: async () => 0,
  interruptAllRuns: async () => { _interrupts++; return 0; },
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
} from "../runtime/executor-watchdog";
import { EventBus } from "../runtime/events";
import type { AgentEvents, AgentRun } from "../types";

// ── Fake clock + setInterval capture ───────────────────────────────────

let originalSetInterval: typeof setInterval;
let originalDateNow: () => number;
let fakeNow = 0;
let capturedTicks: Array<() => void> = [];

beforeEach(() => {
  _interrupts = 0;
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
function start(h: Harness): { run: AgentRun; persisted: string[] } {
  const persisted: string[] = [];
  const run = makeRun(RUN_ID, fakeNow);
  h.runs.set(RUN_ID, run);
  h.controllers.set(RUN_ID, new AbortController());
  h.manager.startWatchdog(RUN_ID, CONV_ID, () => "", async (_c, content) => { persisted.push(content); });
  return { run, persisted };
}

test("S1: a trip right after the host slept names the sleep", async () => {
  const h = makeHarness();
  const { run, persisted } = start(h);
  await advanceAndTick(15_000);
  // Lid closed for ten minutes: the next tick lands 600s later.
  await advanceAndTick(600_000);
  expect(run.status).toBe("error");
  const error = run.result?.error ?? "";
  expect(error).toContain("no activity for 615s");
  expect(error).toContain("asleep or suspended for about 10 min");
  expect(persisted).toEqual([`Error: ${error}`]);
  h.manager.destroy();
});

test("S2: ordinary idling keeps the plain reason", async () => {
  const h = makeHarness();
  const { run } = start(h);
  for (let i = 0; i < 7 && run.status === "running"; i++) await advanceAndTick(15_000);
  expect(run.status).toBe("error");
  expect(run.result?.error).toBe("Watchdog: no activity for 90s");
  h.manager.destroy();
});

test("S3: activity after waking clears the sleep from the reason", async () => {
  const h = makeHarness();
  const { run } = start(h);
  await advanceAndTick(15_000);
  await advanceAndTick(60_000); // a short sleep, under the idle window
  expect(run.status).toBe("running");
  h.manager.bumpActivity(RUN_ID);
  for (let i = 0; i < 7 && run.status === "running"; i++) await advanceAndTick(15_000);
  expect(run.status).toBe("error");
  expect(run.result?.error).toBe("Watchdog: no activity for 90s");
  h.manager.destroy();
});
