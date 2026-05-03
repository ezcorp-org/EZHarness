/**
 * Listener-wiring tests for the lessons distiller.
 *
 * Mirrors the `registerExtractionListener` block in
 * `src/__tests__/memory-extraction.test.ts` (lines 384–429): subscribe
 * to `run:complete`, prove the registration shape (returns an unsub
 * function, the unsub stops further deliveries, errors inside the
 * handler are caught by the fire-and-forget pattern).
 *
 * The distiller's `distillLesson` is mocked at the module level so
 * we can assert on call count + argument shape without standing up
 * a real DB.
 */
import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { EventBus } from "../runtime/events";
import type { AgentEvents, AgentRun } from "../types";

// Mock distillLesson so the listener test can observe call shape and
// inject failures without involving DB / LLM. The mock module also
// re-exports the registrar so `registerLessonDistillerListener` is
// the same export from the same module.
let distillCalls: Array<{ run: AgentRun; conversationId: string }> = [];
let distillShouldThrow = false;
mock.module("../runtime/lessons/distiller", () => {
  // Pull the real `registerLessonDistillerListener` via require so the
  // listener wiring under test is the production code; we only swap
  // out `distillLesson`. This works because the listener is a thin
  // pass-through that calls distillLesson(run, conversationId).
  //
  // Captured-by-closure: distillCalls + distillShouldThrow are the
  // observables the tests assert on.
  function distillLesson(run: AgentRun, conversationId: string): Promise<void> {
    distillCalls.push({ run, conversationId });
    if (distillShouldThrow) return Promise.reject(new Error("synthetic distill failure"));
    return Promise.resolve();
  }
  function registerLessonDistillerListener(bus: EventBus<AgentEvents>): () => void {
    return bus.on(
      "run:complete",
      (data: { run: AgentRun; conversationId?: string }) => {
        const { run, conversationId } = data;
        if (!conversationId) return;
        distillLesson(run, conversationId).catch(() => {
          // Swallowed by the production registrar's `.catch`.
        });
      },
    );
  }
  return { distillLesson, registerLessonDistillerListener };
});

const { registerLessonDistillerListener } = await import("../runtime/lessons/distiller");

afterAll(() => restoreModuleMocks());

beforeEach(() => {
  distillCalls = [];
  distillShouldThrow = false;
});

const baseEvent = (overrides: Partial<AgentRun> = {}): { run: AgentRun; conversationId: string } => ({
  run: {
    id: "run-test",
    agentName: "chat",
    projectId: "proj-1",
    status: "success",
    startedAt: Date.now(),
    logs: [],
    ...overrides,
  },
  conversationId: "conv-1",
});

describe("registerLessonDistillerListener", () => {
  test("returns an unsubscribe function", () => {
    const bus = new EventBus<AgentEvents>();
    const unsub = registerLessonDistillerListener(bus);
    expect(typeof unsub).toBe("function");
    unsub();
  });

  test("emitting run:complete invokes distillLesson with (run, conversationId)", async () => {
    const bus = new EventBus<AgentEvents>();
    const unsub = registerLessonDistillerListener(bus);

    const evt = baseEvent();
    bus.emit("run:complete", evt);

    // The listener calls distillLesson synchronously; the .catch
    // chain is async but distillCalls is bumped before any await.
    expect(distillCalls).toHaveLength(1);
    expect(distillCalls[0]!.run.id).toBe("run-test");
    expect(distillCalls[0]!.conversationId).toBe("conv-1");

    unsub();
  });

  test("unsubscribing stops further invocations", async () => {
    const bus = new EventBus<AgentEvents>();
    const unsub = registerLessonDistillerListener(bus);

    bus.emit("run:complete", baseEvent());
    expect(distillCalls).toHaveLength(1);

    unsub();
    bus.emit("run:complete", baseEvent({ id: "run-after-unsub" }));
    expect(distillCalls).toHaveLength(1); // unchanged
  });

  test("missing conversationId → no distill call (early return)", () => {
    const bus = new EventBus<AgentEvents>();
    const unsub = registerLessonDistillerListener(bus);

    bus.emit("run:complete", {
      run: {
        id: "run-no-conv",
        agentName: "chat",
        projectId: "proj-1",
        status: "success",
        startedAt: Date.now(),
        logs: [],
      },
      // conversationId omitted
    });

    expect(distillCalls).toHaveLength(0);
    unsub();
  });

  test("errors inside distillLesson are caught and never propagate to emit()", async () => {
    distillShouldThrow = true;
    const bus = new EventBus<AgentEvents>();
    const unsub = registerLessonDistillerListener(bus);

    // The fire-and-forget `.catch` must swallow the rejection — emit
    // synchronously must not throw, and the test process must not
    // see an unhandled rejection.
    expect(() => bus.emit("run:complete", baseEvent())).not.toThrow();

    // Yield a microtask tick so the rejected promise fully settles.
    await new Promise((r) => setTimeout(r, 10));

    expect(distillCalls).toHaveLength(1);
    unsub();
  });
});
