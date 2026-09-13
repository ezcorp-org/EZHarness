import { expect, test } from "bun:test";
import { compileFactory } from "./compiler";
import { advanceKernel, createKernelState } from "./kernel";
import { referenceCodeV1 } from "./references.js";
import { simulateFactory, simulationEventsFor } from "./simulator";
import type { CompiledFactory, FactoryDefinition, FactoryNode } from "./types";

const digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const runner = { package: "inert", version: "1", digest, export: "run" } as const;
const string = { type: "string" } as const;
const resultRecord = { type: "object", properties: { result: string }, required: ["result"], additionalProperties: false } as const;

function compiled(nodes: readonly FactoryNode[]): CompiledFactory {
  const definition: FactoryDefinition = {
    schemaVersion: "factory.v1", id: "simulator-regression", version: "1", interpreterCompatibility: "1", inputPorts: {}, outputPorts: {}, graph: { nodes, outputs: {} },
    acceptance: referenceCodeV1.acceptance, packages: [...referenceCodeV1.packages, { name: runner.package, version: runner.version, digest }], capabilities: [], effects: ["none"],
    bounds: { maxExpandedNodes: 100, maxScopeDepth: 16 },
  };
  const result = compileFactory(definition);
  if (!result.ok) throw new Error(result.diagnostics.map((diagnostic) => `${diagnostic.code}:${diagnostic.nodeId ?? "definition"}`).join(", "));
  return result.factory;
}

function itemBody(ids: readonly string[] = ["item"]) {
  return {
    nodes: ids.map((id, index) => ({ id, kind: "task" as const, runner, ...(index === 0 ? {} : { dependsOn: [ids[index - 1]!] }), outputPorts: { result: string } })),
    outputs: { result: { kind: "ref" as const, root: "node" as const, name: ids.at(-1)!, path: ["result"] } },
  };
}

function loop(until: Extract<FactoryNode, { kind: "loop" }> ["until"], maxIterations = 2): Extract<FactoryNode, { kind: "loop" }> {
  return {
    id: "loop", kind: "loop", initialInput: { kind: "literal", value: "seed" }, carriedSchema: string, resultSchema: resultRecord, outputPorts: { result: string }, body: itemBody(["work"]),
    until, nextInput: { kind: "literal", value: "next" }, maxIterations, maxElapsedMs: 1_000, onExhausted: "fail",
  };
}

test("simulator drives the production kernel and emits an independently inspectable trace", () => {
  const factory = compiled([{ id: "work", kind: "task", runner, outputPorts: { echoed: { type: "object", additionalProperties: true } } }]);
  const result = simulateFactory(factory, "simulation-run", {}, { execute: (_node, command) => ({ kind: "success", output: { echoed: command.input } }) });
  expect(result.state.status).toBe("completed");
  expect(result.state.nodes.work?.output).toEqual({ echoed: {} });
  expect(result.events.map((event) => event.kind)).toEqual(["start", "admission-result", "node-result"]);
  expect(result.commands).toContainEqual(expect.objectContaining({ kind: "request-admission", nodeId: "work" }));
  expect(result.commands).toContainEqual(expect.objectContaining({ kind: "dispatch-node", nodeId: "work" }));
  expect(result.commands).toContainEqual(expect.objectContaining({ kind: "complete-run" }));
});

test("simulator exposes a retry as two product attempts", () => {
  let calls = 0;
  const factory = compiled([{ id: "work", kind: "task", runner, outputPorts: { ok: { type: "boolean" } }, retry: { maxAttempts: 2, initialDelayMs: 2, maximumDelayMs: 2 } }]);
  const result = simulateFactory(factory, "retry-run", {}, { execute: () => ++calls === 1 ? { kind: "failure", error: "first failure" } : { kind: "success", output: { ok: true } } });
  expect(calls).toBe(2);
  expect(result.state.status).toBe("completed");
  expect(result.commands.filter((command) => command.kind === "dispatch-node").map((command) => command.attempt)).toEqual([1, 2]);
});

test("map snapshots duplicate values, admits a rolling window, and collects by index", () => {
  const map: Extract<FactoryNode, { kind: "map" }> = { id: "map", kind: "map", collection: { kind: "literal", value: ["same", "same", "last"] }, itemSchema: string, body: itemBody(), outputPorts: { result: { type: "array", items: { type: "object", additionalProperties: true } } }, mode: "collect", maxItems: 3, maxConcurrency: 2 };
  const dispatched: string[] = [];
  const result = simulateFactory(compiled([map]), "map-run", {}, { execute: (_node, command) => { dispatched.push(command.nodeId); return { kind: "success", output: { result: command.nodeId.includes("/0/") ? "first" : command.nodeId.includes("/1/") ? "second" : "third" } }; } });
  expect(dispatched).toEqual(["map/items/0/item", "map/items/1/item", "map/items/2/item"]);
  expect(result.state.nodes.map?.output).toEqual({ result: [{ outcome: "succeeded", value: "first" }, { outcome: "succeeded", value: "second" }, { outcome: "succeeded", value: "third" }] });
  expect(result.state.status).toBe("completed");
});

test("collect records one failed index and continues the other indexed items", () => {
  const map: Extract<FactoryNode, { kind: "map" }> = { id: "map", kind: "map", collection: { kind: "literal", value: ["first", "second", "third"] }, itemSchema: string, body: itemBody(), outputPorts: { result: { type: "array", items: { type: "object", additionalProperties: true } } }, mode: "collect", maxItems: 3, maxConcurrency: 2 };
  const result = simulateFactory(compiled([map]), "collect-failure", {}, { execute: (_node, command) => command.nodeId.includes("/0/") ? { kind: "failure", error: "first failed" } : { kind: "success", output: { result: command.nodeId.includes("/1/") ? "second" : "third" } } });
  expect(result.state.status).toBe("completed");
  expect(result.state.nodes.map?.output).toEqual({ result: [{ outcome: "failed", error: "first failed" }, { outcome: "succeeded", value: "second" }, { outcome: "succeeded", value: "third" }] });
});

test("all-mode map failure fails the enclosing run and stops active item attempts", () => {
  const map: Extract<FactoryNode, { kind: "map" }> = { id: "map", kind: "map", collection: { kind: "literal", value: ["one", "two"] }, itemSchema: string, body: { nodes: [{ id: "item", kind: "task", runner, retry: { maxAttempts: 1, initialDelayMs: 0, maximumDelayMs: 0 }, outputPorts: { result: string } }], outputs: { result: { kind: "ref", root: "node", name: "item", path: ["result"] } } }, outputPorts: { result: { type: "array", items: string } }, mode: "all", maxItems: 2, maxConcurrency: 2 };
  const factory = compiled([map]);
  let state = advanceKernel(factory, createKernelState(factory, "all-failure", {}, 0), { kind: "start", id: "start", atMs: 0 }).nextState;
  for (const nodeId of ["map/items/0/item", "map/items/1/item"]) {
    const attempt = state.nodes[nodeId]!.attempts.at(-1)!;
    state = advanceKernel(factory, state, { kind: "admission-result", id: `${nodeId}:admit`, atMs: 0, nodeId, commandId: attempt.commandId, candidateGeneration: attempt.candidateGeneration, granted: true }).nextState;
  }
  const first = state.nodes["map/items/0/item"]!.attempts.at(-1)!;
  const failing = advanceKernel(factory, state, { kind: "node-failed", id: "failed", atMs: 1, nodeId: "map/items/0/item", commandId: first.commandId, candidateGeneration: first.candidateGeneration, attempt: first.attempt, error: "bad item" });
  const stopped = advanceKernel(factory, failing.nextState, { kind: "attempt-stopped", id: "stopped", atMs: 1, nodeId: "map/items/0/item", commandId: first.commandId, candidateGeneration: first.candidateGeneration, attempt: first.attempt });
  expect(stopped.nextState.status).toBe("stopping");
  expect(stopped.commands).toContainEqual(expect.objectContaining({ kind: "cancel-node", nodeId: "map/items/1/item" }));
});

test("an item keeps its map concurrency slot until its whole multi-node body completes", () => {
  const map: Extract<FactoryNode, { kind: "map" }> = { id: "map", kind: "map", collection: { kind: "literal", value: ["one", "two"] }, itemSchema: string, body: itemBody(["first", "second"]), outputPorts: { result: { type: "array", items: string } }, mode: "all", maxItems: 2, maxConcurrency: 1 };
  const dispatched: string[] = [];
  simulateFactory(compiled([map]), "multi-body", {}, { execute: (_node, command) => { dispatched.push(command.nodeId); return { kind: "success", output: { result: command.nodeId } }; } });
  expect(dispatched).toEqual(["map/items/0/first", "map/items/0/second", "map/items/1/first", "map/items/1/second"]);
});

test("loop executes a scoped body then returns its typed result when until is true", () => {
  const result = simulateFactory(compiled([loop({ kind: "literal", value: true })]), "loop-run", {}, { execute: () => ({ kind: "success", output: { result: "done" } }) });
  expect(result.state.status).toBe("completed");
  expect(result.state.nodes.loop?.output).toEqual({ result: "done" });
  expect(result.commands.filter((command) => command.kind === "dispatch-node").map((command) => command.nodeId)).toEqual(["loop/items/0/work"]);
});

test("loop fails at its iteration bound after a false until result", () => {
  const result = simulateFactory(compiled([loop({ kind: "literal", value: false }, 1)]), "loop-bound", {}, { execute: () => ({ kind: "success", output: { result: "done" } }) });
  expect(result.state.status).toBe("failed");
  expect(result.state.nodes.loop?.error).toBe("LOOP_BOUND_EXHAUSTED");
});

test("loop starts a second scoped iteration after false until and returns the later result", () => {
  const ids: string[] = [];
  const result = simulateFactory(compiled([loop({ kind: "eq", left: { kind: "ref", root: "loop", name: "result", path: ["result"] }, right: { kind: "literal", value: "done" } })]), "loop-two", {}, { execute: (_node, command) => { ids.push(command.nodeId); return { kind: "success", output: { result: command.nodeId.includes("/0/") ? "again" : "done" } }; } });
  expect(ids).toEqual(["loop/items/0/work", "loop/items/1/work"]);
  expect(result.state.status).toBe("completed");
  expect(result.state.nodes.loop?.output).toEqual({ result: "done" });
});

test("the compiler rejects a non-boolean loop until expression before simulation", () => {
  expect(() => compiled([loop({ kind: "literal", value: "not boolean" })])).toThrow("EXPRESSION_TYPE");
});

test("the single-process simulator leaves partition transport commands for an external router", () => {
  const factory = compiled([{ id: "work", kind: "task", runner }]);
  const state = createKernelState(factory, "partition-routing", {}, 0);
  expect(simulationEventsFor({
    kind: "invalidate-partition",
    id: "invalidate-a",
    sourcePartitionId: "source",
    targetPartitionId: "target",
    sourceNodeId: "a",
    nodeId: "b",
    candidateGeneration: 1,
  }, state, factory, {}, () => "unused")).toEqual([]);
});
