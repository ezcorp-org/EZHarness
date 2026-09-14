import { validateDurableInputPorts, validateValue } from "./validation.js";
import { evaluateExpression } from "./expressions.js";
import { canonicalizeJson, isUnsignedDecimal, validateIJson } from "./canonical.js";
import { FACTORY_LIMITS } from "./types.js";
import type { FactoryDurableInput } from "./types.js";
import type {
  AdvanceResult,
  KernelCommand,
  KernelEvent,
  KernelFactoryPlan,
  KernelNodeState,
  KernelState,
} from "./kernel-types.js";
import type { FactoryGraph, FactoryNode, JsonValue, ValueSource } from "./types.js";

const DEFAULT_RUN_DEADLINE_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_RUN_DEADLINE_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_NODE_DEADLINE_MS = 30 * 60 * 1_000;

function partitionFor(factory: KernelFactoryPlan, partitionId: string) {
  return factory.partitions.find((candidate) => candidate.id === partitionId);
}

export class FactoryKernelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FactoryKernelError";
  }
}

export function createKernelState(
  factory: KernelFactoryPlan,
  logicalRunId: string,
  input: JsonValue,
  nowMs: number,
  durableInput?: FactoryDurableInput,
): KernelState {
  return createInitialState(factory, factory.definition.graph.nodes.map((node) => node.id), logicalRunId, input, nowMs, undefined, durableInput);
}

/** Create one bounded interpreter state from a compiler-owned execution partition. */
export function createPartitionKernelState(
  factory: KernelFactoryPlan,
  partitionId: string,
  logicalRunId: string,
  input: JsonValue,
  nowMs: number,
  durableInput?: FactoryDurableInput,
): KernelState {
  const partition = factory.partitions.find((candidate) => candidate.id === partitionId);
  if (!partition) throw new FactoryKernelError(`compiled partition ${partitionId} does not exist`);
  return createInitialState(factory, partition.nodeIds, logicalRunId, input, nowMs, partitionId, durableInput);
}

function snapshotDurableInput(value: FactoryDurableInput): FactoryDurableInput {
  return JSON.parse(canonicalizeJson(value as unknown as JsonValue)) as FactoryDurableInput;
}

function createInitialState(
  factory: KernelFactoryPlan,
  nodeIds: readonly string[],
  logicalRunId: string,
  input: JsonValue,
  nowMs: number,
  partitionId?: string,
  durableInput?: FactoryDurableInput,
): KernelState {
  if (durableInput === undefined) validateRecord(factory.definition.inputPorts, input, "run input");
  else {
    const result = validateDurableInputPorts(factory.definition.inputPorts, input, durableInput);
    if (!result.ok) throw new FactoryKernelError(result.issues[0]?.message ?? "durable run input is invalid");
  }
  const nodes: Record<string, KernelNodeState> = Object.create(null) as Record<string, KernelNodeState>;
  for (const nodeId of nodeIds) {
    if (!factory.definition.graph.nodes.some((node) => node.id === nodeId)) throw new FactoryKernelError(`compiled partition contains unknown node ${nodeId}`);
    nodes[nodeId] = { status: "blocked", candidateGeneration: 0, nextAttempt: 1, attempts: [] };
  }
  const requested = factory.definition.bounds.runDeadlineMs ?? DEFAULT_RUN_DEADLINE_MS;
  return {
    logicalRunId,
    definitionDigest: factory.digest,
    input: snapshotValue(input),
    ...(durableInput ? { durableInput: snapshotDurableInput(durableInput), lazyInput: { versions: {}, values: {}, pending: {} } } : {}),
    status: "created",
    runDeadlineAtMs: nowMs + Math.min(requested, MAX_RUN_DEADLINE_MS),
    nowMs,
    cancellationEpoch: 0,
    commandCounter: 0,
    eventSequence: 0,
    spentCostMicros: "0",
    unknownCostMicros: "0",
    usageSettlements: {},
    nodes,
    scopes: { root: { id: "root", depth: 0, expandedNodeCount: nodeIds.length, spentCostMicros: "0", unknownCostMicros: "0", nodeIds, roots: nodeIds } },
    appliedEventIds: [],
    unresolvedUncertainNodeIds: [],
    ...(partitionId ? { partition: { id: partitionId, completedEdges: {}, invalidatedEdges: {}, externalOutputs: {} } } : {}),
  };
}

/** Apply one recorded event. It is deterministic and never reads ambient state. */
export function advanceKernel(factory: KernelFactoryPlan, state: KernelState, event: KernelEvent): AdvanceResult {
  if (factory.digest !== state.definitionDigest) throw new FactoryKernelError("compiled plan digest does not match kernel state");
  if (state.appliedEventIds.includes(event.id)) return { nextState: state, commands: [] };
  if (!Number.isSafeInteger(event.atMs) || event.atMs < 0) throw new FactoryKernelError("event timestamp must be a non-negative safe integer");
  // The adapter supplies a total recorded event order. A late callback still
  // applies its fence/cancellation semantics; logical time never moves back.
  let next = rememberEvent({ ...state, nowMs: Math.max(state.nowMs, event.atMs), eventSequence: state.eventSequence + 1 }, event.id);
  const commands: KernelCommand[] = [];

  if (event.kind === "usage-settled") {
    next = applyUsage(factory, next, event, commands);
    return { nextState: next, commands };
  }

  if (next.status !== "created" && next.status !== "running" && next.status !== "waiting" && next.status !== "stopping") {
    return { nextState: next, commands };
  }

  if (event.kind === "cancel") {
    next = beginStopping(next, event.reason, commands, true);
    return finish(factory, next, commands);
  }
  if (event.kind === "timer-expired" && event.nodeId === undefined) {
    if (event.commandId !== next.runTimerId || event.atMs < next.runDeadlineAtMs) return { nextState: next, commands };
    next = beginStopping(next, "RUN_DEADLINE_EXPIRED", commands, false);
    return finish(factory, next, commands);
  }
  if (event.atMs >= next.runDeadlineAtMs && next.status !== "stopping") {
    next = beginStopping(next, "RUN_DEADLINE_EXPIRED", commands, false);
  }

  switch (event.kind) {
    case "start":
      if (next.status === "created") {
        next = { ...next, status: "running" };
        if (factory.definition.graph.nodes.length > 0) {
          const timer = commandFor(next, "start-timer");
          next = { ...timer.state, runTimerId: timer.id };
          commands.push({ kind: "start-timer", id: timer.id, deadlineAtMs: next.runDeadlineAtMs });
        }
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
    case "input-value-read":
      next = applyInputValue(factory, next, event, commands);
      break;
    case "input-page-read":
      next = applyInputPage(factory, next, event, commands);
      break;
    case "timer-expired":
      next = applyTimer(factory, next, event, commands);
      break;
    case "repair":
      next = applyRepair(factory, next, event, commands);
      break;
    case "replan":
      next = applyRepair(factory, next, event, commands);
      break;
    case "partition-source-invalidated":
      next = applyPartitionInvalidation(factory, next, event, commands);
      break;
    case "partition-node-completed":
      next = applyPartitionCompletion(factory, next, event, commands);
      break;
  }
  next = completePendingRepair(factory, next, commands);
  next = refillWaitingMaps(factory, next, commands);
  next = emitPartitionNotifications(factory, state, next, commands);
  return finish(factory, next, commands);
}

function applyInputValue(factory: KernelFactoryPlan, state: KernelState, event: Extract<KernelEvent, { readonly kind: "input-value-read" }>, commands: KernelCommand[]): KernelState {
  const pending = state.lazyInput?.pending[event.commandId];
  if (pending?.kind !== "value" || pending.nodeId !== event.nodeId || pending.candidateGeneration !== event.candidateGeneration || pending.cancellationEpoch !== event.cancellationEpoch || pending.name !== event.name || lazyKey(pending.name, pending.path) !== lazyKey(event.name, event.path) || artifactKey(pending.artifact) !== artifactKey(event.artifact) || event.mediaType !== "application/json") throw new FactoryKernelError("lazy input result does not match its pending command");
  if (new TextEncoder().encode(canonicalizeJson(event.value)).byteLength > pending.maxBytes) throw new FactoryKernelError("lazy input result exceeds its bound");
  const key = artifactKey(event.artifact);
  const bound = state.lazyInput!.versions[key];
  if (bound !== undefined && bound !== event.storageVersion) throw new FactoryKernelError("lazy input storage version changed");
  const lazyInput = { versions: { ...state.lazyInput!.versions, [key]: event.storageVersion }, values: { ...state.lazyInput!.values, [lazyKey(event.name, event.path)]: snapshotValue(event.value) }, pending: { ...state.lazyInput!.pending } };
  delete (lazyInput.pending as Record<string, unknown>)[event.commandId];
  return activateReady(factory, withNode({ ...state, lazyInput }, pending.nodeId, { ...state.nodes[pending.nodeId]!, status: "blocked", waitingReason: undefined, waitingDeadlineAtMs: undefined }), commands, [pending.nodeId]);
}

function applyInputPage(factory: KernelFactoryPlan, state: KernelState, event: Extract<KernelEvent, { readonly kind: "input-page-read" }>, commands: KernelCommand[]): KernelState {
  const pending = state.lazyInput?.pending[event.commandId];
  if (pending?.kind !== "page" || pending.nodeId !== event.nodeId || pending.candidateGeneration !== event.candidateGeneration || pending.cancellationEpoch !== event.cancellationEpoch || pending.name !== event.name || pending.cursor !== event.cursor || pending.maxItems !== event.maxItems || artifactKey(pending.artifact) !== artifactKey(event.artifact) || lazyKey(pending.name, pending.path) !== lazyKey(event.name, event.path) || event.mediaType !== "application/json" || event.items.length > pending.maxItems || !Number.isSafeInteger(event.cursor) || event.cursor < 0 || (event.nextCursor !== undefined && (!Number.isSafeInteger(event.nextCursor) || event.nextCursor !== event.cursor + event.items.length || event.nextCursor <= event.cursor))) throw new FactoryKernelError("lazy input page does not match its pending command");
  if (new TextEncoder().encode(canonicalizeJson(event.items as JsonValue)).byteLength > pending.maxBytes) throw new FactoryKernelError("lazy input page exceeds its bound");
  const key = artifactKey(event.artifact); const bound = state.lazyInput!.versions[key];
  if (bound !== undefined && bound !== event.storageVersion) throw new FactoryKernelError("lazy input storage version changed");
  const pendingEntries = { ...state.lazyInput!.pending }; delete (pendingEntries as Record<string, unknown>)[event.commandId];
  const lazyInput = { ...state.lazyInput!, versions: { ...state.lazyInput!.versions, [key]: event.storageVersion }, pending: pendingEntries };
  const runtime = state.nodes[pending.nodeId];
  if (!runtime?.map) throw new FactoryKernelError("lazy input page has no waiting map");
  const node = nodeFor(factory, pending.nodeId);
  if (node?.kind !== "map") throw new FactoryKernelError("lazy input page has no map definition");
  const itemCount = event.nextCursor ?? event.cursor + event.items.length;
  if (itemCount > node.maxItems) return failNode(factory, { ...state, lazyInput }, node, pending.nodeId, "MAP_ITEM_BOUND", "bound_exhausted", commands);
  const map = { ...runtime.map, snapshot: event.items.map(snapshotValue), itemCount, pageOffset: event.cursor, nextCursor: event.nextCursor, lazy: { name: pending.name, artifact: pending.artifact, path: pending.path, storageVersion: event.storageVersion } };
  const resumed = withNode({ ...state, lazyInput }, pending.nodeId, { ...runtime, map });
  if (event.items.length === 0 && event.nextCursor === undefined) return completeMap(factory, resumed, node, pending.nodeId, commands);
  return fillMapWindow(factory, resumed, node, pending.nodeId, commands);
}

function partitionEdgeKey(sourcePartitionId: string, sourceNodeId: string, nodeId: string): string {
  return `${sourcePartitionId}\u0000${sourceNodeId}\u0000${nodeId}`;
}

function applyPartitionCompletion(
  factory: KernelFactoryPlan,
  state: KernelState,
  event: Extract<KernelEvent, { kind: "partition-node-completed" }>,
  commands: KernelCommand[],
): KernelState {
  if (!state.partition || state.partition.id !== event.targetPartitionId) return state;
  if (!Number.isSafeInteger(event.candidateGeneration) || event.candidateGeneration < 0 || !Number.isSafeInteger(event.terminalSequence) || event.terminalSequence < 1) {
    throw new FactoryKernelError("partition completion fence must contain safe non-negative generation and positive sequence values");
  }
  const partition = partitionFor(factory, state.partition.id);
  const edge = partition?.inbound.find((candidate) => candidate.nodeId === event.nodeId && candidate.fromNodeId === event.sourceNodeId && candidate.fromPartitionId === event.sourcePartitionId);
  if (!edge || !Object.hasOwn(state.nodes, event.nodeId)) return state;
  const edgeKey = partitionEdgeKey(event.sourcePartitionId, event.sourceNodeId, event.nodeId);
  const priorEdge = state.partition.completedEdges[edgeKey];
  const priorOutput = state.partition.externalOutputs[event.sourceNodeId];
  const invalidated = state.partition.invalidatedEdges[edgeKey];
  if (invalidated && event.candidateGeneration < invalidated.candidateGeneration) return state;
  if (priorOutput) {
    if (event.candidateGeneration < priorOutput.candidateGeneration) return state;
    const exactSource = priorOutput.candidateGeneration === event.candidateGeneration
      && priorOutput.terminalSequence === event.terminalSequence
      && priorOutput.status === event.outcome
      && priorOutput.error === event.error
      && canonicalizeJson(priorOutput.output ?? null) === canonicalizeJson(event.output ?? null);
    if (event.candidateGeneration === priorOutput.candidateGeneration) {
      if (!exactSource || (priorEdge !== undefined && priorEdge !== event.id)) throw new FactoryKernelError("partition completion conflicts with its recorded source fence");
      if (priorEdge) return state;
    }
  }
  const invalidatedEdges = { ...state.partition.invalidatedEdges };
  delete invalidatedEdges[edgeKey];
  const partitionState = {
    ...state.partition,
    invalidatedEdges,
    completedEdges: { ...state.partition.completedEdges, [edgeKey]: event.id },
    externalOutputs: {
      ...state.partition.externalOutputs,
      [event.sourceNodeId]: {
        status: event.outcome,
        ...(event.output === undefined ? {} : { output: snapshotValue(event.output) }),
        ...(event.error === undefined ? {} : { error: event.error }),
        candidateGeneration: event.candidateGeneration,
        terminalSequence: event.terminalSequence,
      },
    },
  };
  let next: KernelState = { ...state, partition: partitionState };
  if (priorOutput && event.candidateGeneration > priorOutput.candidateGeneration) {
    next = applyRepair(factory, next, { kind: "repair", id: event.id, atMs: event.atMs, nodeId: event.nodeId, reason: "PARTITION_SOURCE_REPAIRED" }, commands);
  }
  return activateReady(factory, next, commands, [event.nodeId]);
}

function applyPartitionInvalidation(
  factory: KernelFactoryPlan,
  state: KernelState,
  event: Extract<KernelEvent, { kind: "partition-source-invalidated" }>,
  commands: KernelCommand[],
): KernelState {
  if (!state.partition || state.partition.id !== event.targetPartitionId) return state;
  if (!Number.isSafeInteger(event.candidateGeneration) || event.candidateGeneration < 1) throw new FactoryKernelError("partition invalidation generation must be a positive safe integer");
  const partition = partitionFor(factory, state.partition.id);
  const edge = partition?.inbound.find((candidate) => candidate.nodeId === event.nodeId && candidate.fromNodeId === event.sourceNodeId && candidate.fromPartitionId === event.sourcePartitionId);
  if (!edge || !Object.hasOwn(state.nodes, event.nodeId)) return state;
  const edgeKey = partitionEdgeKey(event.sourcePartitionId, event.sourceNodeId, event.nodeId);
  const priorInvalidation = state.partition.invalidatedEdges[edgeKey];
  const priorOutput = state.partition.externalOutputs[event.sourceNodeId];
  if (event.candidateGeneration < (priorInvalidation?.candidateGeneration ?? priorOutput?.candidateGeneration ?? 0)) return state;
  if (priorInvalidation?.candidateGeneration === event.candidateGeneration) {
    if (priorInvalidation.eventId !== event.id) throw new FactoryKernelError("partition invalidation conflicts with its recorded source fence");
    return state;
  }
  if (priorOutput && event.candidateGeneration <= priorOutput.candidateGeneration) return state;
  const completedEdges = { ...state.partition.completedEdges };
  delete completedEdges[edgeKey];
  const externalOutputs = { ...state.partition.externalOutputs };
  delete externalOutputs[event.sourceNodeId];
  const partitionState = {
    ...state.partition,
    completedEdges,
    invalidatedEdges: { ...state.partition.invalidatedEdges, [edgeKey]: { candidateGeneration: event.candidateGeneration, eventId: event.id } },
    externalOutputs,
  };
  return applyRepair(factory, { ...state, partition: partitionState }, { kind: "repair", id: event.id, atMs: event.atMs, nodeId: event.nodeId, reason: "PARTITION_SOURCE_INVALIDATED" }, commands, true);
}

function emitPartitionNotifications(
  factory: KernelFactoryPlan,
  previous: KernelState,
  state: KernelState,
  commands: KernelCommand[],
): KernelState {
  if (!state.partition) return state;
  const partition = partitionFor(factory, state.partition.id);
  let next = state;
  for (const edge of partition?.outbound ?? []) {
    const runtime = state.nodes[edge.nodeId]!;
    const status = runtime?.status;
    const previousRuntime = previous.nodes[edge.nodeId];
    if (!status || !terminalStatus(status) || (previousRuntime?.status === status && previousRuntime.candidateGeneration === runtime.candidateGeneration && previousRuntime.terminalSequence === runtime.terminalSequence)) continue;
    const command = commandFor(next, "notify-partition", edge.nodeId);
    next = command.state;
    commands.push({
      kind: "notify-partition",
      id: command.id,
      sourcePartitionId: state.partition.id,
      targetPartitionId: edge.toPartitionId,
      sourceNodeId: edge.nodeId,
      nodeId: edge.toNodeId,
      candidateGeneration: runtime.candidateGeneration,
      terminalSequence: runtime.terminalSequence!,
      outcome: status as "succeeded" | "failed" | "skipped" | "cancelled",
      ...(runtime.output === undefined ? {} : { output: runtime.output }),
      ...(runtime.error === undefined ? {} : { error: runtime.error }),
    });
  }
  return next;
}

function applyUsage(factory: KernelFactoryPlan, state: KernelState, event: Extract<KernelEvent, { kind: "usage-settled" }>, commands: KernelCommand[]): KernelState {
  const node = Object.hasOwn(state.nodes, event.nodeId) ? state.nodes[event.nodeId] : undefined;
  const attempt = node?.attempts.find((candidate) => candidate.commandId === event.commandId && candidate.attempt === event.attempt && candidate.candidateGeneration === event.candidateGeneration);
  if (!attempt) return state;
  if (!Number.isSafeInteger(event.revision) || event.revision < 1) throw new FactoryKernelError("usage revision must be a positive safe integer");
  const known = parseMicros(event.knownCostMicros);
  const unknown = parseMicros(event.unknownCostMicros ?? "0");
  if (known === undefined || unknown === undefined) throw new FactoryKernelError("usage cost must be a non-negative decimal integer");
  const previous = Object.hasOwn(state.usageSettlements, event.commandId) ? state.usageSettlements[event.commandId] : undefined;
  if (previous && event.revision < previous.revision) return state;
  if (previous && event.revision === previous.revision) {
    if (previous.knownCostMicros !== known.toString() || previous.unknownCostMicros !== unknown.toString()) throw new FactoryKernelError("usage settlement conflicts with its recorded revision");
    return state;
  }
  if (event.revision !== (previous?.revision ?? 0) + 1) throw new FactoryKernelError("usage settlement revision has a gap");
  const knownDelta = known - BigInt(previous?.knownCostMicros ?? "0");
  const unknownDelta = unknown - BigInt(previous?.unknownCostMicros ?? "0");
  if (knownDelta < 0n) throw new FactoryKernelError("known usage cannot decrease");
  let next: KernelState = { ...state, spentCostMicros: (BigInt(state.spentCostMicros) + knownDelta).toString(), unknownCostMicros: (BigInt(state.unknownCostMicros) + unknownDelta).toString(), usageSettlements: { ...state.usageSettlements, [event.commandId]: { nodeId: event.nodeId, revision: event.revision, knownCostMicros: known.toString(), unknownCostMicros: unknown.toString() } } };
  const scopes = { ...next.scopes };
  for (const [scopeId, scope] of Object.entries(scopes)) {
    if (scopeId === "root" || scope.nodeIds.some((id) => event.nodeId === id || event.nodeId.startsWith(`${id}/`))) {
      scopes[scopeId] = { ...scope, spentCostMicros: (BigInt(scope.spentCostMicros) + knownDelta).toString(), unknownCostMicros: (BigInt(scope.unknownCostMicros) + unknownDelta).toString() };
    }
  }
  next = { ...next, scopes };
  for (const loopId of loopAncestors(factory, event.nodeId)) {
    const loop = nodeFor(factory, loopId);
    const runtime = next.nodes[loopId];
    if (loop?.kind !== "loop" || !runtime?.loop) continue;
    const spent = BigInt(runtime.loop.spentCostMicros) + knownDelta;
    const unknownSpent = BigInt(runtime.loop.unknownCostMicros) + unknownDelta;
    next = withNode(next, loopId, { ...runtime, loop: { ...runtime.loop, spentCostMicros: spent.toString(), unknownCostMicros: unknownSpent.toString() } });
    if (loop.budget?.maxCostMicros !== undefined && spent + unknownSpent > BigInt(loop.budget.maxCostMicros) && (next.status === "running" || next.status === "waiting")) {
      next = failNode(factory, next, loop, loopId, "LOOP_BUDGET_EXHAUSTED", "bound_exhausted", commands);
    }
  }
  return next;
}

function applyAdmission(factory: KernelFactoryPlan, state: KernelState, event: Extract<KernelEvent, { kind: "admission-result" }>, commands: KernelCommand[]): KernelState {
  const runtime = state.nodes[event.nodeId];
  const node = nodeFor(factory, event.nodeId);
  if (!runtime || !node || runtime.status !== "reserved" || runtime.candidateGeneration !== event.candidateGeneration) return state;
  const attempt = runtime.attempts.at(-1);
  if (!attempt || attempt.commandId !== event.commandId || attempt.stopped) return state;
  if (state.nowMs >= attempt.deadlineAtMs) return failNode(factory, state, node, event.nodeId, "NODE_DEADLINE_EXPIRED", "deadline", commands);
  if (!event.granted) return failNode(factory, state, node, event.nodeId, "ADMISSION_DENIED", "admission_denied", commands);
  const input = inputFor(state, node, event.nodeId);
  const deadlineAtMs = attempt.deadlineAtMs;
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
  return withNode(command.state, event.nodeId, running);
}

function applyResult(factory: KernelFactoryPlan, state: KernelState, event: Extract<KernelEvent, { kind: "node-result" }>, commands: KernelCommand[]): KernelState {
  const runtime = state.nodes[event.nodeId];
  const node = nodeFor(factory, event.nodeId);
  if (!runtime || !node || !matchesAttempt(runtime, event)) return state;
  if (state.nowMs >= runtime.attempts.at(-1)!.deadlineAtMs) return failNode(factory, state, node, event.nodeId, "NODE_DEADLINE_EXPIRED", "deadline", commands);
  if (!validateNodeOutput(node, event.output)) return stopFailedAttempt(state, event.nodeId, "OUTPUT_INVALID", commands);
  const attempts = runtime.attempts.map((attempt) => attempt.commandId === event.commandId ? { ...attempt, stopped: true } : attempt);
  const next = withNode(state, event.nodeId, { ...runtime, status: "succeeded", output: snapshotValue(event.output), error: undefined, attempts });
  const progressed = activateReady(factory, next, commands, successorsFor(factory, event.nodeId));
  return progressContainingScopes(factory, progressed, event.nodeId, commands);
}

function applyFailure(factory: KernelFactoryPlan, state: KernelState, event: Extract<KernelEvent, { kind: "node-failed" }>, commands: KernelCommand[]): KernelState {
  const runtime = state.nodes[event.nodeId];
  const node = nodeFor(factory, event.nodeId);
  if (!runtime || !node || !matchesAttempt(runtime, event)) return state;
  if (state.nowMs >= runtime.attempts.at(-1)!.deadlineAtMs) return failNode(factory, state, node, event.nodeId, "NODE_DEADLINE_EXPIRED", "deadline", commands);
  if (event.failureKind === "acceptance_rejected" && node.kind === "acceptance") return applyRejection(factory, state, node, event.nodeId, event.error, commands);
  return stopFailedAttempt(state, event.nodeId, event.error, commands);
}

/**
 * Answers a protected rejection with a bounded remediation wait, or exhausts the bound.
 *
 * An acceptance node is virtual. Its only attempt is the protected decision, which has already
 * returned this event, so there is nothing physical to stop; answering with `stopFailedAttempt`
 * would emit a `cancel-node` naming a task that never existed. The declared `maxRepairs` bounds the
 * wait and `FACTORY_LIMITS.maxCandidateGenerations` caps every domain, so a rejection can neither
 * be retried without end nor be swallowed as an activity error.
 */
function applyRejection(factory: KernelFactoryPlan, state: KernelState, node: Extract<FactoryNode, { kind: "acceptance" }>, nodeId: string, error: string, commands: KernelCommand[]): KernelState {
  const runtime = state.nodes[nodeId]!;
  const settled = withNode(state, nodeId, { ...runtime, attempts: runtime.attempts.map(attempt => ({ ...attempt, stopped: true })), timer: undefined });
  if (remainingRepairs(node, runtime.candidateGeneration) > 0) return escalateNode(settled, nodeId, error, commands);
  return failNode(factory, settled, node, nodeId, "ACCEPTANCE_BOUND_EXHAUSTED", "bound_exhausted", commands);
}

/** Repairs an acceptance node still authorizes. An undeclared bound authorizes none. */
function remainingRepairs(node: Extract<FactoryNode, { kind: "acceptance" }>, candidateGeneration: number): number {
  return Math.min(node.maxRepairs ?? 0, FACTORY_LIMITS.maxCandidateGenerations - 1) - candidateGeneration;
}

function applyStopped(factory: KernelFactoryPlan, state: KernelState, event: Extract<KernelEvent, { kind: "attempt-stopped" }>, commands: KernelCommand[]): KernelState {
  const runtime = state.nodes[event.nodeId];
  const node = nodeFor(factory, event.nodeId);
  if (!runtime || !node || runtime.candidateGeneration !== event.candidateGeneration) return state;
  const attempt = runtime.attempts.find((candidate) => candidate.commandId === event.commandId && candidate.attempt === event.attempt);
  if (!attempt || (attempt.stopped && (!attempt.uncertain || event.uncertain !== false))) return state;
  const attempts = runtime.attempts.map((candidate) => candidate === attempt ? { ...candidate, stopped: true, uncertain: event.uncertain ?? false } : candidate);
  let next = withNode(state, event.nodeId, { ...runtime, attempts });
  if (event.uncertain) {
    next = { ...next, unresolvedUncertainNodeIds: distinct(next.unresolvedUncertainNodeIds.concat(event.nodeId)) };
    return next;
  }
  next = { ...next, unresolvedUncertainNodeIds: next.unresolvedUncertainNodeIds.filter(id => id !== event.nodeId || attempts.some(candidate => candidate.uncertain)) };
  if (runtime.discarded || state.status === "stopping") {
    next = withNode(next, event.nodeId, { ...next.nodes[event.nodeId]!, status: runtime.failureHandled && runtime.error ? "failed" : runtime.discarded || state.stopKind === "cancelled" ? "cancelled" : "failed", timer: undefined });
    if (state.status !== "stopping") next = activateReady(factory, next, commands, successorsFor(factory, event.nodeId));
    return progressContainingScopes(factory, next, event.nodeId, commands);
  }
  if (runtime.status === "stopping" && retryAllowed(node, runtime)) {
    const delay = retryDelay(node, runtime.nextAttempt);
    next = withNode(next, event.nodeId, { ...next.nodes[event.nodeId]!, status: "retry_wait", nextAttempt: runtime.nextAttempt + 1 });
    return scheduleTimer(next, event.nodeId, next.nowMs + delay, "retry", commands);
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

function applyApproval(factory: KernelFactoryPlan, state: KernelState, event: Extract<KernelEvent, { kind: "approval-decided" }>, commands: KernelCommand[]): KernelState {
  const node = nodeFor(factory, event.nodeId);
  const runtime = state.nodes[event.nodeId];
  if (node?.kind !== "approval" || !runtime || runtime.status !== "waiting" || runtime.waitingReason !== "approval") return state;
  const pending = runtime.attempts.at(-1);
  if (!pending || pending.stopped || pending.commandId !== event.commandId || state.nowMs >= pending.deadlineAtMs) return state;
  if (!node.choices.includes(event.choice)) return state;
  if (event.choice === "approve" || event.choice === "accepted") {
    const attempts = runtime.attempts.map((attempt) => attempt.commandId === event.commandId ? { ...attempt, stopped: true } : attempt);
    return completeControl(factory, withNode(state, event.nodeId, { ...runtime, attempts }), event.nodeId, { choice: event.choice }, commands);
  }
  return node.onDenied === "escalate" ? escalateNode(state, event.nodeId, "APPROVAL_DENIED", commands) : failNode(factory, state, node, event.nodeId, "APPROVAL_DENIED", "approval_denied", commands);
}

function applyTimer(factory: KernelFactoryPlan, state: KernelState, event: Extract<KernelEvent, { kind: "timer-expired" }>, commands: KernelCommand[]): KernelState {
  if (!event.nodeId || state.status === "stopping") return state;
  const node = nodeFor(factory, event.nodeId);
  const runtime = state.nodes[event.nodeId];
  if (!node || !runtime?.timer || runtime.timer.id !== event.commandId || event.atMs < runtime.timer.deadlineAtMs) return state;
  if (runtime.status === "retry_wait" && runtime.timer.purpose === "retry") return dispatchReady(factory, withNode(state, event.nodeId, { ...runtime, timer: undefined }), node, event.nodeId, commands);
  if (runtime.status !== "running" && runtime.status !== "waiting" && runtime.status !== "reserved") return state;
  if (node.kind === "loop") return exhaustLoop(factory, state, node, event.nodeId, "LOOP_BOUND_EXHAUSTED", commands);
  if (node.kind === "approval") return node.onExpired === "escalate" ? escalateNode(state, event.nodeId, "APPROVAL_EXPIRED", commands) : failNode(factory, state, node, event.nodeId, "APPROVAL_EXPIRED", "approval_expired", commands);
  return failNode(factory, state, node, event.nodeId, "NODE_DEADLINE_EXPIRED", "deadline", commands);
}

function scheduleTimer(state: KernelState, nodeId: string, deadlineAtMs: number, purpose: "deadline" | "retry", commands: KernelCommand[]): KernelState {
  const timer = commandFor(state, "start-timer", nodeId);
  commands.push({ kind: "start-timer", id: timer.id, nodeId, deadlineAtMs });
  return withNode(timer.state, nodeId, { ...timer.state.nodes[nodeId]!, timer: { id: timer.id, deadlineAtMs, purpose } });
}

type RevisionEvent = Extract<KernelEvent, { kind: "repair" | "replan" }>;

function sealedRepairInput(state: KernelState, node: Extract<FactoryNode, { kind: "task" | "subfactory" }>, nodeId: string, supplied?: JsonValue): { readonly prior: JsonValue; readonly next: JsonValue } {
  const current = inputFor(state, node, nodeId);
  const prior = snapshotValue(current);
  if (supplied === undefined) return { prior, next: prior };
  if (!isRecord(current) || !isRecord(supplied)) throw new FactoryKernelError(`node ${nodeId} repair input must be an object`);
  const currentNames = Object.keys(current).sort();
  const suppliedNames = Object.keys(supplied).sort();
  if (currentNames.length !== suppliedNames.length || currentNames.some((name, index) => name !== suppliedNames[index])) throw new FactoryKernelError(`node ${nodeId} repair input must preserve every bound port`);
  const repairable = new Set(node.repairableInputs ?? []);
  for (const name of repairable) if (node.bindings?.[name]?.kind !== "literal" || !Object.hasOwn(node.inputPorts ?? {}, name)) throw new FactoryKernelError(`node ${nodeId} has an invalid repairable input declaration`);
  for (const name of currentNames) if (!repairable.has(name) && canonicalizeJson(current[name]!) !== canonicalizeJson(supplied[name]!)) throw new FactoryKernelError(`node ${nodeId} repair input changes a protected binding`);
  validateRecord(node.inputPorts ?? {}, supplied, `node ${nodeId} repair input`);
  return { prior, next: snapshotValue(supplied) };
}

function applyRepair(factory: KernelFactoryPlan, state: KernelState, event: RevisionEvent, commands: KernelCommand[], allowProtected = false): KernelState {
  if (state.status === "stopping" || (state.pendingRepair && !allowProtected)) return state;
  const node = nodeFor(factory, event.nodeId);
  const runtime = state.nodes[event.nodeId];
  // Re-asking a protected contract about an unchanged candidate is not remediation: a repair must
  // replace the work that produced the candidate, so acceptance joins approval and release here.
  if (!allowProtected && (node?.kind === "approval" || node?.kind === "release" || node?.kind === "acceptance")) return state;
  if (event.kind === "replan" && (node?.kind !== "subfactory" || event.replacement.id !== node.factory.id)) return state;
  if (node && !runtime) {
    const parentId = completedMapAncestor(state, event.nodeId);
    if (parentId) {
      return applyRepair(factory, state, { ...event, nodeId: parentId }, commands, allowProtected);
    }
  }
  if (!node || !runtime || runtime.status === "blocked" || runtime.status === "ready") return state;
  const sealedInput = node.kind === "task" || node.kind === "subfactory"
    ? sealedRepairInput(state, node, event.nodeId, event.inputOverride)
    : event.inputOverride === undefined ? undefined : (() => { throw new FactoryKernelError("only task and subfactory nodes accept repair input"); })();
  const inputOverride = sealedInput?.next;
  const priorInput = sealedInput?.prior;
  const priorFactory = node.kind === "subfactory" ? runtime.factoryOverride ?? node.factory : undefined;
  const factoryOverride = event.kind === "replan" ? { ...event.replacement } : undefined;
  // A repair cannot replay publication or turn remediation into new consent.
  const aggregateIds: string[] = [];
  let childId = event.nodeId;
  for (;;) {
    const parentId = Object.values(state.scopes).find(scope => scope.nodeIds.includes(childId))?.parentNodeId;
    if (!parentId) break;
    const parent = state.nodes[parentId]!;
    if (parent.loop && !event.nodeId.startsWith(`${parentId}/items/${parent.loop.iteration}/`)) return state;
    aggregateIds.push(parentId);
    childId = parentId;
  }
  const affected = new Set<string>();
  const localSuccessors = (id: string) => successorsFor(factory, id).filter(successor => Object.hasOwn(state.nodes, successor));
  const queue = [event.nodeId, ...aggregateIds.flatMap(localSuccessors)];
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index]!;
    if (affected.has(id)) continue;
    affected.add(id);
    queue.push(...localSuccessors(id));
    for (const childId of Object.keys(state.nodes)) if (childId.startsWith(`${id}/`)) queue.push(childId);
  }
  const releaseStarted = [...affected].some(id => nodeFor(factory, id)?.kind === "release" && state.nodes[id]?.attempts.length)
    || [event.nodeId, ...aggregateIds].some(id => state.nodes[id]?.map?.protectedEffectStarted);
  const uncertain = [...affected].some(id => state.nodes[id]!.attempts.some(attempt => attempt.uncertain));
  if (!allowProtected && (releaseStarted || uncertain)) return state;
  const priorRepair = state.pendingRepair;
  const newlyAffected = new Set([...affected].filter((id) => !priorRepair?.nodeIds.includes(id)));
  let next: KernelState = {
    ...state,
    pendingRepair: priorRepair ? {
      ...priorRepair,
      nodeIds: [...new Set([...priorRepair.nodeIds, ...affected])],
      aggregateIds: [...new Set([...priorRepair.aggregateIds, ...aggregateIds])],
      awaitDependencies: true,
    } : { rootNodeId: event.nodeId, nodeIds: [...affected], aggregateIds, reason: event.reason, ...(priorInput === undefined ? {} : { priorInput }), ...(inputOverride === undefined ? {} : { inputOverride }), ...(priorFactory === undefined ? {} : { priorFactory }), ...(factoryOverride === undefined ? {} : { factoryOverride }), ...(allowProtected ? { awaitDependencies: true } : {}) },
  };
  if (state.partition) {
    const partition = partitionFor(factory, state.partition.id);
    for (const edge of partition?.outbound.filter((candidate) => newlyAffected.has(candidate.nodeId)) ?? []) {
      const generation = state.nodes[edge.nodeId]!.candidateGeneration + 1;
      if (!Number.isSafeInteger(generation)) throw new FactoryKernelError("candidate generation exhausted");
      const command = commandFor(next, "invalidate-partition", edge.nodeId);
      next = command.state;
      commands.push({
        kind: "invalidate-partition",
        id: command.id,
        sourcePartitionId: state.partition.id,
        targetPartitionId: edge.toPartitionId,
        sourceNodeId: edge.nodeId,
        nodeId: edge.toNodeId,
        candidateGeneration: generation,
      });
    }
  }
  if (releaseStarted) return beginStopping(next, "PARTITION_SOURCE_INVALIDATED_AFTER_RELEASE", commands, false);
  if (uncertain) return beginStopping(next, "PARTITION_SOURCE_INVALIDATED_WITH_UNCERTAIN_ATTEMPT", commands, false);
  for (const id of affected) next = cancelScope(next, id, commands, true);
  return completePendingRepair(factory, next, commands);
}

function completePendingRepair(factory: KernelFactoryPlan, state: KernelState, commands: KernelCommand[]): KernelState {
  const repair = state.pendingRepair;
  if (!repair || state.status === "stopping" || repair.nodeIds.some(id => state.nodes[id]!.attempts.some(attempt => !attempt.stopped || attempt.uncertain))) return state;
  let next = state;
  for (const id of repair.nodeIds) {
    const previous = state.nodes[id]!;
    const replacedScope = repair.nodeIds.some(parentId => id.startsWith(`${parentId}/`));
    next = withNode(next, id, {
      ...newCandidate(previous, id === repair.rootNodeId ? { input: repair.priorInput, factory: repair.priorFactory } : undefined),
      ...(id === repair.rootNodeId && repair.inputOverride !== undefined ? { inputOverride: repair.inputOverride } : {}),
      ...(id === repair.rootNodeId && repair.factoryOverride !== undefined ? { factoryOverride: repair.factoryOverride } : {}),
      status: id === repair.rootNodeId && !repair.awaitDependencies ? "ready" : replacedScope ? "cancelled" : "blocked",
      discarded: replacedScope,
    });
  }
  for (const id of repair.aggregateIds) {
    const previous = state.nodes[id]!;
    let map = previous.map;
    if (map) {
      const changed = new Set(repair.nodeIds.filter(child => child.startsWith(`${id}/items/`)).map(child => Number(child.slice(`${id}/items/`.length).split("/")[0])));
      const outcomes = { ...map.outcomes };
      for (const index of changed) delete outcomes[index];
      map = { ...map, completedIndexes: map.completedIndexes.filter(index => !changed.has(index)), failedIndexes: map.failedIndexes.filter(index => !changed.has(index)), outcomes };
    }
    next = withNode(next, id, { ...newCandidate(previous), status: "waiting", waitingReason: "external_reconciliation", selected: previous.selected, map, loop: previous.loop, timer: previous.timer });
    const definition = nodeFor(factory, id)!;
    if (definition.kind === "loop" && previous.loop && !previous.timer) next = scheduleTimer(next, id, Math.min(state.runDeadlineAtMs, previous.loop.startedAtMs + definition.maxElapsedMs), "deadline", commands);
  }
  const scopes = { ...next.scopes };
  const replacedScopes = Object.values(scopes).filter((scope) => scope.nodeIds.some((id) => repair.nodeIds.includes(id))).map((scope) => scope.id);
  for (const [id, scope] of Object.entries(scopes)) {
    if (scope.parentNodeId && (repair.nodeIds.includes(scope.parentNodeId) || replacedScopes.some((prefix) => id.startsWith(`${prefix}/`)))) delete scopes[id];
  }
  next = { ...next, scopes, pendingRepair: undefined, status: "running" };
  return activateReady(factory, next, commands, [repair.rootNodeId]);
}

function newCandidate(previous: KernelNodeState, prior?: { readonly input?: JsonValue; readonly factory?: import("./types.js").FactoryReference }): KernelNodeState {
  if (!Number.isSafeInteger(previous.candidateGeneration + 1)) throw new FactoryKernelError("candidate generation exhausted");
  return {
    status: "blocked",
    candidateGeneration: previous.candidateGeneration + 1,
    nextAttempt: 1,
    attempts: previous.attempts,
    ...(previous.inputOverride === undefined ? {} : { inputOverride: previous.inputOverride }),
    ...(previous.factoryOverride === undefined ? {} : { factoryOverride: previous.factoryOverride }),
    priorCandidates: (previous.priorCandidates ?? []).concat({
      candidateGeneration: previous.candidateGeneration,
      status: previous.status,
      ...(previous.output === undefined ? {} : { output: previous.output }),
      ...(previous.error === undefined ? {} : { error: previous.error }),
      ...(prior?.input === undefined && previous.inputOverride === undefined ? {} : { inputOverride: prior?.input ?? previous.inputOverride }),
      ...(prior?.factory === undefined && previous.factoryOverride === undefined ? {} : { factoryOverride: prior?.factory ?? previous.factoryOverride }),
    }),
  };
}

function activateReady(factory: KernelFactoryPlan, state: KernelState, commands: KernelCommand[], candidates?: readonly string[]): KernelState {
  let next = state;
  const candidateIds = (candidates ?? Object.keys(state.nodes)).slice().sort();
  for (const nodeId of candidateIds) {
    const node = nodeFor(factory, nodeId);
    const runtime = next.nodes[nodeId];
    if (!node || !runtime) continue;
    if (runtime.status === "blocked" && isReady(next, node, nodeId)) next = withNode(next, nodeId, { ...runtime, status: "ready" });
    if (next.nodes[nodeId]!.status === "ready") next = dispatchReady(factory, next, node, nodeId, commands);
  }
  return next;
}

function dispatchReady(factory: KernelFactoryPlan, state: KernelState, node: FactoryNode, nodeId: string, commands: KernelCommand[]): KernelState {
  const page = node.kind === "map" ? requestArtifactMapPage(state, node, nodeId, commands) : state;
  if (page !== state) return page;
  const pending = requestArtifactInputs(state, node, nodeId, commands);
  if (pending !== state) return pending;
  const runtime = state.nodes[nodeId]!;
  if (node.kind === "branch") {
    const evaluated = evaluateExpression(node.condition, expressionContext(state, nodeId));
    if (!evaluated.ok || typeof evaluated.value !== "boolean") return failNode(factory, state, node, nodeId, "BRANCH_PREDICATE_INVALID", "execution", commands);
    const condition = evaluated.value;
    const selected = condition ? "then" : "else";
    const graph = node[selected];
    const scopeId = `${nodeId}/${selected}`;
    const expansion = instantiateScope(factory, state, nodeId, scopeId, graph, [scopeId], selected);
    if (!expansion.ok) return failNode(factory, state, node, nodeId, expansion.error, "bound_exhausted", commands);
    const waiting = activateReady(factory, withNode(expansion.state, nodeId, { ...runtime, status: "waiting", selected, output: undefined, waitingReason: "external_reconciliation" }), commands, expansion.roots);
    return completeScopeIfReady(factory, waiting, `${scopeId}/`, commands);
  }
  if (node.kind === "join") return settleJoin(factory, state, node, nodeId, commands);
  if (node.kind === "map") {
    const itemPrefix = `${nodeId}/items/`;
    const nodes = Object.fromEntries(Object.entries(state.nodes).filter(([id]) => !id.startsWith(itemPrefix)));
    const scopes = Object.fromEntries(Object.entries(state.scopes).filter(([id]) => !id.startsWith(itemPrefix)));
    const cleanState = { ...state, nodes, scopes };
    const collection = resolveValue(node.collection, cleanState, nodeId);
    if (!Array.isArray(collection)) return failNode(factory, state, node, nodeId, "MAP_COLLECTION_INVALID", "execution", commands);
    if (collection.length > node.maxItems) return failNode(factory, state, node, nodeId, "MAP_ITEM_BOUND", "bound_exhausted", commands);
    if (collection.length === 0) return completeControl(factory, withNode(cleanState, nodeId, { ...runtime, map: { snapshot: [], itemCount: 0, completedIndexes: [], failedIndexes: [], outcomes: {} } }), nodeId, Object.fromEntries(Object.keys(node.outputPorts ?? {}).map(name => [name, []])), commands);
    let waiting = withNode(cleanState, nodeId, { ...runtime, status: "waiting", map: { snapshot: snapshotValue(collection) as JsonValue[], itemCount: collection.length, completedIndexes: [], failedIndexes: [], outcomes: {} }, waitingReason: "external_reconciliation" });
    waiting = fillMapWindow(factory, waiting, node, nodeId, commands);
    return waiting;
  }
  if (node.kind === "loop") {
    let waiting = startLoopIteration(factory, state, node, nodeId, runtime, resolveValue(node.initialInput, state, nodeId), 0, commands);
    while (node.body.nodes.length === 0 && waiting.nodes[nodeId]?.status === "waiting") waiting = progressLoop(factory, waiting, `${nodeId}/items/${waiting.nodes[nodeId]!.loop!.iteration}/`, commands);
    return waiting;
  }
  if (node.kind === "approval") {
    const deadlineAtMs = Math.min(nodeDeadline(state, node), state.nowMs + Math.min(node.expiresInMs, 24 * 60 * 60 * 1_000));
    const command = commandFor(state, "request-approval", nodeId);
    const attempt = { candidateGeneration: runtime.candidateGeneration, attempt: runtime.nextAttempt, commandId: command.id, startedAtMs: state.nowMs, deadlineAtMs, stopped: false, uncertain: false };
    const waiting = { ...runtime, status: "waiting" as const, attempts: runtime.attempts.concat(attempt), waitingReason: "approval" as const, waitingDeadlineAtMs: deadlineAtMs };
    commands.push({ kind: "request-approval", id: command.id, nodeId, choices: node.choices, context: resolveValue(node.context, state, nodeId), actorScope: node.actorScope, deadlineAtMs });
    return scheduleTimer(withNode(command.state, nodeId, waiting), nodeId, deadlineAtMs, "deadline", commands);
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
  return scheduleTimer(withNode(command.state, nodeId, { ...runtime, status: "reserved", attempts: runtime.attempts.concat(attempt), waitingReason: "admission", waitingDeadlineAtMs: deadlineAtMs }), nodeId, deadlineAtMs, "deadline", commands);
}

function dispatchChild(state: KernelState, node: Extract<FactoryNode, { kind: "subfactory" }>, nodeId: string, commands: KernelCommand[]): KernelState {
  const runtime = state.nodes[nodeId]!;
  const deadlineAtMs = nodeDeadline(state, node);
  const command = commandFor(state, "run-child", nodeId);
  const attempt = { candidateGeneration: runtime.candidateGeneration, attempt: runtime.nextAttempt, commandId: command.id, startedAtMs: state.nowMs, deadlineAtMs, stopped: false, uncertain: false };
  commands.push({ kind: "run-child", id: command.id, nodeId, candidateGeneration: runtime.candidateGeneration, factory: runtime.factoryOverride ?? node.factory, input: inputFor(state, node, nodeId), ...(state.durableInput === undefined ? {} : { durableInput: state.durableInput }), deadlineAtMs });
  return waitForExternal(command.state, nodeId, runtime, attempt, commands);
}

function dispatchAcceptance(state: KernelState, node: Extract<FactoryNode, { kind: "acceptance" }>, nodeId: string, commands: KernelCommand[]): KernelState {
  const runtime = state.nodes[nodeId]!;
  const deadlineAtMs = nodeDeadline(state, node);
  const command = commandFor(state, "request-acceptance", nodeId);
  const attempt = { candidateGeneration: runtime.candidateGeneration, attempt: runtime.nextAttempt, commandId: command.id, startedAtMs: state.nowMs, deadlineAtMs, stopped: false, uncertain: false };
  commands.push({ kind: "request-acceptance", id: command.id, nodeId, candidateGeneration: runtime.candidateGeneration, candidate: resolveValue(node.candidate, state, nodeId), evidence: resolveValue(node.evidence, state, nodeId), deadlineAtMs });
  return waitForExternal(command.state, nodeId, runtime, attempt, commands);
}

function dispatchRelease(state: KernelState, node: Extract<FactoryNode, { kind: "release" }>, nodeId: string, commands: KernelCommand[]): KernelState {
  const runtime = state.nodes[nodeId]!;
  const deadlineAtMs = nodeDeadline(state, node);
  const command = commandFor(state, "request-release", nodeId);
  const attempt = { candidateGeneration: runtime.candidateGeneration, attempt: runtime.nextAttempt, commandId: command.id, startedAtMs: state.nowMs, deadlineAtMs, stopped: false, uncertain: false };
  const input = { acceptedCandidate: resolveValue(node.acceptedCandidate, state, nodeId), destination: resolveValue(node.destination, state, nodeId) };
  validateRecord(node.inputPorts ?? {}, input, `node ${nodeId} input`);
  commands.push({ kind: "request-release", id: command.id, nodeId, candidateGeneration: runtime.candidateGeneration, input, deadlineAtMs });
  return waitForExternal(command.state, nodeId, runtime, attempt, commands);
}

function waitForExternal(state: KernelState, nodeId: string, runtime: KernelNodeState, attempt: import("./kernel-types.js").KernelAttempt, commands: KernelCommand[]): KernelState {
  const waiting = withNode(state, nodeId, { ...runtime, status: "waiting", attempts: runtime.attempts.concat(attempt), waitingReason: "external_reconciliation", waitingDeadlineAtMs: attempt.deadlineAtMs });
  return scheduleTimer(waiting, nodeId, attempt.deadlineAtMs, "deadline", commands);
}

function settleJoin(factory: KernelFactoryPlan, state: KernelState, node: Extract<FactoryNode, { kind: "join" }>, nodeId: string, commands: KernelCommand[]): KernelState {
  const scope = nodeId.slice(0, nodeId.lastIndexOf("/") + 1);
  const outcomes = node.predecessors.map((predecessor) => {
    const predecessorId = `${scope}${predecessor}`;
    return [predecessorId, predecessorRuntime(state, predecessorId)] as const;
  });
  const eligible = node.eligibleOutcomes ?? ["succeeded"];
  const winners = outcomes.filter(([, runtime]) => runtime && terminalStatus(runtime.status) && eligible.includes(toJoinOutcome(runtime.status)));
  const quorum = node.mode === "all" ? outcomes.length : node.mode === "any" ? 1 : node.quorum ?? 0;
  if (node.mode === "all") {
    if (!outcomes.every(([, runtime]) => runtime && terminalStatus(runtime.status))) return state;
    if (outcomes.some(([, runtime]) => runtime?.status !== "succeeded" && runtime?.status !== "skipped")) return failNode(factory, state, node, nodeId, "REQUIRED_PREDECESSOR_FAILED", "execution", commands);
  } else {
    if (quorum <= 0) return failNode(factory, state, node, nodeId, "INVALID_QUORUM", "bound_exhausted", commands);
    if (winners.length < quorum) {
      const remaining = outcomes.filter(([, runtime]) => !runtime || !terminalStatus(runtime.status)).length;
      if (winners.length + remaining < quorum) return failNode(factory, state, node, nodeId, "QUORUM_UNREACHABLE", "execution", commands);
      return state;
    }
  }
  const selected = winners.sort(([left, a], [right, b]) => (a!.terminalSequence ?? 0) - (b!.terminalSequence ?? 0) || (left < right ? -1 : left > right ? 1 : 0)).slice(0, quorum);
  let next = withNode(state, nodeId, { ...state.nodes[nodeId]!, status: "succeeded", output: { winners: selected.map(([nodeId, runtime]) => ({ nodeId, outputs: runtime!.output ?? {} })) } });
  if (node.mode !== "all") {
    const selectedIds = selected.map(([id]) => id);
    for (const [loserId] of outcomes) {
      if (selectedIds.includes(loserId)) continue;
      for (const [id, runtime] of Object.entries(next.nodes)) {
        if (id !== loserId && !id.startsWith(`${loserId}/`)) continue;
        if (terminalStatus(runtime.status)) continue;
        next = withNode(next, id, { ...runtime, discarded: true, status: runtime.attempts.some(attempt => !attempt.stopped) ? "stopping" : "cancelled", timer: undefined });
        for (const attempt of runtime.attempts.filter(attempt => !attempt.stopped)) {
          const cancel = commandFor(next, "cancel-node", id);
          next = cancel.state;
          commands.push({ kind: "cancel-node", id: cancel.id, nodeId: id, candidateGeneration: attempt.candidateGeneration, attempt: attempt.attempt, attemptCommandId: attempt.commandId, cancellationEpoch: next.cancellationEpoch });
        }
      }
    }
  }
  return completeControl(factory, next, nodeId, next.nodes[nodeId]!.output!, commands);
}

function predecessorRuntime(state: KernelState, nodeId: string): KernelNodeState | undefined {
  const local = state.nodes[nodeId];
  if (local || !state.partition || nodeId.includes("/")) return local;
  const external = state.partition.externalOutputs[nodeId];
  return external ? {
    status: external.status,
    candidateGeneration: external.candidateGeneration,
    nextAttempt: 1,
    output: external.output,
    error: external.error,
    terminalSequence: external.terminalSequence,
    attempts: [],
  } : undefined;
}

function terminalStatus(status: KernelNodeState["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "skipped" || status === "cancelled";
}

function isReady(state: KernelState, node: FactoryNode, instanceId: string): boolean {
  if (node.kind === "join") return true;
  const scope = instanceId.includes("/") ? `${instanceId.slice(0, instanceId.lastIndexOf("/"))}/` : "";
  return (node.dependsOn ?? []).every((id) => {
    const dependencyId = `${scope}${id}`;
    if (state.nodes[dependencyId]?.status === "succeeded") return true;
    if (!state.partition || scope) return false;
    return Object.keys(state.partition.completedEdges).some((key) => {
      const [, sourceNodeId, targetNodeId] = key.split("\u0000");
      return sourceNodeId === id && targetNodeId === instanceId;
    });
  });
}

/** Stop only the named scope; stop acknowledgements remain necessary. */
function cancelScope(state: KernelState, prefix: string, commands: KernelCommand[], includeSelf = false): KernelState {
  let next = state;
  for (const [id, runtime] of Object.entries(state.nodes)) {
    if ((!includeSelf || id !== prefix) && !id.startsWith(`${prefix}/`)) continue;
    const active = runtime.attempts.filter(attempt => !attempt.stopped);
    if (terminalStatus(runtime.status) && active.length === 0) continue;
    next = withNode(next, id, { ...runtime, discarded: true, status: active.length > 0 ? "stopping" : "cancelled", timer: undefined });
    if (runtime.status === "stopping") continue;
    for (const attempt of active) {
      const cancel = commandFor(next, "cancel-node", id);
      next = cancel.state;
      commands.push({ kind: "cancel-node", id: cancel.id, nodeId: id, candidateGeneration: attempt.candidateGeneration, attempt: attempt.attempt, attemptCommandId: attempt.commandId, cancellationEpoch: next.cancellationEpoch });
    }
  }
  return next;
}

function failNode(factory: KernelFactoryPlan, state: KernelState, node: FactoryNode, nodeId: string, error: string, _kind: string, commands: KernelCommand[]): KernelState {
  const runtime = state.nodes[nodeId]!;
  let failed = withNode(state, nodeId, { ...runtime, status: "failed", error, timer: undefined });
  const location = locateNode(factory, nodeId)!;
  const dependents = successorsFor(factory, nodeId).map(id => ({ id, node: nodeFor(factory, id)! }));
  const joins = dependents.filter(({ node: successor }) => successor.kind === "join" && successor.mode !== "all" && successor.predecessors.includes(node.id));
  if (joins.length > 0 && joins.length === dependents.length) {
    failed = withNode(failed, nodeId, { ...failed.nodes[nodeId]!, failureHandled: true });
    failed = cancelScope(failed, nodeId, commands, true);
    return activateReady(factory, failed, commands, joins.map(join => join.id));
  }
  const scope = Object.values(state.scopes).find(candidate => candidate.nodeIds.includes(nodeId));
  const parentId = scope?.parentNodeId;
  const parentNode = parentId ? nodeFor(factory, parentId) : undefined;
  if (parentId && parentNode?.kind === "map" && parentNode.mode === "collect") {
    failed = withNode(failed, nodeId, { ...failed.nodes[nodeId]!, failureHandled: true });
    const itemPrefix = `${parentId}/items/${nodeId.slice(`${parentId}/items/`.length).split("/")[0]}`;
    failed = cancelScope(failed, itemPrefix, commands);
    return progressMap(factory, failed, nodeId, commands);
  }
  if (parentId && parentNode) {
    failed = withNode(failed, nodeId, { ...failed.nodes[nodeId]!, failureHandled: true });
    failed = cancelScope(failed, location.scope, commands);
    return failNode(factory, failed, parentNode, parentId, parentNode.kind === "map" ? "MAP_ITEM_FAILED" : error, _kind, commands);
  }
  return beginStopping(failed, error, commands, false);
}

function escalateNode(state: KernelState, nodeId: string, error: string, commands: KernelCommand[]): KernelState {
  const runtime = state.nodes[nodeId]!;
  let next = cancelScope(state, nodeId, commands);
  next = withNode(next, nodeId, { ...runtime, status: "waiting", error, waitingReason: "remediation", waitingDeadlineAtMs: state.runDeadlineAtMs, timer: undefined, attempts: runtime.attempts.map(attempt => ({ ...attempt, stopped: true })) });
  const active = Object.values(next.nodes).some(node => ["ready", "reserved", "running", "retry_wait", "stopping"].includes(node.status));
  return { ...next, status: active ? "running" : "waiting" };
}

function exhaustLoop(factory: KernelFactoryPlan, state: KernelState, node: Extract<FactoryNode, { kind: "loop" }>, nodeId: string, error: string, commands: KernelCommand[]): KernelState {
  return node.onExhausted === "escalate" ? escalateNode(state, nodeId, error, commands) : failNode(factory, state, node, nodeId, error, "bound_exhausted", commands);
}

function beginStopping(state: KernelState, reason: string, commands: KernelCommand[], cancelled: boolean): KernelState {
  if (state.status === "stopping") return state;
  let next: KernelState = { ...state, status: "stopping", stopReason: reason, stopKind: cancelled ? "cancelled" : "failed", pendingRepair: undefined, cancellationEpoch: state.cancellationEpoch + 1 };
  for (const [nodeId, runtime] of Object.entries(next.nodes)) {
    const active = runtime.attempts.filter((attempt) => !attempt.stopped);
    if (active.length === 0) {
      if (!["succeeded", "failed", "skipped", "cancelled"].includes(runtime.status)) next = withNode(next, nodeId, { ...runtime, status: cancelled ? "cancelled" : "failed", error: runtime.error ?? reason, timer: undefined });
      continue;
    }
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

function finish(factory: KernelFactoryPlan, state: KernelState, commands: KernelCommand[]): AdvanceResult {
  if (state.pendingRepair) return { nextState: state, commands };
  if (state.status === "stopping") {
    if (Object.values(state.nodes).some((node) => node.attempts.some((attempt) => !attempt.stopped) || node.attempts.some((attempt) => attempt.uncertain))) return { nextState: state, commands };
    const cancelled = state.stopKind === "cancelled";
    const failed = state.stopKind !== "completed" && !cancelled;
    const next = { ...state, status: cancelled ? "cancelled" as const : failed ? "failed" as const : "completed" as const };
    if (!cancelled && !failed && state.partition) {
      const command = commandFor(next, "complete-partition");
      commands.push({ kind: "complete-partition", id: command.id, partitionId: state.partition.id });
      return { nextState: command.state, commands };
    }
    const command = commandFor(next, cancelled ? "cancel-run" : failed ? "fail-run" : "complete-run");
    if (command.kind === "complete-run") commands.push({ kind: "complete-run", id: command.id, output: graphOutput(factory, command.state) });
    else if (command.kind === "fail-run") commands.push({ kind: "fail-run", id: command.id, error: state.stopReason ?? "GRAPH_FAILED" });
    else commands.push({ kind: "cancel-run", id: command.id, reason: state.stopReason ?? "CANCELLED" });
    return { nextState: command.state, commands };
  }
  const nodes = Object.values(state.nodes);
  if (nodes.every((node) => node.status === "succeeded" || node.status === "skipped" || node.discarded || (node.status === "failed" && node.failureHandled))) {
    if (nodes.some(node => node.attempts.some(attempt => !attempt.stopped || attempt.uncertain))) return { nextState: { ...state, status: "stopping", stopKind: "completed" }, commands };
    const done = { ...state, status: "completed" as const };
    if (state.partition) {
      const command = commandFor(done, "complete-partition");
      commands.push({ kind: "complete-partition", id: command.id, partitionId: state.partition.id });
      return { nextState: command.state, commands };
    }
    const command = commandFor(done, "complete-run");
    commands.push({ kind: "complete-run", id: command.id, output: graphOutput(factory, command.state) });
    return { nextState: command.state, commands };
  }
  return { nextState: state, commands };
}

function commandFor<T extends KernelCommand["kind"]>(state: KernelState, kind: T, nodeId?: string): { state: KernelState; id: string; kind: T } {
  const commandCounter = state.commandCounter + 1;
  const partition = state.partition ? `:${state.partition.id}` : "";
  return { state: { ...state, commandCounter }, id: `${state.logicalRunId}${partition}:${nodeId ?? "run"}:${kind}:${commandCounter}`, kind };
}

function withNode(state: KernelState, nodeId: string, runtime: KernelNodeState): KernelState {
  const terminalSequence = terminalStatus(runtime.status) ? runtime.terminalSequence ?? state.eventSequence : undefined;
  return { ...state, nodes: { ...state.nodes, [nodeId]: { ...runtime, terminalSequence } } };
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

function inputFor(state: KernelState, node: FactoryNode, nodeId: string): JsonValue {
  const override = state.nodes[nodeId]?.inputOverride;
  if (override !== undefined) {
    validateRecord(node.inputPorts ?? {}, override, `node ${nodeId} input`);
    return override;
  }
  const bindings = node.bindings;
  if (!bindings || Object.keys(bindings).length === 0) {
    validateRecord(node.inputPorts ?? {}, state.input, `node ${nodeId} input`);
    return state.input;
  }
  const input: Record<string, JsonValue> = {};
  for (const [name, source] of Object.entries(bindings)) input[name] = resolveValue(source, state, nodeId);
  validateRecord(node.inputPorts ?? {}, input, `node ${node.id} input`);
  return input;
}

export function validateNodeOutput(node: FactoryNode, output: JsonValue): boolean {
  try {
    validateRecord(node.outputPorts ?? {}, output, `node ${node.id} output`);
    return true;
  } catch { return false; }
}

function snapshotValue(value: JsonValue): JsonValue {
  return JSON.parse(canonicalizeJson(value)) as JsonValue;
}

function validateRecord(schemas: Readonly<Record<string, import("./types").PortSchema>>, value: JsonValue, label: string): void {
  if (!validateIJson(value).ok || new TextEncoder().encode(canonicalizeJson(value)).byteLength > 64 * 1024) throw new FactoryKernelError(`${label} must be bounded I-JSON`);
  if (!isRecord(value)) throw new FactoryKernelError(`${label} must be an object`);
  for (const [name, schema] of Object.entries(schemas)) {
    if (!Object.hasOwn(value, name)) throw new FactoryKernelError(`${label}.${name} is missing`);
    if (!validateValue(schema, value[name]! ).ok) throw new FactoryKernelError(`${label}.${name} is invalid`);
  }
}

function lazyKey(name: string, path: readonly import("./types.js").ReferencePathSegment[]): string { return canonicalizeJson([name, path] as unknown as JsonValue); }
function artifactKey(artifact: import("./types.js").FactoryArtifactReference): string { return `${artifact.artifactId}\u0000${artifact.digest}\u0000${artifact.encodedBytes}`; }
function artifactInput(state: KernelState, name: string): import("./types.js").FactoryArtifactReference | undefined {
  const value = state.durableInput?.parameters[name];
  return value?.kind === "artifact" ? value.artifact : undefined;
}
function inputReferences(value: unknown, output: { readonly name: string; readonly path: readonly import("./types.js").ReferencePathSegment[] }[] = []): readonly { readonly name: string; readonly path: readonly import("./types.js").ReferencePathSegment[] }[] {
  if (!value || typeof value !== "object") return output;
  if (!Array.isArray(value) && (value as { kind?: unknown }).kind === "ref") {
    const ref = value as { root?: unknown; name?: unknown; path?: unknown };
    if (ref.root === "input" && typeof ref.name === "string" && (ref.path === undefined || Array.isArray(ref.path))) output.push({ name: ref.name, path: (ref.path ?? []) as readonly import("./types.js").ReferencePathSegment[] });
  }
  for (const child of Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)) inputReferences(child, output);
  return output;
}
function hydrateArtifactReferences(value: unknown, state: KernelState): unknown {
  if (!value || typeof value !== "object") return value;
  if (!Array.isArray(value) && (value as { kind?: unknown }).kind === "ref") {
    const ref = value as { root?: unknown; name?: unknown; path?: unknown };
    if (ref.root === "input" && typeof ref.name === "string") {
      const artifact = artifactInput(state, ref.name);
      if (artifact) {
        const path = (Array.isArray(ref.path) ? ref.path : []) as readonly import("./types.js").ReferencePathSegment[];
        const cached = state.lazyInput?.values[lazyKey(ref.name, path)];
        if (cached === undefined) throw new FactoryKernelError("artifact input is not yet loaded");
        return { kind: "literal", value: cached };
      }
    }
  }
  if (Array.isArray(value)) return value.map(item => hydrateArtifactReferences(item, state));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, hydrateArtifactReferences(item, state)]));
}
function requestArtifactMapPage(state: KernelState, node: Extract<FactoryNode, { kind: "map" }>, nodeId: string, commands: KernelCommand[]): KernelState {
  const collection = node.collection;
  if (collection.kind !== "ref" || collection.root !== "input") return state;
  const path = collection.path ?? [];
  const artifact = artifactInput(state, collection.name);
  if (!artifact || !state.lazyInput) return state;
  const command = commandFor(state, "read-input-page", nodeId);
  const expectedStorageVersion = state.lazyInput.versions[artifactKey(artifact)];
  const pending = { kind: "page" as const, nodeId, candidateGeneration: state.nodes[nodeId]!.candidateGeneration, cancellationEpoch: state.cancellationEpoch, name: collection.name, artifact, path, cursor: 0, maxItems: 32, maxBytes: 32 * 1024, ...(expectedStorageVersion === undefined ? {} : { expectedStorageVersion }) };
  const lazyInput = { ...command.state.lazyInput!, pending: { ...command.state.lazyInput!.pending, [command.id]: pending } };
  commands.push({ kind: "read-input-page", id: command.id, nodeId, candidateGeneration: pending.candidateGeneration, cancellationEpoch: pending.cancellationEpoch, name: pending.name, artifact, path, cursor: 0, maxItems: 32, maxBytes: pending.maxBytes, ...(pending.expectedStorageVersion === undefined ? {} : { expectedStorageVersion: pending.expectedStorageVersion }) });
  return withNode({ ...command.state, lazyInput }, nodeId, { ...command.state.nodes[nodeId]!, status: "waiting", waitingReason: "external_reconciliation", map: { snapshot: [], itemCount: 0, pageOffset: 0, nextCursor: 0, lazy: { name: collection.name, artifact, path, ...(expectedStorageVersion === undefined ? {} : { storageVersion: expectedStorageVersion }) }, completedIndexes: [], failedIndexes: [], outcomes: {} } });
}

function requestNextArtifactMapPage(state: KernelState, node: Extract<FactoryNode, { kind: "map" }>, nodeId: string, commands: KernelCommand[]): KernelState {
  const runtime = state.nodes[nodeId];
  const map = runtime?.map;
  const cursor = map?.nextCursor;
  const lazy = map?.lazy;
  if (!runtime || !map || !lazy || cursor === undefined || !state.lazyInput) return state;
  if (Object.values(state.lazyInput.pending).some(pending => pending.kind === "page" && pending.nodeId === nodeId)) return state;
  const command = commandFor(state, "read-input-page", nodeId);
  const pending = { kind: "page" as const, nodeId, candidateGeneration: runtime.candidateGeneration, cancellationEpoch: state.cancellationEpoch, name: lazy.name, artifact: lazy.artifact, path: lazy.path, cursor, maxItems: 32, maxBytes: 32 * 1024, expectedStorageVersion: lazy.storageVersion };
  const lazyInput = { ...command.state.lazyInput!, pending: { ...command.state.lazyInput!.pending, [command.id]: pending } };
  commands.push({ kind: "read-input-page", id: command.id, nodeId, candidateGeneration: pending.candidateGeneration, cancellationEpoch: pending.cancellationEpoch, name: pending.name, artifact: pending.artifact, path: pending.path, cursor, maxItems: pending.maxItems, maxBytes: pending.maxBytes, expectedStorageVersion: lazy.storageVersion });
  return withNode({ ...command.state, lazyInput }, nodeId, { ...runtime, map: { ...map, snapshot: [], nextCursor: undefined }, waitingReason: "external_reconciliation" });
}

function requestArtifactInputs(state: KernelState, node: FactoryNode, nodeId: string, commands: KernelCommand[]): KernelState {
  if (!state.durableInput || !state.lazyInput) return state;
  let next = state;
  for (const reference of inputReferences(node.kind === "map" ? { ...node, collection: { kind: "literal", value: null } } : node)) {
    const artifact = artifactInput(next, reference.name);
    if (!artifact || next.lazyInput!.values[lazyKey(reference.name, reference.path)] !== undefined) continue;
    if (Object.values(next.lazyInput!.pending).some(pending => pending.name === reference.name && lazyKey(pending.name, pending.path) === lazyKey(reference.name, reference.path))) continue;
    const command = commandFor(next, "read-input-value", nodeId);
    const expectedStorageVersion = next.lazyInput!.versions[artifactKey(artifact)];
    const pending = { kind: "value" as const, nodeId, candidateGeneration: next.nodes[nodeId]!.candidateGeneration, cancellationEpoch: next.cancellationEpoch, name: reference.name, artifact, path: reference.path, maxBytes: 32 * 1024, ...(expectedStorageVersion === undefined ? {} : { expectedStorageVersion }) };
    next = { ...command.state, lazyInput: { ...command.state.lazyInput!, pending: { ...command.state.lazyInput!.pending, [command.id]: pending } } };
    commands.push({ kind: "read-input-value", id: command.id, nodeId: pending.nodeId, candidateGeneration: pending.candidateGeneration, cancellationEpoch: pending.cancellationEpoch, name: pending.name, artifact: pending.artifact, path: pending.path, maxBytes: pending.maxBytes, ...(pending.expectedStorageVersion === undefined ? {} : { expectedStorageVersion: pending.expectedStorageVersion }) });
  }
  return next === state ? state : withNode(next, nodeId, { ...next.nodes[nodeId]!, status: "waiting", waitingReason: "external_reconciliation" });
}

function resolveValue(source: ValueSource, state: KernelState, nodeId = ""): JsonValue {
  const result = evaluateExpression(hydrateArtifactReferences(source, state) as ValueSource, expressionContext(state, nodeId));
  if (!result.ok) throw new FactoryKernelError(result.message);
  return result.value;
}

function expressionContext(state: KernelState, nodeId = "", loopOverride?: Readonly<Record<string, JsonValue>>): import("./types.js").ExpressionContext {
  const nodes: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const [id, completion] of Object.entries(state.partition?.externalOutputs ?? {})) if (completion.output !== undefined) nodes[id] = completion.output;
  const parts = nodeId.split("/");
  const scopes = [""];
  let map: Readonly<Record<string, JsonValue>> | undefined;
  let loop: Readonly<Record<string, JsonValue>> | undefined;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const parentId = parts.slice(0, index + 1).join("/");
    const runtime = Object.hasOwn(state.nodes, parentId) ? state.nodes[parentId] : undefined;
    if (runtime?.selected && parts[index + 1] === runtime.selected) {
      scopes.push(`${parts.slice(0, index + 2).join("/")}/`);
      index += 1;
    } else if ((runtime?.map || runtime?.loop) && parts[index + 1] === "items") {
      const item = Number(parts[index + 2]);
      if (runtime.map) map = { item: runtime.map.snapshot[item - (runtime.map.pageOffset ?? 0)]!, index: item };
      if (runtime.loop) loop = { carried: runtime.loop.carried, index: item };
      scopes.push(`${parts.slice(0, index + 3).join("/")}/`);
      index += 2;
    }
  }
  // Outer names are loaded first. A local declared name takes precedence.
  for (const scope of scopes) for (const [id, runtime] of Object.entries(state.nodes)) {
    if (id.startsWith(scope) && !id.slice(scope.length).includes("/") && runtime.output !== undefined) nodes[id.slice(scope.length)] = runtime.output;
  }
  return { inputs: isRecord(state.input) ? state.input : {}, nodes, map, loop: loopOverride ?? loop };
}

function graphValues(graph: FactoryGraph, state: KernelState, scope = ""): Record<string, JsonValue> {
  const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const [name, source] of Object.entries(graph.outputs)) output[name] = resolveValue(source, state, scope);
  return output;
}

function graphOutput(factory: KernelFactoryPlan, state: KernelState): JsonValue {
  const output = graphValues(factory.definition.graph, state);
  validateRecord(factory.definition.outputPorts, output, "run output");
  return output;
}

function completeControl(factory: KernelFactoryPlan, state: KernelState, nodeId: string, output: JsonValue, commands: KernelCommand[]): KernelState {
  const node = nodeFor(factory, nodeId)!;
  if (!validateNodeOutput(node, output)) return failNode(factory, state, node, nodeId, "OUTPUT_INVALID", "output_invalid", commands);
  const done = withNode(state, nodeId, { ...state.nodes[nodeId]!, status: "succeeded", output, timer: undefined });
  const progressed = activateReady(factory, done, commands, successorsFor(factory, nodeId));
  return progressContainingScopes(factory, progressed, nodeId, commands);
}

function progressContainingScopes(factory: KernelFactoryPlan, state: KernelState, nodeId: string, commands: KernelCommand[]): KernelState {
  if (state.status !== "running" && state.status !== "waiting") return state;
  return progressLoop(factory, progressMap(factory, completeScopeIfReady(factory, state, nodeId, commands), nodeId, commands), nodeId, commands);
}

function completeScopeIfReady(factory: KernelFactoryPlan, state: KernelState, nodeId: string, commands: KernelCommand[]): KernelState {
  const scopeId = nodeId.slice(0, nodeId.lastIndexOf("/"));
  const scope = Object.hasOwn(state.scopes, scopeId) ? state.scopes[scopeId] : undefined;
  if (!scope?.parentNodeId || !scope.nodeIds.every(id => state.nodes[id]?.status === "succeeded" || state.nodes[id]?.discarded || state.nodes[id]?.failureHandled)) return state;
  const parent = state.nodes[scope.parentNodeId];
  const parentNode = nodeFor(factory, scope.parentNodeId);
  if (parent?.status !== "waiting" || parentNode?.kind !== "branch" || !parent.selected) return state;
  return completeControl(factory, state, scope.parentNodeId, graphValues(parentNode[parent.selected], state, `${scopeId}/`), commands);
}

function progressMap(factory: KernelFactoryPlan, state: KernelState, nodeId: string, commands: KernelCommand[]): KernelState {
  if (state.status !== "running" && state.status !== "waiting") return state;
  const marker = "/items/";
  const markerAt = nodeId.lastIndexOf(marker);
  if (markerAt < 0) return state;
  const parentId = nodeId.slice(0, markerAt);
  const itemStart = markerAt + marker.length;
  const itemEnd = nodeId.indexOf("/", itemStart);
  const item = Number(nodeId.slice(itemStart, itemEnd));
  const parentNode = nodeFor(factory, parentId);
  const parent = state.nodes[parentId];
  if (parentNode?.kind !== "map" || !parent?.map || !Number.isSafeInteger(item)) return state;
  if (state.pendingRepair && (state.pendingRepair.nodeIds.includes(parentId) || state.pendingRepair.aggregateIds.includes(parentId))) return state;
  const prefix = `${parentId}/items/${item}/`;
  const members = parentNode.body.nodes.map(child => `${prefix}${child.id}`);
  if (!members.every((id) => terminalStatus(state.nodes[id]!.status)) || Object.entries(state.nodes).some(([id, runtime]) => id.startsWith(prefix) && runtime.attempts.some(attempt => !attempt.stopped || attempt.uncertain))) return state;
  if (parent.map.completedIndexes.includes(item) || parent.map.failedIndexes.includes(item)) return state;
  const failed = members.find((id) => state.nodes[id]?.status !== "succeeded" && (!state.nodes[id]?.failureHandled || !locationHasQualifyingJoin(factory, id)));
  if (failed && parentNode.mode === "all") return failNode(factory, state, parentNode, parentId, "MAP_ITEM_FAILED", "execution", commands);
  const outcomes: Record<string, JsonValue> = {
    ...parent.map.outcomes,
    [String(item)]: failed ? { error: state.nodes[failed]!.error ?? "MAP_ITEM_FAILED" } : graphValues(parentNode.body, state, prefix),
  };
  const protectedEffectStarted = parent.map.protectedEffectStarted
    || Object.entries(state.nodes).some(([id, runtime]) => id.startsWith(prefix) && nodeFor(factory, id)?.kind === "release" && runtime.attempts.length > 0);
  const map = { ...parent.map, outcomes, completedIndexes: failed ? parent.map.completedIndexes : parent.map.completedIndexes.concat(item), failedIndexes: failed ? parent.map.failedIndexes.concat(item) : parent.map.failedIndexes, ...(protectedEffectStarted ? { protectedEffectStarted: true } : {}) };
  const nodes = { ...state.nodes };
  for (const id of Object.keys(nodes)) if (id.startsWith(prefix)) delete nodes[id];
  const scopes = { ...state.scopes };
  const itemScope = `${parentId}/items/${item}`;
  for (const id of Object.keys(scopes)) if (id === itemScope || id.startsWith(`${itemScope}/`)) delete scopes[id];
  const accountingScopeId = `${parentId}/items`;
  const accountingScope = scopes[accountingScopeId];
  if (accountingScope) scopes[accountingScopeId] = {
    ...accountingScope,
    nodeIds: accountingScope.nodeIds.filter((id) => !id.startsWith(prefix)),
    roots: accountingScope.roots.filter((id) => !id.startsWith(prefix)),
  };
  const next = withNode({ ...state, nodes, scopes }, parentId, { ...parent, map });
  const terminalItems = map.completedIndexes.length + map.failedIndexes.length;
  if (terminalItems === map.itemCount) {
    if (map.nextCursor !== undefined) return requestNextArtifactMapPage(next, parentNode, parentId, commands);
    return completeMap(factory, next, parentNode, parentId, commands);
  }
  return next;
}

function completeMap(factory: KernelFactoryPlan, state: KernelState, parentNode: Extract<FactoryNode, { kind: "map" }>, parentId: string, commands: KernelCommand[]): KernelState {
  const map = state.nodes[parentId]?.map;
  if (!map) throw new FactoryKernelError("map completion requires map state");
  const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const name of Object.keys(parentNode.outputPorts ?? {})) {
    output[name] = Array.from({ length: map.itemCount }, (_, index) => {
      const outcome = map.outcomes[index];
      const value = isRecord(outcome) ? outcome[name] ?? null : null;
      return parentNode.mode === "all" ? value : map.failedIndexes.includes(index) ? { outcome: "failed", error: isRecord(outcome) ? outcome.error ?? "MAP_ITEM_FAILED" : "MAP_ITEM_FAILED" } : { outcome: "succeeded", value };
    });
  }
  const scopes = { ...state.scopes };
  delete scopes[`${parentId}/items`];
  return completeControl(factory, { ...state, scopes }, parentId, output, commands);
}

function fillMapWindow(factory: KernelFactoryPlan, state: KernelState, parentNode: Extract<FactoryNode, { kind: "map" }>, parentId: string, commands: KernelCommand[]): KernelState {
  let next = state;
  const activeItems = new Set(Object.keys(next.nodes).filter((id) => id.startsWith(`${parentId}/items/`) && ["reserved", "running", "waiting", "retry_wait", "stopping"].includes(next.nodes[id]!.status)).map((id) => Number(id.slice(`${parentId}/items/`.length).split("/")[0])));
  const pageStart = next.nodes[parentId]?.map?.pageOffset ?? 0;
  const pageEnd = pageStart + (next.nodes[parentId]?.map?.snapshot.length ?? 0);
  for (let nextItem = pageStart; next.nodes[parentId]?.status === "waiting" && nextItem < pageEnd && activeItems.size < parentNode.maxConcurrency; nextItem += 1) {
    const currentMap = next.nodes[parentId]!.map!;
    if (currentMap.completedIndexes.includes(nextItem) || currentMap.failedIndexes.includes(nextItem) || activeItems.has(nextItem)) continue;
    const scopeId = `${parentId}/items/${nextItem}`;
    const expansion = instantiateScope(factory, next, parentId, scopeId, parentNode.body, [scopeId]);
    if (!expansion.ok) return failNode(factory, next, parentNode, parentId, expansion.error, "bound_exhausted", commands);
    const accountingScopeId = `${parentId}/items`;
    const accountingScope = expansion.state.scopes[accountingScopeId];
    const itemScope = expansion.state.scopes[scopeId]!;
    const parentScope = Object.values(expansion.state.scopes).find((scope) => scope.nodeIds.includes(parentId));
    const scopes = {
      ...expansion.state.scopes,
      [accountingScopeId]: accountingScope ? {
        ...accountingScope,
        expandedNodeCount: accountingScope.expandedNodeCount + parentNode.body.nodes.length,
        nodeIds: distinct(accountingScope.nodeIds.concat(itemScope.nodeIds)),
        roots: distinct(accountingScope.roots.concat(itemScope.roots)),
      } : {
        id: accountingScopeId,
        parentNodeId: parentId,
        depth: (parentScope?.depth ?? 0) + 1,
        expandedNodeCount: parentNode.body.nodes.length,
        spentCostMicros: "0",
        unknownCostMicros: "0",
        nodeIds: itemScope.nodeIds,
        roots: itemScope.roots,
      },
    };
    next = activateReady(factory, { ...expansion.state, scopes }, commands, expansion.roots);
    if (parentNode.body.nodes.length === 0) next = progressMap(factory, next, `${scopeId}/`, commands);
    if (Object.keys(next.nodes).some((id) => id.startsWith(`${scopeId}/`) && ["reserved", "running", "waiting", "retry_wait", "stopping"].includes(next.nodes[id]!.status))) activeItems.add(nextItem);
  }
  return next;
}

function refillWaitingMaps(factory: KernelFactoryPlan, state: KernelState, commands: KernelCommand[]): KernelState {
  let next = state;
  for (const nodeId of Object.keys(next.nodes)) {
    const node = nodeFor(factory, nodeId);
    if (node?.kind === "map" && next.nodes[nodeId]?.status === "waiting" && next.nodes[nodeId]?.map) next = fillMapWindow(factory, next, node, nodeId, commands);
  }
  return next;
}

/** Instantiate one approved scope and charge every containing scope exactly once. */
function instantiateScope(factory: KernelFactoryPlan, state: KernelState, parentNodeId: string, scopeId: string, graph: FactoryGraph, prefixes: readonly string[], selectedBranch?: "then" | "else"):
  { readonly ok: true; readonly state: KernelState; readonly roots: readonly string[] } | { readonly ok: false; readonly error: string } {
  const ancestors = Object.values(state.scopes).filter(scope => scope.nodeIds.some(id => parentNodeId === id || parentNodeId.startsWith(`${id}/`)));
  const depth = Math.max(0, ...ancestors.map(scope => scope.depth)) + 1;
  const count = graph.nodes.length * prefixes.length;
  if (depth > factory.definition.bounds.maxScopeDepth) return { ok: false, error: "SCOPE_DEPTH_BOUND" };
  if (state.scopes.root!.expandedNodeCount + count > factory.definition.bounds.maxExpandedNodes) return { ok: false, error: "EXPANDED_NODE_BOUND" };
  if (Object.hasOwn(state.scopes, scopeId)) return { ok: false, error: "SCOPE_ALREADY_EXISTS" };
  const nodes = { ...state.nodes };
  const nodeIds: string[] = [];
  const roots: string[] = [];
  for (const prefix of prefixes) for (const child of graph.nodes) {
    const id = `${prefix}/${child.id}`;
    nodes[id] = Object.hasOwn(nodes, id) ? { ...nodes[id]!, status: "blocked", discarded: false } : { status: "blocked", candidateGeneration: state.nodes[parentNodeId]?.candidateGeneration ?? 0, nextAttempt: 1, attempts: [] };
    nodeIds.push(id);
    if ((child.dependsOn?.length ?? 0) === 0) roots.push(id);
  }
  const scopes = { ...state.scopes };
  for (const scope of ancestors) scopes[scope.id] = { ...scope, expandedNodeCount: scope.expandedNodeCount + count };
  scopes[scopeId] = { id: scopeId, parentNodeId, depth, expandedNodeCount: count, selectedBranch, spentCostMicros: "0", unknownCostMicros: "0", nodeIds, roots };
  return { ok: true, state: { ...state, nodes, scopes }, roots };
}

function startLoopIteration(factory: KernelFactoryPlan, state: KernelState, node: Extract<FactoryNode, { kind: "loop" }>, nodeId: string, runtime: KernelNodeState, carried: JsonValue, iteration: number, commands: KernelCommand[]): KernelState {
  if (!validateValue(node.carriedSchema, carried).ok) return failNode(factory, state, node, nodeId, "LOOP_INPUT_INVALID", "execution", commands);
  if (iteration >= node.maxIterations || state.nowMs - (runtime.loop?.startedAtMs ?? state.nowMs) >= node.maxElapsedMs) return exhaustLoop(factory, state, node, nodeId, "LOOP_BOUND_EXHAUSTED", commands);
  const scopeId = `${nodeId}/items/${iteration}`;
  const expansion = instantiateScope(factory, state, nodeId, scopeId, node.body, [scopeId]);
  if (!expansion.ok) return failNode(factory, state, node, nodeId, expansion.error, "bound_exhausted", commands);
  const loop = { iteration, carried, startedAtMs: runtime.loop?.startedAtMs ?? state.nowMs, spentCostMicros: runtime.loop?.spentCostMicros ?? "0", unknownCostMicros: runtime.loop?.unknownCostMicros ?? "0" };
  let waiting = withNode(expansion.state, nodeId, { ...runtime, status: "waiting", loop, waitingReason: "external_reconciliation" });
  if (iteration === 0) waiting = scheduleTimer(waiting, nodeId, Math.min(state.runDeadlineAtMs, loop.startedAtMs + node.maxElapsedMs), "deadline", commands);
  return activateReady(factory, waiting, commands, expansion.roots);
}

function progressLoop(factory: KernelFactoryPlan, state: KernelState, nodeId: string, commands: KernelCommand[]): KernelState {
  const parentId = mapParent(nodeId);
  const parentNode = parentId ? nodeFor(factory, parentId) : undefined;
  const parent = parentId ? state.nodes[parentId] : undefined;
  if (!parentId || !parent || parentNode?.kind !== "loop" || !parent.loop) return state;
  const prefix = `${parentId}/items/${parent.loop.iteration}/`;
  const members = parentNode.body.nodes.map(child => `${prefix}${child.id}`);
  if (parent.status !== "waiting" || parent.waitingReason === "remediation" || !members.every((id) => state.nodes[id]?.status === "succeeded" || state.nodes[id]?.discarded || state.nodes[id]?.failureHandled)) return state;
  const result = graphValues(parentNode.body, state, prefix);
  if (!validateValue(parentNode.resultSchema, result).ok) return failNode(factory, state, parentNode, parentId, "LOOP_RESULT_INVALID", "execution", commands);
  const context = expressionContext(state, `${parentId}/items/${parent.loop.iteration}/`, { carried: parent.loop.carried, result, index: parent.loop.iteration });
  const until = evaluateExpression(parentNode.until, context);
  if (!until.ok || typeof until.value !== "boolean") return failNode(factory, state, parentNode, parentId, "LOOP_UNTIL_INVALID", "execution", commands);
  if (until.value) return completeControl(factory, state, parentId, result, commands);
  if (parentNode.budget?.maxCostMicros !== undefined && BigInt(parent.loop.spentCostMicros) + BigInt(parent.loop.unknownCostMicros) >= BigInt(parentNode.budget.maxCostMicros)) return exhaustLoop(factory, state, parentNode, parentId, "LOOP_BUDGET_EXHAUSTED", commands);
  const next = evaluateExpression(parentNode.nextInput, context);
  if (!next.ok || !validateValue(parentNode.carriedSchema, next.value).ok) return failNode(factory, state, parentNode, parentId, "LOOP_NEXT_INPUT_INVALID", "execution", commands);
  return startLoopIteration(factory, state, parentNode, parentId, parent, next.value, parent.loop.iteration + 1, commands);
}

function mapParent(nodeId: string): string | undefined {
  const marker = "/items/";
  const markerAt = nodeId.lastIndexOf(marker);
  return markerAt < 0 ? undefined : nodeId.slice(0, markerAt);
}

function completedMapAncestor(state: KernelState, nodeId: string): string | undefined {
  let childId = nodeId;
  for (let parentId = mapParent(childId); parentId; parentId = mapParent(childId)) {
    const parent = state.nodes[parentId];
    const item = Number(childId.slice(`${parentId}/items/`.length).split("/")[0]);
    if (parent?.map && Number.isSafeInteger(item) && (parent.map.completedIndexes.includes(item) || parent.map.failedIndexes.includes(item))) return parentId;
    childId = parentId;
  }
  return undefined;
}

function locationHasQualifyingJoin(factory: KernelFactoryPlan, nodeId: string): boolean {
  const location = locateNode(factory, nodeId)!;
  return location.graph.nodes.some(node => node.kind === "join" && node.mode !== "all" && node.predecessors.includes(location.node.id));
}

function loopAncestors(factory: KernelFactoryPlan, nodeId: string): readonly string[] {
  const ancestors: string[] = [];
  for (let index = nodeId.indexOf("/items/"); index >= 0; index = nodeId.indexOf("/items/", index + 1)) {
    const parent = nodeId.slice(0, index);
    if (nodeFor(factory, parent)?.kind === "loop") ancestors.push(parent);
  }
  return ancestors;
}

function parseMicros(value: string): bigint | undefined {
  return typeof value === "string" && value.length <= 64 * 1024 && isUnsignedDecimal(value) ? BigInt(value) : undefined;
}

interface NodeLocation {
  readonly node: FactoryNode;
  readonly graph: FactoryGraph;
  readonly scope: string;
}

function locateNode(factory: KernelFactoryPlan, nodeId: string): NodeLocation | undefined {
  const parts = nodeId.split("/");
  let graph = factory.definition.graph;
  for (let index = 0; ; ) {
    const node = graph.nodes.find(candidate => candidate.id === parts[index]);
    if (!node) return undefined;
    if (index === parts.length - 1) return { node, graph, scope: parts.slice(0, index).join("/") };
    const scope = parts[index + 1];
    if (node.kind === "branch" && (scope === "then" || scope === "else")) { graph = node[scope]; index += 2; continue; }
    if ((node.kind === "map" || node.kind === "loop") && scope === "items" && parts[index + 2] !== undefined) { graph = node.body; index += 3; continue; }
    return undefined;
  }
}

/** Resolve one expanded instance against the immutable compiled definition. */
export function nodeFor(factory: KernelFactoryPlan, nodeId: string): FactoryNode | undefined {
  return locateNode(factory, nodeId)?.node;
}

/** Recomputes protected acceptance/release inputs from the current kernel state. */
export function currentEffectCommandMatches(factory: KernelFactoryPlan, state: KernelState, command: Extract<KernelCommand, { kind: "request-acceptance" | "request-release" }>): boolean {
  const node = nodeFor(factory, command.nodeId);
  try {
    if (command.kind === "request-acceptance" && node?.kind === "acceptance") return canonicalizeJson({ candidate: resolveValue(node.candidate, state, command.nodeId), evidence: resolveValue(node.evidence, state, command.nodeId) }) === canonicalizeJson({ candidate: command.candidate, evidence: command.evidence });
    if (command.kind === "request-release" && node?.kind === "release") return canonicalizeJson({ acceptedCandidate: resolveValue(node.acceptedCandidate, state, command.nodeId), destination: resolveValue(node.destination, state, command.nodeId) }) === canonicalizeJson(command.input);
  } catch { return false; }
  return false;
}

/** Rejects forged repair/replan state before a durable continuation resumes. */
export function assertKernelContinuationState(factory: KernelFactoryPlan, value: unknown): asserts value is KernelState {
  if (!isRecord(value) || !isRecord(value.nodes)) throw new FactoryKernelError("kernel continuation state is invalid");
  const checkReference = (node: FactoryNode, candidate: unknown, label: string): void => {
    if (candidate === undefined) return;
    if (node.kind !== "subfactory" || !isRecord(candidate) || candidate.id !== node.factory.id || typeof candidate.version !== "string" || candidate.version.length < 1 || candidate.version === "latest" || candidate.version.includes("*") || typeof candidate.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(candidate.digest)) throw new FactoryKernelError(`${label} is invalid`);
  };
  const checkInput = (node: FactoryNode, candidate: unknown, label: string): void => {
    if (candidate === undefined) return;
    if ((node.kind !== "task" && node.kind !== "subfactory") || !validateIJson(candidate).ok) throw new FactoryKernelError(`${label} is invalid`);
    validateRecord(node.inputPorts ?? {}, candidate as JsonValue, label);
  };
  for (const [nodeId, candidate] of Object.entries(value.nodes)) {
    if (!isRecord(candidate)) throw new FactoryKernelError("kernel continuation node state is invalid");
    const node = nodeFor(factory, nodeId);
    if (!node) throw new FactoryKernelError("kernel continuation node is unknown");
    checkInput(node, candidate.inputOverride, `node ${nodeId} input override`);
    checkReference(node, candidate.factoryOverride, `node ${nodeId} factory override`);
    if (candidate.priorCandidates !== undefined) {
      if (!Array.isArray(candidate.priorCandidates)) throw new FactoryKernelError("kernel prior candidates are invalid");
      for (const prior of candidate.priorCandidates) {
        if (!isRecord(prior)) throw new FactoryKernelError("kernel prior candidate is invalid");
        checkInput(node, prior.inputOverride, `node ${nodeId} prior input override`);
        checkReference(node, prior.factoryOverride, `node ${nodeId} prior factory override`);
      }
    }
  }
  if (value.pendingRepair !== undefined) {
    const repair = value.pendingRepair;
    if (!isRecord(repair) || typeof repair.rootNodeId !== "string" || !Array.isArray(repair.nodeIds) || !Array.isArray(repair.aggregateIds) || new Set(repair.nodeIds).size !== repair.nodeIds.length || new Set(repair.aggregateIds).size !== repair.aggregateIds.length || !repair.nodeIds.includes(repair.rootNodeId)) throw new FactoryKernelError("pending repair is invalid");
    const node = nodeFor(factory, repair.rootNodeId);
    if (!node) throw new FactoryKernelError("pending repair node is unknown");
    checkInput(node, repair.priorInput, "pending repair prior input");
    checkInput(node, repair.inputOverride, "pending repair input override");
    checkReference(node, repair.priorFactory, "pending repair prior factory");
    checkReference(node, repair.factoryOverride, "pending repair factory override");
  }
}

function successorsFor(factory: KernelFactoryPlan, nodeId: string): readonly string[] {
  if (!nodeId.includes("/")) return factory.indexes.successors[nodeId] ?? [];
  const location = locateNode(factory, nodeId);
  if (!location) return [];
  return location.graph.nodes.filter(candidate => (candidate.dependsOn ?? []).includes(location.node.id) || (candidate.kind === "join" && candidate.predecessors.includes(location.node.id))).map(candidate => `${location.scope}/${candidate.id}`);
}

function toJoinOutcome(status: KernelNodeState["status"]): "succeeded" | "failed" | "skipped" | "cancelled" {
  return status === "succeeded" || status === "failed" || status === "skipped" ? status : "cancelled";
}

function isRecord(value: unknown): value is Record<string, JsonValue> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function distinct(values: readonly string[]): readonly string[] { return [...new Set(values)]; }
