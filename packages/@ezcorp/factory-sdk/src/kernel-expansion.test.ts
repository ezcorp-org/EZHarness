import { expect, test } from "bun:test";
import { compileFactory } from "./compiler";
import { referenceCodeV1 } from "./references.js";
import { advanceKernel, createKernelState } from "./kernel";
import type { CompiledFactory, FactoryBounds, FactoryDefinition, FactoryNode, KernelState } from "./index";

const digest = "sha256:bcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbc";
const runner = { package: "inert", version: "1", digest, export: "run" } as const;
const string = { type: "string" } as const;
const loopResult = { type: "object", properties: { result: string }, required: ["result"], additionalProperties: false } as const;

function compiled(nodes: readonly FactoryNode[], bounds: FactoryBounds): CompiledFactory {
  const definition: FactoryDefinition = {
    schemaVersion: "factory.v1", id: "expansion-regression", version: "1", interpreterCompatibility: "1",
    inputPorts: {}, outputPorts: {}, graph: { nodes, outputs: {} }, acceptance: referenceCodeV1.acceptance,
    packages: [...referenceCodeV1.packages, { name: runner.package, version: runner.version, digest }], capabilities: [], effects: ["none"], bounds,
  };
  const result = compileFactory(definition);
  if (!result.ok) throw new Error(result.diagnostics.map((diagnostic) => `${diagnostic.code}:${diagnostic.nodeId ?? "definition"}`).join(", "));
  return result.factory;
}

function nestedBranchMapLoop(): Extract<FactoryNode, { kind: "branch" }> {
  const loop: Extract<FactoryNode, { kind: "loop" }> = {
    id: "loop", kind: "loop", initialInput: { kind: "literal", value: "seed" }, carriedSchema: string, resultSchema: loopResult, outputPorts: { result: string },
    body: { nodes: [{ id: "work", kind: "task", runner, outputPorts: { result: string } }], outputs: { result: { kind: "ref", root: "node", name: "work", path: ["result"] } } },
    until: { kind: "literal", value: true }, nextInput: { kind: "literal", value: "seed" }, maxIterations: 1, maxElapsedMs: 1_000, onExhausted: "fail",
  };
  const map: Extract<FactoryNode, { kind: "map" }> = {
    id: "map", kind: "map", collection: { kind: "literal", value: ["one", "two"] }, itemSchema: string, mode: "all", maxItems: 2, maxConcurrency: 2,
    outputPorts: { result: { type: "array", items: string } }, body: { nodes: [loop], outputs: { result: { kind: "ref", root: "node", name: "loop", path: ["result"] } } },
  };
  return {
    id: "branch", kind: "branch", condition: { kind: "literal", value: true }, outputPorts: { result: { type: "array", items: { type: ["string", "null"] } } },
    then: { nodes: [map], outputs: { result: { kind: "ref", root: "node", name: "map", path: ["result"] } } },
    else: { nodes: [], outputs: { result: { kind: "literal", value: [] } } },
  };
}

function start(factory: CompiledFactory, runId: string): KernelState {
  return advanceKernel(factory, createKernelState(factory, runId, {}, 0), { kind: "start", id: `${runId}:start`, atMs: 0 }).nextState;
}

function admit(factory: CompiledFactory, state: KernelState, nodeId: string): KernelState {
  const attempt = state.nodes[nodeId]?.attempts.at(-1);
  if (!attempt) throw new Error(`missing admission attempt for ${nodeId}`);
  return advanceKernel(factory, state, { kind: "admission-result", id: `${nodeId}:admit`, atMs: 0, nodeId, commandId: attempt.commandId, candidateGeneration: attempt.candidateGeneration, granted: true }).nextState;
}

function succeed(factory: CompiledFactory, state: KernelState, nodeId: string, output: Record<string, string>): KernelState {
  const attempt = state.nodes[nodeId]?.attempts.at(-1);
  if (!attempt) throw new Error(`missing dispatch attempt for ${nodeId}`);
  return advanceKernel(factory, state, { kind: "node-result", id: `${nodeId}:result:${attempt.attempt}`, atMs: 1, nodeId, commandId: attempt.commandId, candidateGeneration: attempt.candidateGeneration, attempt: attempt.attempt, output }).nextState;
}

test("nested branch/map/loop expansion is charged once to the run-wide bound ledger", () => {
  const factory = compiled([nestedBranchMapLoop()], { maxExpandedNodes: 6, maxScopeDepth: 4 });
  const state = start(factory, "expansion-bound");

  expect(state.status).toBe("running");
  expect(state.scopes.root?.expandedNodeCount).toBe(6);
  expect(state.scopes["branch/then"]?.expandedNodeCount).toBe(5);
  expect(state.scopes["branch/then/map/items"]?.expandedNodeCount).toBe(4);
});

test("nested branch, map, and loop scopes carry their real lexical depth", () => {
  const factory = compiled([nestedBranchMapLoop()], { maxExpandedNodes: 6, maxScopeDepth: 4 });
  const state = start(factory, "scope-depth");

  expect(state.scopes["branch/then"]?.depth).toBe(1);
  expect(state.scopes["branch/then/map/items"]?.depth).toBe(2);
  expect(state.scopes["branch/then/map/items/0/loop/items/0"]?.depth).toBe(3);
  expect(state.scopes["branch/then/map/items/1/loop/items/0"]?.depth).toBe(3);
});

test("loop iterations add stable global expansion counts instead of resetting the run ledger", () => {
  const loop: Extract<FactoryNode, { kind: "loop" }> = {
    id: "loop", kind: "loop", initialInput: { kind: "literal", value: "seed" }, carriedSchema: string, resultSchema: loopResult, outputPorts: { result: string },
    body: { nodes: [{ id: "work", kind: "task", runner, outputPorts: { result: string } }], outputs: { result: { kind: "ref", root: "node", name: "work", path: ["result"] } } },
    until: { kind: "eq", left: { kind: "ref", root: "loop", name: "result", path: ["result"] }, right: { kind: "literal", value: "done" } },
    nextInput: { kind: "literal", value: "seed" }, maxIterations: 3, maxElapsedMs: 1_000, onExhausted: "fail",
  };
  const factory = compiled([loop], { maxExpandedNodes: 10, maxScopeDepth: 2 });
  let state = start(factory, "loop-ledger");
  state = admit(factory, state, "loop/items/0/work");
  state = succeed(factory, state, "loop/items/0/work", { result: "again" });
  state = admit(factory, state, "loop/items/1/work");
  state = succeed(factory, state, "loop/items/1/work", { result: "done" });

  expect(state.status).toBe("completed");
  expect(state.nodes.loop?.output).toEqual({ result: "done" });
  expect(state.scopes["loop/items/0"]?.expandedNodeCount).toBe(1);
  expect(state.scopes["loop/items/1"]?.expandedNodeCount).toBe(1);
  expect(state.scopes.root?.expandedNodeCount).toBe(3);
});

test("a loop configured to escalate waits for remediation when its iteration bound is exhausted", () => {
  const loop: Extract<FactoryNode, { kind: "loop" }> = {
    id: "loop", kind: "loop", initialInput: { kind: "literal", value: "seed" }, carriedSchema: string, resultSchema: loopResult, outputPorts: { result: string },
    body: { nodes: [{ id: "work", kind: "task", runner, outputPorts: { result: string } }], outputs: { result: { kind: "ref", root: "node", name: "work", path: ["result"] } } },
    until: { kind: "literal", value: false }, nextInput: { kind: "literal", value: "seed" }, maxIterations: 1, maxElapsedMs: 1_000, onExhausted: "escalate",
  };
  const factory = compiled([loop], { maxExpandedNodes: 2, maxScopeDepth: 2 });
  let state = start(factory, "loop-escalation");
  state = admit(factory, state, "loop/items/0/work");
  state = succeed(factory, state, "loop/items/0/work", { result: "still-running" });

  expect(state.status).toBe("waiting");
  expect(state.nodes.loop?.status).toBe("waiting");
  expect(state.nodes.loop?.waitingReason).toBe("remediation");
  expect(state.stopReason).toBeUndefined();
});
