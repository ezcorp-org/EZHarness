/**
 * Integration test for Phase 2 of the "stuck chat" fix.
 *
 * Exercises the REAL WatchdogManager trip branch + the REAL
 * `persistErrorMessage` helper (via the same per-run closure the
 * executor wires at `startWatchdog`) + the REAL `finalizeError`'s shared
 * idempotency guard, over a mocked DB.
 *
 * Proves the end-to-end Defect-2 contract:
 *   A1 — a hung tool → watchdog kills → ONE assistant message is
 *        persisted to the conversation with non-empty error text
 *        (the chat shows the failure, not a frozen "thinking" bubble).
 *   A2 — `runs.status=error` (finalizeRunRow) AND
 *        `active_runs=interrupted` (markInterrupted) in the same tick.
 *   A3 — the suspended `streamChat` await then unblocks and
 *        `finalizeError` runs → it sees the shared slot already claimed
 *        and persists NO second message (exactly one bubble per run).
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

// ── Mocked DB sinks (must precede SUT import) ──────────────────────────

interface CreatedMessage {
  conversationId: string;
  role: string;
  content: string;
  runId?: string;
}
const createdMessages: CreatedMessage[] = [];
const finalizeRunRowCalls: Array<{ runId: string; status: string; error?: string }> = [];
const markInterruptedCalls: string[] = [];

mock.module("../db/queries/conversations", () => ({
  createMessage: async (
    conversationId: string,
    data: { role: string; content: string; runId?: string },
  ) => {
    const msg = {
      id: `msg-${createdMessages.length + 1}`,
      conversationId,
      role: data.role,
      content: data.content,
      runId: data.runId,
    };
    createdMessages.push(msg);
    return msg;
  },
}));

// persistErrorMessage also re-anchors tool_calls via getDb().update(...).
// A chainable no-op stand-in keeps the helper's happy path intact.
const chainNoop = {
  update: () => chainNoop,
  set: () => chainNoop,
  where: async () => undefined,
};
mock.module("../db/connection", () => ({
  getDb: () => chainNoop,
}));

mock.module("../db/queries/active-runs", () => ({
  updateHeartbeat: async () => {},
  updatePartialResponse: async () => {},
  markInterrupted: async (id: string) => {
    markInterruptedCalls.push(id);
  },
  cleanupOrphanedRuns: async () => 0,
  interruptAllRuns: async () => 0,
  getActiveRun: async () => null,
}));
mock.module("../db/queries/runs", () => ({
  finalizeRunRow: async (runId: string, status: string, error?: string) => {
    finalizeRunRowCalls.push({ runId, status, error });
    return 1;
  },
  terminalizeOrphanedRuns: async () => 0,
  updateRun: async () => {},
}));

import {
  WatchdogManager,
  type WatchdogHost,
  type WatchdogPersistError,
} from "../runtime/executor-watchdog";
import { persistErrorMessage } from "../runtime/executor-helpers";
import { finalizeError } from "../runtime/stream-chat/finalize";
import { EventBus } from "../runtime/events";
import type { AgentEvents, AgentRun } from "../types";
import type { StreamChatHost } from "../runtime/stream-chat/host";
import type { StreamChatContext } from "../runtime/stream-chat/context";

// ── Fake clock + setInterval capture ───────────────────────────────────

let originalSetInterval: typeof setInterval;
let originalDateNow: () => number;
let fakeNow = 0;
let capturedTicks: Array<() => void> = [];

beforeEach(() => {
  originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((fn: (...a: unknown[]) => void) => {
    capturedTicks.push(() => fn());
    return 0 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  originalDateNow = Date.now;
  fakeNow = 1_000_000;
  Date.now = () => fakeNow;
  capturedTicks = [];
  createdMessages.length = 0;
  finalizeRunRowCalls.length = 0;
  markInterruptedCalls.length = 0;
});

afterEach(() => {
  globalThis.setInterval = originalSetInterval;
  Date.now = originalDateNow;
  capturedTicks = [];
});

async function advanceAndTick(deltaMs: number): Promise<void> {
  fakeNow += deltaMs;
  for (const fn of capturedTicks) fn();
  for (let i = 0; i < 4; i++) {
    await new Promise<void>((r) => queueMicrotask(r));
  }
}

const RUN_ID = "run-vis-1";
const CONV_ID = "conv-vis-1";

function makeRun(): AgentRun {
  return { id: RUN_ID, agentName: "chat", status: "running", startedAt: fakeNow, logs: [] };
}

describe("Phase 2 integration: watchdog kill → exactly one visible assistant error", () => {
  test("hung tool → watchdog persists ONE error message; runs=error + active_runs=interrupted; later finalizeError adds no duplicate", async () => {
    const bus = new EventBus<AgentEvents>();
    const runErrors: string[] = [];
    bus.on("run:error", (d) => runErrors.push((d as { error: string }).error));

    const runs = new Map<string, AgentRun>();
    const controllers = new Map<string, AbortController>();
    const errorMessagePersisted = new Set<string>();
    const run = makeRun();
    runs.set(RUN_ID, run);
    controllers.set(RUN_ID, new AbortController());

    const watchdogHost: WatchdogHost = {
      runs,
      controllers,
      activeAgents: new Map(),
      runConversations: new Map([[RUN_ID, CONV_ID]]),
      pendingPermissions: new Map(),
      bus,
      persist: true,
      errorMessagePersisted,
    };
    const watchdog = new WatchdogManager(watchdogHost);

    // The per-run persistError closure — EXACTLY the shape executor.ts
    // wires: it forwards to the real persistErrorMessage helper.
    const persistError: WatchdogPersistError = async (convId, errorContent) => {
      await persistErrorMessage(
        convId,
        errorContent,
        { model: "claude-x", provider: "anthropic", parentMessageId: undefined },
        RUN_ID,
        true,
      );
    };

    watchdog.startWatchdog(RUN_ID, CONV_ID, () => "", persistError);

    // A hung tool in flight — exactly the create_extension stall shape.
    watchdog.noteToolStart(RUN_ID, "tc-1", {
      toolName: "extension-author__create_extension",
      conversationId: CONV_ID,
      extensionId: "extension-author",
      startedAt: fakeNow,
      callTimeoutMs: 30_000,
    });

    // Tool blows its 30s budget, then the idle window trips the kill.
    await advanceAndTick(35_000);
    await advanceAndTick(95_000);

    // A1 — exactly one assistant message, non-empty error text.
    expect(run.status).toBe("error");
    const assistantMsgs = createdMessages.filter((m) => m.role === "assistant");
    expect(assistantMsgs).toHaveLength(1);
    expect(assistantMsgs[0]!.conversationId).toBe(CONV_ID);
    expect(assistantMsgs[0]!.content.length).toBeGreaterThan(0);
    expect(assistantMsgs[0]!.content).toContain(
      "extension-author__create_extension",
    );
    expect(assistantMsgs[0]!.content).toMatch(/exceeded.*call timeout/i);
    expect(assistantMsgs[0]!.runId).toBe(RUN_ID);

    // A2 — both terminal-state writes happened in the kill tick.
    expect(finalizeRunRowCalls).toHaveLength(1);
    expect(finalizeRunRowCalls[0]!.status).toBe("error");
    expect(markInterruptedCalls).toEqual([RUN_ID]);
    expect(runErrors).toHaveLength(1);

    // The shared slot is claimed → a later finalize must skip.
    expect(errorMessagePersisted.has(RUN_ID)).toBe(true);

    // A3 — the wedged await unblocks; the REAL finalizeError runs with
    // the SHARED host (same errorMessagePersisted set). It must NOT
    // persist a second assistant message.
    const streamHost = {
      bus,
      persist: true,
      pendingPermissions: new Map(),
      controllers,
      runConversations: watchdogHost.runConversations,
      activeAgents: new Map(),
      runs,
      watchdog,
      errorMessagePersisted, // SAME reference the watchdog claimed
      stateMediator: undefined,
      spawnQuota: {} as unknown,
      executor: {} as unknown,
      permissionEngine: {} as unknown,
    } as unknown as StreamChatHost;

    const ctx = {
      run,
      lastSavedMessageId: null,
      allTurnsText: "",
      turnText: "",
      dbQueue: Promise.resolve(),
      turnStart: fakeNow,
      totalUsage: { input: 0, output: 0 },
    } as unknown as StreamChatContext;

    await finalizeError(
      ctx,
      streamHost,
      CONV_ID,
      { model: "claude-x", provider: "anthropic" },
      new Error("Tool extension-author__create_extension exceeded its 30000ms call timeout"),
    );

    // STILL exactly one assistant message — finalizeError saw the slot
    // claimed by the watchdog and skipped its persistErrorMessage.
    const after = createdMessages.filter((m) => m.role === "assistant");
    expect(after).toHaveLength(1);
  });

  test("if finalizeError runs FIRST (no watchdog), the watchdog trip later adds no duplicate either", async () => {
    const bus = new EventBus<AgentEvents>();
    const runs = new Map<string, AgentRun>();
    const controllers = new Map<string, AbortController>();
    const errorMessagePersisted = new Set<string>();
    const run = makeRun();
    runs.set(RUN_ID, run);
    controllers.set(RUN_ID, new AbortController());

    const watchdogHost: WatchdogHost = {
      runs,
      controllers,
      activeAgents: new Map(),
      runConversations: new Map([[RUN_ID, CONV_ID]]),
      pendingPermissions: new Map(),
      bus,
      persist: true,
      errorMessagePersisted,
    };
    const watchdog = new WatchdogManager(watchdogHost);

    const streamHost = {
      bus,
      persist: true,
      pendingPermissions: new Map(),
      controllers,
      runConversations: watchdogHost.runConversations,
      activeAgents: new Map(),
      runs,
      watchdog,
      errorMessagePersisted,
      stateMediator: undefined,
      spawnQuota: {} as unknown,
      executor: {} as unknown,
      permissionEngine: {} as unknown,
    } as unknown as StreamChatHost;
    const ctx = {
      run,
      lastSavedMessageId: null,
      allTurnsText: "",
      turnText: "",
      dbQueue: Promise.resolve(),
      turnStart: fakeNow,
      totalUsage: { input: 0, output: 0 },
    } as unknown as StreamChatContext;

    // finalizeError wins the race first.
    await finalizeError(
      ctx,
      streamHost,
      CONV_ID,
      { model: "m", provider: "p" },
      new Error("boom from the normal error path"),
    );
    expect(
      createdMessages.filter((m) => m.role === "assistant"),
    ).toHaveLength(1);
    expect(errorMessagePersisted.has(RUN_ID)).toBe(true);

    // The run is now terminal (finalizeError set status=error). The
    // watchdog tick correctly early-returns for a non-"running" run, so
    // it neither persists a second message nor re-emits run:error — the
    // run already finalized cleanly through the normal path. We start
    // the watchdog and advance well past the idle window to prove it
    // stays a no-op (no duplicate bubble, no throw).
    const runErrors: string[] = [];
    bus.on("run:error", () => runErrors.push("x"));
    watchdog.startWatchdog(
      RUN_ID,
      CONV_ID,
      () => "",
      async (convId, errorContent) =>
        persistErrorMessage(convId, errorContent, {}, RUN_ID, true),
    );
    await advanceAndTick(95_000);

    expect(run.status).toBe("error");
    // No duplicate assistant message; watchdog stayed a no-op on the
    // already-finalized run; the slot remains claimed.
    expect(
      createdMessages.filter((m) => m.role === "assistant"),
    ).toHaveLength(1);
    expect(runErrors).toHaveLength(0);
    expect(errorMessagePersisted.has(RUN_ID)).toBe(true);
  });
});
