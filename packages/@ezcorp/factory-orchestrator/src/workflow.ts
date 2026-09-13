import type { JsonValue } from "@ezcorp/factory-sdk";
import { factoryChildRunId } from "@ezcorp/factory-sdk/transport-types";
import { canonicalizeJson } from "@ezcorp/factory-sdk/canonical";
import type { KernelCommand, KernelEvent, KernelFactoryPlan, KernelState } from "@ezcorp/factory-sdk/kernel-types";
import { advanceKernel, createKernelState, createPartitionKernelState } from "@ezcorp/factory-sdk/kernel";
import {
  condition,
  ActivityCancellationType,
  ApplicationFailure,
  CancellationScope,
  ChildWorkflowCancellationType,
  continueAsNew,
  defineQuery,
  defineSignal,
  executeChild,
  proxyActivities,
  setHandler,
  sleep,
  isCancellation,
} from "@temporalio/workflow";
import {
  CONTINUE_AFTER_EVENTS,
  FACTORY_INBOX_RECEIPT_QUERY,
  FACTORY_INBOX_SIGNAL,
  FACTORY_STATE_QUERY,
  FACTORY_WORKFLOW_TYPE,
  MAX_INBOX_EVENTS,
  MAX_INFLIGHT_COMMANDS,
  type FactoryActivities,
  type FactoryDefinitionSource,
  type FactoryInboxEnvelope,
  type FactoryIdentity,
  type FactoryInboxReceipt,
  type FactoryWorkflowInput,
  type FactoryWorkflowResult,
} from "./contracts.ts";
import { loadCompiledFactory } from "./definition-pages.ts";
import { acceptFactoryInbox } from "./inbox.ts";
import { loadPartitionKernelPlan } from "./partition-plan.ts";
import { loadTransitionArtifact, persistTransition } from "./transition-pages.ts";
import { assertCommandBatchSize, assertContinuationSize, isPartitionSource, validateCompiledFactoryShape, validateInboxEvent, validateWorkflowInput } from "./validation.ts";

const inboxSignal = defineSignal<[FactoryInboxEnvelope]>(FACTORY_INBOX_SIGNAL);
const stateQuery = defineQuery<KernelState>(FACTORY_STATE_QUERY);
const inboxReceiptQuery = defineQuery<FactoryInboxReceipt>(FACTORY_INBOX_RECEIPT_QUERY);
const audit = proxyActivities<Pick<FactoryActivities, "stageTransitionPage" | "finalizeTransitionArtifact" | "recordTransition">>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 3 },
});
const reads = proxyActivities<Pick<FactoryActivities, "resolveFactory" | "loadManifestPage" | "loadDefinitionPage" | "loadExecutionManifest" | "loadPartitionArtifact" | "loadTransitionManifest" | "loadTransitionPage">>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 3 },
});
const effects = proxyActivities<Pick<FactoryActivities, "executeCommand">>({
  startToCloseTimeout: "24 hours",
  heartbeatTimeout: "20 seconds",
  retry: { maximumAttempts: 1 },
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
});

type TerminalCommand = Extract<KernelCommand, { readonly kind: "complete-run" | "complete-partition" | "fail-run" | "cancel-run" }>;

function isTerminal(command: KernelCommand): command is TerminalCommand {
  return command.kind === "complete-run" || command.kind === "complete-partition" || command.kind === "fail-run" || command.kind === "cancel-run";
}

function workflowFailure(error: unknown, type: string): ApplicationFailure {
  return ApplicationFailure.nonRetryable(error instanceof Error ? error.message : String(error), type);
}

function terminal(command: TerminalCommand, state: KernelState): FactoryWorkflowResult {
  if (command.kind === "complete-run") return { status: "completed", output: command.output, state };
  if (command.kind === "complete-partition") return { status: "completed", state };
  if (command.kind === "fail-run") return { status: "failed", error: command.error, state };
  return { status: "cancelled", error: command.reason, state };
}

function childInput(parent: FactoryWorkflowInput, command: Extract<KernelCommand, { readonly kind: "run-child" }>, definition: FactoryDefinitionSource): FactoryWorkflowInput {
  return {
    tenantId: parent.tenantId,
    projectId: parent.projectId,
    logicalRunId: factoryChildRunId(parent.logicalRunId, command),
    interpreterId: parent.interpreterId,
    startedAtMs: parent.startedAtMs,
    deadlineAtMs: command.deadlineAtMs,
    definition,
    input: command.input,
    ...(command.durableInput === undefined ? {} : { durableInput: command.durableInput }),
  };
}

function childEvent(command: Extract<KernelCommand, { readonly kind: "run-child" }>, result: FactoryWorkflowResult, completedAtMs: number): KernelEvent {
  if (result.status === "completed") {
    return { kind: "node-result", id: `${command.id}:child-result`, atMs: completedAtMs, nodeId: command.nodeId, commandId: command.id, candidateGeneration: command.candidateGeneration, attempt: 1, output: result.output ?? null };
  }
  return { kind: "node-failed", id: `${command.id}:child-failed`, atMs: completedAtMs, nodeId: command.nodeId, commandId: command.id, candidateGeneration: command.candidateGeneration, attempt: 1, error: result.error ?? result.status };
}

async function runCommand(
  input: FactoryWorkflowInput,
  command: Exclude<KernelCommand, { readonly kind: "start-timer" | "complete-run" | "complete-partition" | "fail-run" | "cancel-run" }>,
  scope: CancellationScope,
): Promise<KernelEvent | null> {
  if (command.kind === "run-child") {
    try {
      return await scope.run(async () => {
        const definition = await reads.resolveFactory({ ...workflowIdentity(input), commandId: command.id, factory: command.factory });
        const result = await executeChild<typeof factoryWorkflow>(FACTORY_WORKFLOW_TYPE, {
          workflowId: `${input.tenantId}/${command.id}`,
          args: [childInput(input, command, definition)],
          retry: { maximumAttempts: 1 },
          cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
        });
        return childEvent(command, result, Date.now());
      });
    } catch (error) {
      if (!isCancellation(error)) throw error;
      return null;
    }
  }
  try {
    return await scope.run(() => effects.executeCommand({ tenantId: input.tenantId, projectId: input.projectId, logicalRunId: input.logicalRunId, interpreterId: input.interpreterId, command }));
  } catch (error) {
    if (!isCancellation(error)) throw error;
    return null;
  }
}

function workflowIdentity(input: FactoryWorkflowInput): FactoryIdentity {
  return { tenantId: input.tenantId, projectId: input.projectId, logicalRunId: input.logicalRunId, interpreterId: input.interpreterId };
}

function durableInputJson(value: FactoryWorkflowInput["durableInput"]): JsonValue {
  // Both sources were schema-validated before this comparison; this preserves a canonical transport snapshot.
  return (value ?? null) as unknown as JsonValue;
}

function assertDurableInputContinuity(input: FactoryWorkflowInput, state: KernelState): void {
  if (canonicalizeJson(durableInputJson(state.durableInput)) !== canonicalizeJson(durableInputJson(input.durableInput))) {
    throw workflowFailure(new Error("continuation durable input does not match workflow input"), "FACTORY_INPUT_INVALID");
  }
}

export async function factoryWorkflow(input: FactoryWorkflowInput): Promise<FactoryWorkflowResult> {
  try {
    validateWorkflowInput(input);
  } catch (error) {
    throw workflowFailure(error, "FACTORY_INPUT_INVALID");
  }
  let factory: KernelFactoryPlan;
  try {
    if (isPartitionSource(input.definition)) factory = await loadPartitionKernelPlan(workflowIdentity(input), input.definition, reads);
    else {
      const compiled = await loadCompiledFactory(workflowIdentity(input), input.definition, reads);
      validateCompiledFactoryShape(compiled);
      factory = compiled;
    }
  } catch (error) {
    throw workflowFailure(error, "FACTORY_DEFINITION_INVALID");
  }
  let created: KernelState;
  try {
    created = isPartitionSource(input.definition)
      ? createPartitionKernelState(factory, input.definition.partition.partitionId, input.logicalRunId, input.input, input.startedAtMs, input.durableInput)
      : createKernelState(factory, input.logicalRunId, input.input, input.startedAtMs, input.durableInput);
  } catch (error) {
    throw workflowFailure(error, "FACTORY_INPUT_INVALID");
  }
  const restored = input.continuation?.stateArtifact
    ? await loadTransitionArtifact(workflowIdentity(input), input.continuation.stateArtifact.sourceSequence, input.continuation.stateArtifact.manifest, reads)
    : undefined;
  let state = input.continuation?.state ?? restored?.nextState ?? (input.deadlineAtMs === undefined ? created : { ...created, runDeadlineAtMs: Math.min(created.runDeadlineAtMs, input.deadlineAtMs) });
  if (state.definitionDigest !== input.definition.definitionDigest) throw workflowFailure(new Error("continuation definition digest does not match input"), "FACTORY_INPUT_INVALID");
  if (input.continuation) assertDurableInputContinuity(input, state);
  if (isPartitionSource(input.definition) && state.partition?.id !== input.definition.partition.partitionId) throw workflowFailure(new Error("continuation partition ID does not match input"), "FACTORY_INPUT_INVALID");
  const inbox = [...(input.continuation?.inbox ?? [{ kind: "start", id: `${input.logicalRunId}:start`, atMs: input.startedAtMs } as KernelEvent])];
  const pendingInbox = new Map((input.continuation?.pendingInbox ?? []).map((delivery) => [delivery.sequence, delivery]));
  let sourceSequence = input.continuation?.sourceSequence ?? 0;
  let handled = input.continuation?.handledSinceContinuation ?? 0;
  let acknowledgedInboxSequence = input.continuation?.acknowledgedInboxSequence ?? 0;
  let stateArtifact = input.continuation?.stateArtifact;
  let overflow = false;
  let workflowError: Error | undefined;
  let terminalResult: FactoryWorkflowResult | undefined;
  type ExecutableCommand = Exclude<KernelCommand, { readonly kind: "start-timer" | "complete-run" | "complete-partition" | "fail-run" | "cancel-run" }>;
  const pendingCommands: ExecutableCommand[] = [];
  const activeScopes = new Map<string, CancellationScope>();
  const knownIds = new Set([...state.appliedEventIds, ...inbox.map((event) => event.id)]);

  const scheduleTimer = (command: Extract<KernelCommand, { readonly kind: "start-timer" }>) => {
    const eventId = `${command.id}:expired`;
    void sleep(Math.max(0, command.deadlineAtMs - Date.now()))
      .then(() => {
        if (knownIds.has(eventId)) return;
        knownIds.add(eventId);
        inbox.push({ kind: "timer-expired", id: eventId, atMs: command.deadlineAtMs, nodeId: command.nodeId, commandId: command.id });
      })
      .catch((error) => { if (!isCancellation(error)) throw error; });
  };

  const launchCommand = (command: ExecutableCommand) => {
    const scope = new CancellationScope();
    activeScopes.set(command.id, scope);
    void runCommand(input, command, scope)
      .then((result) => {
        if (result && !knownIds.has(result.id)) { knownIds.add(result.id); inbox.push(result); }
      })
      .catch((error) => { workflowError = workflowFailure(error, "FACTORY_COMMAND_FAILED"); })
      .finally(() => { activeScopes.delete(command.id); });
  };

  const pumpCommands = () => {
    while (activeScopes.size < MAX_INFLIGHT_COMMANDS && pendingCommands.length > 0) launchCommand(pendingCommands.shift()!);
  };

  if (input.continuation) {
    if (state.runTimerId) scheduleTimer({ kind: "start-timer", id: state.runTimerId, deadlineAtMs: state.runDeadlineAtMs });
    for (const [nodeId, runtime] of Object.entries(state.nodes)) {
      if (runtime.timer) scheduleTimer({ kind: "start-timer", id: runtime.timer.id, nodeId, deadlineAtMs: runtime.timer.deadlineAtMs });
    }
  }

  setHandler(inboxSignal, (delivery) => {
    const accepted = acceptFactoryInbox(delivery, acknowledgedInboxSequence, pendingInbox);
    workflowError = accepted.error ? ApplicationFailure.nonRetryable(accepted.error, "FACTORY_INBOX_CONFLICT") : workflowError;
    overflow = overflow || accepted.overflow;
    if (accepted.accepted?.event.kind === "cancel") for (const scope of activeScopes.values()) scope.cancel();
  });
  setHandler(stateQuery, () => state);
  setHandler(inboxReceiptQuery, () => ({
    acknowledgedSequence: acknowledgedInboxSequence,
    pending: [...pendingInbox.values()].map(({ sequence, eventId, eventHash }) => ({ sequence, eventId, eventHash })),
  }));

  for (;;) {
    if (workflowError) throw workflowError;
    if (overflow) throw new Error(`factory inbox exceeds ${MAX_INBOX_EVENTS} distinct events`);
    pumpCommands();
    if (terminalResult && activeScopes.size === 0 && pendingCommands.length === 0) return terminalResult;
    const delivery = pendingInbox.get(acknowledgedInboxSequence + 1);
    if (inbox.length === 0 && !delivery) {
      const arrived = await condition(() => inbox.length > 0 || pendingInbox.has(acknowledgedInboxSequence + 1) || overflow || workflowError !== undefined || (pendingCommands.length > 0 && activeScopes.size < MAX_INFLIGHT_COMMANDS) || (terminalResult !== undefined && activeScopes.size === 0), Math.max(0, state.runDeadlineAtMs - Date.now()));
      if (!arrived) inbox.push({ kind: "timer-expired", id: `${input.logicalRunId}:run-deadline`, atMs: state.runDeadlineAtMs, commandId: state.runTimerId });
      continue;
    }
    const selectedDelivery = inbox.length > 0 ? undefined : delivery!;
    const event = selectedDelivery ? selectedDelivery.event : inbox.shift()!;
    if (selectedDelivery) pendingInbox.delete(selectedDelivery.sequence);
    validateInboxEvent(event as unknown as JsonValue);
    const advanced = advanceKernel(factory, state, event);
    assertCommandBatchSize(advanced.commands);
    const finalized = await persistTransition(
      workflowIdentity(input),
      sourceSequence + 1,
      event,
      advanced.nextState,
      advanced.commands,
      selectedDelivery ? { sequence: selectedDelivery.sequence, eventId: selectedDelivery.eventId, eventHash: selectedDelivery.eventHash } : undefined,
      audit,
    );
    state = advanced.nextState;
    sourceSequence += 1;
    stateArtifact = { sourceSequence, manifest: finalized.manifest };
    handled += 1;
    if (selectedDelivery) acknowledgedInboxSequence = selectedDelivery.sequence;
    for (const command of advanced.commands) {
      if (command.kind === "start-timer") { scheduleTimer(command); continue; }
      if (isTerminal(command)) { terminalResult = terminal(command, state); continue; }
      pendingCommands.push(command);
    }
    pumpCommands();
    if (terminalResult && activeScopes.size === 0 && pendingCommands.length === 0) return terminalResult;
    if (handled >= CONTINUE_AFTER_EVENTS && inbox.length === 0 && activeScopes.size === 0 && pendingCommands.length === 0) {
      const continuation = { stateArtifact: stateArtifact!, inbox, pendingInbox: [...pendingInbox.values()], sourceSequence, handledSinceContinuation: 0, acknowledgedInboxSequence };
      assertContinuationSize(continuation);
      await continueAsNew<typeof factoryWorkflow>({ ...input, continuation });
    }
  }
}
