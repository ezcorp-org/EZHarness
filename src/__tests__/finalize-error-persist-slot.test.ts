/**
 * Unit tests for the `claimErrorPersistSlot` idempotency guard on the
 * TWO finalize branches the existing `watchdog-visible-error.integration`
 * suite leaves uncovered:
 *
 *   - `finalizeError` with a `ProviderUnavailableError`
 *     (`finalize.ts` provider-unavailable branch).
 *   - `finalizeSetupError` (the setup-phase safety net).
 *
 * Contract (Locked decision 3 — exactly ONE visible error bubble per run):
 *   B1 — slot UNclaimed → `persistErrorMessage` runs exactly once AND
 *        `run:error` is emitted.
 *   B2 — slot PRE-claimed (a watchdog trip / earlier finalize already
 *        wrote the bubble) → `persistErrorMessage` is NOT called, but
 *        `run:error` is STILL emitted (the rendering path is unchanged).
 *
 * Style mirrors `executor-watchdog-persist-error.test.ts` /
 * `watchdog-visible-error.integration.test.ts`: a focused unit test with
 * the DB sinks mocked via `mock.module` (declared before the SUT import)
 * so the REAL `finalizeError` / `finalizeSetupError` + the REAL
 * `persistErrorMessage` helper run, only the leaf DB writes are stubbed.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
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
const updateRunCalls: Array<{ id: string; status: string }> = [];
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

// persistErrorMessage / finalizeCleanup also re-anchor tool_calls via
// getDb().update(...). A chainable no-op keeps the happy path intact.
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
  deleteActiveRun: async () => {},
}));
mock.module("../db/queries/runs", () => ({
  finalizeRunRow: async () => 1,
  terminalizeOrphanedRuns: async () => 0,
  updateRun: async (run: { id: string; status: string }) => {
    updateRunCalls.push({ id: run.id, status: run.status });
  },
}));

import { ProviderUnavailableError } from "../providers/router";
import {
  finalizeError,
  finalizeSetupError,
} from "../runtime/stream-chat/finalize";
import { EventBus } from "../runtime/events";
import type { AgentEvents, AgentRun } from "../types";
import type { StreamChatHost } from "../runtime/stream-chat/host";
import type { StreamChatContext } from "../runtime/stream-chat/context";

// ── Harness ────────────────────────────────────────────────────────────

const RUN_ID = "run-fin-1";
const CONV_ID = "conv-fin-1";

function makeRun(status: AgentRun["status"] = "running"): AgentRun {
  return { id: RUN_ID, agentName: "chat", status, startedAt: 1_000, logs: [] };
}

interface Harness {
  host: StreamChatHost;
  bus: EventBus<AgentEvents>;
  errorMessagePersisted: Set<string>;
  runErrors: string[];
}

function makeHarness(): Harness {
  const bus = new EventBus<AgentEvents>();
  const runErrors: string[] = [];
  bus.on("run:error", (d) => runErrors.push((d as { error: string }).error));
  const errorMessagePersisted = new Set<string>();
  const controllers = new Map<string, AbortController>();
  controllers.set(RUN_ID, new AbortController());
  const host = {
    bus,
    persist: true,
    pendingPermissions: new Map(),
    controllers,
    runConversations: new Map([[RUN_ID, CONV_ID]]),
    activeAgents: new Map(),
    runs: new Map(),
    watchdog: { clearRun: () => {} },
    errorMessagePersisted,
    stateMediator: undefined,
    spawnQuota: {} as unknown,
    executor: {} as unknown,
    permissionEngine: {} as unknown,
  } as unknown as StreamChatHost;
  return { host, bus, errorMessagePersisted, runErrors };
}

function makeCtx(run: AgentRun): StreamChatContext {
  return {
    run,
    lastSavedMessageId: null,
    allTurnsText: "",
    turnText: "",
    dbQueue: Promise.resolve(),
    turnStart: 1_000,
    totalUsage: { input: 0, output: 0 },
  } as unknown as StreamChatContext;
}

beforeEach(() => {
  createdMessages.length = 0;
  updateRunCalls.length = 0;
  markInterruptedCalls.length = 0;
});

const provErr = () =>
  new ProviderUnavailableError(
    "all providers down",
    "anthropic",
    "claude-x",
    null,
  );

// ── finalizeError(ProviderUnavailableError) ────────────────────────────

describe("finalizeError ProviderUnavailableError persist-slot idempotency", () => {
  test("B1 slot UNclaimed → exactly one persisted message + run:error", async () => {
    const h = makeHarness();
    const run = makeRun();

    await finalizeError(
      makeCtx(run),
      h.host,
      CONV_ID,
      { model: "claude-x", provider: "anthropic" },
      provErr(),
    );

    expect(run.status).toBe("error");
    const assistant = createdMessages.filter((m) => m.role === "assistant");
    expect(assistant).toHaveLength(1);
    // structured provider_unavailable payload, not the flat-Error path.
    expect(assistant[0]!.content).toContain("provider_unavailable");
    expect(assistant[0]!.content).toContain("anthropic");
    expect(assistant[0]!.runId).toBe(RUN_ID);
    expect(h.errorMessagePersisted.has(RUN_ID)).toBe(true);
    expect(h.runErrors).toHaveLength(1);
    expect(h.runErrors[0]).toContain("provider_unavailable");
  });

  test("B2 slot PRE-claimed → NO persist, run:error STILL emitted", async () => {
    const h = makeHarness();
    // A watchdog trip (or an earlier finalize) already wrote the bubble.
    h.errorMessagePersisted.add(RUN_ID);
    const run = makeRun();

    await finalizeError(
      makeCtx(run),
      h.host,
      CONV_ID,
      { model: "claude-x", provider: "anthropic" },
      provErr(),
    );

    expect(run.status).toBe("error");
    // No duplicate bubble — the slot was taken.
    expect(createdMessages.filter((m) => m.role === "assistant")).toHaveLength(
      0,
    );
    // Rendering path unchanged: run:error still fires.
    expect(h.runErrors).toHaveLength(1);
    expect(h.runErrors[0]).toContain("provider_unavailable");
  });
});

// ── finalizeSetupError ─────────────────────────────────────────────────

describe("finalizeSetupError persist-slot idempotency", () => {
  test("B1 slot UNclaimed → exactly one persisted message + run:error", async () => {
    const h = makeHarness();
    const run = makeRun("running");

    await finalizeSetupError(
      makeCtx(run),
      h.host,
      CONV_ID,
      { model: "m", provider: "p" },
      new Error("credential resolution failed"),
    );

    expect(run.status).toBe("error");
    const assistant = createdMessages.filter((m) => m.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.content).toContain("credential resolution failed");
    expect(assistant[0]!.runId).toBe(RUN_ID);
    expect(h.errorMessagePersisted.has(RUN_ID)).toBe(true);
    expect(h.runErrors).toHaveLength(1);
    // Setup-error path still aborts the controller + tidies active_runs.
    expect(h.host.controllers.has(RUN_ID)).toBe(false);
    expect(markInterruptedCalls).toEqual([RUN_ID]);
  });

  test("B2 slot PRE-claimed → NO persist, run:error STILL emitted, still aborts", async () => {
    const h = makeHarness();
    h.errorMessagePersisted.add(RUN_ID);
    const ctrl = h.host.controllers.get(RUN_ID)!;
    const run = makeRun("running");

    await finalizeSetupError(
      makeCtx(run),
      h.host,
      CONV_ID,
      { model: "m", provider: "p" },
      new Error("oauth flow blew up"),
    );

    expect(run.status).toBe("error");
    expect(createdMessages.filter((m) => m.role === "assistant")).toHaveLength(
      0,
    );
    expect(h.runErrors).toHaveLength(1);
    // The abort/cleanup tail is independent of the persist guard.
    expect(ctrl.signal.aborted).toBe(true);
    expect(h.host.controllers.has(RUN_ID)).toBe(false);
    expect(markInterruptedCalls).toEqual([RUN_ID]);
  });

  test("non-running run → finalizeSetupError skips persist + run:error entirely", async () => {
    const h = makeHarness();
    // streamChat already terminalised this run; the setup safety-net must
    // not double-write or re-emit.
    const run = makeRun("error");

    await finalizeSetupError(
      makeCtx(run),
      h.host,
      CONV_ID,
      { model: "m", provider: "p" },
      new Error("late setup error"),
    );

    expect(createdMessages).toHaveLength(0);
    expect(h.runErrors).toHaveLength(0);
    expect(h.errorMessagePersisted.has(RUN_ID)).toBe(false);
  });
});
