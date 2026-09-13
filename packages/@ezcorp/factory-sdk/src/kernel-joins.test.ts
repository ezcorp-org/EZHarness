import { expect, test } from "bun:test";
import { compileFactory } from "./compiler";
import { advanceKernel, createKernelState } from "./kernel";
import type { CompiledFactory, FactoryDefinition, FactoryNode, KernelState } from "./index";

const digest = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const runner = { package: "inert", version: "1", digest, export: "run" } as const;

function compiled(nodes: readonly FactoryNode[]): CompiledFactory {
  const definition: FactoryDefinition = {
    schemaVersion: "factory.v1", id: "join-regression", version: "1", interpreterCompatibility: "1",
    inputPorts: {}, outputPorts: {}, graph: { nodes, outputs: {} }, acceptance: { id: "none", version: "1", claims: [] },
    packages: [{ name: runner.package, version: runner.version, digest }], capabilities: [], effects: ["none"],
    bounds: { maxExpandedNodes: 100, maxScopeDepth: 16 },
  };
  const result = compileFactory(definition);
  if (!result.ok) throw new Error(result.diagnostics.map((diagnostic) => diagnostic.code).join(", "));
  return result.factory;
}

function start(graph: CompiledFactory, runId: string): KernelState {
  return advanceKernel(graph, createKernelState(graph, runId, {}, 0), { kind: "start", id: `${runId}-start`, atMs: 0 }).nextState;
}

function admit(graph: CompiledFactory, state: KernelState, nodeId: string): KernelState {
  const attempt = state.nodes[nodeId]?.attempts.at(-1);
  if (!attempt) throw new Error(`missing admission for ${nodeId}`);
  return advanceKernel(graph, state, { kind: "admission-result", id: `admit-${nodeId}`, atMs: 0, nodeId, commandId: attempt.commandId, candidateGeneration: attempt.candidateGeneration, granted: true }).nextState;
}

function result(graph: CompiledFactory, state: KernelState, nodeId: string, atMs: number, output: string) {
  const attempt = state.nodes[nodeId]?.attempts.at(-1);
  if (!attempt) throw new Error(`missing dispatch for ${nodeId}`);
  return advanceKernel(graph, state, { kind: "node-result", id: `result-${nodeId}-${atMs}`, atMs, nodeId, commandId: attempt.commandId, candidateGeneration: attempt.candidateGeneration, attempt: attempt.attempt, output });
}

function joinGraph(mode: "any" | "quorum", quorum: number): CompiledFactory {
  return compiled([
    { id: "a", kind: "task", runner },
    { id: "b", kind: "task", runner },
    { id: "c", kind: "task", runner },
    { id: "join", kind: "join", mode, predecessors: ["a", "b", "c"], eligibleOutcomes: ["succeeded"], quorum },
  ]);
}

test("any join selects its first qualified result and cancels each loser before terminal completion", () => {
  const graph = joinGraph("any", 1);
  let state = start(graph, "any-join");
  state = admit(graph, state, "a");
  state = admit(graph, state, "b");
  state = admit(graph, state, "c");
  const winner = result(graph, state, "b", 10, "b-result");

  expect(winner.nextState.nodes.join?.output).toEqual([{ id: "b", output: "b-result" }]);
  expect(winner.nextState.nodes.join?.status).toBe("succeeded");
  expect(winner.nextState.nodes.a?.status).toBe("stopping");
  expect(winner.nextState.nodes.c?.status).toBe("stopping");
  expect(winner.commands.filter((command) => command.kind === "cancel-node").map((command) => command.nodeId)).toEqual(["a", "c"]);
  expect(winner.nextState.status).toBe("stopping");

  const a = winner.nextState.nodes.a!.attempts.at(-1)!;
  const aStopped = advanceKernel(graph, winner.nextState, { kind: "attempt-stopped", id: "a-stopped", atMs: 10, nodeId: "a", commandId: a.commandId, candidateGeneration: a.candidateGeneration, attempt: a.attempt });
  const c = aStopped.nextState.nodes.c!.attempts.at(-1)!;
  const completed = advanceKernel(graph, aStopped.nextState, { kind: "attempt-stopped", id: "c-stopped", atMs: 10, nodeId: "c", commandId: c.commandId, candidateGeneration: c.candidateGeneration, attempt: c.attempt });
  expect(completed.nextState.status).toBe("completed");
  expect(completed.commands).toContainEqual(expect.objectContaining({ kind: "complete-run" }));
});

test("quorum retains the first qualified set in recorded order and cancels remaining work", () => {
  const graph = joinGraph("quorum", 2);
  let state = start(graph, "quorum-join");
  state = admit(graph, state, "a");
  state = admit(graph, state, "b");
  state = admit(graph, state, "c");
  state = result(graph, state, "b", 10, "b-result").nextState;
  const winner = result(graph, state, "a", 20, "a-result");

  expect(winner.nextState.nodes.join?.output).toEqual([
    { id: "b", output: "b-result" },
    { id: "a", output: "a-result" },
  ]);
  expect(winner.nextState.nodes.join?.status).toBe("succeeded");
  expect(winner.nextState.nodes.c?.status).toBe("stopping");
  expect(winner.commands.filter((command) => command.kind === "cancel-node").map((command) => command.nodeId)).toEqual(["c"]);
  expect(winner.nextState.status).toBe("stopping");

  const c = winner.nextState.nodes.c!.attempts.at(-1)!;
  const completed = advanceKernel(graph, winner.nextState, { kind: "attempt-stopped", id: "c-stopped", atMs: 20, nodeId: "c", commandId: c.commandId, candidateGeneration: c.candidateGeneration, attempt: c.attempt });
  expect(completed.nextState.status).toBe("completed");
  expect(completed.commands).toContainEqual(expect.objectContaining({ kind: "complete-run" }));
});
