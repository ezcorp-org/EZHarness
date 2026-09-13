import { validateValue } from "./validation";
import { evaluateExpression } from "./expressions";
import type {
  AdvanceResult,
  KernelCommand,
  KernelEvent,
  KernelNodeState,
  KernelState,
} from "./kernel-types";
import type { CompiledFactory, FactoryNode, JsonValue, ValueReference, ValueSource } from "./types";

const DEFAULT_RUN_DEADLINE_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_RUN_DEADLINE_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_NODE_DEADLINE_MS = 30 * 60 * 1_000;

export class FactoryKernelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FactoryKernelError";
  }
}

export function createKernelState(
  factory: CompiledFactory,
  logicalRunId: string,
  input: JsonValue,
  nowMs: number,
): KernelState {
  validateRecord(factory.definition.inputPorts, input, "run input");
  const nodes: Record<string, KernelNodeState> = Object.create(null) as Record<string, KernelNodeState>;
  for (const node of factory.definition.graph.nodes) {
    nodes[node.id] = { status: "blocked", candidateGeneration: 0, nextAttempt: 1, attempts: [] };
  }
  const requested = factory.definition.bounds.runDeadlineMs ?? DEFAULT_RUN_DEADLINE_MS;
  return {
    logicalRunId,
    definitionDigest: factory.digest,
    input,
    status: "created",
    runDeadlineAtMs: nowMs + Math.min(requested, MAX_RUN_DEADLINE_MS),
    nowMs,
    cancellationEpoch: 0,
    commandCounter: 0,
    eventSequence: 0,
    nodes,
    scopes: { root: { id: "root", depth: 0, expandedNodeCount: factory.definition.graph.nodes.length, spentCostMicros: "0", unknownCostMicros: "0", nodeIds: factory.definition.graph.nodes.map((node) => node.id), roots: factory.definition.graph.nodes.filter((node) => (node.dependsOn?.length ?? 0) === 0).map((node) => node.id) } },
    appliedEventIds: [],
    unresolvedUncertainNodeIds: [],
  };
}

/** Apply one recorded event. It is deterministic and never reads ambient state. */
export function advanceKernel(factory: CompiledFactory, state: KernelState, event: KernelEvent): AdvanceResult {
  if (factory.digest !== state.definitionDigest) throw new FactoryKernelError("compiled plan digest does not match kernel state");
  if (state.appliedEventIds.includes(event.id)) return { nextState: state, commands: [] };
  if (!Number.isSafeInteger(event.atMs) || event.atMs < 0) throw new FactoryKernelError("event timestamp must be a non-negative safe integer");
  // The adapter supplies a total recorded event order. A late callback still
  // applies its fence/cancellation semantics; logical time never moves back.
  let next = rememberEvent({ ...state, nowMs: Math.max(state.nowMs, event.atMs), eventSequence: state.eventSequence + 1 }, event.id);
  const commands: KernelCommand[] = [];

  if (next.status !== "created" && next.status !== "running" && next.status !== "waiting" && next.status !== "stopping") {
    return { nextState: next, commands };
  }

  if (event.kind === "cancel") {
    next = beginStopping(next, event.reason, commands, true);
    return finish(factory, next, commands);
  }
  if (event.kind === "timer-expired" && event.nodeId === undefined) {
    next = beginStopping(next, "RUN_DEADLINE_EXPIRED", commands, true);
    return finish(factory, next, commands);
  }
  if (event.atMs >= next.runDeadlineAtMs) {
    next = beginStopping(next, "RUN_DEADLINE_EXPIRED", commands, true);
    return finish(factory, next, commands);
  }

  switch (event.kind) {
    case "start":
      if (next.status === "created") {
        next = { ...next, status: "running" };
        next = activateReady(factory, next, commands);
      }
      break;
    case "admission-result":
      next = applyAdmission(factory, next, event, commands);
      break;
    case "node-result":
      next = applyResult(factory, next, event, commands);
      break;
    case "node-failed":
      next = applyFailure(factory, next, event, commands);
      break;
    case "attempt-stopped":
      next = applyStopped(factory, next, event, commands);
      break;
    case "approval-decided":
      next = applyApproval(factory, next, event, commands);
      break;
    case "timer-expired":
      next = applyTimer(factory, next, event, commands);
      break;
    case "repair":
      next = applyRepair(factory, next, event, commands);
      break;
  }
  return finish(factory, next, commands);
}

function applyAdmission(factory: CompiledFactory, state: KernelState, event: Extract<KernelEvent, { kind: "admission-result" }>, commands: KernelCommand[]): KernelState {
  const runtime = state.nodes[event.nodeId];
  const node = nodeFor(factory, event.nodeId);
  if (!runtime || !node || runtime.status !== "reserved" || runtime.candidateGeneration !== event.candidateGeneration) return state;
  const attempt = runtime.attempts.at(-1);
  if (!attempt || attempt.commandId !== event.commandId || attempt.stopped) return state;
  if (!event.granted) return failNode(factory, state, node, event.nodeId, "ADMISSION_DENIED", "admission_denied", commands);
  const input = inputFor(state, node);
  const deadlineAtMs = nodeDeadline(state, node);
  const command = commandFor(state, "dispatch-node", event.nodeId);
  const running = {
    ...runtime,
    status: "running" as const,
    attempts: runtime.attempts.slice(0, -1).concat({ ...attempt, commandId: command.id, startedAtMs: state.nowMs, deadlineAtMs }),
  };
  commands.push({
    kind: "dispatch-node", id: command.id, nodeId: event.nodeId, candidateGeneration: runtime.candidateGeneration,
    attempt: attempt.attempt, input, deadlineAtMs, cancellationEpoch: state.cancellationEpoch,
  });
  const dispatched = { ...command.state, nodes: { ...command.state.nodes, [event.nodeId]: running } };
  const timer = commandFor(dispatched, "start-timer", event.nodeId);
  commands.push({ kind: "start-timer", id: timer.id, nodeId: event.nodeId, deadlineAtMs });
  return timer.state;
}

function applyResult(factory: CompiledFactory, state: KernelState, event: Extract<KernelEvent, { kind: "node-result" }>, commands: KernelCommand[]): KernelState {
  const runtime = state.nodes[event.nodeId];
  const node = nodeFor(factory, event.nodeId);
  if (!runtime || !node || !matchesAttempt(runtime, event)) return state;
  if (!validateOutput(node, event.output)) return stopFailedAttempt(state, event.nodeId, "OUTPUT_INVALID", commands);
  const attempts = runtime.attempts.map((attempt) => attempt.commandId === event.commandId ? { ...attempt, stopped: true } : attempt);
  const next = withNode(state, event.nodeId, { ...runtime, status: "succeeded", output: event.output, error: undefined, attempts });
  const progressed = activateReady(factory, next, commands, successorsFor(factory, event.nodeId));
  return progressLoop(factory, progressMap(factory, completeScopeIfReady(factory, progressed, event.nodeId, commands), event.nodeId, commands), event.nodeId, commands);
}

function applyFailure(factory: CompiledFactory, state: KernelState, event: Extract<KernelEvent, { kind: "node-failed" }>, commands: KernelCommand[]): KernelState {
  const runtime = state.nodes[event.nodeId];
  const node = nodeFor(factory, event.nodeId);
  if (!runtime || !node || !matchesAttempt(runtime, event)) return state;
  return stopFailedAttempt(state, event.nodeId, event.error, commands);
}

function applyStopped(factory: CompiledFactory, state: KernelState, event: Extract<KernelEvent, { kind: "attempt-stopped" }>, commands: KernelCommand[]): KernelState {
  const runtime = state.nodes[event.nodeId];
  const node = nodeFor(factory, event.nodeId);
  if (!runtime || !node || runtime.candidateGeneration !== event.candidateGeneration) return state;
  const attempt = runtime.attempts.find((candidate) => candidate.commandId === event.commandId && candidate.attempt === event.attempt);
  if (!attempt || attempt.stopped) return state;
  const attempts = runtime.attempts.map((candidate) => candidate === attempt ? { ...candidate, stopped: true, uncertain: event.uncertain ?? false } : candidate);
  let next = withNode(state, event.nodeId, { ...runtime, attempts });
  if (event.uncertain) {
    next = { ...next, unresolvedUncertainNodeIds: distinct(next.unresolvedUncertainNodeIds.concat(event.nodeId)) };
    return next;
  }
  if (runtime.status === "stopping" && retryAllowed(node, runtime)) {
    const delay = retryDelay(node, runtime.nextAttempt);
    const timer = commandFor(next, "start-timer", event.nodeId);
    next = withNode(timer.state, event.nodeId, { ...timer.state.nodes[event.nodeId]!, status: "retry_wait", nextAttempt: runtime.nextAttempt + 1 });
    commands.push({ kind: "start-timer", id: timer.id, nodeId: event.nodeId, deadlineAtMs: next.nowMs + delay });
    return next;
  }
  if (runtime.status === "stopping") return failNode(factory, next, node, event.nodeId, runtime.error ?? "NODE_FAILED", "execution", commands);
  return next;
}

function stopFailedAttempt(state: KernelState, nodeId: string, error: string, commands: KernelCommand[]): KernelState {
  const runtime = state.nodes[nodeId]!;
  const attempt = runtime.attempts.at(-1)!;
  const stopping = withNode(state, nodeId, { ...runtime, status: "stopping", error });
  const command = commandFor(stopping, "cancel-node", nodeId);
  commands.push({ kind: "cancel-node", id: command.id, nodeId, candidateGeneration: attempt.candidateGeneration, attempt: attempt.attempt, attemptCommandId: attempt.commandId, cancellationEpoch: command.state.cancellationEpoch });
  return command.state;
}

function applyApproval(factory: CompiledFactory, state: KernelState, event: Extract<KernelEvent, { kind: "approval-decided" }>, commands: KernelCommand[]): KernelState {
  const node = nodeFor(factory, event.nodeId);
  const runtime = state.nodes[event.nodeId];
  if (!node || node.kind !== "approval" || !runtime || runtime.status !== "waiting") return state;
  const pending = runtime.attempts.at(-1);
  if (!pending || pending.commandId !== event.commandId || event.atMs > pending.deadlineAtMs) return state;
  if (!node.choices.includes(event.choice)) return state;
  if (event.choice === "approve" || event.choice === "accepted") {
    const attempts = runtime.attempts.map((attempt) => attempt.commandId === event.commandId ? { ...attempt, stopped: true } : attempt);
    return activateReady(factory, withNode(state, event.nodeId, { ...runtime, status: "succeeded", output: event.choice, attempts }), commands, successorsFor(factory, event.nodeId));
  }
  return failNode(factory, state, node, event.nodeId, "APPROVAL_DENIED", "approval_denied", commands);
}

function applyTimer(factory: CompiledFactory, state: KernelState, event: Extract<KernelEvent, { kind: "timer-expired" }>, commands: KernelCommand[]): KernelState {
  if (!event.nodeId) return state;
  const node = nodeFor(factory, event.nodeId);
  const runtime = state.nodes[event.nodeId];
  if (!node || !runtime) return state;
  if (runtime.status === "retry_wait") return dispatchReady(factory, state, node, event.nodeId, commands);
  if (runtime.status === "waiting") {
    if (node.kind === "approval") return failNode(factory, state, node, event.nodeId, "APPROVAL_EXPIRED", "approval_expired", commands);
    return failNode(factory, state, node, event.nodeId, "NODE_DEADLINE_EXPIRED", "deadline", commands);
  }
  return state;
}

function applyRepair(factory: CompiledFactory, state: KernelState, event: Extract<KernelEvent, { kind: "repair" }>, commands: KernelCommand[]): KernelState {
  const node = nodeFor(factory, event.nodeId);
  const runtime = state.nodes[event.nodeId];
  if (!node || !runtime || runtime.status === "running" || runtime.status === "reserved" || runtime.status === "waiting") return state;
  if (runtime.attempts.some((attempt) => !attempt.stopped || attempt.uncertain)) return state;
  const repaired = withNode(state, event.nodeId, {
    status: "ready", candidateGeneration: runtime.candidateGeneration + 1, nextAttempt: 1, attempts: [], error: undefined,
  });
  return dispatchReady(factory, repaired, node, event.nodeId, commands);
}

function activateReady(factory: CompiledFactory, state: KernelState, commands: KernelCommand[], candidates?: readonly string[]): KernelState {
  let next = state;
  const candidateIds = (candidates ?? Object.keys(state.nodes)).slice().sort();
  for (const nodeId of candidateIds) {
    const node = nodeFor(factory, nodeId);
    if (!node) continue;
    const runtime = next.nodes[nodeId]!;
    if (runtime.status === "blocked" && isReady(next, node, nodeId)) next = withNode(next, nodeId, { ...runtime, status: "ready" });
    if (next.nodes[nodeId]!.status === "ready") next = dispatchReady(factory, next, node, nodeId, commands);
  }
  return next;
}

function dispatchReady(factory: CompiledFactory, state: KernelState, node: FactoryNode, nodeId: string, commands: KernelCommand[]): KernelState {
  const runtime = state.nodes[nodeId]!;
  if (node.kind === "branch") {
    const evaluated = evaluateExpression(node.condition, expressionContext(state));
    if (!evaluated.ok || typeof evaluated.value !== "boolean") return failNode(factory, state, node, nodeId, "BRANCH_PREDICATE_INVALID", "execution", commands);
    const condition = evaluated.value;
    const selected = condition ? "then" : "else";
    const graph = node[selected];
    const rootScope = state.scopes.root!;
    const expanded = rootScope.expandedNodeCount + graph.nodes.length;
    if (expanded > factory.definition.bounds.maxExpandedNodes) return failNode(factory, state, node, nodeId, "EXPANDED_NODE_BOUND", "bound_exhausted", commands);
    const scopeId = `${nodeId}/${selected}`;
    const childNodes: Record<string, KernelNodeState> = { ...state.nodes };
    const roots: string[] = [];
    for (const child of graph.nodes) {
      const childId = `${scopeId}/${child.id}`;
      childNodes[childId] = { status: "blocked", candidateGeneration: 0, nextAttempt: 1, attempts: [] };
      if ((child.dependsOn?.length ?? 0) === 0) roots.push(childId);
    }
    const scoped = { ...state, nodes: childNodes, scopes: { ...state.scopes, [scopeId]: { id: scopeId, parentNodeId: nodeId, depth: 1, selectedBranch: selected as "then" | "else", expandedNodeCount: expanded, spentCostMicros: rootScope.spentCostMicros, unknownCostMicros: rootScope.unknownCostMicros, nodeIds: graph.nodes.map((child) => `${scopeId}/${child.id}`), roots } } };
    return activateReady(factory, withNode(scoped, nodeId, { ...runtime, status: "waiting", selected, output: undefined, waitingReason: "external_reconciliation" }), commands, roots);
  }
  if (node.kind === "join") return settleJoin(factory, state, node, nodeId, commands);
  if (node.kind === "map") {
    const collection = resolveValue(node.collection, state);
    if (!Array.isArray(collection)) return failNode(factory, state, node, nodeId, "MAP_COLLECTION_INVALID", "execution", commands);
    if (collection.length > node.maxItems) return failNode(factory, state, node, nodeId, "MAP_ITEM_BOUND", "bound_exhausted", commands);
    if (collection.length === 0) return activateReady(factory, withNode(state, nodeId, { ...runtime, status: "succeeded", output: [], map: { snapshot: [], itemCount: 0, completedIndexes: [], failedIndexes: [], outcomes: [] } }), commands, successorsFor(factory, nodeId));
    const nodes: Record<string, KernelNodeState> = { ...state.nodes };
    const scopeIds: string[] = [];
    const roots: string[] = [];
    for (let item = 0; item < collection.length; item += 1) for (const child of node.body.nodes) {
      const id = `${nodeId}/items/${item}/${child.id}`;
      nodes[id] = { status: "blocked", candidateGeneration: 0, nextAttempt: 1, attempts: [] };
      scopeIds.push(id);
      if ((child.dependsOn?.length ?? 0) === 0 && item < node.maxConcurrency) roots.push(id);
    }
    const scopeId = `${nodeId}/items`;
    const scoped = { ...state, nodes, scopes: { ...state.scopes, [scopeId]: { id: scopeId, parentNodeId: nodeId, depth: 1, expandedNodeCount: scopeIds.length, spentCostMicros: "0", unknownCostMicros: "0", nodeIds: scopeIds, roots } } };
    return activateReady(factory, withNode(scoped, nodeId, { ...runtime, status: "waiting", map: { snapshot: collection, itemCount: collection.length, completedIndexes: [], failedIndexes: [], outcomes: Array.from({ length: collection.length }) }, waitingReason: "external_reconciliation" }), commands, roots);
  }
  if (node.kind === "loop") return startLoopIteration(factory, state, node, nodeId, runtime, resolveValue(node.initialInput, state), 0, commands);
  if (node.kind === "approval") {
    const deadlineAtMs = Math.min(nodeDeadline(state, node), state.nowMs + Math.min(node.expiresInMs, 24 * 60 * 60 * 1_000));
    const command = commandFor(state, "request-approval", nodeId);
    const attempt = { candidateGeneration: runtime.candidateGeneration, attempt: runtime.nextAttempt, commandId: command.id, startedAtMs: state.nowMs, deadlineAtMs, stopped: false, uncertain: false };
    const waiting = { ...runtime, status: "waiting" as const, attempts: runtime.attempts.concat(attempt), waitingReason: "approval" as const, waitingDeadlineAtMs: deadlineAtMs };
    commands.push({ kind: "request-approval", id: command.id, nodeId, choices: node.choices, context: resolveValue(node.context, state), actorScope: node.actorScope, deadlineAtMs });
    return withNode(command.state, nodeId, waiting);
  }
  if (node.kind === "subfactory") return dispatchChild(state, node, nodeId, commands);
  if (node.kind === "acceptance") return dispatchAcceptance(state, node, nodeId, commands);
  if (node.kind === "release") return dispatchRelease(state, node, nodeId, commands);
  return requestAdmission(state, node, nodeId, commands);
}

function requestAdmission(state: KernelState, node: FactoryNode, nodeId: string, commands: KernelCommand[]): KernelState {
  const runtime = state.nodes[nodeId]!;
  const deadlineAtMs = nodeDeadline(state, node);
  const command = commandFor(state, "request-admission", nodeId);
  const attempt = { candidateGeneration: runtime.candidateGeneration, attempt: runtime.nextAttempt, commandId: command.id, startedAtMs: state.nowMs, deadlineAtMs, stopped: false, uncertain: false };
  commands.push({ kind: "request-admission", id: command.id, nodeId, candidateGeneration: runtime.candidateGeneration, deadlineAtMs });
  return withNode(command.state, nodeId, { ...runtime, status: "reserved", attempts: runtime.attempts.concat(attempt) });
}

function dispatchChild(state: KernelState, node: Extract<FactoryNode, { kind: "subfactory" }>, nodeId: string, commands: KernelCommand[]): KernelState {
  const runtime = state.nodes[nodeId]!;
  const deadlineAtMs = nodeDeadline(state, node);
  const command = commandFor(state, "run-child", nodeId);
  const attempt = { candidateGeneration: runtime.candidateGeneration, attempt: runtime.nextAttempt, commandId: command.id, startedAtMs: state.nowMs, deadlineAtMs, stopped: false, uncertain: false };
  commands.push({ kind: "run-child", id: command.id, nodeId, candidateGeneration: runtime.candidateGeneration, factory: node.factory, input: inputFor(state, node), deadlineAtMs });
  return withNode(command.state, nodeId, { ...runtime, status: "waiting", attempts: runtime.attempts.concat(attempt), waitingReason: "external_reconciliation", waitingDeadlineAtMs: deadlineAtMs });
}

function dispatchAcceptance(state: KernelState, node: Extract<FactoryNode, { kind: "acceptance" }>, nodeId: string, commands: KernelCommand[]): KernelState {
  const runtime = state.nodes[nodeId]!;
  const deadlineAtMs = nodeDeadline(state, node);
  const command = commandFor(state, "request-acceptance", nodeId);
  const attempt = { candidateGeneration: runtime.candidateGeneration, attempt: runtime.nextAttempt, commandId: command.id, startedAtMs: state.nowMs, deadlineAtMs, stopped: false, uncertain: false };
  commands.push({ kind: "request-acceptance", id: command.id, nodeId, candidateGeneration: runtime.candidateGeneration, candidate: resolveValue(node.candidate, state), evidence: resolveValue(node.evidence, state), deadlineAtMs });
  return withNode(command.state, nodeId, { ...runtime, status: "waiting", attempts: runtime.attempts.concat(attempt), waitingReason: "external_reconciliation", waitingDeadlineAtMs: deadlineAtMs });
}

function dispatchRelease(state: KernelState, node: Extract<FactoryNode, { kind: "release" }>, nodeId: string, commands: KernelCommand[]): KernelState {
  const runtime = state.nodes[nodeId]!;
  const deadlineAtMs = nodeDeadline(state, node);
  const command = commandFor(state, "request-release", nodeId);
  const attempt = { candidateGeneration: runtime.candidateGeneration, attempt: runtime.nextAttempt, commandId: command.id, startedAtMs: state.nowMs, deadlineAtMs, stopped: false, uncertain: false };
  commands.push({ kind: "request-release", id: command.id, nodeId, candidateGeneration: runtime.candidateGeneration, input: inputFor(state, node), deadlineAtMs });
  return withNode(command.state, nodeId, { ...runtime, status: "waiting", attempts: runtime.attempts.concat(attempt), waitingReason: "external_reconciliation", waitingDeadlineAtMs: deadlineAtMs });
}

function settleJoin(factory: CompiledFactory, state: KernelState, node: Extract<FactoryNode, { kind: "join" }>, nodeId: string, commands: KernelCommand[]): KernelState {
  const outcomes = node.predecessors.map((predecessor) => [predecessor, state.nodes[predecessor]] as const);
  const terminal = (candidate: KernelNodeState | undefined) => candidate?.status === "succeeded" || candidate?.status === "failed" || candidate?.status === "skipped" || candidate?.status === "cancelled";
  const eligible = node.eligibleOutcomes ?? ["succeeded"];
  const winners = outcomes.filter(([, runtime]) => runtime && eligible.includes(toJoinOutcome(runtime.status))).filter(([, runtime]) => terminal(runtime));
  if (node.mode === "all") {
    if (!outcomes.every(([, runtime]) => terminal(runtime))) return state;
    if (outcomes.some(([, runtime]) => runtime?.status !== "succeeded")) return failNode(factory, state, node, nodeId, "REQUIRED_PREDECESSOR_FAILED", "execution", commands);
  } else {
    const quorum = node.mode === "any" ? 1 : node.quorum ?? 0;
    if (quorum <= 0) return failNode(factory, state, node, nodeId, "INVALID_QUORUM", "bound_exhausted", commands);
    if (winners.length < quorum) {
      const remaining = outcomes.filter(([, runtime]) => !terminal(runtime)).length;
      if (winners.length + remaining < quorum) return failNode(factory, state, node, nodeId, "QUORUM_UNREACHABLE", "execution", commands);
      return state;
    }
  }
  const selected = winners.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([id, runtime]) => ({ id, output: runtime!.output ?? null }));
  return activateReady(factory, withNode(state, nodeId, { ...state.nodes[nodeId]!, status: "succeeded", output: selected }), commands, successorsFor(factory, nodeId));
}

function isReady(state: KernelState, node: FactoryNode, instanceId: string): boolean {
  if (node.kind === "join") return true;
  const scope = instanceId.includes("/") ? `${instanceId.slice(0, instanceId.lastIndexOf("/"))}/` : "";
  return (node.dependsOn ?? []).every((id) => state.nodes[`${scope}${id}`]?.status === "succeeded");
}

function failNode(factory: CompiledFactory, state: KernelState, node: FactoryNode, nodeId: string, error: string, _kind: string, commands: KernelCommand[]): KernelState {
  const runtime = state.nodes[nodeId]!;
  const failed = withNode(state, nodeId, { ...runtime, status: "failed", error });
  const mapParentId = mapParent(nodeId);
  const parentRuntime = mapParentId ? state.nodes[mapParentId] : undefined;
  const mapNode = mapParentId ? nodeFor(factory, mapParentId) : undefined;
  if (parentRuntime && mapNode?.kind === "map" && mapNode.mode === "collect") return progressMap(factory, failed, nodeId, commands);
  if (parentRuntime && mapNode?.kind === "map" && mapNode.mode === "all") {
    const enclosing = withNode(failed, mapParentId!, { ...parentRuntime, status: "failed", error: "MAP_ITEM_FAILED" });
    return beginStopping(enclosing, "MAP_ITEM_FAILED", commands, false);
  }
  if (node.kind === "map" && node.mode === "collect") return activateReady(factory, failed, commands, successorsFor(factory, nodeId));
  return beginStopping(failed, error, commands, false);
}

function beginStopping(state: KernelState, reason: string, commands: KernelCommand[], cancelled: boolean): KernelState {
  if (state.status === "stopping") return state;
  let next: KernelState = { ...state, status: "stopping", cancellationEpoch: state.cancellationEpoch + (cancelled ? 1 : 0) };
  for (const [nodeId, runtime] of Object.entries(next.nodes)) {
    const active = runtime.attempts.filter((attempt) => !attempt.stopped);
    if (active.length === 0) continue;
    const stopping = { ...runtime, status: "stopping" as const, error: runtime.error ?? reason };
    next = withNode(next, nodeId, stopping);
    for (const attempt of active) {
      const command = commandFor(next, "cancel-node", nodeId);
      next = command.state;
      commands.push({ kind: "cancel-node", id: command.id, nodeId, candidateGeneration: attempt.candidateGeneration, attempt: attempt.attempt, attemptCommandId: attempt.commandId, cancellationEpoch: next.cancellationEpoch });
    }
  }
  if (cancelled) {
    for (const [nodeId, runtime] of Object.entries(next.nodes)) {
      if (runtime.status === "blocked" || runtime.status === "ready" || runtime.status === "retry_wait") next = withNode(next, nodeId, { ...runtime, status: "cancelled" });
    }
  }
  return next;
}

function finish(factory: CompiledFactory, state: KernelState, commands: KernelCommand[]): AdvanceResult {
  if (state.status === "stopping") {
    if (Object.values(state.nodes).some((node) => node.attempts.some((attempt) => !attempt.stopped) || node.attempts.some((attempt) => attempt.uncertain))) return { nextState: state, commands };
    const failed = Object.values(state.nodes).some((node) => node.status === "failed");
    const cancelled = state.cancellationEpoch > 0;
    const next = { ...state, status: cancelled ? "cancelled" as const : failed ? "failed" as const : "completed" as const };
    const command = commandFor(next, cancelled ? "cancel-run" : failed ? "fail-run" : "complete-run");
    if (command.kind === "complete-run") commands.push({ kind: "complete-run", id: command.id, output: graphOutput(factory, command.state) });
    else if (command.kind === "fail-run") commands.push({ kind: "fail-run", id: command.id, error: "GRAPH_FAILED" });
    else commands.push({ kind: "cancel-run", id: command.id, reason: "CANCELLED" });
    return { nextState: command.state, commands };
  }
  const nodes = Object.entries(state.nodes).filter(([id, runtime]) => !(runtime.status === "failed" && isCollectMapChild(factory, id))).map(([, runtime]) => runtime);
  if (nodes.length > 0 && nodes.every((node) => node.status === "succeeded" || node.status === "skipped")) {
    const done = { ...state, status: "completed" as const };
    const command = commandFor(done, "complete-run");
    commands.push({ kind: "complete-run", id: command.id, output: graphOutput(factory, command.state) });
    return { nextState: command.state, commands };
  }
  return { nextState: state, commands };
}

function commandFor<T extends KernelCommand["kind"]>(state: KernelState, kind: T, nodeId?: string): { state: KernelState; id: string; kind: T } {
  const commandCounter = state.commandCounter + 1;
  return { state: { ...state, commandCounter }, id: `${state.logicalRunId}:${nodeId ?? "run"}:${kind}:${commandCounter}`, kind };
}

function withNode(state: KernelState, nodeId: string, runtime: KernelNodeState): KernelState {
  return { ...state, nodes: { ...state.nodes, [nodeId]: runtime } };
}

function rememberEvent(state: KernelState, eventId: string): KernelState {
  return { ...state, appliedEventIds: state.appliedEventIds.concat(eventId) };
}

function nodeDeadline(state: KernelState, node: FactoryNode): number {
  return Math.min(state.runDeadlineAtMs, state.nowMs + Math.min(node.deadlineMs ?? DEFAULT_NODE_DEADLINE_MS, 24 * 60 * 60 * 1_000));
}

function retryAllowed(node: FactoryNode, runtime: KernelNodeState): boolean {
  return runtime.nextAttempt < (node.retry?.maxAttempts ?? 1);
}

function retryDelay(node: FactoryNode, attempt: number): number {
  const retry = node.retry;
  if (!retry) return 0;
  return Math.min(retry.maximumDelayMs, retry.initialDelayMs * 2 ** Math.max(0, attempt - 1));
}

function matchesAttempt(runtime: KernelNodeState, event: Extract<KernelEvent, { kind: "node-result" | "node-failed" }>): boolean {
  const attempt = runtime.attempts.at(-1);
  return (runtime.status === "running" || runtime.status === "waiting") && attempt?.commandId === event.commandId && attempt.candidateGeneration === event.candidateGeneration && attempt.attempt === event.attempt && !attempt.stopped;
}

function inputFor(state: KernelState, node: FactoryNode): JsonValue {
  const bindings = node.bindings;
  if (!bindings || Object.keys(bindings).length === 0) return state.input;
  const input: Record<string, JsonValue> = {};
  for (const [name, source] of Object.entries(bindings)) input[name] = resolveValue(source, state);
  validateRecord(node.inputPorts ?? {}, input, `node ${node.id} input`);
  return input;
}

function validateOutput(node: FactoryNode, output: JsonValue): boolean {
  try {
    validateRecord(node.outputPorts ?? {}, output, `node ${node.id} output`);
    return true;
  } catch { return false; }
}

function validateRecord(schemas: Readonly<Record<string, import("./types").PortSchema>>, value: JsonValue, label: string): void {
  if (Object.keys(schemas).length === 0) return;
  if (!isRecord(value)) throw new FactoryKernelError(`${label} must be an object`);
  for (const [name, schema] of Object.entries(schemas)) {
    if (!Object.hasOwn(value, name)) throw new FactoryKernelError(`${label}.${name} is missing`);
    if (!validateValue(schema, value[name]! ).ok) throw new FactoryKernelError(`${label}.${name} is invalid`);
  }
}

function resolveValue(source: ValueSource, state: KernelState): JsonValue {
  if (source.kind === "literal") return source.value;
  return resolveReference(source, state);
}

function resolveReference(reference: ValueReference, state: KernelState): JsonValue {
  let value: JsonValue | undefined;
  if (reference.root === "input") value = isRecord(state.input) ? state.input[reference.name] : undefined;
  else if (reference.root === "node") value = state.nodes[reference.name]?.output;
  if (value === undefined) throw new FactoryKernelError(`reference ${reference.root}.${reference.name} is missing`);
  for (const segment of reference.path ?? []) {
    if (typeof segment === "number") value = Array.isArray(value) ? value[segment] : undefined;
    else value = isRecord(value) ? value[segment] : undefined;
    if (value === undefined) throw new FactoryKernelError(`reference path is missing`);
  }
  return value;
}

function expressionContext(state: KernelState, loop?: Readonly<Record<string, JsonValue>>): { readonly inputs: Readonly<Record<string, JsonValue>>; readonly nodes: Readonly<Record<string, JsonValue>>; readonly loop?: Readonly<Record<string, JsonValue>> } {
  const inputs = isRecord(state.input) ? state.input : {};
  const nodes: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const [id, runtime] of Object.entries(state.nodes)) if (runtime.output !== undefined) nodes[id] = runtime.output;
  return { inputs, nodes, loop };
}

function graphOutput(factory: CompiledFactory, state: KernelState): JsonValue {
  const output: Record<string, JsonValue> = {};
  for (const [name, source] of Object.entries(factory.definition.graph.outputs)) output[name] = resolveValue(source, state);
  return output;
}

function completeScopeIfReady(factory: CompiledFactory, state: KernelState, nodeId: string, commands: KernelCommand[]): KernelState {
  const scope = Object.values(state.scopes).find((candidate) => candidate.nodeIds.includes(nodeId));
  if (!scope || !scope.parentNodeId || !scope.nodeIds.every((id) => state.nodes[id]?.status === "succeeded")) return state;
  const parent = state.nodes[scope.parentNodeId];
  if (!parent || parent.status !== "waiting") return state;
  const output: Record<string, JsonValue> = {};
  for (const id of scope.nodeIds) output[id.slice(id.lastIndexOf("/") + 1)] = state.nodes[id]!.output ?? null;
  const complete = withNode(state, scope.parentNodeId, { ...parent, status: "succeeded", output });
  return activateReady(factory, complete, commands, successorsFor(factory, scope.parentNodeId));
}

function progressMap(factory: CompiledFactory, state: KernelState, nodeId: string, commands: KernelCommand[]): KernelState {
  if (state.status !== "running") return state;
  const marker = "/items/";
  const markerAt = nodeId.indexOf(marker);
  if (markerAt < 0) return state;
  const parentId = nodeId.slice(0, markerAt);
  const itemStart = markerAt + marker.length;
  const itemEnd = nodeId.indexOf("/", itemStart);
  const item = Number(nodeId.slice(itemStart, itemEnd));
  const parentNode = nodeFor(factory, parentId);
  const parent = state.nodes[parentId];
  if (!parentNode || parentNode.kind !== "map" || !parent?.map || !Number.isSafeInteger(item)) return state;
  const prefix = `${parentId}/items/${item}/`;
  const members = Object.keys(state.nodes).filter((id) => id.startsWith(prefix));
  if (members.length === 0 || !members.every((id) => state.nodes[id]?.status === "succeeded" || state.nodes[id]?.status === "failed" || state.nodes[id]?.status === "cancelled")) return state;
  if (parent.map.completedIndexes.includes(item) || parent.map.failedIndexes.includes(item)) return state;
  const failed = members.find((id) => state.nodes[id]?.status !== "succeeded");
  if (failed && parentNode.mode === "all") return failNode(factory, state, parentNode, parentId, "MAP_ITEM_FAILED", "execution", commands);
  const outcomes = parent.map.outcomes.slice();
  outcomes[item] = failed ? { error: state.nodes[failed]!.error ?? "MAP_ITEM_FAILED" } : state.nodes[members.at(-1)!]!.output ?? null;
  const map = { ...parent.map, outcomes, completedIndexes: failed ? parent.map.completedIndexes : parent.map.completedIndexes.concat(item), failedIndexes: failed ? parent.map.failedIndexes.concat(item) : parent.map.failedIndexes };
  let next = withNode(state, parentId, { ...parent, map });
  const terminalItems = map.completedIndexes.length + map.failedIndexes.length;
  if (terminalItems === map.itemCount) {
    const output: JsonValue = outcomes.map((outcome) => outcome ?? { error: "MAP_ITEM_MISSING" });
    next = withNode(next, parentId, { ...next.nodes[parentId]!, status: "succeeded", output });
    return activateReady(factory, next, commands, successorsFor(factory, parentId));
  }
  const activeItems = new Set(Object.keys(next.nodes).filter((id) => id.startsWith(`${parentId}/items/`) && ["reserved", "running", "waiting", "retry_wait"].includes(next.nodes[id]!.status)).map((id) => Number(id.slice(`${parentId}/items/`.length).split("/")[0])));
  for (let nextItem = 0; nextItem < map.itemCount && activeItems.size < parentNode.maxConcurrency; nextItem += 1) {
    if (map.completedIndexes.includes(nextItem) || map.failedIndexes.includes(nextItem) || activeItems.has(nextItem)) continue;
    const roots = parentNode.body.nodes.filter((child) => (child.dependsOn?.length ?? 0) === 0).map((child) => `${parentId}/items/${nextItem}/${child.id}`);
    next = activateReady(factory, next, commands, roots);
    activeItems.add(nextItem);
  }
  return next;
}

function startLoopIteration(factory: CompiledFactory, state: KernelState, node: Extract<FactoryNode, { kind: "loop" }>, nodeId: string, runtime: KernelNodeState, carried: JsonValue, iteration: number, commands: KernelCommand[]): KernelState {
  if (!validateValue(node.carriedSchema, carried).ok) return failNode(factory, state, node, nodeId, "LOOP_INPUT_INVALID", "execution", commands);
  if (iteration >= node.maxIterations || state.nowMs - (runtime.loop?.startedAtMs ?? state.nowMs) > node.maxElapsedMs) return failNode(factory, state, node, nodeId, "LOOP_BOUND_EXHAUSTED", "bound_exhausted", commands);
  const prefix = `${nodeId}/items/${iteration}`;
  const nodes: Record<string, KernelNodeState> = { ...state.nodes };
  const roots: string[] = [];
  for (const child of node.body.nodes) {
    const id = `${prefix}/${child.id}`;
    nodes[id] = { status: "blocked", candidateGeneration: 0, nextAttempt: 1, attempts: [] };
    if ((child.dependsOn?.length ?? 0) === 0) roots.push(id);
  }
  const scopeId = `${nodeId}/items/${iteration}`;
  const loop = { iteration, carried, startedAtMs: runtime.loop?.startedAtMs ?? state.nowMs, spentCostMicros: runtime.loop?.spentCostMicros ?? "0", unknownCostMicros: runtime.loop?.unknownCostMicros ?? "0" };
  const next = { ...state, nodes, scopes: { ...state.scopes, [scopeId]: { id: scopeId, parentNodeId: nodeId, depth: 1, expandedNodeCount: node.body.nodes.length, spentCostMicros: loop.spentCostMicros, unknownCostMicros: loop.unknownCostMicros, nodeIds: node.body.nodes.map((child) => `${prefix}/${child.id}`), roots } } };
  return activateReady(factory, withNode(next, nodeId, { ...runtime, status: "waiting", loop, waitingReason: "external_reconciliation" }), commands, roots);
}

function progressLoop(factory: CompiledFactory, state: KernelState, nodeId: string, commands: KernelCommand[]): KernelState {
  const parentId = mapParent(nodeId);
  const parentNode = parentId ? nodeFor(factory, parentId) : undefined;
  const parent = parentId ? state.nodes[parentId] : undefined;
  if (!parentId || !parent || parentNode?.kind !== "loop" || !parent.loop) return state;
  const prefix = `${parentId}/items/${parent.loop.iteration}/`;
  const members = Object.keys(state.nodes).filter((id) => id.startsWith(prefix));
  if (members.length === 0 || !members.every((id) => state.nodes[id]?.status === "succeeded")) return state;
  const result = state.nodes[members.at(-1)!]!.output ?? null;
  if (!validateValue(parentNode.resultSchema, result).ok) return failNode(factory, state, parentNode, parentId, "LOOP_RESULT_INVALID", "execution", commands);
  const context = expressionContext(state, { carried: parent.loop.carried, result, iteration: parent.loop.iteration });
  const until = evaluateExpression(parentNode.until, context);
  if (!until.ok || typeof until.value !== "boolean") return failNode(factory, state, parentNode, parentId, "LOOP_UNTIL_INVALID", "execution", commands);
  if (until.value) return activateReady(factory, withNode(state, parentId, { ...parent, status: "succeeded", output: result }), commands, successorsFor(factory, parentId));
  const next = evaluateExpression(parentNode.nextInput, context);
  if (!next.ok || !validateValue(parentNode.carriedSchema, next.value).ok) return failNode(factory, state, parentNode, parentId, "LOOP_NEXT_INPUT_INVALID", "execution", commands);
  return startLoopIteration(factory, state, parentNode, parentId, parent, next.value, parent.loop.iteration + 1, commands);
}

function mapParent(nodeId: string): string | undefined {
  const marker = "/items/";
  const markerAt = nodeId.indexOf(marker);
  return markerAt < 0 ? undefined : nodeId.slice(0, markerAt);
}

function isCollectMapChild(factory: CompiledFactory, nodeId: string): boolean {
  const parentId = mapParent(nodeId);
  const parent = parentId ? nodeFor(factory, parentId) : undefined;
  return parent?.kind === "map" && parent.mode === "collect";
}

function nodeFor(factory: CompiledFactory, nodeId: string): FactoryNode | undefined {
  const parts = nodeId.split("/");
  let graph = factory.definition.graph;
  for (let index = 0; index < parts.length; index += 1) {
    const id = parts[index]!;
    const node = graph.nodes.find((candidate) => candidate.id === id);
    if (!node) return undefined;
    if (index === parts.length - 1) return node;
    const scope = parts[index + 1];
    if (node.kind === "branch" && (scope === "then" || scope === "else")) { graph = node[scope]; index += 1; continue; }
    if ((node.kind === "map" || node.kind === "loop") && scope === "items" && parts[index + 2] !== undefined) { graph = node.body; index += 2; continue; }
    return undefined;
  }
  return undefined;
}

function successorsFor(factory: CompiledFactory, nodeId: string): readonly string[] {
  if (!nodeId.includes("/")) return factory.indexes.successors[nodeId] ?? [];
  const separator = nodeId.lastIndexOf("/");
  const scope = nodeId.slice(0, separator);
  const node = nodeFor(factory, nodeId);
  if (!node) return [];
  const itemMarker = "/items/";
  const itemAt = scope.indexOf(itemMarker);
  if (itemAt >= 0) {
    const parentId = scope.slice(0, itemAt);
    const item = scope.slice(itemAt + itemMarker.length);
    const parent = nodeFor(factory, parentId);
    if (!parent || (parent.kind !== "map" && parent.kind !== "loop")) return [];
    return parent.body.nodes.filter((candidate) => (candidate.dependsOn ?? []).includes(node.id)).map((candidate) => `${parentId}/items/${item}/${candidate.id}`);
  }
  const parts = scope.split("/");
  let graph = factory.definition.graph;
  for (let index = 0; index < parts.length; index += 2) {
    const branch = graph.nodes.find((candidate) => candidate.id === parts[index]);
    if (!branch || branch.kind !== "branch") return [];
    graph = branch[parts[index + 1] as "then" | "else"];
  }
  return graph.nodes.filter((candidate) => (candidate.dependsOn ?? []).includes(node.id)).map((candidate) => `${scope}/${candidate.id}`);
}

function toJoinOutcome(status: KernelNodeState["status"]): "succeeded" | "failed" | "skipped" | "cancelled" {
  return status === "succeeded" || status === "failed" || status === "skipped" ? status : "cancelled";
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function distinct(values: readonly string[]): readonly string[] { return [...new Set(values)]; }
