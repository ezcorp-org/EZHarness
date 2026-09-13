import { expect, test } from "bun:test";
import { advanceKernel, createKernelState } from "./kernel";
import { simulateFactory } from "./simulator";
import type { CompiledFactory } from "./types";

const runner = { package: "inert", version: "1", digest: "sha256:test", export: "run" } as const;

const oneTask: CompiledFactory = {
  schemaVersion: "factory.ir.v1", digest: "sha256:factory", definition: {
    schemaVersion: "factory.v1", id: "simulation", version: "1", interpreterCompatibility: "1", inputPorts: {}, outputPorts: {},
    graph: { nodes: [{ id: "work", kind: "task", runner }], outputs: { result: { kind: "ref", root: "node", name: "work" } } },
    acceptance: { id: "none", version: "1", claims: [] }, packages: [], capabilities: [], effects: [], bounds: { maxExpandedNodes: 10_000, maxScopeDepth: 16 },
  }, lock: { packages: [], factories: [], interpreter: "1" },
  indexes: { nodeById: { work: { id: "work", kind: "task", runner } }, successors: { work: [] }, dependencyCounts: { work: 0 } }, partitions: [],
};

test("simulator drives the production kernel and emits an independently inspectable trace", () => {
  const result = simulateFactory(oneTask, "simulation-run", { message: "hello" }, {
    execute: (_node, command) => ({ kind: "success", output: { echoed: command.input } }),
  });
  expect(result.state.status).toBe("completed");
  expect(result.state.nodes.work?.output).toEqual({ echoed: { message: "hello" } });
  expect(result.events.map((event) => event.kind)).toEqual(["start", "admission-result", "node-result"]);
  expect(result.commands.find((command) => command.kind === "start-timer" && command.nodeId === undefined)).toEqual(expect.objectContaining({ kind: "start-timer" }));
  expect(result.commands.find((command) => command.kind === "request-admission" && command.nodeId === "work")).toEqual(expect.objectContaining({ kind: "request-admission", nodeId: "work" }));
  expect(result.commands.find((command) => command.kind === "dispatch-node" && command.nodeId === "work")).toEqual(expect.objectContaining({ kind: "dispatch-node", nodeId: "work" }));
  expect(result.commands.find((command) => command.kind === "start-timer" && command.nodeId === "work")).toEqual(expect.objectContaining({ kind: "start-timer", nodeId: "work" }));
  expect(result.commands.find((command) => command.kind === "complete-run")).toEqual(expect.objectContaining({ kind: "complete-run" }));
});

test("simulator exposes a retry as two product attempts", () => {
  let calls = 0;
  const result = simulateFactory({
    ...oneTask,
    definition: { ...oneTask.definition, graph: { ...oneTask.definition.graph, nodes: [{ id: "work", kind: "task", runner, retry: { maxAttempts: 2, initialDelayMs: 2, maximumDelayMs: 2 } }] } },
    indexes: { ...oneTask.indexes, nodeById: { work: { id: "work", kind: "task", runner, retry: { maxAttempts: 2, initialDelayMs: 2, maximumDelayMs: 2 } } }, dependencyCounts: { work: 0 } },
  }, "retry-run", {}, {
    execute: () => (++calls === 1 ? { kind: "failure", error: "first failure" } : { kind: "success", output: { ok: true } }),
  });
  expect(calls).toBe(2);
  expect(result.state.status).toBe("completed");
  expect(result.commands.filter((command) => command.kind === "dispatch-node").map((command) => command.attempt)).toEqual([1, 2]);
});

test("map snapshots duplicate values, admits a rolling window, and collects by index", () => {
  const body = { nodes: [{ id: "item", kind: "task" as const, runner }], outputs: {} };
  const map = { id: "map", kind: "map" as const, collection: { kind: "literal" as const, value: ["same", "same", "last"] }, itemSchema: { type: "string" as const }, body, mode: "collect" as const, maxItems: 3, maxConcurrency: 2 };
  const factory: CompiledFactory = {
    ...oneTask,
    definition: { ...oneTask.definition, graph: { nodes: [map], outputs: { result: { kind: "ref", root: "node", name: "map" } } } },
    indexes: { nodeById: { map }, successors: { map: [] }, dependencyCounts: { map: 0 } },
  };
  const dispatched: string[] = [];
  const result = simulateFactory(factory, "map-run", {}, {
    execute: (_node, command) => { dispatched.push(command.nodeId); return { kind: "success", output: command.nodeId.includes("/0/") ? "first" : command.nodeId.includes("/1/") ? "second" : "third" }; },
  });
  expect(dispatched).toEqual(["map/items/0/item", "map/items/1/item", "map/items/2/item"]);
  expect(result.state.nodes.map?.output).toEqual(["first", "second", "third"]);
  expect(result.state.status).toBe("completed");
});

test("collect records one failed index and continues the other indexed items", () => {
  const body = { nodes: [{ id: "item", kind: "task" as const, runner }], outputs: {} };
  const map = { id: "map", kind: "map" as const, collection: { kind: "literal" as const, value: ["first", "second", "third"] }, itemSchema: { type: "string" as const }, body, mode: "collect" as const, maxItems: 3, maxConcurrency: 2 };
  const factory: CompiledFactory = { ...oneTask, definition: { ...oneTask.definition, graph: { nodes: [map], outputs: { result: { kind: "ref", root: "node", name: "map" } } } }, indexes: { nodeById: { map }, successors: { map: [] }, dependencyCounts: { map: 0 } } };
  const result = simulateFactory(factory, "collect-failure", {}, {
    execute: (_node, command) => command.nodeId.includes("/0/") ? { kind: "failure", error: "first failed" } : { kind: "success", output: command.nodeId.includes("/1/") ? "second" : "third" },
  });
  expect(result.state.status).toBe("completed");
  expect(result.state.nodes.map?.output).toEqual([{ error: "first failed" }, "second", "third"]);
  expect(result.commands.filter((command) => command.kind === "dispatch-node").map((command) => command.nodeId)).toEqual(["map/items/0/item", "map/items/1/item", "map/items/2/item"]);
});

test("all-mode map failure fails the enclosing run and stops active item attempts", () => {
  const body = { nodes: [{ id: "item", kind: "task" as const, runner }], outputs: {} };
  const map = { id: "map", kind: "map" as const, collection: { kind: "literal" as const, value: ["one", "two"] }, itemSchema: { type: "string" as const }, body, mode: "all" as const, maxItems: 2, maxConcurrency: 2 };
  const factory: CompiledFactory = { ...oneTask, definition: { ...oneTask.definition, graph: { nodes: [map], outputs: { result: { kind: "ref", root: "node", name: "map" } } } }, indexes: { nodeById: { map }, successors: { map: [] }, dependencyCounts: { map: 0 } } };
  let state = advanceKernel(factory, createKernelState(factory, "all-failure", {}, 0), { kind: "start", id: "start", atMs: 0 }).nextState;
  const firstAdmission = state.nodes["map/items/0/item"]!.attempts[0]!.commandId;
  state = advanceKernel(factory, state, { kind: "admission-result", id: "admit-0", atMs: 0, nodeId: "map/items/0/item", commandId: firstAdmission, candidateGeneration: 0, granted: true }).nextState;
  const secondAdmission = state.nodes["map/items/1/item"]!.attempts[0]!.commandId;
  state = advanceKernel(factory, state, { kind: "admission-result", id: "admit-1", atMs: 0, nodeId: "map/items/1/item", commandId: secondAdmission, candidateGeneration: 0, granted: true }).nextState;
  const firstDispatch = state.nodes["map/items/0/item"]!.attempts[0]!.commandId;
  const failed = advanceKernel(factory, state, { kind: "node-failed", id: "failed", atMs: 1, nodeId: "map/items/0/item", commandId: firstDispatch, candidateGeneration: 0, attempt: 1, error: "bad item" });
  const stopped = advanceKernel(factory, failed.nextState, { kind: "attempt-stopped", id: "stopped", atMs: 1, nodeId: "map/items/0/item", commandId: firstDispatch, candidateGeneration: 0, attempt: 1 });
  expect(stopped.nextState.status).toBe("stopping");
  expect(stopped.commands.some((command) => command.kind === "cancel-node" && command.nodeId === "map/items/1/item")).toBe(true);
});

test("an item keeps its map concurrency slot until its whole multi-node body completes", () => {
  const body = { nodes: [{ id: "first", kind: "task" as const, runner }, { id: "second", kind: "task" as const, runner, dependsOn: ["first"] }], outputs: {} };
  const map = { id: "map", kind: "map" as const, collection: { kind: "literal" as const, value: ["one", "two"] }, itemSchema: { type: "string" as const }, body, mode: "all" as const, maxItems: 2, maxConcurrency: 1 };
  const factory: CompiledFactory = { ...oneTask, definition: { ...oneTask.definition, graph: { nodes: [map], outputs: { result: { kind: "ref", root: "node", name: "map" } } } }, indexes: { nodeById: { map }, successors: { map: [] }, dependencyCounts: { map: 0 } } };
  const dispatched: string[] = [];
  simulateFactory(factory, "multi-body", {}, { execute: (_node, command) => { dispatched.push(command.nodeId); return { kind: "success", output: command.nodeId }; } });
  expect(dispatched).toEqual(["map/items/0/first", "map/items/0/second", "map/items/1/first", "map/items/1/second"]);
});

test("loop executes a scoped body then returns its typed result when until is true", () => {
  const body = { nodes: [{ id: "work", kind: "task" as const, runner, outputPorts: {} }], outputs: {} };
  const loop = { id: "loop", kind: "loop" as const, initialInput: { kind: "literal" as const, value: "seed" }, carriedSchema: { type: "string" as const }, resultSchema: { type: "string" as const }, body, until: { kind: "literal" as const, value: true }, nextInput: { kind: "literal" as const, value: "next" }, maxIterations: 2, maxElapsedMs: 1_000, onExhausted: "fail" as const };
  const factory: CompiledFactory = { ...oneTask, definition: { ...oneTask.definition, graph: { nodes: [loop], outputs: { result: { kind: "ref", root: "node", name: "loop" } } } }, indexes: { nodeById: { loop }, successors: { loop: [] }, dependencyCounts: { loop: 0 } } };
  const result = simulateFactory(factory, "loop-run", {}, { execute: () => ({ kind: "success", output: "done" }) });
  expect(result.state.status).toBe("completed");
  expect(result.state.nodes.loop?.output).toBe("done");
  expect(result.commands.filter((command) => command.kind === "dispatch-node").map((command) => command.nodeId)).toEqual(["loop/items/0/work"]);
});

test("loop fails at its iteration bound after a false until result", () => {
  const body = { nodes: [{ id: "work", kind: "task" as const, runner }], outputs: {} };
  const loop = { id: "loop", kind: "loop" as const, initialInput: { kind: "literal" as const, value: "seed" }, carriedSchema: { type: "string" as const }, resultSchema: { type: "string" as const }, body, until: { kind: "literal" as const, value: false }, nextInput: { kind: "literal" as const, value: "next" }, maxIterations: 1, maxElapsedMs: 1_000, onExhausted: "fail" as const };
  const factory: CompiledFactory = { ...oneTask, definition: { ...oneTask.definition, graph: { nodes: [loop], outputs: { result: { kind: "ref", root: "node", name: "loop" } } } }, indexes: { nodeById: { loop }, successors: { loop: [] }, dependencyCounts: { loop: 0 } } };
  const result = simulateFactory(factory, "loop-bound", {}, { execute: () => ({ kind: "success", output: "done" }) });
  expect(result.state.status).toBe("failed");
  expect(result.state.nodes.loop?.error).toBe("LOOP_BOUND_EXHAUSTED");
});

test("loop starts a second scoped iteration after false until and returns the later result", () => {
  const body = { nodes: [{ id: "work", kind: "task" as const, runner }], outputs: {} };
  const loop = { id: "loop", kind: "loop" as const, initialInput: { kind: "literal" as const, value: "seed" }, carriedSchema: { type: "string" as const }, resultSchema: { type: "string" as const }, body, until: { kind: "eq" as const, left: { kind: "ref" as const, root: "loop" as const, name: "result" }, right: { kind: "literal" as const, value: "done" } }, nextInput: { kind: "literal" as const, value: "next" }, maxIterations: 2, maxElapsedMs: 1_000, onExhausted: "fail" as const };
  const factory: CompiledFactory = { ...oneTask, definition: { ...oneTask.definition, graph: { nodes: [loop], outputs: { result: { kind: "ref", root: "node", name: "loop" } } } }, indexes: { nodeById: { loop }, successors: { loop: [] }, dependencyCounts: { loop: 0 } } };
  const ids: string[] = [];
  const result = simulateFactory(factory, "loop-two", {}, { execute: (_node, command) => { ids.push(command.nodeId); return { kind: "success", output: command.nodeId.includes("/0/") ? "again" : "done" }; } });
  expect(ids).toEqual(["loop/items/0/work", "loop/items/1/work"]);
  expect(result.state.status).toBe("completed");
  expect(result.state.nodes.loop?.output).toBe("done");
});

test("loop rejects a non-boolean until result", () => {
  const body = { nodes: [{ id: "work", kind: "task" as const, runner }], outputs: {} };
  const loop = { id: "loop", kind: "loop" as const, initialInput: { kind: "literal" as const, value: "seed" }, carriedSchema: { type: "string" as const }, resultSchema: { type: "string" as const }, body, until: { kind: "literal" as const, value: "not boolean" }, nextInput: { kind: "literal" as const, value: "next" }, maxIterations: 2, maxElapsedMs: 1_000, onExhausted: "fail" as const };
  const factory: CompiledFactory = { ...oneTask, definition: { ...oneTask.definition, graph: { nodes: [loop], outputs: { result: { kind: "ref", root: "node", name: "loop" } } } }, indexes: { nodeById: { loop }, successors: { loop: [] }, dependencyCounts: { loop: 0 } } };
  const result = simulateFactory(factory, "loop-bad-until", {}, { execute: () => ({ kind: "success", output: "done" }) });
  expect(result.state.status).toBe("failed");
  expect(result.state.nodes.loop?.error).toBe("LOOP_UNTIL_INVALID");
});
