import { describe, expect, test } from "bun:test";
import { compileFactory } from "./compiler";
import { FactoryKernelError, advanceKernel, createPartitionKernelState } from "./kernel";
import { referenceCodeV1 } from "./references.js";
import type { CompiledFactory, FactoryDefinition, FactoryNode, KernelCommand, KernelState } from "./index";

const digest = `sha256:${"d".repeat(64)}`;
const runner = { package: "inert", version: "1", digest, export: "run" } as const;

function partitionedFactory(target: FactoryNode): CompiledFactory {
  const padding: FactoryNode[] = Array.from({ length: 128 }, (_, index) => ({
    id: `slow-${index.toString().padStart(3, "0")}`,
    kind: "task",
    runner,
  }));
  const definition: FactoryDefinition = {
    schemaVersion: "factory.v1",
    id: "partition-kernel-regression",
    version: "1",
    interpreterCompatibility: "1",
    inputPorts: {},
    outputPorts: {},
    graph: {
      nodes: [
        { id: "a", kind: "task", runner, outputPorts: { value: { type: "number" } } },
        ...padding,
        target,
      ],
      outputs: {},
    },
    acceptance: referenceCodeV1.acceptance,
    packages: [{ name: runner.package, version: runner.version, digest }, ...referenceCodeV1.packages],
    capabilities: [],
    effects: ["none"],
    bounds: { maxExpandedNodes: 10_000, maxScopeDepth: 16 },
  };
  const result = compileFactory(definition);
  if (!result.ok) throw new Error(result.diagnostics.map((diagnostic) => diagnostic.code).join(", "));
  return result.factory;
}

function command<T extends KernelCommand["kind"]>(commands: readonly KernelCommand[], kind: T, nodeId?: string): Extract<KernelCommand, { kind: T }> {
  const value = commands.find((candidate) => candidate.kind === kind && (nodeId === undefined || ("nodeId" in candidate && candidate.nodeId === nodeId)));
  if (!value) throw new Error(`missing ${kind} command${nodeId ? ` for ${nodeId}` : ""}`);
  return value as Extract<KernelCommand, { kind: T }>;
}

function start(factory: CompiledFactory, partitionId: string, runId: string) {
  return advanceKernel(factory, createPartitionKernelState(factory, partitionId, runId, {}, 0), { kind: "start", id: `${partitionId}-start`, atMs: 1 });
}

function completeTask(factory: CompiledFactory, state: KernelState, nodeId: string, output: Record<string, number>) {
  const admission = state.nodes[nodeId]!.attempts.at(-1)!;
  const admitted = advanceKernel(factory, state, {
    kind: "admission-result",
    id: `${nodeId}-admitted`,
    atMs: 2,
    nodeId,
    commandId: admission.commandId,
    candidateGeneration: admission.candidateGeneration,
    granted: true,
  });
  const dispatch = command(admitted.commands, "dispatch-node", nodeId);
  return advanceKernel(factory, admitted.nextState, {
    kind: "node-result",
    id: `${nodeId}-completed`,
    atMs: 3,
    nodeId,
    commandId: dispatch.id,
    candidateGeneration: dispatch.candidateGeneration,
    attempt: dispatch.attempt,
    output,
  });
}

function completionEvent(notification: Extract<KernelCommand, { kind: "notify-partition" }>, id = notification.id) {
  const { kind: _kind, id: _commandId, ...completion } = notification;
  return { kind: "partition-node-completed" as const, id, atMs: 4, ...completion };
}

describe("partition-local factory kernel", () => {
  test("releases a successor when its node completes while unrelated work remains active", () => {
    const factory = partitionedFactory({
      id: "z",
      kind: "task",
      runner,
      dependsOn: ["a"],
      inputPorts: { fromA: { type: "number" } },
      bindings: { fromA: { kind: "ref", root: "node", name: "a", path: ["value"] } },
    });
    const sourcePartition = factory.partitions.find((partition) => partition.nodeIds.includes("a"))!;
    const targetPartition = factory.partitions.find((partition) => partition.nodeIds.includes("z"))!;
    expect(sourcePartition.id).not.toBe(targetPartition.id);
    expect(factory.partitions.every((partition) => partition.nodeIds.length <= 128 && partition.encodedBytes <= 32 * 1024)).toBe(true);

    let source = start(factory, sourcePartition.id, "partition-run");
    expect(Object.keys(source.nextState.nodes).length).toBeLessThanOrEqual(128);
    const slowNodeId = sourcePartition.nodeIds.find((nodeId) => nodeId !== "a")!;
    const slowAdmission = command(source.commands, "request-admission", slowNodeId);
    source = advanceKernel(factory, source.nextState, {
      kind: "admission-result",
      id: "slow-admitted",
      atMs: 2,
      nodeId: slowNodeId,
      commandId: slowAdmission.id,
      candidateGeneration: slowAdmission.candidateGeneration,
      granted: true,
    });
    expect(source.nextState.nodes[slowNodeId]?.status).toBe("running");

    const target = start(factory, targetPartition.id, "partition-run");
    expect(target.nextState.nodes.z?.status).toBe("blocked");
    expect(target.commands.some((candidate) => candidate.kind === "request-admission" && candidate.nodeId === "z")).toBe(false);

    const completed = completeTask(factory, source.nextState, "a", { value: 7 });
    const notification = command(completed.commands, "notify-partition", "z");
    expect(completed.nextState.nodes[slowNodeId]?.status).toBe("running");
    expect(completed.nextState.status).toBe("running");
    expect(notification).toEqual(expect.objectContaining({
      sourcePartitionId: sourcePartition.id,
      targetPartitionId: targetPartition.id,
      sourceNodeId: "a",
      nodeId: "z",
      candidateGeneration: 0,
    }));

    const released = advanceKernel(factory, target.nextState, completionEvent(notification));
    expect(command(released.commands, "request-admission", "z")).toEqual(expect.objectContaining({ id: expect.stringContaining(`:${targetPartition.id}:z:`) }));
    const zAttempt = released.nextState.nodes.z!.attempts.at(-1)!;
    const admitted = advanceKernel(factory, released.nextState, {
      kind: "admission-result",
      id: "z-admitted",
      atMs: 5,
      nodeId: "z",
      commandId: zAttempt.commandId,
      candidateGeneration: zAttempt.candidateGeneration,
      granted: true,
    });
    expect(command(admitted.commands, "dispatch-node", "z").input).toEqual({ fromA: 7 });

    expect(advanceKernel(factory, released.nextState, completionEvent(notification)).commands).toEqual([]);
    expect(() => advanceKernel(factory, released.nextState, completionEvent({ ...notification, output: { value: 8 } }, "conflict"))).toThrow("recorded source fence");
    expect(() => advanceKernel(factory, target.nextState, completionEvent({ ...notification, terminalSequence: 0 }, "invalid-sequence"))).toThrow("partition completion fence");
    expect(() => advanceKernel(factory, target.nextState, completionEvent({ ...notification, candidateGeneration: -1 }, "invalid-generation"))).toThrow(FactoryKernelError);
    const unrelated = advanceKernel(factory, target.nextState, completionEvent({ ...notification, sourceNodeId: "other" }, "unrelated"));
    expect(unrelated.nextState.nodes.z?.status).toBe("blocked");
  });

  test("settles a cross-partition join from the fenced external outcome", () => {
    const factory = partitionedFactory({ id: "z", kind: "join", mode: "all", predecessors: ["a"] });
    const sourcePartition = factory.partitions.find((partition) => partition.nodeIds.includes("a"))!;
    const targetPartition = factory.partitions.find((partition) => partition.nodeIds.includes("z"))!;
    const source = start(factory, sourcePartition.id, "join-run");
    const completed = completeTask(factory, source.nextState, "a", { value: 11 });
    const notification = command(completed.commands, "notify-partition", "z");
    const target = start(factory, targetPartition.id, "join-run");
    const joined = advanceKernel(factory, target.nextState, completionEvent(notification));
    expect(joined.nextState.nodes.z).toEqual(expect.objectContaining({
      status: "succeeded",
      output: { winners: [{ nodeId: "a", outputs: { value: 11 } }] },
    }));
  });

  test("rejects unknown partitions and unknown nodes in a partition manifest", () => {
    const factory = partitionedFactory({ id: "z", kind: "task", runner, dependsOn: ["a"] });
    expect(() => createPartitionKernelState(factory, "missing", "run", {}, 0)).toThrow("does not exist");
    const damaged = {
      ...factory,
      partitions: [{ ...factory.partitions[0]!, nodeIds: ["missing"] }, ...factory.partitions.slice(1)],
    };
    expect(() => createPartitionKernelState(damaged, damaged.partitions[0]!.id, "run", {}, 0)).toThrow("unknown node");
  });

  test("ignores completion messages addressed to another partition", () => {
    const factory = partitionedFactory({ id: "z", kind: "task", runner, dependsOn: ["a"] });
    const sourcePartition = factory.partitions.find((partition) => partition.nodeIds.includes("a"))!;
    const targetPartition = factory.partitions.find((partition) => partition.nodeIds.includes("z"))!;
    const startedSource = start(factory, sourcePartition.id, "partition-run");
    const source = completeTask(factory, startedSource.nextState, "a", { value: 1 });
    const notification = command(source.commands, "notify-partition", "z");
    const target = start(factory, targetPartition.id, "partition-run");
    const unchanged = advanceKernel(factory, target.nextState, {
      ...completionEvent(notification),
      targetPartitionId: sourcePartition.id,
    });
    expect(unchanged.nextState.partition).toEqual(target.nextState.partition);
    expect(unchanged.nextState.nodes.z?.status).toBe("blocked");
    expect(unchanged.commands).toEqual([]);
  });
});
