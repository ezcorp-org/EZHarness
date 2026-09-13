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
