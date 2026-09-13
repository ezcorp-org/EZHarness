import { describe, expect, test } from "bun:test";
import { compileFactory } from "./compiler";
import { FactoryKernelError, advanceKernel, createPartitionKernelState } from "./kernel";
import { referenceCodeV1 } from "./references.js";
import type { CompiledFactory, FactoryDefinition, FactoryNode, KernelCommand, KernelState } from "./index";

const digest = `sha256:${"d".repeat(64)}`;
const runner = { package: "inert", version: "1", digest, export: "run" } as const;

function partitionedFactory(target: FactoryNode | readonly FactoryNode[]): CompiledFactory {
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
        ...(Array.isArray(target) ? target : [target]),
      ],
      outputs: {},
    },
    acceptance: referenceCodeV1.acceptance,
    packages: [{ name: runner.package, version: runner.version, digest }, ...referenceCodeV1.packages],
    capabilities: [],
    effects: [...new Set(["none", ...(Array.isArray(target) ? target : [target]).flatMap((item) => item.effects ?? [])])],
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
    id: `${nodeId}-${admission.candidateGeneration}-admitted`,
    atMs: 2,
    nodeId,
    commandId: admission.commandId,
    candidateGeneration: admission.candidateGeneration,
    granted: true,
  });
  const dispatch = command(admitted.commands, "dispatch-node", nodeId);
  return advanceKernel(factory, admitted.nextState, {
    kind: "node-result",
    id: `${nodeId}-${dispatch.candidateGeneration}-completed`,
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

function invalidationEvent(notification: Extract<KernelCommand, { kind: "invalidate-partition" }>, id = notification.id) {
  const { kind: _kind, id: _commandId, ...invalidation } = notification;
  return { kind: "partition-source-invalidated" as const, id, atMs: 5, ...invalidation };
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

  test("repairs a partition source without traversing foreign state", () => {
    const factory = partitionedFactory({ id: "z", kind: "task", runner, dependsOn: ["a"] });
    const sourcePartition = factory.partitions.find((partition) => partition.nodeIds.includes("a"))!;
    const started = start(factory, sourcePartition.id, "repair-source");
    const completed = completeTask(factory, started.nextState, "a", { value: 1 });
    const repaired = advanceKernel(factory, completed.nextState, { kind: "repair", id: "repair-a", atMs: 5, nodeId: "a", reason: "retry source" });
    const admission = command(repaired.commands, "request-admission", "a");
    expect(admission.candidateGeneration).toBe(1);
    expect(repaired.nextState.nodes.a?.candidateGeneration).toBe(1);
    expect(Object.keys(repaired.nextState.nodes)).not.toContain("z");
  });

  test("invalidates a waiting approval before a repaired source completes again", () => {
    const factory = partitionedFactory({
      id: "z",
      kind: "approval",
      dependsOn: ["a"],
      choices: ["approve"],
      context: { kind: "literal", value: null },
      actorScope: "owner",
      expiresInMs: 60_000,
      onDenied: "fail",
      onExpired: "fail",
    });
    const sourcePartition = factory.partitions.find((partition) => partition.nodeIds.includes("a"))!;
    const targetPartition = factory.partitions.find((partition) => partition.nodeIds.includes("z"))!;
    const sourceDone = completeTask(factory, start(factory, sourcePartition.id, "repair-approval").nextState, "a", { value: 1 });
    const original = command(sourceDone.commands, "notify-partition", "z");
    const targetStarted = advanceKernel(factory, start(factory, targetPartition.id, "repair-approval").nextState, completionEvent(original));
    const oldApproval = command(targetStarted.commands, "request-approval", "z");

    const sourceRepair = advanceKernel(factory, sourceDone.nextState, { kind: "repair", id: "repair-source-a", atMs: 5, nodeId: "a", reason: "replace input" });
    const invalidation = command(sourceRepair.commands, "invalidate-partition", "z");
    expect(invalidation.candidateGeneration).toBe(1);
    expect(advanceKernel(factory, targetStarted.nextState, invalidationEvent({ ...invalidation, targetPartitionId: sourcePartition.id }, "wrong-target")).nextState.partition).toEqual(targetStarted.nextState.partition);
    expect(advanceKernel(factory, targetStarted.nextState, invalidationEvent({ ...invalidation, sourceNodeId: "unrelated" }, "unrelated-source")).nextState.partition).toEqual(targetStarted.nextState.partition);
    expect(() => advanceKernel(factory, targetStarted.nextState, invalidationEvent({ ...invalidation, candidateGeneration: 0 }, "invalid-generation"))).toThrow("positive safe integer");
    const targetInvalidated = advanceKernel(factory, targetStarted.nextState, invalidationEvent(invalidation));
    const cancelApproval = command(targetInvalidated.commands, "cancel-node", "z");
    expect(targetInvalidated.nextState.partition?.externalOutputs.a).toBeUndefined();
    expect(targetInvalidated.nextState.partition?.completedEdges).toEqual({});
    expect(targetInvalidated.nextState.pendingRepair?.nodeIds).toContain("z");
    const replayable = { ...targetInvalidated.nextState, appliedEventIds: targetInvalidated.nextState.appliedEventIds.filter((id) => id !== invalidation.id) };
    expect(advanceKernel(factory, replayable, invalidationEvent(invalidation)).commands).toEqual([]);
    expect(() => advanceKernel(factory, replayable, invalidationEvent({ ...invalidation, id: "conflicting-invalidation" }))).toThrow("recorded source fence");
    const edgeKey = `${invalidation.sourcePartitionId}\u0000${invalidation.sourceNodeId}\u0000${invalidation.nodeId}`;
    const ahead = { ...replayable, partition: { ...replayable.partition!, invalidatedEdges: { [edgeKey]: { candidateGeneration: 2, eventId: "generation-two" } } } };
    expect(advanceKernel(factory, ahead, invalidationEvent({ ...invalidation, id: "stale-invalidation" })).nextState).toEqual(expect.objectContaining({ partition: ahead.partition }));

    const oldDecision = advanceKernel(factory, targetInvalidated.nextState, { kind: "approval-decided", id: "old-approval", atMs: 6, nodeId: "z", commandId: oldApproval.id, choice: "approve" });
    expect(oldDecision.nextState.nodes.z?.status).toBe("stopping");
    const stopped = advanceKernel(factory, oldDecision.nextState, { kind: "attempt-stopped", id: "old-approval-stopped", atMs: 7, nodeId: "z", commandId: cancelApproval.attemptCommandId, candidateGeneration: cancelApproval.candidateGeneration, attempt: cancelApproval.attempt });
    expect(stopped.nextState.nodes.z).toEqual(expect.objectContaining({ status: "blocked", candidateGeneration: 1 }));
    expect(stopped.commands.some((candidate) => candidate.kind === "request-approval")).toBe(false);

    const replacementDone = completeTask(factory, sourceRepair.nextState, "a", { value: 2 });
    const replacement = command(replacementDone.commands, "notify-partition", "z");
    expect(replacement.candidateGeneration).toBe(1);
    const targetRestarted = advanceKernel(factory, stopped.nextState, completionEvent(replacement, "replacement-completed"));
    const newApproval = command(targetRestarted.commands, "request-approval", "z");
    expect(newApproval.id).not.toBe(oldApproval.id);
    expect(targetRestarted.nextState.partition?.invalidatedEdges).toEqual({});
    expect(advanceKernel(factory, targetRestarted.nextState, invalidationEvent({ ...invalidation, id: "already-current" })).nextState.partition).toEqual(targetRestarted.nextState.partition);
    const replayedOldDecision = advanceKernel(factory, targetRestarted.nextState, { kind: "approval-decided", id: "old-approval-replayed", atMs: 8, nodeId: "z", commandId: oldApproval.id, choice: "approve" });
    expect(replayedOldDecision.nextState.nodes.z?.status).toBe("waiting");
  });

  test("records every fan-out edge invalidation without conflating their identities", () => {
    const factory = partitionedFactory([
      { id: "z", kind: "task", runner, dependsOn: ["a"] },
      { id: "zz", kind: "task", runner, dependsOn: ["a"] },
    ]);
    const sourcePartition = factory.partitions.find((partition) => partition.nodeIds.includes("a"))!;
    const targetPartition = factory.partitions.find((partition) => partition.nodeIds.includes("z"))!;
    expect(targetPartition.nodeIds).toContain("zz");
    const sourceDone = completeTask(factory, start(factory, sourcePartition.id, "repair-fan-out").nextState, "a", { value: 1 });
    const completions = sourceDone.commands.filter((candidate): candidate is Extract<KernelCommand, { kind: "notify-partition" }> => candidate.kind === "notify-partition");
    let target = start(factory, targetPartition.id, "repair-fan-out").nextState;
    for (const completion of completions) target = advanceKernel(factory, target, completionEvent(completion)).nextState;

    const sourceRepair = advanceKernel(factory, sourceDone.nextState, { kind: "repair", id: "repair-fan-out-source", atMs: 5, nodeId: "a", reason: "replace input" });
    const invalidations = sourceRepair.commands.filter((candidate): candidate is Extract<KernelCommand, { kind: "invalidate-partition" }> => candidate.kind === "invalidate-partition");
    expect(invalidations).toHaveLength(2);
    expect(new Set(invalidations.map((candidate) => candidate.id)).size).toBe(2);
    for (const invalidation of invalidations) target = advanceKernel(factory, target, invalidationEvent(invalidation)).nextState;
    expect(Object.keys(target.partition?.invalidatedEdges ?? {})).toHaveLength(2);
    expect(target.partition?.completedEdges).toEqual({});
  });

  test("propagates a source invalidation through an intermediate partition immediately", () => {
    const sourcePadding: FactoryNode[] = Array.from({ length: 256 }, (_, index) => ({
      id: `before-middle-${index.toString().padStart(3, "0")}`,
      kind: "task",
      runner,
    }));
    const targetPadding: FactoryNode[] = Array.from({ length: 256 }, (_, index) => ({
      id: `next-middle-${index.toString().padStart(3, "0")}`,
      kind: "task",
      runner,
    }));
    const factory = partitionedFactory([
      ...sourcePadding,
      { id: "m", kind: "task", runner, dependsOn: ["a"], outputPorts: { value: { type: "number" } } },
      ...targetPadding,
      {
        id: "z",
        kind: "approval",
        dependsOn: ["m"],
        choices: ["approve"],
        context: { kind: "literal", value: null },
        actorScope: "owner",
        expiresInMs: 60_000,
        onDenied: "fail",
        onExpired: "fail",
      },
    ]);
    const sourcePartition = factory.partitions.find((partition) => partition.nodeIds.includes("a"))!;
    const middlePartition = factory.partitions.find((partition) => partition.nodeIds.includes("m"))!;
    const targetPartition = factory.partitions.find((partition) => partition.nodeIds.includes("z"))!;
    expect(new Set([sourcePartition.id, middlePartition.id, targetPartition.id]).size).toBe(3);

    const sourceDone = completeTask(factory, start(factory, sourcePartition.id, "repair-transitive").nextState, "a", { value: 1 });
    const sourceCompletion = command(sourceDone.commands, "notify-partition", "m");
    const middleStarted = advanceKernel(factory, start(factory, middlePartition.id, "repair-transitive").nextState, completionEvent(sourceCompletion));
    const middleDone = completeTask(factory, middleStarted.nextState, "m", { value: 1 });
    const middleCompletion = command(middleDone.commands, "notify-partition", "z");
    const targetStarted = advanceKernel(factory, start(factory, targetPartition.id, "repair-transitive").nextState, completionEvent(middleCompletion));
    expect(command(targetStarted.commands, "request-approval", "z")).toBeDefined();

    const sourceRepair = advanceKernel(factory, sourceDone.nextState, { kind: "repair", id: "repair-transitive-source", atMs: 5, nodeId: "a", reason: "replace input" });
    const sourceInvalidation = command(sourceRepair.commands, "invalidate-partition", "m");
    const middleInvalidated = advanceKernel(factory, middleDone.nextState, invalidationEvent(sourceInvalidation));
    const transitiveInvalidation = command(middleInvalidated.commands, "invalidate-partition", "z");
    const targetInvalidated = advanceKernel(factory, targetStarted.nextState, invalidationEvent(transitiveInvalidation));
    expect(targetInvalidated.nextState.nodes.z).toEqual(expect.objectContaining({ status: "stopping" }));
    expect(targetInvalidated.nextState.partition?.externalOutputs.m).toBeUndefined();
  });

  test("retains a second incoming edge fence while the first invalidation is stopping the target", () => {
    const factory = partitionedFactory({
      id: "z",
      kind: "approval",
      dependsOn: ["a", "slow-000"],
      choices: ["approve"],
      context: { kind: "literal", value: null },
      actorScope: "owner",
      expiresInMs: 60_000,
      onDenied: "fail",
      onExpired: "fail",
    });
    const sourcePartition = factory.partitions.find((partition) => partition.nodeIds.includes("a"))!;
    const targetPartition = factory.partitions.find((partition) => partition.nodeIds.includes("z"))!;
    let source = start(factory, sourcePartition.id, "repair-two-inputs").nextState;
    const firstDone = completeTask(factory, source, "a", { value: 1 });
    source = firstDone.nextState;
    const secondDone = completeTask(factory, source, "slow-000", {});
    const completions = [...firstDone.commands, ...secondDone.commands].filter((candidate): candidate is Extract<KernelCommand, { kind: "notify-partition" }> => candidate.kind === "notify-partition" && candidate.nodeId === "z");
    let target = start(factory, targetPartition.id, "repair-two-inputs").nextState;
    for (const completion of completions) target = advanceKernel(factory, target, completionEvent(completion)).nextState;
    const approval = target.nodes.z?.attempts.at(-1);
    expect(approval).toBeDefined();

    const firstEdge = targetPartition.inbound.find((edge) => edge.fromNodeId === "a")!;
    const secondEdge = targetPartition.inbound.find((edge) => edge.fromNodeId === "slow-000")!;
    const invalidation = (edge: typeof firstEdge, id: string) => ({
      kind: "partition-source-invalidated" as const,
      id,
      atMs: 5,
      sourcePartitionId: edge.fromPartitionId,
      targetPartitionId: targetPartition.id,
      sourceNodeId: edge.fromNodeId,
      nodeId: edge.nodeId,
      candidateGeneration: 1,
    });
    target = advanceKernel(factory, target, invalidation(firstEdge, "invalidate-a")).nextState;
    expect(target.pendingRepair).toBeDefined();
    target = advanceKernel(factory, target, invalidation(secondEdge, "invalidate-slow")).nextState;
    expect(Object.keys(target.partition?.invalidatedEdges ?? {})).toHaveLength(2);
    expect(target.pendingRepair?.nodeIds).toContain("z");
  });

  test("fails closed instead of replaying a release after source invalidation", () => {
    const artifact = { digest, mediaType: "application/json", storage: "immutable" };
    const releaseTemplate = referenceCodeV1.graph.nodes.find((node) => node.kind === "release")!;
    const factory = partitionedFactory([
      {
        id: "z",
        kind: "acceptance",
        dependsOn: ["a"],
        contract: referenceCodeV1.acceptance.id,
        candidate: { kind: "literal", value: artifact },
        evidence: { kind: "literal", value: null },
        outputPorts: { acceptedCandidate: { type: "object", additionalProperties: true } },
      },
      {
        ...releaseTemplate,
        id: "zz",
        dependsOn: ["z"],
        acceptedCandidate: { kind: "ref", root: "node", name: "z", path: ["acceptedCandidate"] },
        destination: { kind: "literal", value: "destination" },
      },
    ]);
    const sourcePartition = factory.partitions.find((partition) => partition.nodeIds.includes("a"))!;
    const targetPartition = factory.partitions.find((partition) => partition.nodeIds.includes("z"))!;
    const sourceDone = completeTask(factory, start(factory, sourcePartition.id, "repair-release").nextState, "a", { value: 1 });
    const original = command(sourceDone.commands, "notify-partition", "z");
    const targetStarted = advanceKernel(factory, start(factory, targetPartition.id, "repair-release").nextState, completionEvent(original));
    const acceptance = command(targetStarted.commands, "request-acceptance", "z");
    const releasing = advanceKernel(factory, targetStarted.nextState, { kind: "node-result", id: "acceptance-result", atMs: 5, nodeId: "z", commandId: acceptance.id, candidateGeneration: acceptance.candidateGeneration, attempt: 1, output: { acceptedCandidate: artifact } });
    expect(command(releasing.commands, "request-release", "zz")).toBeDefined();
    const sourceRepair = advanceKernel(factory, sourceDone.nextState, { kind: "repair", id: "repair-release-source", atMs: 5, nodeId: "a", reason: "replace source" });
    const invalidation = command(sourceRepair.commands, "invalidate-partition", "z");
    const stopped = advanceKernel(factory, releasing.nextState, invalidationEvent(invalidation));
    expect(stopped.nextState).toEqual(expect.objectContaining({ status: "stopping", stopReason: "PARTITION_SOURCE_INVALIDATED_AFTER_RELEASE" }));
    expect(command(stopped.commands, "cancel-node", "zz")).toBeDefined();
  });

  test("repairs a running local descendant when an external generation advances", () => {
    const factory = partitionedFactory([
      { id: "z", kind: "task", runner, dependsOn: ["a"], inputPorts: { fromA: { type: "number" } }, bindings: { fromA: { kind: "ref", root: "node", name: "a", path: ["value"] } } },
      { id: "zz", kind: "task", runner, dependsOn: ["z"] },
    ]);
    const sourcePartition = factory.partitions.find((partition) => partition.nodeIds.includes("a"))!;
    const targetPartition = factory.partitions.find((partition) => partition.nodeIds.includes("z"))!;
    expect(targetPartition.nodeIds).toContain("zz");
    const sourceStart = start(factory, sourcePartition.id, "repair-run");
    const sourceDone = completeTask(factory, sourceStart.nextState, "a", { value: 1 });
    const original = command(sourceDone.commands, "notify-partition", "z");
    let target = advanceKernel(factory, start(factory, targetPartition.id, "repair-run").nextState, completionEvent(original));
    const zAdmission = command(target.commands, "request-admission", "z");
    target = advanceKernel(factory, target.nextState, { kind: "admission-result", id: "z-admitted", atMs: 5, nodeId: "z", commandId: zAdmission.id, candidateGeneration: 0, granted: true });
    const zDispatch = command(target.commands, "dispatch-node", "z");
    target = advanceKernel(factory, target.nextState, { kind: "node-result", id: "z-result", atMs: 6, nodeId: "z", commandId: zDispatch.id, candidateGeneration: 0, attempt: 1, output: {} });
    const descendantAdmission = command(target.commands, "request-admission", "zz");
    target = advanceKernel(factory, target.nextState, { kind: "admission-result", id: "zz-admitted", atMs: 7, nodeId: "zz", commandId: descendantAdmission.id, candidateGeneration: 0, granted: true });
    const descendantDispatch = command(target.commands, "dispatch-node", "zz");

    const replacement = { ...original, id: "a-generation-1", candidateGeneration: 1, terminalSequence: original.terminalSequence + 1, output: { value: 2 } };
    const invalidated = advanceKernel(factory, target.nextState, completionEvent(replacement));
    expect(command(invalidated.commands, "cancel-node", "zz").attemptCommandId).toBe(descendantDispatch.id);
    expect(invalidated.nextState.pendingRepair?.nodeIds).toEqual(expect.arrayContaining(["z", "zz"]));

    const late = advanceKernel(factory, invalidated.nextState, { kind: "node-result", id: "late-zz", atMs: 9, nodeId: "zz", commandId: descendantDispatch.id, candidateGeneration: 0, attempt: 1, output: {} });
    expect(late.nextState.pendingRepair).toBeDefined();
    expect(late.nextState.nodes.zz?.status).toBe("stopping");
    const stopped = advanceKernel(factory, late.nextState, { kind: "attempt-stopped", id: "zz-stopped", atMs: 10, nodeId: "zz", commandId: descendantDispatch.id, candidateGeneration: 0, attempt: 1 });
    expect(stopped.nextState.pendingRepair).toBeUndefined();
    expect(stopped.nextState.nodes.z?.candidateGeneration).toBe(1);
    expect(stopped.nextState.nodes.zz?.candidateGeneration).toBe(1);
    expect(command(stopped.commands, "request-admission", "z").candidateGeneration).toBe(1);
  });

  test("settles quorum impossibility after a failed external candidate", () => {
    const factory = partitionedFactory({ id: "z", kind: "join", mode: "quorum", quorum: 1, predecessors: ["a"], eligibleOutcomes: ["succeeded"] });
    const sourcePartition = factory.partitions.find((partition) => partition.nodeIds.includes("a"))!;
    const targetPartition = factory.partitions.find((partition) => partition.nodeIds.includes("z"))!;
    const target = start(factory, targetPartition.id, "failed-external");
    const failed = advanceKernel(factory, target.nextState, {
      kind: "partition-node-completed",
      id: "a-failed",
      atMs: 4,
      sourcePartitionId: sourcePartition.id,
      targetPartitionId: targetPartition.id,
      sourceNodeId: "a",
      nodeId: "z",
      candidateGeneration: 0,
      terminalSequence: 3,
      outcome: "failed",
      error: "SOURCE_FAILED",
    });
    expect(failed.nextState.nodes.z).toEqual(expect.objectContaining({ status: "failed", error: "QUORUM_UNREACHABLE" }));
  });

  test("notifies downstream partitions when a source candidate is cancelled", () => {
    const compiled = partitionedFactory({ id: "z", kind: "task", runner, dependsOn: ["a"] });
    const sourcePartition = compiled.partitions.find((partition) => partition.nodeIds.includes("a"))!;
    const factory = { ...compiled, partitions: compiled.partitions.map((partition) => partition.id === sourcePartition.id ? { ...partition, nodeIds: ["a"] } : partition) };
    let source = start(factory, sourcePartition.id, "failed-source");
    const admission = command(source.commands, "request-admission", "a");
    source = advanceKernel(factory, source.nextState, { kind: "cancel", id: "cancel-source", atMs: 2, reason: "USER_CANCELLED" });
    source = advanceKernel(factory, source.nextState, { kind: "attempt-stopped", id: "a-stopped", atMs: 3, nodeId: "a", commandId: admission.id, candidateGeneration: 0, attempt: 1 });
    expect(command(source.commands, "notify-partition", "z")).toEqual(expect.objectContaining({ outcome: "cancelled", error: "USER_CANCELLED" }));
  });
});
