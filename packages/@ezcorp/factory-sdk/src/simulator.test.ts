import { expect, test } from "bun:test";
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
  expect(result.events.map((event) => event.kind)).toEqual(["start", "admission-result", "node-result", "timer-expired"]);
  expect(result.commands.map((command) => command.id)).toEqual([
    "simulation-run:work:request-admission:1",
    "simulation-run:work:dispatch-node:2",
    "simulation-run:work:start-timer:3",
    "simulation-run:run:complete-run:4",
  ]);
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
