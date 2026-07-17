import { test, expect, describe, spyOn, afterEach } from "bun:test";
import {
  isTerminalStatus,
  extractStructuredOutput,
  buildSpawnInput,
  makeSpawnDispatcher,
  type AssignmentUpdate,
  type DispatchOptions,
  type SpawnFn,
  type SubscribeFn,
  type DelayFn,
} from "./agent";
import {
  __resetChannelForTests,
  getChannel,
  type HostChannel,
  type SpawnAssignmentHandle,
  type SpawnAssignmentInput,
} from "@ezcorp/sdk/runtime";

const opts = (over: Partial<DispatchOptions> = {}): DispatchOptions => ({
  role: "reviewer",
  prompt: "review this",
  cwd: "/wt",
  jsonSchema: { type: "object" },
  ...over,
});

const update = (over: Partial<AssignmentUpdate> & { id: string; status: string }): AssignmentUpdate => ({
  assignment: { id: over.id, status: over.status, resultPreview: over.assignment?.resultPreview },
  resultFull: over.resultFull,
  structuredResult: over.structuredResult,
  structuredResultError: over.structuredResultError,
});

const handle = (assignmentId: string): SpawnAssignmentHandle => ({
  subConversationId: "sub",
  agentRunId: "run",
  taskId: "task",
  assignmentId,
});

// ── pure helpers ────────────────────────────────────────────────────

describe("isTerminalStatus", () => {
  test("completed/failed terminal; running not", () => {
    expect(isTerminalStatus("completed")).toBe(true);
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("running")).toBe(false);
  });
});

describe("extractStructuredOutput", () => {
  test("structuredResult present → output = it, text = resultFull", () => {
    const r = extractStructuredOutput({
      assignment: { id: "a", status: "completed" },
      resultFull: "full",
      structuredResult: { findings: [] },
    });
    expect(r.output).toEqual({ findings: [] });
    expect(r.text).toBe("full");
  });
  test("no structuredResult → output null, text falls back to preview then ''", () => {
    expect(
      extractStructuredOutput({ assignment: { id: "a", status: "completed", resultPreview: "p" } }),
    ).toEqual({ output: null, text: "p" });
    expect(extractStructuredOutput({ assignment: { id: "a", status: "completed" } })).toEqual({
      output: null,
      text: "",
    });
  });
});

describe("buildSpawnInput", () => {
  test("task carries steering + cwd + prompt; title names the role; schema forwarded", () => {
    const input = buildSpawnInput(opts({ agentName: "code-reviewer" }), "/tmp/ev");
    expect(input.task).toContain("Workspace boundary");
    expect(input.task).toContain("/tmp/ev");
    expect(input.task).toContain("git worktree at: /wt");
    expect(input.task).toContain("review this");
    expect(input.title).toBe("ez-code-factory: reviewer");
    expect(input.agentName).toBe("code-reviewer");
    expect(input.outputSchema).toEqual({ type: "object" });
  });
  test("defaults agentName to 'default' and omits outputSchema when no schema", () => {
    const input = buildSpawnInput(opts({ agentName: undefined, jsonSchema: undefined }), "/tmp/ev");
    expect(input.agentName).toBe("default");
    expect(input.outputSchema).toBeUndefined();
  });
});

// ── dispatcher (injected fakes) ─────────────────────────────────────

/** Wire a dispatcher whose seams the test controls. `delay` never resolves by
 *  default so the terminal update always wins the race. */
function harness(over: { delay?: DelayFn; spawn?: SpawnFn } = {}) {
  const spawnCalls: SpawnAssignmentInput[] = [];
  let subscribeCount = 0;
  let captured: ((u: AssignmentUpdate) => void) | null = null;
  const spawn: SpawnFn =
    over.spawn ??
    (async (input) => {
      spawnCalls.push(input);
      return handle(`asg-${spawnCalls.length}`);
    });
  const subscribe: SubscribeFn = (h) => {
    subscribeCount++;
    captured = h;
  };
  const delay: DelayFn = over.delay ?? (() => new Promise<void>(() => {}));
  const dispatcher = makeSpawnDispatcher({ evidenceDir: "/tmp/ev", spawn, subscribe, delay });
  return {
    dispatcher,
    spawnCalls,
    get subscribeCount() {
      return subscribeCount;
    },
    fire(u: AssignmentUpdate) {
      captured!(u);
    },
  };
}

/** Yield so the dispatch's `await spawn(...)` + pending registration run. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("makeSpawnDispatcher", () => {
  test("resolves with structured output on a completed terminal update", async () => {
    const h = harness();
    const p = h.dispatcher.dispatch(opts());
    await tick();
    h.fire(update({ id: "asg-1", status: "completed", structuredResult: { ok: true } }));
    expect(await p).toEqual({ output: { ok: true }, text: "" });
  });

  test("ignores non-terminal + foreign-id updates before the matching terminal", async () => {
    const h = harness();
    const p = h.dispatcher.dispatch(opts());
    await tick();
    h.fire(update({ id: "asg-1", status: "running" })); // non-terminal → ignored
    h.fire(update({ id: "other", status: "completed" })); // foreign id → ignored
    h.fire({ assignment: { id: 123 as unknown as string, status: "completed" } }); // non-string id
    h.fire(update({ id: "asg-1", status: "completed", resultFull: "done" }));
    expect(await p).toEqual({ output: null, text: "done" });
  });

  test("rejects on a failed terminal update", async () => {
    const h = harness();
    const p = h.dispatcher.dispatch(opts());
    await tick();
    h.fire(update({ id: "asg-1", status: "failed", resultFull: "boom" }));
    await expect(p).rejects.toThrow("agent run failed (reviewer): boom");
  });

  test("rejects on timeout when delay wins the race", async () => {
    const h = harness({ delay: () => Promise.resolve() });
    await expect(h.dispatcher.dispatch(opts())).rejects.toThrow("timed out");
  });

  test("cancels the pending timeout timer once a terminal update wins", async () => {
    let capturedSignal: AbortSignal | undefined;
    // A delay that never resolves on its own — only cancellation clears it.
    const delay: DelayFn = (_ms, signal) => {
      capturedSignal = signal;
      return new Promise<void>(() => {});
    };
    const h = harness({ delay });
    const p = h.dispatcher.dispatch(opts());
    await tick();
    expect(capturedSignal!.aborted).toBe(false); // still pending mid-dispatch
    h.fire(update({ id: "asg-1", status: "completed", structuredResult: { ok: true } }));
    expect(await p).toEqual({ output: { ok: true }, text: "" });
    // The terminal update won, so the dispatch aborted the timeout timer.
    expect(capturedSignal!.aborted).toBe(true);
  });

  test("subscribes exactly once across multiple dispatches", async () => {
    const h = harness();
    const p1 = h.dispatcher.dispatch(opts());
    const p2 = h.dispatcher.dispatch(opts({ role: "fixer" }));
    await tick();
    h.fire(update({ id: "asg-1", status: "completed", structuredResult: 1 }));
    h.fire(update({ id: "asg-2", status: "completed", structuredResult: 2 }));
    expect(await p1).toEqual({ output: 1, text: "" });
    expect(await p2).toEqual({ output: 2, text: "" });
    expect(h.subscribeCount).toBe(1);
    expect(h.spawnCalls).toHaveLength(2);
  });

  test("failed terminal with no detail still rejects", async () => {
    const h = harness();
    const p = h.dispatcher.dispatch(opts());
    await tick();
    h.fire(update({ id: "asg-1", status: "failed" }));
    await expect(p).rejects.toThrow("no detail");
  });
});

// ── production defaults driven through a stubbed channel ────────────

describe("production seams (default spawn / subscribe / delay)", () => {
  afterEach(() => __resetChannelForTests());

  test("dispatch wires spawnAssignment + registerEventHandler and resolves on a delivered update", async () => {
    __resetChannelForTests();
    const ch = getChannel() as HostChannel;
    // spawnAssignment → request("ezcorp/spawn-assignment", …)
    spyOn(ch, "request").mockImplementation((async (_method: string, params: unknown) => {
      expect((params as { task: string }).task).toContain("git worktree at:");
      return {
        v: 1,
        subConversationId: "s",
        agentRunId: "r",
        taskId: "t",
        assignmentId: "asg-real",
      };
    }) as HostChannel["request"]);
    // registerEventHandler → onRequest("ezcorp/event/task:assignment_update", wrapped)
    let deliver: ((params: unknown) => Promise<unknown>) | null = null;
    spyOn(ch, "onRequest").mockImplementation(((method: string, handler: (p: unknown) => Promise<unknown>) => {
      if (method === "ezcorp/event/task:assignment_update") deliver = handler;
    }) as HostChannel["onRequest"]);

    // No seams injected → uses defaultSpawn / defaultSubscribe / defaultDelay.
    const dispatcher = makeSpawnDispatcher({ evidenceDir: "/tmp/ev", timeoutMs: 5000 });
    const p = dispatcher.dispatch(opts());
    await tick();
    expect(deliver).not.toBeNull();
    await deliver!({
      assignment: { id: "asg-real", status: "completed" },
      structuredResult: { ok: 1 },
    });
    expect(await p).toEqual({ output: { ok: 1 }, text: "" });
  });
});
