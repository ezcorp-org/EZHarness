import { advanceKernel, createKernelState, nodeFor } from "./kernel.js";
import type { KernelCommand, KernelEvent, KernelState } from "./kernel-types.js";
import type { CompiledFactory, FactoryNode, JsonValue } from "./types.js";

export type SimulatedOutcome =
  | { readonly kind: "success"; readonly output: JsonValue }
  | { readonly kind: "failure"; readonly error: string };

export interface FactorySimulatorOptions {
  readonly nowMs?: number;
  readonly admit?: (command: Extract<KernelCommand, { kind: "request-admission" }>) => boolean;
  readonly execute?: (node: FactoryNode, command: Extract<KernelCommand, { kind: "dispatch-node" }>) => SimulatedOutcome;
  readonly child?: (command: Extract<KernelCommand, { kind: "run-child" }>) => SimulatedOutcome;
  readonly approval?: (command: Extract<KernelCommand, { kind: "request-approval" }>) => string | undefined;
  readonly acceptance?: (command: Extract<KernelCommand, { kind: "request-acceptance" }>) => SimulatedOutcome;
  readonly release?: (command: Extract<KernelCommand, { kind: "request-release" }>) => SimulatedOutcome;
}

export interface SimulationResult {
  readonly state: KernelState;
  readonly events: readonly KernelEvent[];
  readonly commands: readonly KernelCommand[];
}

/** A deterministic harness that drives the production kernel; it has no state machine of its own. */
export function simulateFactory(
  factory: CompiledFactory,
  logicalRunId: string,
  input: JsonValue,
  options: FactorySimulatorOptions = {},
): SimulationResult {
  let sequence = 0;
  let state = createKernelState(factory, logicalRunId, input, options.nowMs ?? 0);
  const events: KernelEvent[] = [];
  const commands: KernelCommand[] = [];
  const pending: KernelEvent[] = [{ kind: "start", id: eventId("start"), atMs: state.nowMs }];

  while (pending.length > 0 && state.status !== "completed" && state.status !== "failed" && state.status !== "cancelled") {
    const event = pending.shift()!;
    events.push(event);
    const advanced = advanceKernel(factory, state, event);
    state = advanced.nextState;
    commands.push(...advanced.commands);
    for (const command of advanced.commands) pending.push(...eventsFor(command, state, factory, options, eventId));
    // ECMAScript sort is stable: equal timestamps retain recorded enqueue order.
    pending.sort((left, right) => left.atMs - right.atMs);
  }
  return { state, events, commands };

  function eventId(kind: string): string {
    sequence += 1;
    return `${logicalRunId}:sim:${kind}:${sequence}`;
  }
}

function eventsFor(
  command: KernelCommand,
  state: KernelState,
  factory: CompiledFactory,
  options: FactorySimulatorOptions,
  eventId: (kind: string) => string,
): readonly KernelEvent[] {
  switch (command.kind) {
    case "request-admission":
      return [{ kind: "admission-result", id: eventId("admission"), atMs: state.nowMs, nodeId: command.nodeId, commandId: command.id, candidateGeneration: command.candidateGeneration, granted: options.admit?.(command) ?? true }];
    case "dispatch-node": {
      const node = nodeFor(factory, command.nodeId)!;
      return outcomeEvents(options.execute?.(node, command) ?? { kind: "success", output: command.input }, command, state.nowMs, eventId);
    }
    case "run-child":
      return outcomeEvents(options.child?.(command) ?? { kind: "success", output: command.input }, command, state.nowMs, eventId);
    case "request-approval": {
      const choice = options.approval ? options.approval(command) : command.choices[0];
      return choice === undefined ? [] : [{ kind: "approval-decided", id: eventId("approval"), atMs: state.nowMs, nodeId: command.nodeId, commandId: command.id, choice }];
    }
    case "request-acceptance":
      return outcomeEvents(options.acceptance?.(command) ?? { kind: "success", output: command.candidate }, command, state.nowMs, eventId);
    case "request-release":
      return outcomeEvents(options.release?.(command) ?? { kind: "success", output: command.input }, command, state.nowMs, eventId);
    case "start-timer":
      return [{ kind: "timer-expired", id: eventId("timer"), atMs: command.deadlineAtMs, nodeId: command.nodeId, commandId: command.id }];
    case "cancel-node":
      return [{ kind: "attempt-stopped", id: eventId("stopped"), atMs: state.nowMs, nodeId: command.nodeId, commandId: command.attemptCommandId, candidateGeneration: command.candidateGeneration, attempt: command.attempt }];
    case "complete-run":
    case "fail-run":
    case "cancel-run":
      return [];
  }
}

function outcomeEvents(
  outcome: SimulatedOutcome,
  command: Extract<KernelCommand, { kind: "dispatch-node" | "run-child" | "request-acceptance" | "request-release" }>,
  atMs: number,
  eventId: (kind: string) => string,
): readonly KernelEvent[] {
  if (outcome.kind === "success") return [{ kind: "node-result", id: eventId("result"), atMs, nodeId: command.nodeId, commandId: command.id, candidateGeneration: command.candidateGeneration, attempt: command.kind === "dispatch-node" ? command.attempt : 1, output: outcome.output }];
  const attempt = command.kind === "dispatch-node" ? command.attempt : 1;
  return [
    { kind: "node-failed", id: eventId("failure"), atMs, nodeId: command.nodeId, commandId: command.id, candidateGeneration: command.candidateGeneration, attempt, error: outcome.error },
    { kind: "attempt-stopped", id: eventId("stopped"), atMs, nodeId: command.nodeId, commandId: command.id, candidateGeneration: command.candidateGeneration, attempt },
  ];
}
