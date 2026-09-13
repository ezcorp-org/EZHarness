import { expect, test } from "bun:test";
import { compileFactory } from "./compiler";
import { referenceCodeV1 } from "./references.js";
import { advanceKernel, createKernelState, FactoryKernelError } from "./kernel";
import type { CompiledFactory, FactoryDefinition, FactoryNode, KernelState } from "./index";

const digest = "sha256:fefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefe";
const runner = { package: "inert", version: "1", digest, export: "run" } as const;
const string = { type: "string" } as const;

function compiled(nodes: readonly FactoryNode[], runDeadlineMs?: number): CompiledFactory {
  const definition: FactoryDefinition = {
    schemaVersion: "factory.v1", id: "coverage-regression", version: "1", interpreterCompatibility: "1", inputPorts: {}, outputPorts: {},
    graph: { nodes, outputs: {} }, acceptance: referenceCodeV1.acceptance,
    packages: [...referenceCodeV1.packages, { name: runner.package, version: runner.version, digest }], capabilities: [], effects: ["none"],
    bounds: { maxExpandedNodes: 100, maxScopeDepth: 16, ...(runDeadlineMs === undefined ? {} : { runDeadlineMs }) },
  };
  const result = compileFactory(definition);
  if (!result.ok) throw new Error(result.diagnostics.map((diagnostic) => `${diagnostic.code}:${diagnostic.nodeId ?? "definition"}`).join(", "));
  return result.factory;
}

function start(factory: CompiledFactory, id: string): KernelState {
  return advanceKernel(factory, createKernelState(factory, id, {}, 0), { kind: "start", id: `${id}:start`, atMs: 0 }).nextState;
}

function admit(factory: CompiledFactory, state: KernelState, nodeId: string, atMs = 0): KernelState {
  const attempt = state.nodes[nodeId]?.attempts.at(-1);
  if (!attempt) throw new Error(`missing admission for ${nodeId}`);
  return advanceKernel(factory, state, { kind: "admission-result", id: `${nodeId}:admit`, atMs, nodeId, commandId: attempt.commandId, candidateGeneration: attempt.candidateGeneration, granted: true }).nextState;
}

test("run deadline and invalid scoped instance or timestamp events are fenced", () => {
  const factory = compiled([{ id: "work", kind: "task", runner }]);
  const state = start(factory, "deadline-fence");
  const runTimer = state.runTimerId;
  if (!runTimer) throw new Error("missing run deadline timer");
  const unknown = advanceKernel(factory, state, { kind: "node-result", id: "unknown-instance", atMs: 1, nodeId: "work/not-a-scope", commandId: "forged", candidateGeneration: 0, attempt: 1, output: {} });
  expect(unknown.nextState.nodes.work?.status).toBe("reserved");
  expect(() => advanceKernel(factory, unknown.nextState, { kind: "start", id: "bad-time", atMs: -1 })).toThrow(FactoryKernelError);
  const expired = advanceKernel(factory, unknown.nextState, { kind: "timer-expired", id: "run-expired", atMs: unknown.nextState.runDeadlineAtMs, commandId: runTimer });
  expect(expired.nextState.status).toBe("stopping");
  expect(expired.nextState.stopReason).toBe("RUN_DEADLINE_EXPIRED");
  expect(expired.commands).toContainEqual(expect.objectContaining({ kind: "cancel-node", nodeId: "work" }));
});

test("a standalone zero-input all join completes with its intrinsic empty winners record", () => {
  const factory = compiled([{ id: "join", kind: "join", mode: "all", predecessors: [] }]);
  const state = start(factory, "empty-all-join");
  expect(state.status).toBe("completed");
  expect(state.nodes.join?.output).toEqual({ winners: [] });
});

test("a loop budget exact bound permits settlement but prevents a following iteration", () => {
  const loop: Extract<FactoryNode, { kind: "loop" }> = {
    id: "loop", kind: "loop", initialInput: { kind: "literal", value: "seed" }, carriedSchema: string,
    resultSchema: { type: "object", properties: { result: string }, required: ["result"], additionalProperties: false }, outputPorts: { result: string },
    body: { nodes: [{ id: "work", kind: "task", runner, outputPorts: { result: string } }], outputs: { result: { kind: "ref", root: "node", name: "work", path: ["result"] } } },
    until: { kind: "literal", value: false }, nextInput: { kind: "literal", value: "seed" }, maxIterations: 2, maxElapsedMs: 1_000, budget: { maxCostMicros: "5" }, onExhausted: "fail",
  };
  const factory = compiled([loop]);
  let state = start(factory, "budget-exact");
  state = admit(factory, state, "loop/items/0/work");
  const attempt = state.nodes["loop/items/0/work"]!.attempts.at(-1)!;
  state = advanceKernel(factory, state, { kind: "usage-settled", id: "exact-cost", atMs: 1, nodeId: "loop/items/0/work", commandId: attempt.commandId, candidateGeneration: attempt.candidateGeneration, attempt: attempt.attempt, revision: 1, knownCostMicros: "5" }).nextState;
  expect(state.nodes.loop?.loop?.spentCostMicros).toBe("5");
  const result = advanceKernel(factory, state, { kind: "node-result", id: "first-result", atMs: 2, nodeId: "loop/items/0/work", commandId: attempt.commandId, candidateGeneration: attempt.candidateGeneration, attempt: attempt.attempt, output: { result: "again" } });
  expect(result.nextState.status).toBe("failed");
  expect(result.nextState.stopReason).toBe("LOOP_BUDGET_EXHAUSTED");
  expect(result.nextState.nodes["loop/items/1/work"]).toBeUndefined();
});

test("a max-length external result fails before it can become a graph output", () => {
  const factory = compiled([{ id: "work", kind: "task", runner, retry: { maxAttempts: 1, initialDelayMs: 0, maximumDelayMs: 0 }, outputPorts: { payload: { type: "string", maxLength: 2 } } }]);
  let state = start(factory, "payload-bound");
  state = admit(factory, state, "work");
  const attempt = state.nodes.work!.attempts.at(-1)!;
  const invalid = advanceKernel(factory, state, { kind: "node-result", id: "overlong", atMs: 1, nodeId: "work", commandId: attempt.commandId, candidateGeneration: attempt.candidateGeneration, attempt: attempt.attempt, output: { payload: "too-long" } });
  expect(invalid.nextState.nodes.work?.status).toBe("stopping");
  expect(invalid.nextState.nodes.work?.error).toBe("OUTPUT_INVALID");
});

test("a delayed ordinary result at the run deadline cannot complete active work", () => {
  const factory = compiled([{ id: "work", kind: "task", runner, outputPorts: { result: string } }]);
  let state = start(factory, "ordinary-at-run-deadline");
  state = admit(factory, state, "work");
  const attempt = state.nodes.work!.attempts.at(-1)!;
  const delayed = advanceKernel(factory, state, {
    kind: "node-result", id: "delayed-result", atMs: state.runDeadlineAtMs, nodeId: "work", commandId: attempt.commandId,
    candidateGeneration: attempt.candidateGeneration, attempt: attempt.attempt, output: { result: "late" },
  });
  expect(delayed.nextState.stopReason).toBe("RUN_DEADLINE_EXPIRED");
  expect(delayed.nextState.nodes.work?.status).toBe("stopping");
  expect(delayed.nextState.nodes.work?.output).toBeUndefined();
  expect(delayed.commands).toContainEqual(expect.objectContaining({ kind: "cancel-node", nodeId: "work" }));
});

test("usage beyond a loop budget stops the active scope immediately", () => {
  const loop: Extract<FactoryNode, { kind: "loop" }> = {
    id: "loop", kind: "loop", initialInput: { kind: "literal", value: "seed" }, carriedSchema: string,
    resultSchema: { type: "object", properties: { result: string }, required: ["result"], additionalProperties: false }, outputPorts: { result: string },
    body: { nodes: [{ id: "work", kind: "task", runner, outputPorts: { result: string } }], outputs: { result: { kind: "ref", root: "node", name: "work", path: ["result"] } } },
    until: { kind: "literal", value: false }, nextInput: { kind: "literal", value: "seed" }, maxIterations: 2, maxElapsedMs: 1_000, budget: { maxCostMicros: "5" }, onExhausted: "fail",
  };
  const factory = compiled([loop]);
  let state = start(factory, "budget-over");
  state = admit(factory, state, "loop/items/0/work");
  const attempt = state.nodes["loop/items/0/work"]!.attempts.at(-1)!;
  const settled = advanceKernel(factory, state, {
    kind: "usage-settled", id: "over-cost", atMs: 1, nodeId: "loop/items/0/work", commandId: attempt.commandId,
    candidateGeneration: attempt.candidateGeneration, attempt: attempt.attempt, revision: 1, knownCostMicros: "6",
  });
  expect(settled.nextState.nodes.loop?.loop?.spentCostMicros).toBe("6");
  expect(settled.nextState.stopReason).toBe("LOOP_BUDGET_EXHAUSTED");
  expect(settled.nextState.nodes["loop/items/0/work"]?.status).toBe("stopping");
  expect(settled.commands).toContainEqual(expect.objectContaining({ kind: "cancel-node", nodeId: "loop/items/0/work" }));
});

test("an unrequested stopped callback fences a late completion without fabricating a retry", () => {
  const factory = compiled([{ id: "work", kind: "task", runner, outputPorts: { result: string } }]);
  let state = start(factory, "normal-stop");
  state = admit(factory, state, "work");
  const attempt = state.nodes.work!.attempts.at(-1)!;
  const stopped = advanceKernel(factory, state, {
    kind: "attempt-stopped", id: "normal-stop", atMs: 1, nodeId: "work", commandId: attempt.commandId,
    candidateGeneration: attempt.candidateGeneration, attempt: attempt.attempt,
  });
  expect(stopped.nextState.nodes.work?.status).toBe("running");
  expect(stopped.nextState.nodes.work?.attempts.at(-1)?.stopped).toBe(true);
  expect(stopped.commands).toEqual([]);
  const late = advanceKernel(factory, stopped.nextState, {
    kind: "node-result", id: "late-result", atMs: 2, nodeId: "work", commandId: attempt.commandId,
    candidateGeneration: attempt.candidateGeneration, attempt: attempt.attempt, output: { result: "late" },
  });
  expect(late.nextState.nodes.work?.output).toBeUndefined();
  expect(late.commands).toEqual([]);
});
