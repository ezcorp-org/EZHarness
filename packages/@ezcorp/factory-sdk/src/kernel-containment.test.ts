import { expect, test } from "bun:test";
import { compileFactory } from "./compiler";
import { referenceCodeV1 } from "./references.js";
import { advanceKernel, createKernelState } from "./kernel";
import type { CompiledFactory, FactoryDefinition, FactoryNode, KernelState } from "./index";

const digest = "sha256:abababababababababababababababababababababababababababababababab";
const runner = { package: "inert", version: "1", digest, export: "run" } as const;
const string = { type: "string" } as const;

function compiled(nodes: readonly FactoryNode[]): CompiledFactory {
  const definition: FactoryDefinition = {
    schemaVersion: "factory.v1", id: "containment-regression", version: "1", interpreterCompatibility: "1",
    inputPorts: {}, outputPorts: {}, graph: { nodes, outputs: {} }, acceptance: referenceCodeV1.acceptance,
    packages: [...referenceCodeV1.packages, { name: runner.package, version: runner.version, digest }], capabilities: [], effects: ["none"],
    bounds: { maxExpandedNodes: 100, maxScopeDepth: 16 },
  };
  const result = compileFactory(definition);
  if (!result.ok) throw new Error(result.diagnostics.map((diagnostic) => `${diagnostic.code}:${diagnostic.nodeId ?? "definition"}`).join(", "));
  return result.factory;
}

function start(factory: CompiledFactory, runId: string): KernelState {
  return advanceKernel(factory, createKernelState(factory, runId, {}, 0), { kind: "start", id: `${runId}:start`, atMs: 0 }).nextState;
}

function admit(factory: CompiledFactory, state: KernelState, nodeId: string): KernelState {
  const attempt = state.nodes[nodeId]?.attempts.at(-1);
  if (!attempt) throw new Error(`missing admission attempt for ${nodeId}`);
  return advanceKernel(factory, state, {
    kind: "admission-result", id: `${nodeId}:admit`, atMs: 0, nodeId, commandId: attempt.commandId,
    candidateGeneration: attempt.candidateGeneration, granted: true,
  }).nextState;
}

function failAndStop(factory: CompiledFactory, state: KernelState, nodeId: string, atMs: number): KernelState {
  const attempt = state.nodes[nodeId]?.attempts.at(-1);
  if (!attempt) throw new Error(`missing running attempt for ${nodeId}`);
  const failed = advanceKernel(factory, state, {
    kind: "node-failed", id: `${nodeId}:failed:${atMs}`, atMs, nodeId, commandId: attempt.commandId,
    candidateGeneration: attempt.candidateGeneration, attempt: attempt.attempt, error: `${nodeId}-failed`,
  });
  return advanceKernel(factory, failed.nextState, {
    kind: "attempt-stopped", id: `${nodeId}:stopped:${atMs}`, atMs, nodeId, commandId: attempt.commandId,
    candidateGeneration: attempt.candidateGeneration, attempt: attempt.attempt,
  }).nextState;
}

test("an any join contains a failed candidate while a qualified sibling remains running", () => {
  const factory = compiled([
    { id: "failed-candidate", kind: "task", runner, retry: { maxAttempts: 1, initialDelayMs: 0, maximumDelayMs: 0 } },
    { id: "winner-candidate", kind: "task", runner },
    {
      id: "winner", kind: "join", mode: "any", predecessors: ["failed-candidate", "winner-candidate"],
      eligibleOutcomes: ["succeeded"], quorum: 1,
      outputPorts: { winners: { type: "array", items: { type: "object", properties: { nodeId: string, outputs: { type: "object", additionalProperties: true } }, required: ["nodeId", "outputs"], additionalProperties: false } } },
    },
    { id: "shared-downstream", kind: "task", runner, dependsOn: ["winner"] },
  ]);
  let state = start(factory, "contained-any");
  state = admit(factory, state, "failed-candidate");
  state = admit(factory, state, "winner-candidate");
  state = failAndStop(factory, state, "failed-candidate", 10);

  expect(state.status).toBe("running");
  expect(state.nodes["failed-candidate"]?.status).toBe("failed");
  expect(state.nodes["winner-candidate"]?.status).toBe("running");
  expect(state.nodes["shared-downstream"]?.status).toBe("blocked");

  const winnerAttempt = state.nodes["winner-candidate"]!.attempts.at(-1)!;
  const won = advanceKernel(factory, state, {
    kind: "node-result", id: "winner-candidate:result", atMs: 20, nodeId: "winner-candidate", commandId: winnerAttempt.commandId,
    candidateGeneration: winnerAttempt.candidateGeneration, attempt: winnerAttempt.attempt, output: {},
  });
  expect(won.nextState.nodes.winner?.status).toBe("succeeded");
  expect(won.nextState.nodes["shared-downstream"]?.status).toBe("reserved");
  expect(won.commands.some((command) => command.kind === "cancel-node" && command.nodeId === "shared-downstream")).toBe(false);
});

test("a collect map drains failed item descendants while independent active items continue", () => {
  const factory = compiled([{
    id: "collect", kind: "map", collection: { kind: "literal", value: ["first", "second"] }, itemSchema: string,
    mode: "collect", maxItems: 2, maxConcurrency: 2,
    outputPorts: { result: { type: "array", items: { type: "object", additionalProperties: true } } },
    body: {
      nodes: [
        { id: "primary", kind: "task", runner, outputPorts: { value: string } },
        { id: "sidecar", kind: "task", runner, outputPorts: { value: string } },
      ],
      outputs: { result: { kind: "ref", root: "node", name: "primary", path: ["value"] } },
    },
  }]);
  let state = start(factory, "collect-drain");
  for (const nodeId of ["collect/items/0/primary", "collect/items/0/sidecar", "collect/items/1/primary", "collect/items/1/sidecar"]) state = admit(factory, state, nodeId);

  const primary = state.nodes["collect/items/0/primary"]!.attempts.at(-1)!;
  const failure = advanceKernel(factory, state, {
    kind: "node-failed", id: "first-primary:failed", atMs: 10, nodeId: "collect/items/0/primary", commandId: primary.commandId,
    candidateGeneration: primary.candidateGeneration, attempt: primary.attempt, error: "first-item-failed",
  });
  const afterStop = advanceKernel(factory, failure.nextState, {
    kind: "attempt-stopped", id: "first-primary:stopped", atMs: 10, nodeId: "collect/items/0/primary", commandId: primary.commandId,
    candidateGeneration: primary.candidateGeneration, attempt: primary.attempt,
  });

  expect(afterStop.nextState.status).toBe("running");
  expect(afterStop.nextState.nodes["collect/items/0/sidecar"]?.status).toBe("stopping");
  expect(afterStop.commands).toContainEqual(expect.objectContaining({ kind: "cancel-node", nodeId: "collect/items/0/sidecar" }));
  expect(afterStop.nextState.nodes["collect/items/1/primary"]?.status).toBe("running");
  expect(afterStop.nextState.nodes["collect/items/1/sidecar"]?.status).toBe("running");
});
