import { expect, test } from "bun:test";
import { referenceCodeV1 } from "./references.js";
import { compileFactory } from "./compiler";
import { advanceKernel, createKernelState } from "./kernel";
import type { CompiledFactory, FactoryDefinition, FactoryNode, KernelState } from "./index";

const digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const runner = { package: "inert", version: "1", digest, export: "run" } as const;

/** Compile every fixture so tests use the same public execution plan as adapters. */
function factory(nodes: readonly FactoryNode[]): CompiledFactory {
  const definition: FactoryDefinition = {
    schemaVersion: "factory.v1", id: "settlement-regression", version: "1", interpreterCompatibility: "1",
    inputPorts: {}, outputPorts: {}, graph: { nodes, outputs: {} },
    acceptance: referenceCodeV1.acceptance,
    packages: [{ name: runner.package, version: runner.version, digest }, ...referenceCodeV1.packages], capabilities: [], effects: ["none"],
    bounds: { maxExpandedNodes: 100, maxScopeDepth: 16 },
  };
  const result = compileFactory(definition);
  if (!result.ok) throw new Error(result.diagnostics.map((diagnostic) => diagnostic.code).join(", "));
  return result.factory;
}

function start(graph: CompiledFactory, runId: string): KernelState {
  return advanceKernel(graph, createKernelState(graph, runId, {}, 0), { kind: "start", id: `${runId}-start`, atMs: 0 }).nextState;
}

function admit(graph: CompiledFactory, state: KernelState, nodeId: string, id: string): KernelState {
  const attempt = state.nodes[nodeId]?.attempts.at(-1);
  if (!attempt) throw new Error(`missing admission attempt for ${nodeId}`);
  return advanceKernel(graph, state, {
    kind: "admission-result", id, atMs: 0, nodeId, commandId: attempt.commandId,
    candidateGeneration: attempt.candidateGeneration, granted: true,
  }).nextState;
}

function settle(graph: CompiledFactory, state: KernelState, nodeId: string, id: string, knownCostMicros: string, revision = 1): KernelState {
  const attempt = state.nodes[nodeId]?.attempts.at(-1);
  if (!attempt) throw new Error(`missing dispatched attempt for ${nodeId}`);
  return advanceKernel(graph, state, {
    kind: "usage-settled", id, atMs: 1, nodeId, commandId: attempt.commandId,
    candidateGeneration: attempt.candidateGeneration, attempt: attempt.attempt, revision, knownCostMicros,
  }).nextState;
}

function singleIterationLoop(id: string, body: readonly FactoryNode[], budget?: string): Extract<FactoryNode, { readonly kind: "loop" }> {
  return {
    id, kind: "loop", initialInput: { kind: "literal", value: "seed" },
    carriedSchema: { type: "string" }, resultSchema: { type: "string" }, body: { nodes: body, outputs: {} },
    until: { kind: "literal", value: true }, nextInput: { kind: "literal", value: "seed" },
    maxIterations: 4, maxElapsedMs: 1_000, onExhausted: "fail",
    ...(budget === undefined ? {} : { budget: { maxCostMicros: budget } }),
  };
}

test("forged __proto__ and toString node identities cannot settle an actual operation", () => {
  const graph = factory([{ id: "work", kind: "task", runner }]);
  let state = start(graph, "forged");
  state = admit(graph, state, "work", "admit-work");
  const commandId = state.nodes.work!.attempts.at(-1)!.commandId;

  for (const nodeId of ["__proto__", "toString"]) {
    state = advanceKernel(graph, state, {
      kind: "usage-settled", id: `forged-${nodeId}`, atMs: 1, nodeId, commandId,
      candidateGeneration: 0, attempt: 1, revision: 1, knownCostMicros: "9",
    }).nextState;
  }

  expect(state.spentCostMicros).toBe("0");
  expect(state.unknownCostMicros).toBe("0");
  expect(Object.keys(state.usageSettlements)).toEqual([]);
});

test("a nested-loop operation charges each enclosing loop once", () => {
  const inner = singleIterationLoop("inner", [{ id: "leaf", kind: "task", runner }]);
  const outer = singleIterationLoop("outer", [inner]);
  const graph = factory([outer]);
  let state = start(graph, "nested");
  const leafId = "outer/items/0/inner/items/0/leaf";
  state = admit(graph, state, leafId, "admit-leaf");
  state = settle(graph, state, leafId, "leaf-cost", "7");

  expect(state.spentCostMicros).toBe("7");
  expect(state.nodes.outer?.loop?.spentCostMicros).toBe("7");
  expect(state.nodes["outer/items/0/inner"]?.loop?.spentCostMicros).toBe("7");
  const duplicate = settle(graph, state, leafId, "leaf-cost-duplicate", "7");
  expect(duplicate.nodes.outer?.loop?.spentCostMicros).toBe("7");
  expect(duplicate.nodes["outer/items/0/inner"]?.loop?.spentCostMicros).toBe("7");
});

test("an unrelated root task cost does not consume a loop budget", () => {
  const loop = singleIterationLoop("loop", [{ id: "inside", kind: "task", runner }], "1");
  const graph = factory([{ id: "outside", kind: "task", runner }, loop]);
  let state = start(graph, "unrelated");
  state = admit(graph, state, "outside", "admit-outside");
  state = settle(graph, state, "outside", "outside-cost", "2");

  expect(state.spentCostMicros).toBe("2");
  expect(state.nodes.loop?.loop?.spentCostMicros).toBe("0");
  expect(state.nodes.loop?.status).toBe("waiting");
});

test("each new loop iteration has a zero local ledger while the loop aggregate persists", () => {
  const loop: Extract<FactoryNode, { readonly kind: "loop" }> = {
    ...singleIterationLoop("loop", [{ id: "inside", kind: "task", runner }]),
    until: { kind: "eq", left: { kind: "ref", root: "loop", name: "result" }, right: { kind: "literal", value: "done" } },
  };
  const graph = factory([loop]);
  let state = start(graph, "iteration-ledger");
  const first = "loop/items/0/inside";
  state = admit(graph, state, first, "admit-first");
  state = settle(graph, state, first, "first-cost", "5");
  const firstAttempt = state.nodes[first]!.attempts.at(-1)!;
  state = advanceKernel(graph, state, {
    kind: "node-result", id: "first-result", atMs: 2, nodeId: first, commandId: firstAttempt.commandId,
    candidateGeneration: firstAttempt.candidateGeneration, attempt: firstAttempt.attempt, output: "again",
  }).nextState;

  expect(state.scopes["loop/items/0"]?.spentCostMicros).toBe("5");
  expect(state.nodes.loop?.loop?.spentCostMicros).toBe("5");
  expect(state.scopes["loop/items/1"]?.spentCostMicros).toBe("0");
  expect(state.scopes["loop/items/1"]?.unknownCostMicros).toBe("0");
  expect(state.nodes["loop/items/1/inside"]?.status).toBe("reserved");
});

test("a repaired generation keeps a late charge for its stopped prior attempt", () => {
  const graph = factory([{ id: "work", kind: "task", runner, retry: { maxAttempts: 2, initialDelayMs: 10, maximumDelayMs: 10 } }]);
  let state = start(graph, "repair");
  state = admit(graph, state, "work", "admit-first");
  const first = state.nodes.work!.attempts.at(-1)!;
  state = advanceKernel(graph, state, {
    kind: "node-failed", id: "first-failed", atMs: 1, nodeId: "work", commandId: first.commandId,
    candidateGeneration: first.candidateGeneration, attempt: first.attempt, error: "temporary",
  }).nextState;
  state = advanceKernel(graph, state, {
    kind: "attempt-stopped", id: "first-stopped", atMs: 1, nodeId: "work", commandId: first.commandId,
    candidateGeneration: first.candidateGeneration, attempt: first.attempt,
  }).nextState;
  state = advanceKernel(graph, state, { kind: "repair", id: "repair", atMs: 2, nodeId: "work", reason: "retry elsewhere" }).nextState;

  expect(state.nodes.work?.candidateGeneration).toBe(1);
  expect(state.nodes.work?.status).toBe("reserved");
  state = advanceKernel(graph, state, {
    kind: "usage-settled", id: "late-first-cost", atMs: 3, nodeId: "work", commandId: first.commandId,
    candidateGeneration: first.candidateGeneration, attempt: first.attempt, revision: 1, knownCostMicros: "5",
  }).nextState;
  expect(state.spentCostMicros).toBe("5");
  expect(state.usageSettlements[first.commandId]?.knownCostMicros).toBe("5");
});
