import { expect, test } from "bun:test";
import { compileFactory } from "./compiler";
import { advanceKernel, createKernelState } from "./kernel";
import type { CompiledFactory, FactoryDefinition, FactoryNode, KernelState } from "./index";

const digest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const runner = { package: "inert", version: "1", digest, export: "run" } as const;

function compiled(nodes: readonly FactoryNode[]): CompiledFactory {
  const definition: FactoryDefinition = {
    schemaVersion: "factory.v1", id: "deadline-regression", version: "1", interpreterCompatibility: "1",
    inputPorts: {}, outputPorts: {}, graph: { nodes, outputs: {} }, acceptance: { id: "none", version: "1", claims: [] },
    packages: [{ name: runner.package, version: runner.version, digest }], capabilities: [], effects: ["none"],
    bounds: { maxExpandedNodes: 100, maxScopeDepth: 16 },
  };
  const result = compileFactory(definition);
  if (!result.ok) throw new Error(result.diagnostics.map((diagnostic) => diagnostic.code).join(", "));
  return result.factory;
}

function start(graph: CompiledFactory, runId: string) {
  return advanceKernel(graph, createKernelState(graph, runId, {}, 0), { kind: "start", id: `${runId}-start`, atMs: 0 });
}

function admit(graph: CompiledFactory, state: KernelState, nodeId: string, id: string) {
  const attempt = state.nodes[nodeId]?.attempts.at(-1);
  if (!attempt) throw new Error(`missing admission for ${nodeId}`);
  return advanceKernel(graph, state, { kind: "admission-result", id, atMs: 0, nodeId, commandId: attempt.commandId, candidateGeneration: attempt.candidateGeneration, granted: true });
}

test("a forged or early approval timer cannot expire an approval", () => {
  const graph = compiled([{ id: "approval", kind: "approval", choices: ["approve"], context: { kind: "literal", value: {} }, actorScope: "operator", expiresInMs: 100, onDenied: "fail", onExpired: "fail" }]);
  const started = start(graph, "approval-timer");
  const request = started.commands.find((command) => command.kind === "request-approval");
  expect(request?.deadlineAtMs).toBe(100);

  for (const timer of [
    { id: "forged-timer", atMs: 1, commandId: "not-the-approval-command" },
    { id: "early-real-timer", atMs: 99, commandId: request!.id },
  ]) {
    const result = advanceKernel(graph, started.nextState, { kind: "timer-expired", nodeId: "approval", ...timer });
    expect(result.nextState.nodes.approval?.status).toBe("waiting");
    expect(result.nextState.status).toBe("running");
    expect(result.commands).toEqual([]);
  }
});

test("an old attempt deadline cannot dispatch a newer retry early", () => {
  const graph = compiled([{ id: "work", kind: "task", runner, deadlineMs: 20, retry: { maxAttempts: 2, initialDelayMs: 50, maximumDelayMs: 50 } }]);
  let state = start(graph, "old-timer").nextState;
  const admitted = admit(graph, state, "work", "admit-first");
  state = admitted.nextState;
  const first = state.nodes.work!.attempts.at(-1)!;
  const oldTimer = admitted.commands.find((command) => command.kind === "start-timer")!;
  state = advanceKernel(graph, state, { kind: "node-failed", id: "first-failed", atMs: 1, nodeId: "work", commandId: first.commandId, candidateGeneration: first.candidateGeneration, attempt: first.attempt, error: "transient" }).nextState;
  state = advanceKernel(graph, state, { kind: "attempt-stopped", id: "first-stopped", atMs: 1, nodeId: "work", commandId: first.commandId, candidateGeneration: first.candidateGeneration, attempt: first.attempt }).nextState;
  expect(state.nodes.work?.status).toBe("retry_wait");

  const stale = advanceKernel(graph, state, { kind: "timer-expired", id: "old-attempt-deadline", atMs: oldTimer.deadlineAtMs, nodeId: "work", commandId: oldTimer.id });
  expect(stale.nextState.nodes.work?.status).toBe("retry_wait");
  expect(stale.commands).toEqual([]);
});

test("a running attempt deadline requests cancellation and waits for confirmation", () => {
  const graph = compiled([{ id: "work", kind: "task", runner, deadlineMs: 10 }]);
  let state = start(graph, "long-running").nextState;
  const admitted = admit(graph, state, "work", "admit-work");
  state = admitted.nextState;
  const attempt = state.nodes.work!.attempts.at(-1)!;
  const timer = admitted.commands.find((command) => command.kind === "start-timer")!;

  const expired = advanceKernel(graph, state, { kind: "timer-expired", id: "work-deadline", atMs: timer.deadlineAtMs, nodeId: "work", commandId: timer.id });
  expect(expired.nextState.status).toBe("stopping");
  expect(expired.nextState.nodes.work?.status).toBe("stopping");
  expect(expired.commands).toContainEqual(expect.objectContaining({ kind: "cancel-node", nodeId: "work", attemptCommandId: attempt.commandId }));
  expect(expired.commands.some((command) => command.kind === "fail-run")).toBe(false);

  const stopped = advanceKernel(graph, expired.nextState, { kind: "attempt-stopped", id: "deadline-stopped", atMs: 10, nodeId: "work", commandId: attempt.commandId, candidateGeneration: attempt.candidateGeneration, attempt: attempt.attempt });
  expect(stopped.nextState.status).toBe("failed");
  expect(stopped.commands).toContainEqual(expect.objectContaining({ kind: "fail-run" }));
});

test("cancelling an active retry-enabled attempt never schedules a retry after stop", () => {
  const graph = compiled([{ id: "work", kind: "task", runner, retry: { maxAttempts: 2, initialDelayMs: 10, maximumDelayMs: 10 } }]);
  let state = start(graph, "cancel-retry").nextState;
  state = admit(graph, state, "work", "admit-work").nextState;
  const attempt = state.nodes.work!.attempts.at(-1)!;
  const cancelling = advanceKernel(graph, state, { kind: "cancel", id: "cancel", atMs: 1, reason: "operator" });
  const stopped = advanceKernel(graph, cancelling.nextState, { kind: "attempt-stopped", id: "stopped", atMs: 1, nodeId: "work", commandId: attempt.commandId, candidateGeneration: attempt.candidateGeneration, attempt: attempt.attempt });
  expect(stopped.nextState.status).toBe("cancelled");
  expect(stopped.nextState.nodes.work?.status).toBe("stopping");
  expect(stopped.commands.some((command) => command.kind === "start-timer")).toBe(false);
  expect(stopped.commands).toContainEqual(expect.objectContaining({ kind: "cancel-run" }));
});

test("loop maxElapsedMs installs expiry, cancels its active child, then fails after stop", () => {
  const loop: Extract<FactoryNode, { readonly kind: "loop" }> = {
    id: "loop", kind: "loop", initialInput: { kind: "literal", value: "seed" }, carriedSchema: { type: "string" }, resultSchema: { type: "string" },
    body: { nodes: [{ id: "child", kind: "task", runner, deadlineMs: 100 }], outputs: {} },
    until: { kind: "literal", value: false }, nextInput: { kind: "literal", value: "seed" }, maxIterations: 10, maxElapsedMs: 5, onExhausted: "fail",
  };
  const graph = compiled([loop]);
  const started = start(graph, "loop-elapsed");
  expect(started.commands).toContainEqual(expect.objectContaining({ kind: "start-timer", nodeId: "loop", deadlineAtMs: 5 }));
  const state = admit(graph, started.nextState, "loop/items/0/child", "admit-child").nextState;
  const child = state.nodes["loop/items/0/child"]!.attempts.at(-1)!;
  const expired = advanceKernel(graph, state, { kind: "timer-expired", id: "loop-elapsed-timer", atMs: 5, nodeId: "loop", commandId: "loop-elapsed:loop:start-timer:1" });
  expect(expired.nextState.status).toBe("stopping");
  expect(expired.commands).toContainEqual(expect.objectContaining({ kind: "cancel-node", nodeId: "loop/items/0/child", attemptCommandId: child.commandId }));
  expect(expired.commands.some((command) => command.kind === "fail-run")).toBe(false);

  const stopped = advanceKernel(graph, expired.nextState, { kind: "attempt-stopped", id: "loop-child-stopped", atMs: 5, nodeId: "loop/items/0/child", commandId: child.commandId, candidateGeneration: child.candidateGeneration, attempt: child.attempt });
  expect(stopped.nextState.status).toBe("failed");
  expect(stopped.nextState.nodes.loop?.status).toBe("failed");
});
