import { expect, test } from "bun:test";
import { compileFactory } from "./compiler";
import { advanceKernel, assertKernelContinuationState, createKernelState } from "./kernel";
import { referenceCatalogV1, referenceCodeV1 } from "./references";
import type { CompiledFactory, FactoryDefinition, FactoryReference, KernelCommand, KernelState } from "./index";

const stringPort = { type: "string" as const };

function compiled(definition: FactoryDefinition): CompiledFactory {
  const result = compileFactory(definition);
  if (!result.ok) throw new Error(result.diagnostics.map(item => item.code).join(","));
  return result.factory;
}

function taskFactory(): CompiledFactory {
  const definition = structuredClone(referenceCodeV1);
  definition.inputPorts = { source: stringPort };
  definition.outputPorts = { result: stringPort };
  definition.graph = {
    nodes: [{
      id: "candidate",
      kind: "task",
      runner: structuredClone(referenceCodeV1.graph.nodes[1] as Extract<(typeof referenceCodeV1.graph.nodes)[number], { kind: "task" }>).runner,
      inputPorts: { source: stringPort, instruction: stringPort },
      bindings: { source: { kind: "ref", root: "input", name: "source" }, instruction: { kind: "literal", value: "first" } },
      repairableInputs: ["instruction"],
      outputPorts: { result: stringPort },
    }, {
      id: "hold",
      kind: "task",
      runner: structuredClone(referenceCodeV1.graph.nodes[1] as Extract<(typeof referenceCodeV1.graph.nodes)[number], { kind: "task" }>).runner,
      inputPorts: { source: stringPort },
      bindings: { source: { kind: "ref", root: "input", name: "source" } },
      outputPorts: {},
    }],
    outputs: { result: { kind: "ref", root: "node", name: "candidate", path: ["result"] } },
  };
  return compiled(definition);
}

function childFactory(): CompiledFactory {
  const definition = structuredClone(referenceCatalogV1);
  const original = definition.graph.nodes.find(node => node.id === "static-catalog-code")!;
  if (original.kind !== "subfactory") throw new Error("fixture");
  definition.inputPorts = { source: stringPort };
  definition.outputPorts = { result: stringPort };
  definition.graph = {
    nodes: [{
      ...original,
      id: "child",
      dependsOn: [],
      inputPorts: { source: stringPort, instruction: stringPort },
      bindings: { source: { kind: "ref", root: "input", name: "source" }, instruction: { kind: "literal", value: "first" } },
      repairableInputs: ["instruction"],
      outputPorts: { result: stringPort },
    }],
    outputs: { result: { kind: "ref", root: "node", name: "child", path: ["result"] } },
  };
  return compiled(definition);
}

function start(factory: CompiledFactory, runId: string): { state: KernelState; commands: readonly KernelCommand[] } {
  const result = advanceKernel(factory, createKernelState(factory, runId, { source: "protected" }, 0), { kind: "start", id: `${runId}:start`, atMs: 0 });
  return { state: result.nextState, commands: result.commands };
}

test("repair changes only opted-in literal input and preserves prior candidate evidence", () => {
  const factory = taskFactory();
  let current = start(factory, "repair-input");
  const admission = current.commands.find(command => command.kind === "request-admission" && command.nodeId === "candidate")!;
  current = advanceKernel(factory, current.state, { kind: "admission-result", id: "admitted", atMs: 1, nodeId: "candidate", commandId: admission.id, candidateGeneration: 0, granted: true });
  const dispatch = current.commands.find(command => command.kind === "dispatch-node")!;
  current = advanceKernel(factory, current.nextState, { kind: "node-result", id: "done", atMs: 2, nodeId: "candidate", commandId: dispatch.id, candidateGeneration: 0, attempt: 1, output: { result: "old" } });

  expect(() => advanceKernel(factory, current.nextState, { kind: "repair", id: "protected-change", atMs: 4, nodeId: "candidate", reason: "repair", inputOverride: { source: "changed", instruction: "second" } })).toThrow("protected binding");
  const repaired = advanceKernel(factory, current.nextState, { kind: "repair", id: "repair", atMs: 4, nodeId: "candidate", reason: "repair", inputOverride: { source: "protected", instruction: "second" } });
  expect(repaired.nextState.nodes.candidate).toMatchObject({ candidateGeneration: 1, inputOverride: { source: "protected", instruction: "second" }, priorCandidates: [{ candidateGeneration: 0, inputOverride: { source: "protected", instruction: "first" }, output: { result: "old" } }] });
  const nextAdmission = repaired.commands.find(command => command.kind === "request-admission")!;
  const admitted = advanceKernel(factory, repaired.nextState, { kind: "admission-result", id: "readmitted", atMs: 4, nodeId: "candidate", commandId: nextAdmission.id, candidateGeneration: 1, granted: true });
  expect(admitted.commands.find(command => command.kind === "dispatch-node")).toMatchObject({ input: { source: "protected", instruction: "second" }, candidateGeneration: 1 });
});

test("replan waits for the current child attempt and dispatches only the sealed replacement", () => {
  const factory = childFactory();
  const current = start(factory, "replan-child");
  const active = current.commands.find(command => command.kind === "run-child")!;
  const original = (factory.definition.graph.nodes[0] as Extract<(typeof factory.definition.graph.nodes)[number], { kind: "subfactory" }>).factory;
  const replacement: FactoryReference = { id: original.id, version: "2", digest: `sha256:${"d".repeat(64)}` };
  const replanning = advanceKernel(factory, current.state, { kind: "replan", id: "replan", atMs: 1, nodeId: "child", reason: "replace defective transform", replacement, inputOverride: { source: "protected", instruction: "second" } });
  expect(replanning.nextState.pendingRepair).toMatchObject({ rootNodeId: "child", priorFactory: original, factoryOverride: replacement, inputOverride: { source: "protected", instruction: "second" } });
  expect(replanning.commands).toContainEqual(expect.objectContaining({ kind: "cancel-node", attemptCommandId: active.id }));
  expect(replanning.commands.some(command => command.kind === "run-child")).toBe(false);

  const stopped = advanceKernel(factory, replanning.nextState, { kind: "attempt-stopped", id: "stopped", atMs: 2, nodeId: "child", commandId: active.id, candidateGeneration: 0, attempt: 1 });
  expect(stopped.nextState.nodes.child).toMatchObject({ candidateGeneration: 1, factoryOverride: replacement, inputOverride: { source: "protected", instruction: "second" }, priorCandidates: [{ candidateGeneration: 0, factoryOverride: original, inputOverride: { source: "protected", instruction: "first" } }] });
  expect(stopped.commands.find(command => command.kind === "run-child")).toMatchObject({ factory: replacement, input: { source: "protected", instruction: "second" }, candidateGeneration: 1 });
  expect(() => assertKernelContinuationState(factory, stopped.nextState)).not.toThrow();
  expect(() => assertKernelContinuationState(factory, { ...stopped.nextState, nodes: { ...stopped.nextState.nodes, child: { ...stopped.nextState.nodes.child, factoryOverride: { ...replacement, id: "foreign" } } } })).toThrow("factory override");
  expect(() => assertKernelContinuationState(factory, { ...replanning.nextState, pendingRepair: { ...replanning.nextState.pendingRepair!, inputOverride: { source: "protected" } } })).toThrow("input override");
});

test("replan rejects another factory and ordinary repair keeps the current child override", () => {
  const factory = childFactory();
  const current = start(factory, "replan-fence");
  const original = (factory.definition.graph.nodes[0] as Extract<(typeof factory.definition.graph.nodes)[number], { kind: "subfactory" }>).factory;
  const foreign = { id: "foreign", version: "2", digest: `sha256:${"e".repeat(64)}` };
  const rejected = advanceKernel(factory, current.state, { kind: "replan", id: "foreign", atMs: 1, nodeId: "child", reason: "foreign", replacement: foreign });
  expect(rejected.nextState.pendingRepair).toBeUndefined();
  expect(rejected.commands).toEqual([]);
  const missing = advanceKernel(factory, current.state, { kind: "replan", id: "missing", atMs: 1, nodeId: "missing", reason: "missing", replacement: original });
  expect(missing.nextState.pendingRepair).toBeUndefined();
  expect(missing.commands).toEqual([]);
});
