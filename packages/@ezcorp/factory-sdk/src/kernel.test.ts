import { describe, expect, test } from "bun:test";
import { advanceKernel, createKernelState } from "./kernel";
import type { CompiledFactory, FactoryNode, JsonValue } from "./types";

const runner = { package: "inert", version: "1", digest: "sha256:test", export: "run" } as const;

function compiled(nodes: readonly FactoryNode[], outputs: Record<string, { readonly kind: "ref"; readonly root: "node"; readonly name: string }>): CompiledFactory {
  const nodeById = Object.fromEntries(nodes.map((node) => [node.id, node]));
  const successors: Record<string, readonly string[]> = {};
  const dependencyCounts: Record<string, number> = {};
  for (const node of nodes) { successors[node.id] = []; dependencyCounts[node.id] = node.dependsOn?.length ?? 0; }
  for (const node of nodes) for (const parent of node.dependsOn ?? []) successors[parent] = [...(successors[parent] ?? []), node.id];
  return {
    schemaVersion: "factory.ir.v1", digest: "sha256:factory", definition: {
      schemaVersion: "factory.v1", id: "test", version: "1", interpreterCompatibility: "1", inputPorts: {}, outputPorts: {},
      graph: { nodes, outputs }, acceptance: { id: "none", version: "1", claims: [] }, packages: [], capabilities: [], effects: [], bounds: { maxExpandedNodes: 10_000, maxScopeDepth: 16 },
    }, lock: { packages: [], factories: [], interpreter: "1" }, indexes: { nodeById, successors, dependencyCounts }, partitions: [],
  };
}

const event = <T extends object>(id: string, values: T): T & { readonly id: string; readonly atMs: number } => ({ id, atMs: 1, ...values });

describe("factory kernel", () => {
  test("uses stable command identities and independently advances a ready successor", () => {
    const graph = compiled([
      { id: "first", kind: "task", runner },
      { id: "second", kind: "task", runner, dependsOn: ["first"] },
    ], { result: { kind: "ref", root: "node", name: "second" } });
    const initial = createKernelState(graph, "run-1", {}, 0);
    const started = advanceKernel(graph, initial, event("start", { kind: "start" }));
    expect(started.commands).toEqual([{ kind: "request-admission", id: "run-1:first:request-admission:1", nodeId: "first", candidateGeneration: 0, deadlineAtMs: 1_800_001 }]);
    const admitted = advanceKernel(graph, started.nextState, event("admit", { kind: "admission-result", nodeId: "first", commandId: "run-1:first:request-admission:1", candidateGeneration: 0, granted: true }));
    expect(admitted.commands).toEqual([
      { kind: "dispatch-node", id: "run-1:first:dispatch-node:2", nodeId: "first", candidateGeneration: 0, attempt: 1, input: {}, deadlineAtMs: 1_800_001, cancellationEpoch: 0 },
      { kind: "start-timer", id: "run-1:first:start-timer:3", nodeId: "first", deadlineAtMs: 1_800_001 },
    ]);
    const completed = advanceKernel(graph, admitted.nextState, event("result", { kind: "node-result", nodeId: "first", commandId: "run-1:first:dispatch-node:2", candidateGeneration: 0, attempt: 1, output: { value: 1 } }));
    expect(completed.nextState.nodes.second?.status).toBe("reserved");
    expect(completed.commands).toEqual([{ kind: "request-admission", id: "run-1:second:request-admission:4", nodeId: "second", candidateGeneration: 0, deadlineAtMs: 1_800_001 }]);
  });

  test("ignores duplicate and stale completion fences", () => {
    const graph = compiled([{ id: "only", kind: "task", runner }], { result: { kind: "ref", root: "node", name: "only" } });
    let state = advanceKernel(graph, createKernelState(graph, "run-2", {}, 0), event("start", { kind: "start" })).nextState;
    state = advanceKernel(graph, state, event("admit", { kind: "admission-result", nodeId: "only", commandId: "run-2:only:request-admission:1", candidateGeneration: 0, granted: true })).nextState;
    const stale = advanceKernel(graph, state, event("wrong-attempt", { kind: "node-result", nodeId: "only", commandId: "run-2:only:dispatch-node:2", candidateGeneration: 0, attempt: 2, output: {} }));
    expect(stale.nextState.nodes.only?.status).toBe("running");
    const complete = advanceKernel(graph, stale.nextState, event("result", { kind: "node-result", nodeId: "only", commandId: "run-2:only:dispatch-node:2", candidateGeneration: 0, attempt: 1, output: {} }));
    expect(complete.nextState.status).toBe("completed");
    expect(advanceKernel(graph, complete.nextState, event("result", { kind: "node-result", nodeId: "only", commandId: "run-2:only:dispatch-node:2", candidateGeneration: 0, attempt: 1, output: {} })).commands).toEqual([]);
  });

  test("does not retry before an attempt has stopped", () => {
    const graph = compiled([{ id: "only", kind: "task", runner, retry: { maxAttempts: 2, initialDelayMs: 5, maximumDelayMs: 5 } }], { result: { kind: "ref", root: "node", name: "only" } });
    let state = advanceKernel(graph, createKernelState(graph, "run-3", {}, 0), event("start", { kind: "start" })).nextState;
    state = advanceKernel(graph, state, event("admit", { kind: "admission-result", nodeId: "only", commandId: "run-3:only:request-admission:1", candidateGeneration: 0, granted: true })).nextState;
    const failed = advanceKernel(graph, state, event("failed", { kind: "node-failed", nodeId: "only", commandId: "run-3:only:dispatch-node:2", candidateGeneration: 0, attempt: 1, error: "boom" }));
    expect(failed.nextState.nodes.only?.status).toBe("stopping");
    expect(failed.commands.some((command) => command.kind === "request-admission")).toBe(false);
    const stopped = advanceKernel(graph, failed.nextState, event("stopped", { kind: "attempt-stopped", nodeId: "only", commandId: "run-3:only:dispatch-node:2", candidateGeneration: 0, attempt: 1 }));
    expect(stopped.nextState.nodes.only?.status).toBe("retry_wait");
    expect(stopped.commands).toEqual([{ kind: "start-timer", id: "run-3:only:start-timer:5", nodeId: "only", deadlineAtMs: 6 }]);
  });

  test("cancellation fences late work and retains uncertainty", () => {
    const graph = compiled([{ id: "only", kind: "task", runner }], { result: { kind: "ref", root: "node", name: "only" } });
    let state = advanceKernel(graph, createKernelState(graph, "run-4", {}, 0), event("start", { kind: "start" })).nextState;
    state = advanceKernel(graph, state, event("admit", { kind: "admission-result", nodeId: "only", commandId: "run-4:only:request-admission:1", candidateGeneration: 0, granted: true })).nextState;
    const cancelling = advanceKernel(graph, state, event("cancel", { kind: "cancel", reason: "user" }));
    expect(cancelling.nextState.cancellationEpoch).toBe(1);
    expect(cancelling.nextState.status).toBe("stopping");
    const stopped = advanceKernel(graph, cancelling.nextState, event("uncertain", { kind: "attempt-stopped", nodeId: "only", commandId: "run-4:only:dispatch-node:2", candidateGeneration: 0, attempt: 1, uncertain: true }));
    expect(stopped.nextState.status).toBe("stopping");
    expect(stopped.nextState.unresolvedUncertainNodeIds).toEqual(["only"]);
  });
});

void ({} as JsonValue);
