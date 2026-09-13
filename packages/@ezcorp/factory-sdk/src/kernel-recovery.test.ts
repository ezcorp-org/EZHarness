import { expect, test } from "bun:test";
import { compileFactory } from "./compiler";
import { referenceCodeV1 } from "./references.js";
import { advanceKernel, createKernelState } from "./kernel";
import type { CompiledFactory, FactoryDefinition, FactoryNode, KernelState } from "./index";

const digest = "sha256:edededededededededededededededededededededededededededededededed";
const runner = { package: "inert", version: "1", digest, export: "run" } as const;
const string = { type: "string" } as const;

function compiled(nodes: readonly FactoryNode[]): CompiledFactory {
  const definition: FactoryDefinition = {
    schemaVersion: "factory.v1", id: "recovery-regression", version: "1", interpreterCompatibility: "1",
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

function admit(factory: CompiledFactory, state: KernelState, nodeId: string, atMs = 0): KernelState {
  const attempt = state.nodes[nodeId]?.attempts.at(-1);
  if (!attempt) throw new Error(`missing admission attempt for ${nodeId}`);
  return advanceKernel(factory, state, {
    kind: "admission-result", id: `${nodeId}:admit:${attempt.candidateGeneration}:${attempt.attempt}`, atMs, nodeId,
    commandId: attempt.commandId, candidateGeneration: attempt.candidateGeneration, granted: true,
  }).nextState;
}

test("repair invalidates completed descendants so they cannot reuse the replaced candidate output", () => {
  const factory = compiled([
    { id: "candidate", kind: "task", runner, outputPorts: { payload: string } },
    { id: "consumer", kind: "task", runner, dependsOn: ["candidate"], inputPorts: { payload: string }, outputPorts: { seen: string }, bindings: { payload: { kind: "ref", root: "node", name: "candidate", path: ["payload"] } } },
    { id: "hold", kind: "task", runner },
  ]);
  let state = start(factory, "repair-descendant");
  state = admit(factory, state, "candidate");
  const candidate = state.nodes.candidate!.attempts.at(-1)!;
  state = advanceKernel(factory, state, {
    kind: "node-result", id: "candidate:old-result", atMs: 1, nodeId: "candidate", commandId: candidate.commandId,
    candidateGeneration: candidate.candidateGeneration, attempt: candidate.attempt, output: { payload: "old" },
  }).nextState;
  state = admit(factory, state, "consumer", 1);
  const consumer = state.nodes.consumer!.attempts.at(-1)!;
  state = advanceKernel(factory, state, {
    kind: "node-result", id: "consumer:old-result", atMs: 2, nodeId: "consumer", commandId: consumer.commandId,
    candidateGeneration: consumer.candidateGeneration, attempt: consumer.attempt, output: { seen: "old" },
  }).nextState;

  const repaired = advanceKernel(factory, state, { kind: "repair", id: "candidate:repair", atMs: 3, nodeId: "candidate", reason: "replace candidate" });
  expect(repaired.nextState.nodes.candidate?.candidateGeneration).toBe(1);
  expect(repaired.nextState.nodes.candidate?.status).toBe("reserved");
  expect(repaired.nextState.nodes.consumer?.status).toBe("blocked");
  expect(repaired.nextState.nodes.consumer?.output).toBeUndefined();
  expect(repaired.commands.some((command) => command.kind === "dispatch-node" && command.nodeId === "consumer")).toBe(false);
});

test("malformed task output is fenced, retried, then fails only after its final stopped attempt", () => {
  const factory = compiled([{
    id: "work", kind: "task", runner, outputPorts: { value: string },
    retry: { maxAttempts: 2, initialDelayMs: 5, maximumDelayMs: 5 },
  }]);
  let state = start(factory, "malformed-output");
  state = admit(factory, state, "work");
  const first = state.nodes.work!.attempts.at(-1)!;
  const malformedFirst = advanceKernel(factory, state, {
    kind: "node-result", id: "first-invalid", atMs: 1, nodeId: "work", commandId: first.commandId,
    candidateGeneration: first.candidateGeneration, attempt: first.attempt, output: { value: 1 },
  });
  expect(malformedFirst.nextState.nodes.work?.status).toBe("stopping");
  expect(malformedFirst.nextState.nodes.work?.error).toBe("OUTPUT_INVALID");
  expect(malformedFirst.commands).toContainEqual(expect.objectContaining({ kind: "cancel-node", attemptCommandId: first.commandId }));

  const firstStopped = advanceKernel(factory, malformedFirst.nextState, {
    kind: "attempt-stopped", id: "first-stopped", atMs: 1, nodeId: "work", commandId: first.commandId,
    candidateGeneration: first.candidateGeneration, attempt: first.attempt,
  });
  expect(firstStopped.nextState.nodes.work?.status).toBe("retry_wait");
  const retryTimer = firstStopped.nextState.nodes.work?.timer;
  if (!retryTimer) throw new Error("missing retry timer");
  state = advanceKernel(factory, firstStopped.nextState, { kind: "timer-expired", id: "retry", atMs: retryTimer.deadlineAtMs, nodeId: "work", commandId: retryTimer.id }).nextState;
  state = admit(factory, state, "work", retryTimer.deadlineAtMs);
  const second = state.nodes.work!.attempts.at(-1)!;
  const malformedSecond = advanceKernel(factory, state, {
    kind: "node-result", id: "second-invalid", atMs: 10, nodeId: "work", commandId: second.commandId,
    candidateGeneration: second.candidateGeneration, attempt: second.attempt, output: { value: 2 },
  });
  const failed = advanceKernel(factory, malformedSecond.nextState, {
    kind: "attempt-stopped", id: "second-stopped", atMs: 10, nodeId: "work", commandId: second.commandId,
    candidateGeneration: second.candidateGeneration, attempt: second.attempt,
  });
  expect(failed.nextState.status).toBe("failed");
  expect(failed.nextState.nodes.work?.error).toBe("OUTPUT_INVALID");
  expect(failed.commands).toContainEqual(expect.objectContaining({ kind: "fail-run", error: "OUTPUT_INVALID" }));
});

test("forged and duplicate approval decisions and a post-success timer do not change terminal facts", () => {
  const approvalFactory = compiled([{
    id: "approval", kind: "approval", choices: ["approve", "deny"], context: { kind: "literal", value: {} }, actorScope: "operator", expiresInMs: 100,
    onDenied: "fail", onExpired: "fail", outputPorts: { choice: { type: "string", enum: ["approve", "deny"] } },
  }]);
  const started = advanceKernel(approvalFactory, createKernelState(approvalFactory, "approval-events", {}, 0), { kind: "start", id: "start", atMs: 0 });
  const request = started.nextState.nodes.approval!.attempts.at(-1)!;
  const forged = advanceKernel(approvalFactory, started.nextState, { kind: "approval-decided", id: "forged", atMs: 1, nodeId: "approval", commandId: "forged-command", choice: "approve" });
  expect(forged.nextState.nodes.approval?.status).toBe("waiting");
  const approved = advanceKernel(approvalFactory, forged.nextState, { kind: "approval-decided", id: "approved", atMs: 1, nodeId: "approval", commandId: request.commandId, choice: "approve" });
  const duplicate = advanceKernel(approvalFactory, approved.nextState, { kind: "approval-decided", id: "approved-again", atMs: 2, nodeId: "approval", commandId: request.commandId, choice: "deny" });
  expect(duplicate.nextState.nodes.approval?.status).toBe("succeeded");
  expect(duplicate.nextState.nodes.approval?.output).toEqual({ choice: "approve" });
  expect(duplicate.commands).toEqual([]);

  const taskFactory = compiled([{ id: "work", kind: "task", runner, deadlineMs: 10 }]);
  let task = start(taskFactory, "timer-after-success");
  task = admit(taskFactory, task, "work");
  const attempt = task.nodes.work!.attempts.at(-1)!;
  const timer = task.nodes.work?.timer;
  if (!timer) throw new Error("missing task deadline timer");
  task = advanceKernel(taskFactory, task, { kind: "node-result", id: "success", atMs: 1, nodeId: "work", commandId: attempt.commandId, candidateGeneration: attempt.candidateGeneration, attempt: attempt.attempt, output: {} }).nextState;
  const duplicateTimer = advanceKernel(taskFactory, task, { kind: "timer-expired", id: "deadline-after-success", atMs: timer.deadlineAtMs, nodeId: "work", commandId: timer.id });
  expect(duplicateTimer.nextState.status).toBe("completed");
  expect(duplicateTimer.nextState.nodes.work?.status).toBe("succeeded");
  expect(duplicateTimer.commands).toEqual([]);
});

test("an invalid required source result never dispatches its typed dependent boundary", () => {
  const factory = compiled([
    { id: "source", kind: "task", runner, retry: { maxAttempts: 1, initialDelayMs: 0, maximumDelayMs: 0 }, outputPorts: { payload: string } },
    { id: "dependent", kind: "task", runner, dependsOn: ["source"], inputPorts: { payload: string }, bindings: { payload: { kind: "ref", root: "node", name: "source", path: ["payload"] } } },
  ]);
  let state = start(factory, "invalid-source-boundary");
  state = admit(factory, state, "source");
  const source = state.nodes.source!.attempts.at(-1)!;
  const malformed = advanceKernel(factory, state, {
    kind: "node-result", id: "source-invalid", atMs: 1, nodeId: "source", commandId: source.commandId,
    candidateGeneration: source.candidateGeneration, attempt: source.attempt, output: { payload: 9 },
  });
  const stopped = advanceKernel(factory, malformed.nextState, {
    kind: "attempt-stopped", id: "source-stopped", atMs: 1, nodeId: "source", commandId: source.commandId,
    candidateGeneration: source.candidateGeneration, attempt: source.attempt,
  });
  expect(stopped.nextState.status).toBe("failed");
  expect(stopped.nextState.nodes.dependent?.status).toBe("failed");
  expect(stopped.commands.some((command) => command.kind === "request-admission" && command.nodeId === "dependent")).toBe(false);
  expect(stopped.commands.some((command) => command.kind === "dispatch-node" && command.nodeId === "dependent")).toBe(false);
});

function activeDependent() {
  const factory = compiled([
    { id: "candidate", kind: "task", runner, outputPorts: { payload: string } },
    { id: "consumer", kind: "task", runner, dependsOn: ["candidate"], inputPorts: { payload: string }, outputPorts: { seen: string }, bindings: { payload: { kind: "ref", root: "node", name: "candidate", path: ["payload"] } } },
  ]);
  let state = start(factory, "active-descendant-repair");
  state = admit(factory, state, "candidate");
  const candidate = state.nodes.candidate!.attempts.at(-1)!;
  state = advanceKernel(factory, state, { kind: "node-result", id: "candidate:result", atMs: 1, nodeId: "candidate", commandId: candidate.commandId, candidateGeneration: candidate.candidateGeneration, attempt: candidate.attempt, output: { payload: "old" } }).nextState;
  state = admit(factory, state, "consumer", 1);
  return { factory, state, candidate, consumer: state.nodes.consumer!.attempts.at(-1)! };
}

test("repair drains an active descendant before admitting a fresh candidate and preserves prior facts", () => {
  const setup = activeDependent();
  const repairing = advanceKernel(setup.factory, setup.state, { kind: "repair", id: "repair", atMs: 2, nodeId: "candidate", reason: "replace" });
  expect(repairing.nextState.pendingRepair?.rootNodeId).toBe("candidate");
  expect(repairing.nextState.nodes.candidate?.candidateGeneration).toBe(0);
  expect(repairing.nextState.nodes.consumer?.status).toBe("stopping");
  expect(repairing.commands).toContainEqual(expect.objectContaining({ kind: "cancel-node", nodeId: "consumer", attemptCommandId: setup.consumer.commandId }));
  expect(repairing.commands.some((command) => command.kind === "request-admission" && command.nodeId === "candidate" && command.candidateGeneration === 1)).toBe(false);

  const drained = advanceKernel(setup.factory, repairing.nextState, { kind: "attempt-stopped", id: "consumer:stopped", atMs: 2, nodeId: "consumer", commandId: setup.consumer.commandId, candidateGeneration: setup.consumer.candidateGeneration, attempt: setup.consumer.attempt });
  expect(drained.nextState.pendingRepair).toBeUndefined();
  expect(drained.nextState.nodes.candidate?.candidateGeneration).toBe(1);
  expect(drained.nextState.nodes.candidate?.priorCandidates).toContainEqual(expect.objectContaining({ candidateGeneration: 0, output: { payload: "old" } }));
  expect(drained.nextState.nodes.consumer?.status).toBe("blocked");

  const stale = advanceKernel(setup.factory, drained.nextState, { kind: "node-result", id: "candidate:stale-result", atMs: 3, nodeId: "candidate", commandId: setup.candidate.commandId, candidateGeneration: 0, attempt: 1, output: { payload: "stale" } });
  expect(stale.nextState.nodes.candidate?.output).toBeUndefined();
  const charged = advanceKernel(setup.factory, stale.nextState, { kind: "usage-settled", id: "candidate:old-charge", atMs: 3, nodeId: "candidate", commandId: setup.candidate.commandId, candidateGeneration: 0, attempt: 1, revision: 1, knownCostMicros: "4" });
  expect(charged.nextState.spentCostMicros).toBe("4");
});

test("global cancellation clears a pending repair and prevents a fresh candidate admission", () => {
  const setup = activeDependent();
  const repairing = advanceKernel(setup.factory, setup.state, { kind: "repair", id: "repair", atMs: 2, nodeId: "candidate", reason: "replace" });
  expect(repairing.nextState.status).toBe("running");
  const cancelled = advanceKernel(setup.factory, repairing.nextState, { kind: "cancel", id: "cancel", atMs: 2, reason: "operator" });
  expect(cancelled.nextState.pendingRepair).toBeUndefined();
  expect(cancelled.nextState.status).toBe("stopping");
  const stopped = advanceKernel(setup.factory, cancelled.nextState, { kind: "attempt-stopped", id: "consumer:stopped", atMs: 2, nodeId: "consumer", commandId: setup.consumer.commandId, candidateGeneration: setup.consumer.candidateGeneration, attempt: setup.consumer.attempt });
  expect(stopped.nextState.nodes.candidate?.candidateGeneration).toBe(0);
  expect(stopped.commands.some((command) => command.kind === "request-admission" && command.nodeId === "candidate" && command.candidateGeneration === 1)).toBe(false);
});

test("scoped map leaf repair invalidates its completed parent aggregate before re-execution", () => {
  const map: Extract<FactoryNode, { kind: "map" }> = {
    id: "map", kind: "map", collection: { kind: "literal", value: ["one"] }, itemSchema: string, mode: "all", maxItems: 1, maxConcurrency: 1,
    outputPorts: { result: { type: "array", items: string } }, body: { nodes: [{ id: "work", kind: "task", runner, outputPorts: { result: string } }], outputs: { result: { kind: "ref", root: "node", name: "work", path: ["result"] } } },
  };
  const factory = compiled([map, { id: "hold", kind: "task", runner }]);
  let state = start(factory, "scoped-map-repair");
  state = admit(factory, state, "map/items/0/work");
  const leaf = state.nodes["map/items/0/work"]!.attempts.at(-1)!;
  state = advanceKernel(factory, state, { kind: "node-result", id: "leaf:result", atMs: 1, nodeId: "map/items/0/work", commandId: leaf.commandId, candidateGeneration: leaf.candidateGeneration, attempt: leaf.attempt, output: { result: "old" } }).nextState;
  expect(state.nodes.map?.output).toEqual({ result: ["old"] });
  const repaired = advanceKernel(factory, state, { kind: "repair", id: "leaf:repair", atMs: 2, nodeId: "map/items/0/work", reason: "replace item" });
  expect(repaired.nextState.nodes.map?.status).toBe("waiting");
  expect(repaired.nextState.nodes.map?.output).toBeUndefined();
  expect(repaired.nextState.nodes["map/items/0/work"]?.candidateGeneration).toBe(1);
});

test("repair refuses a release after its external operation has been dispatched", () => {
  const factory = compiled([
    { id: "accept", kind: "acceptance", contract: referenceCodeV1.acceptance.id, candidate: { kind: "literal", value: "candidate" }, evidence: { kind: "literal", value: "evidence" }, outputPorts: { acceptedCandidate: string } },
    { id: "release", kind: "release", dependsOn: ["accept"], adapter: runner, acceptedCandidate: { kind: "ref", root: "node", name: "accept", path: ["acceptedCandidate"] }, destination: { kind: "literal", value: "destination" }, outputPorts: { receipt: string } },
  ]);
  let state = start(factory, "release-repair");
  const accepted = state.nodes.accept!.attempts.at(-1)!;
  state = advanceKernel(factory, state, { kind: "node-result", id: "accepted", atMs: 1, nodeId: "accept", commandId: accepted.commandId, candidateGeneration: accepted.candidateGeneration, attempt: accepted.attempt, output: { acceptedCandidate: "candidate" } }).nextState;
  const release = state.nodes.release!.attempts.at(-1)!;
  expect(state.nodes.release?.status).toBe("waiting");
  const repaired = advanceKernel(factory, state, { kind: "repair", id: "release:repair", atMs: 2, nodeId: "release", reason: "cannot replay publication" });
  expect(repaired.nextState.nodes.release?.candidateGeneration).toBe(release.candidateGeneration);
  expect(repaired.nextState.nodes.release?.status).toBe("waiting");
  expect(repaired.nextState.pendingRepair).toBeUndefined();
  expect(repaired.commands).toEqual([]);
});

test("repairing a nested branch/map/loop leaf invalidates every enclosing control result", () => {
  const loop: Extract<FactoryNode, { kind: "loop" }> = {
    id: "loop", kind: "loop", initialInput: { kind: "literal", value: "seed" }, carriedSchema: string,
    resultSchema: { type: "object", properties: { result: string }, required: ["result"], additionalProperties: false }, outputPorts: { result: string },
    body: { nodes: [{ id: "work", kind: "task", runner, outputPorts: { result: string } }], outputs: { result: { kind: "ref", root: "node", name: "work", path: ["result"] } } },
    until: { kind: "literal", value: true }, nextInput: { kind: "literal", value: "seed" }, maxIterations: 1, maxElapsedMs: 1_000, onExhausted: "fail",
  };
  const map: Extract<FactoryNode, { kind: "map" }> = {
    id: "map", kind: "map", collection: { kind: "literal", value: ["one"] }, itemSchema: string, mode: "all", maxItems: 1, maxConcurrency: 1,
    outputPorts: { result: { type: "array", items: string } }, body: { nodes: [loop], outputs: { result: { kind: "ref", root: "node", name: "loop", path: ["result"] } } },
  };
  const branch: Extract<FactoryNode, { kind: "branch" }> = {
    id: "branch", kind: "branch", condition: { kind: "literal", value: true }, outputPorts: { result: { type: "array", items: { type: ["string", "null"] } } },
    then: { nodes: [map], outputs: { result: { kind: "ref", root: "node", name: "map", path: ["result"] } } }, else: { nodes: [], outputs: { result: { kind: "literal", value: [] } } },
  };
  const factory = compiled([branch, { id: "hold", kind: "task", runner }]);
  const leafId = "branch/then/map/items/0/loop/items/0/work";
  let state = start(factory, "nested-control-repair");
  state = admit(factory, state, leafId);
  const leaf = state.nodes[leafId]!.attempts.at(-1)!;
  state = advanceKernel(factory, state, { kind: "node-result", id: "nested:result", atMs: 1, nodeId: leafId, commandId: leaf.commandId, candidateGeneration: leaf.candidateGeneration, attempt: leaf.attempt, output: { result: "old" } }).nextState;
  expect(state.nodes.branch?.output).toEqual({ result: ["old"] });
  const repaired = advanceKernel(factory, state, { kind: "repair", id: "nested:repair", atMs: 2, nodeId: leafId, reason: "replace nested leaf" });
  expect(repaired.nextState.nodes.branch?.status).toBe("waiting");
  expect(repaired.nextState.nodes.branch?.output).toBeUndefined();
  expect(repaired.nextState.nodes["branch/then/map"]?.status).toBe("waiting");
  expect(repaired.nextState.nodes["branch/then/map/items/0/loop"]?.status).toBe("waiting");
});
