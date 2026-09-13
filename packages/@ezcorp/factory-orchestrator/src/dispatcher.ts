import type { Client } from "@temporalio/client";
import { WorkflowIdConflictPolicy } from "@temporalio/common";
import {
  FACTORY_INBOX_SIGNAL,
  FACTORY_TASK_QUEUE,
  FACTORY_WORKFLOW_TYPE,
  type ClaimedFactoryCommand,
  type FactoryCommandQueue,
  type FactoryTransportCommand,
  type FactoryWorkflowInput,
} from "./contracts.ts";
import { validateInboxEnvelope } from "./validation.ts";

const START_OPTIONS = Symbol.for("__temporal_internal_client_workflow_start_options");

export type DispatchVerdict = "delivered" | "retry" | "outcome_unknown";

function startInput(command: FactoryTransportCommand): FactoryWorkflowInput {
  if (command.kind !== "start_run" || typeof command.body !== "object" || command.body === null || Array.isArray(command.body)) {
    throw new Error("start command body must be a workflow input object");
  }
  return command.body as unknown as FactoryWorkflowInput;
}

export async function deliverFactoryCommand(client: Client, command: FactoryTransportCommand): Promise<void> {
  if (command.requestId !== command.commandId) throw new Error("Temporal request ID must equal command ID");
  if (command.kind === "start_run") {
    const options = {
      args: [startInput(command)],
      taskQueue: FACTORY_TASK_QUEUE,
      workflowId: command.workflowId,
      workflowIdConflictPolicy: WorkflowIdConflictPolicy.FAIL,
      retry: { maximumAttempts: 1 },
      [START_OPTIONS]: { requestId: command.commandId },
    };
    await client.workflow.start(FACTORY_WORKFLOW_TYPE, options);
    return;
  }
  if (!command.eventId || !command.eventSequence || !command.eventHash) throw new Error("signal command requires a stable event identity, hash, and sequence");
  const envelope = { sequence: command.eventSequence, eventId: command.eventId, eventHash: command.eventHash, event: command.body };
  validateInboxEnvelope(envelope as never);
  await client.workflow.getHandle(command.workflowId).signal(FACTORY_INBOX_SIGNAL, envelope);
}

export function classifyDispatchError(error: unknown): DispatchVerdict {
  if (error instanceof TypeError && /connect|connection|fetch|socket/i.test(error.message)) return "retry";
  return "outcome_unknown";
}

export async function dispatchClaim(client: Client, queue: FactoryCommandQueue, claim: ClaimedFactoryCommand): Promise<DispatchVerdict> {
  try {
    await deliverFactoryCommand(client, claim.command);
    await queue.settle(claim, "delivered");
    return "delivered";
  } catch (error) {
    const verdict = classifyDispatchError(error);
    await queue.settle(claim, verdict, error instanceof Error ? error.name : "UNKNOWN");
    return verdict;
  }
}

export async function dispatchNext(client: Client, queue: FactoryCommandQueue): Promise<DispatchVerdict | "empty"> {
  const claim = await queue.claim();
  return claim ? dispatchClaim(client, queue, claim) : "empty";
}
