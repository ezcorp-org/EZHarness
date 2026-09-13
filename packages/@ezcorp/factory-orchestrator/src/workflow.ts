import type { JsonValue } from "@ezcorp/factory-sdk";
import type { KernelCommand, KernelEvent, KernelState } from "@ezcorp/factory-sdk/kernel-types";
import { advanceKernel, createKernelState } from "@ezcorp/factory-sdk/kernel";
import {
  condition,
  CancellationScope,
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
  FACTORY_INBOX_SIGNAL,
  FACTORY_STATE_QUERY,
  FACTORY_WORKFLOW_TYPE,
  MAX_INBOX_EVENTS,
  type FactoryActivities,
  type FactoryWorkflowInput,
  type FactoryWorkflowResult,
} from "./contracts.ts";
import { assertContinuationSize, validateInboxEvent, validateWorkflowInput } from "./validation.ts";

const inboxSignal = defineSignal<[KernelEvent]>(FACTORY_INBOX_SIGNAL);
const stateQuery = defineQuery<KernelState>(FACTORY_STATE_QUERY);
const audit = proxyActivities<Pick<FactoryActivities, "recordTransition">>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 3 },
});
const effects = proxyActivities<Pick<FactoryActivities, "executeCommand" | "loadFactory">>({
  startToCloseTimeout: "24 hours",
  retry: { maximumAttempts: 1 },
});

type TerminalCommand = Extract<KernelCommand, { readonly kind: "complete-run" | "fail-run" | "cancel-run" }>;

function isTerminal(command: KernelCommand): command is TerminalCommand {
  return command.kind === "complete-run" || command.kind === "fail-run" || command.kind === "cancel-run";
}

function terminal(command: TerminalCommand, state: KernelState): FactoryWorkflowResult {
  if (command.kind === "complete-run") return { status: "completed", output: command.output, state };
  if (command.kind === "fail-run") return { status: "failed", error: command.error, state };
  return { status: "cancelled", error: command.reason, state };
}

function childInput(parent: FactoryWorkflowInput, command: Extract<KernelCommand, { readonly kind: "run-child" }>, factory: FactoryWorkflowInput["factory"]): FactoryWorkflowInput {
  return {
    tenantId: parent.tenantId,
    projectId: parent.projectId,
    logicalRunId: `${parent.logicalRunId}/${command.nodeId}`,
    interpreterId: parent.interpreterId,
    startedAtMs: parent.startedAtMs,
    factory,
    input: command.input,
  };
}

function childEvent(command: Extract<KernelCommand, { readonly kind: "run-child" }>, result: FactoryWorkflowResult): KernelEvent {
  if (result.status === "completed") {
    return { kind: "node-result", id: `${command.id}:child-result`, atMs: command.deadlineAtMs, nodeId: command.nodeId, commandId: command.id, candidateGeneration: command.candidateGeneration, attempt: 1, output: result.output ?? null };
  }
  return { kind: "node-failed", id: `${command.id}:child-failed`, atMs: command.deadlineAtMs, nodeId: command.nodeId, commandId: command.id, candidateGeneration: command.candidateGeneration, attempt: 1, error: result.error ?? result.status };
}

async function runCommand(
  input: FactoryWorkflowInput,
  command: Exclude<KernelCommand, { readonly kind: "start-timer" | "complete-run" | "fail-run" | "cancel-run" }>,
  setActiveScope: (scope: CancellationScope | undefined) => void,
): Promise<KernelEvent | null> {
  if (command.kind === "run-child") {
    const scope = new CancellationScope();
    setActiveScope(scope);
    try {
      return await scope.run(async () => {
        const childFactory = await effects.loadFactory(command.factory);
        const result = await executeChild<typeof factoryWorkflow>(FACTORY_WORKFLOW_TYPE, {
          workflowId: `${input.tenantId}/${input.logicalRunId}/${command.nodeId}`,
          args: [childInput(input, command, childFactory)],
          retry: { maximumAttempts: 1 },
        });
        return childEvent(command, result);
      });
    } catch (error) {
      if (!isCancellation(error)) throw error;
      return null;
    } finally {
      setActiveScope(undefined);
    }
  }
  const scope = new CancellationScope();
  setActiveScope(scope);
  try {
    return await scope.run(() => effects.executeCommand({ tenantId: input.tenantId, projectId: input.projectId, logicalRunId: input.logicalRunId, interpreterId: input.interpreterId, command }));
  } catch (error) {
    if (!isCancellation(error)) throw error;
    return null;
  } finally {
    setActiveScope(undefined);
  }
}

export async function factoryWorkflow(input: FactoryWorkflowInput): Promise<FactoryWorkflowResult> {
  validateWorkflowInput(input);
  let state = input.continuation?.state ?? createKernelState(input.factory, input.logicalRunId, input.input, input.startedAtMs);
  const inbox = [...(input.continuation?.inbox ?? [{ kind: "start", id: `${input.logicalRunId}:start`, atMs: input.startedAtMs } as KernelEvent])];
  let sourceSequence = input.continuation?.sourceSequence ?? 0;
  let handled = input.continuation?.handledSinceContinuation ?? 0;
  let overflow = false;
  let activeScope: CancellationScope | undefined;
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

  if (input.continuation) {
    if (state.runTimerId) scheduleTimer({ kind: "start-timer", id: state.runTimerId, deadlineAtMs: state.runDeadlineAtMs });
    for (const [nodeId, runtime] of Object.entries(state.nodes)) {
      if (runtime.timer) scheduleTimer({ kind: "start-timer", id: runtime.timer.id, nodeId, deadlineAtMs: runtime.timer.deadlineAtMs });
    }
  }

  setHandler(inboxSignal, (event) => {
    if (knownIds.has(event.id)) return;
    if (inbox.length >= MAX_INBOX_EVENTS) { overflow = true; return; }
    knownIds.add(event.id);
    inbox.push(event);
    if (event.kind === "cancel") activeScope?.cancel();
  });
  setHandler(stateQuery, () => state);

  for (;;) {
    if (overflow) throw new Error(`factory inbox exceeds ${MAX_INBOX_EVENTS} distinct events`);
    if (inbox.length === 0) {
      const before = inbox.length;
      const arrived = await condition(() => inbox.length > before || overflow, Math.max(0, state.runDeadlineAtMs - Date.now()));
      if (!arrived) inbox.push({ kind: "timer-expired", id: `${input.logicalRunId}:run-deadline`, atMs: state.runDeadlineAtMs });
      continue;
    }
    const event = inbox.shift()!;
    validateInboxEvent(event as unknown as JsonValue);
    const advanced = advanceKernel(input.factory, state, event);
    await audit.recordTransition({ tenantId: input.tenantId, projectId: input.projectId, logicalRunId: input.logicalRunId, interpreterId: input.interpreterId, sourceSequence: sourceSequence + 1, event, nextState: advanced.nextState, commands: advanced.commands });
    state = advanced.nextState;
    sourceSequence += 1;
    handled += 1;
    for (const command of advanced.commands) {
      if (command.kind === "start-timer") { scheduleTimer(command); continue; }
      if (isTerminal(command)) return terminal(command, state);
      const result = await runCommand(input, command, (scope) => { activeScope = scope; });
      if (result && !knownIds.has(result.id)) { knownIds.add(result.id); inbox.push(result); }
    }
    if (handled >= CONTINUE_AFTER_EVENTS && inbox.length === 0) {
      const continuation = { state, inbox, sourceSequence, handledSinceContinuation: 0 };
      assertContinuationSize(continuation);
      await continueAsNew<typeof factoryWorkflow>({ ...input, continuation });
    }
  }
}
