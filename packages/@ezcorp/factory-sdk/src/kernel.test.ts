import { describe, expect, test } from "bun:test";
import { compileFactory } from "./compiler";
import { FactoryKernelError, advanceKernel, createKernelState } from "./kernel";
import { referenceCodeV1 } from "./references.js";
import type { CompiledFactory, FactoryDefinition, FactoryNode, JsonValue } from "./types";

const digest = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const runner = { package: "inert", version: "1", digest, export: "run" } as const;

function compiled(nodes: readonly FactoryNode[], _outputs: Record<string, { readonly kind: "ref"; readonly root: "node"; readonly name: string }>): CompiledFactory {
  const normalize = (node: FactoryNode): FactoryNode => {
    if (node.kind === "map") return { ...node, outputPorts: node.outputPorts ?? {}, body: { ...node.body, nodes: node.body.nodes.map(normalize), outputs: node.body.outputs } };
    if (node.kind === "loop") return { ...node, outputPorts: node.outputPorts ?? {}, body: { ...node.body, nodes: node.body.nodes.map(normalize), outputs: node.body.outputs } };
    if (node.kind === "branch") return { ...node, outputPorts: node.outputPorts ?? {}, then: { ...node.then, nodes: node.then.nodes.map(normalize) }, else: { ...node.else, nodes: node.else.nodes.map(normalize) } };
    return node;
  };
  const definition: FactoryDefinition = {
    schemaVersion: "factory.v1", id: "kernel-event-regression", version: "1", interpreterCompatibility: "1",
    inputPorts: {}, outputPorts: {}, graph: { nodes: nodes.map(normalize), outputs: {} },
    acceptance: referenceCodeV1.acceptance,
    packages: [{ name: runner.package, version: runner.version, digest }, ...referenceCodeV1.packages],
    capabilities: [], effects: ["none"], bounds: { maxExpandedNodes: 10_000, maxScopeDepth: 16 },
  };
  const result = compileFactory(definition);
  if (!result.ok) throw new Error(result.diagnostics.map((diagnostic) => diagnostic.code).join(", "));
  return result.factory;
}

const event = <T extends object>(id: string, values: T): T & { readonly id: string; readonly atMs: number } => ({ id, atMs: 1, ...values });

function activeWork(graph: CompiledFactory, runId: string) {
  const started = advanceKernel(graph, createKernelState(graph, runId, {}, 0), event("start", { kind: "start" }));
  const admission = started.commands.find((command) => command.kind === "request-admission" && command.nodeId === "work");
  if (!admission) throw new Error("work admission was not emitted");
  return advanceKernel(graph, started.nextState, event("admit", {
    kind: "admission-result", nodeId: "work", commandId: admission.id, candidateGeneration: admission.candidateGeneration, granted: true,
  })).nextState;
}

function dispatchedAttempt(state: import("./kernel-types").KernelState, nodeId: string) {
  const attempt = state.nodes[nodeId]?.attempts.at(-1);
  if (!attempt) throw new Error(`missing dispatched attempt for ${nodeId}`);
  return attempt;
}

describe("factory kernel", () => {
  test("completes a valid empty root graph immediately", () => {
    const graph = compiled([], {});
    const result = advanceKernel(graph, createKernelState(graph, "empty", {}, 0), event("start", { kind: "start" }));
    expect(result.nextState.status).toBe("completed");
    expect(result.commands.find((command) => command.kind === "complete-run")).toEqual(expect.objectContaining({ kind: "complete-run", output: {} }));
  });

  test("records known and uncertain usage as persistent decimal ledger entries", () => {
    const graph = compiled([{ id: "work", kind: "task", runner }], { result: { kind: "ref", root: "node", name: "work" } });
    const state = activeWork(graph, "usage");
    const work = dispatchedAttempt(state, "work");
    const settled = advanceKernel(graph, state, { kind: "usage-settled", id: "usage-1", atMs: 1, nodeId: "work", commandId: work.commandId, candidateGeneration: work.candidateGeneration, attempt: work.attempt, revision: 1, knownCostMicros: "12", unknownCostMicros: "3" });
    expect(settled.nextState.spentCostMicros).toBe("12");
    expect(settled.nextState.unknownCostMicros).toBe("3");
    expect(advanceKernel(graph, settled.nextState, { kind: "usage-settled", id: "usage-1", atMs: 2, nodeId: "work", commandId: work.commandId, candidateGeneration: work.candidateGeneration, attempt: work.attempt, revision: 1, knownCostMicros: "99" }).nextState.spentCostMicros).toBe("12");
  });

  test("rejects malformed and negative recorded usage charges", () => {
    const graph = compiled([{ id: "work", kind: "task", runner }], { result: { kind: "ref", root: "node", name: "work" } });
    const state = activeWork(graph, "usage-invalid");
    const work = dispatchedAttempt(state, "work");
    const settlement = { nodeId: "work", commandId: work.commandId, candidateGeneration: work.candidateGeneration, attempt: work.attempt, revision: 1 };
    expect(() => advanceKernel(graph, state, { kind: "usage-settled", id: "negative", atMs: 1, ...settlement, knownCostMicros: "-1" })).toThrow("usage cost");
    expect(() => advanceKernel(graph, state, { kind: "usage-settled", id: "decimal", atMs: 1, ...settlement, knownCostMicros: "1.5" })).toThrow("usage cost");
    expect(() => advanceKernel(graph, state, { kind: "usage-settled", id: "unsafe", atMs: 1, ...settlement, knownCostMicros: "01" })).toThrow("usage cost");
  });

  test("rejects a settlement for a nonexistent node without changing the run ledger", () => {
    const graph = compiled([{ id: "work", kind: "task", runner }], { result: { kind: "ref", root: "node", name: "work" } });
    const initial = createKernelState(graph, "usage-fence", {}, 0);
    const settled = advanceKernel(graph, initial, { kind: "usage-settled", id: "unknown-node", atMs: 1, nodeId: "does-not-exist", commandId: "missing", candidateGeneration: 0, attempt: 1, revision: 1, knownCostMicros: "7" });
    expect(settled.nextState.spentCostMicros).toBe("0");
    expect(settled.nextState.unknownCostMicros).toBe("0");
  });

  test("settlements fence the attempt and reconcile cumulative revisions without double charging", () => {
    const graph = compiled([{ id: "work", kind: "task", runner }], { result: { kind: "ref", root: "node", name: "work" } });
    const state = activeWork(graph, "usage-revision");
    const work = dispatchedAttempt(state, "work");
    const initial = advanceKernel(graph, state, { kind: "usage-settled", id: "delivery-a", atMs: 1, nodeId: "work", commandId: work.commandId, candidateGeneration: work.candidateGeneration, attempt: work.attempt, revision: 1, knownCostMicros: "4", unknownCostMicros: "6" });
    expect(initial.nextState.spentCostMicros).toBe("4");
    expect(initial.nextState.unknownCostMicros).toBe("6");
    const duplicate = advanceKernel(graph, initial.nextState, { kind: "usage-settled", id: "delivery-b", atMs: 2, nodeId: "work", commandId: work.commandId, candidateGeneration: work.candidateGeneration, attempt: work.attempt, revision: 1, knownCostMicros: "4", unknownCostMicros: "6" });
    expect(duplicate.nextState.spentCostMicros).toBe("4");
    const reconciled = advanceKernel(graph, duplicate.nextState, { kind: "usage-settled", id: "delivery-c", atMs: 3, nodeId: "work", commandId: work.commandId, candidateGeneration: work.candidateGeneration, attempt: work.attempt, revision: 2, knownCostMicros: "10", unknownCostMicros: "0" });
    expect(reconciled.nextState.spentCostMicros).toBe("10");
    expect(reconciled.nextState.unknownCostMicros).toBe("0");
    expect(() => advanceKernel(graph, reconciled.nextState, { kind: "usage-settled", id: "delivery-conflict", atMs: 4, nodeId: "work", commandId: work.commandId, candidateGeneration: work.candidateGeneration, attempt: work.attempt, revision: 2, knownCostMicros: "11" })).toThrow(FactoryKernelError);
    const stale = advanceKernel(graph, reconciled.nextState, { kind: "usage-settled", id: "delivery-stale", atMs: 5, nodeId: "work", commandId: work.commandId, candidateGeneration: work.candidateGeneration, attempt: work.attempt, revision: 1, knownCostMicros: "4", unknownCostMicros: "6" });
    expect(stale.nextState.spentCostMicros).toBe("10");
    expect(() => advanceKernel(graph, reconciled.nextState, { kind: "usage-settled", id: "delivery-gap", atMs: 5, nodeId: "work", commandId: work.commandId, candidateGeneration: work.candidateGeneration, attempt: work.attempt, revision: 4, knownCostMicros: "10" })).toThrow(FactoryKernelError);
  });

  test("uses stable command identities and independently advances a ready successor", () => {
    const graph = compiled([
      { id: "first", kind: "task", runner },
      { id: "second", kind: "task", runner, dependsOn: ["first"] },
    ], { result: { kind: "ref", root: "node", name: "second" } });
    const initial = createKernelState(graph, "run-1", {}, 0);
    const started = advanceKernel(graph, initial, event("start", { kind: "start" }));
    const replay = advanceKernel(graph, createKernelState(graph, "run-1", {}, 0), event("replay-start", { kind: "start" }));
    expect(started.commands.map((command) => command.id)).toEqual(replay.commands.map((command) => command.id));
    expect(started.commands.find((command) => command.kind === "start-timer" && command.nodeId === undefined)).toEqual(expect.objectContaining({ kind: "start-timer", deadlineAtMs: 7 * 24 * 60 * 60 * 1_000 }));
    const admission = started.commands.find((command) => command.kind === "request-admission" && command.nodeId === "first");
    expect(admission).toEqual(expect.objectContaining({ kind: "request-admission", nodeId: "first", candidateGeneration: 0, deadlineAtMs: 1_800_001 }));
    const admitted = advanceKernel(graph, started.nextState, event("admit", { kind: "admission-result", nodeId: "first", commandId: admission!.id, candidateGeneration: admission!.candidateGeneration, granted: true }));
    const dispatch = admitted.commands.find((command) => command.kind === "dispatch-node" && command.nodeId === "first");
    const timer = started.commands.find((command) => command.kind === "start-timer" && command.nodeId === "first");
    expect(dispatch).toEqual(expect.objectContaining({ kind: "dispatch-node", nodeId: "first", candidateGeneration: 0, attempt: 1, input: {}, deadlineAtMs: 1_800_001, cancellationEpoch: 0 }));
    expect(timer).toEqual(expect.objectContaining({ kind: "start-timer", nodeId: "first", deadlineAtMs: 1_800_001 }));
    const completed = advanceKernel(graph, admitted.nextState, event("result", { kind: "node-result", nodeId: "first", commandId: dispatch!.id, candidateGeneration: dispatch!.candidateGeneration, attempt: dispatch!.attempt, output: { value: 1 } }));
    expect(completed.nextState.nodes.second?.status).toBe("reserved");
    expect(completed.commands.find((command) => command.kind === "request-admission" && command.nodeId === "second")).toEqual(expect.objectContaining({ kind: "request-admission", nodeId: "second", candidateGeneration: 0, deadlineAtMs: 1_800_001 }));
  });

  test("ignores duplicate and stale completion fences", () => {
    const graph = compiled([{ id: "only", kind: "task", runner }], { result: { kind: "ref", root: "node", name: "only" } });
    let state = advanceKernel(graph, createKernelState(graph, "run-2", {}, 0), event("start", { kind: "start" })).nextState;
    const admission = state.nodes.only!.attempts.at(-1)!;
    state = advanceKernel(graph, state, event("admit", { kind: "admission-result", nodeId: "only", commandId: admission.commandId, candidateGeneration: admission.candidateGeneration, granted: true })).nextState;
    const only = dispatchedAttempt(state, "only");
    const stale = advanceKernel(graph, state, event("wrong-attempt", { kind: "node-result", nodeId: "only", commandId: only.commandId, candidateGeneration: only.candidateGeneration, attempt: only.attempt + 1, output: {} }));
    expect(stale.nextState.nodes.only?.status).toBe("running");
    const complete = advanceKernel(graph, stale.nextState, event("result", { kind: "node-result", nodeId: "only", commandId: only.commandId, candidateGeneration: only.candidateGeneration, attempt: only.attempt, output: {} }));
    expect(complete.nextState.status).toBe("completed");
    expect(advanceKernel(graph, complete.nextState, event("result", { kind: "node-result", nodeId: "only", commandId: only.commandId, candidateGeneration: only.candidateGeneration, attempt: only.attempt, output: {} })).commands).toEqual([]);
  });

  test("does not retry before an attempt has stopped", () => {
    const graph = compiled([{ id: "only", kind: "task", runner, retry: { maxAttempts: 2, initialDelayMs: 5, maximumDelayMs: 5 } }], { result: { kind: "ref", root: "node", name: "only" } });
    let state = advanceKernel(graph, createKernelState(graph, "run-3", {}, 0), event("start", { kind: "start" })).nextState;
    const admission = state.nodes.only!.attempts.at(-1)!;
    state = advanceKernel(graph, state, event("admit", { kind: "admission-result", nodeId: "only", commandId: admission.commandId, candidateGeneration: admission.candidateGeneration, granted: true })).nextState;
    const only = dispatchedAttempt(state, "only");
    const failed = advanceKernel(graph, state, event("failed", { kind: "node-failed", nodeId: "only", commandId: only.commandId, candidateGeneration: only.candidateGeneration, attempt: only.attempt, error: "boom" }));
    expect(failed.nextState.nodes.only?.status).toBe("stopping");
    expect(failed.commands.some((command) => command.kind === "request-admission")).toBe(false);
    const stopped = advanceKernel(graph, failed.nextState, event("stopped", { kind: "attempt-stopped", nodeId: "only", commandId: only.commandId, candidateGeneration: only.candidateGeneration, attempt: only.attempt }));
    expect(stopped.nextState.nodes.only?.status).toBe("retry_wait");
    expect(stopped.commands.find((command) => command.kind === "start-timer" && command.nodeId === "only")).toEqual(expect.objectContaining({ kind: "start-timer", nodeId: "only", deadlineAtMs: 6 }));
  });

  test("cancellation fences late work and retains uncertainty", () => {
    const graph = compiled([{ id: "only", kind: "task", runner }], { result: { kind: "ref", root: "node", name: "only" } });
    let state = advanceKernel(graph, createKernelState(graph, "run-4", {}, 0), event("start", { kind: "start" })).nextState;
    const admission = state.nodes.only!.attempts.at(-1)!;
    state = advanceKernel(graph, state, event("admit", { kind: "admission-result", nodeId: "only", commandId: admission.commandId, candidateGeneration: admission.candidateGeneration, granted: true })).nextState;
    const only = dispatchedAttempt(state, "only");
    const cancelling = advanceKernel(graph, state, event("cancel", { kind: "cancel", reason: "user" }));
    expect(cancelling.nextState.cancellationEpoch).toBe(1);
    expect(cancelling.nextState.status).toBe("stopping");
    const stopped = advanceKernel(graph, cancelling.nextState, event("uncertain", { kind: "attempt-stopped", nodeId: "only", commandId: only.commandId, candidateGeneration: only.candidateGeneration, attempt: only.attempt, uncertain: true }));
    expect(stopped.nextState.status).toBe("stopping");
    expect(stopped.nextState.unresolvedUncertainNodeIds).toEqual(["only"]);
  });

  test("cancelling a map stops admitted items and never opens a blocked index", () => {
    const body = { nodes: [{ id: "item", kind: "task" as const, runner }], outputs: {} };
    const map = { id: "map", kind: "map" as const, collection: { kind: "literal" as const, value: ["one", "two", "three"] }, itemSchema: { type: "string" as const }, body, mode: "all" as const, maxItems: 3, maxConcurrency: 1 };
    const graph = compiled([map], { result: { kind: "ref", root: "node", name: "map" } });
    const started = advanceKernel(graph, createKernelState(graph, "cancel-map", {}, 0), event("start", { kind: "start" }));
    const admission = started.commands.find((command) => command.kind === "request-admission")!;
    const admitted = advanceKernel(graph, started.nextState, event("admit", { kind: "admission-result", nodeId: admission.nodeId, commandId: admission.id, candidateGeneration: 0, granted: true }));
    const cancelled = advanceKernel(graph, admitted.nextState, event("cancel", { kind: "cancel", reason: "user" }));
    expect(cancelled.nextState.status).toBe("stopping");
    expect(cancelled.commands.some((command) => command.kind === "cancel-node" && command.nodeId === "map/items/0/item")).toBe(true);
    expect(cancelled.nextState.nodes["map/items/1/item"]).toBeUndefined();
    expect(cancelled.nextState.nodes["map/items/2/item"]).toBeUndefined();
  });

  test("keeps only the active map window and safely reopens an evicted item repair", () => {
    const body = { nodes: [{ id: "item", kind: "task" as const, runner }], outputs: {} };
    const map = { id: "map", kind: "map" as const, collection: { kind: "literal" as const, value: ["one", "two", "three"] }, itemSchema: { type: "string" as const }, body, mode: "all" as const, maxItems: 3, maxConcurrency: 1 };
    const graph = compiled([map], { result: { kind: "ref", root: "node", name: "map" } });
    const started = advanceKernel(graph, createKernelState(graph, "repair-evicted-map", {}, 0), event("start", { kind: "start" }));
    expect(Object.keys(started.nextState.nodes)).toEqual(["map", "map/items/0/item"]);
    const admission = started.commands.find((command) => command.kind === "request-admission")!;
    const admitted = advanceKernel(graph, started.nextState, event("admit-item-zero", { kind: "admission-result", nodeId: admission.nodeId, commandId: admission.id, candidateGeneration: 0, granted: true }));
    const attempt = admitted.commands.find((command) => command.kind === "dispatch-node")!;
    const completed = advanceKernel(graph, admitted.nextState, event("complete-item-zero", { kind: "node-result", nodeId: attempt.nodeId, commandId: attempt.id, candidateGeneration: 0, attempt: 1, output: {} }));
    expect(completed.nextState.nodes["map/items/0/item"]).toBeUndefined();
    expect(completed.nextState.nodes["map/items/1/item"]?.status).toBe("reserved");

    const repaired = advanceKernel(graph, completed.nextState, event("repair-evicted-item", { kind: "repair", nodeId: "map/items/0/item", reason: "replace item" }));
    const cancel = repaired.commands.find((command) => command.kind === "cancel-node");
    expect(cancel).toEqual(expect.objectContaining({ nodeId: "map/items/1/item" }));
    const stopped = advanceKernel(graph, repaired.nextState, event("stop-item-one", { kind: "attempt-stopped", nodeId: cancel!.nodeId, commandId: cancel!.attemptCommandId, candidateGeneration: cancel!.candidateGeneration, attempt: cancel!.attempt }));
    expect(stopped.nextState.nodes.map?.candidateGeneration).toBe(1);
    expect(Object.keys(stopped.nextState.nodes)).toEqual(["map", "map/items/0/item"]);
    expect(stopped.commands).toContainEqual(expect.objectContaining({ kind: "request-admission", nodeId: "map/items/0/item" }));
  });

  test("repairs an active map item through its aggregate and clears the prior result", () => {
    const body = { nodes: [{ id: "item", kind: "task" as const, runner }], outputs: {} };
    const map = { id: "map", kind: "map" as const, collection: { kind: "literal" as const, value: ["one"] }, itemSchema: { type: "string" as const }, body, mode: "all" as const, maxItems: 1, maxConcurrency: 1 };
    const graph = compiled([map], { result: { kind: "ref", root: "node", name: "map" } });
    const started = advanceKernel(graph, createKernelState(graph, "repair-active-map", {}, 0), event("start", { kind: "start" }));
    const repair = advanceKernel(graph, started.nextState, event("repair-active-item", { kind: "repair", nodeId: "map/items/0/item", reason: "replace active item" }));
    const cancel = repair.commands.find((command) => command.kind === "cancel-node")!;
    const stopped = advanceKernel(graph, repair.nextState, event("stop-active-item", { kind: "attempt-stopped", nodeId: cancel.nodeId, commandId: cancel.attemptCommandId, candidateGeneration: cancel.candidateGeneration, attempt: cancel.attempt }));
    expect(stopped.nextState.nodes.map?.map?.outcomes).toEqual({});
    expect(stopped.nextState.nodes.map?.candidateGeneration).toBe(1);
    expect(stopped.nextState.nodes["map/items/0/item"]?.candidateGeneration).toBe(1);
  });
});

void ({} as JsonValue);
