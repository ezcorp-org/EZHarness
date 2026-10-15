import type { KernelEvent } from "@ezcorp/factory-sdk";
import type { FactoryCommandAuthority } from "./command-authority";
import type { FactoryInbox } from "./inbox";
import { assertFactoryIdentity } from "./records";
import type { TrustedFactoryCommandReference, TrustedFactoryServiceIdentity } from "./trusted-command-gateway";

/** Delivers one verified compiled edge through the existing durable interpreter inbox. */
export class FactoryPartitionCommands {
  readonly tenantId: string;

  constructor(private readonly authority: FactoryCommandAuthority, private readonly inbox: FactoryInbox) {
    if (!authority || !inbox || authority.tenantId !== inbox.tenantId || typeof authority.withCurrentPartition !== "function" || typeof inbox.enqueueInTransaction !== "function") throw new Error("factory_partition_commands_invalid");
    this.tenantId = authority.tenantId;
    assertFactoryIdentity(this.tenantId);
  }

  execute(serviceValue: TrustedFactoryServiceIdentity, value: TrustedFactoryCommandReference): Promise<null> {
    const service = Object.freeze({ tenantId: serviceValue.tenantId, subject: serviceValue.subject });
    const reference = Object.freeze({ tenantId: value.tenantId, projectId: value.projectId, logicalRunId: value.logicalRunId, interpreterId: value.interpreterId, commandId: value.commandId });
    return this.authority.withCurrentPartition(service, reference, async (transaction, { command, commandState }) => {
      const common = {
        id: `${command.id}:result`, atMs: commandState.nowMs,
        sourcePartitionId: command.sourcePartitionId, targetPartitionId: command.targetPartitionId,
        sourceNodeId: command.sourceNodeId, nodeId: command.nodeId, candidateGeneration: command.candidateGeneration,
      };
      const event: KernelEvent = command.kind === "invalidate-partition"
        ? { ...common, kind: "partition-source-invalidated" }
        : { ...common, kind: "partition-node-completed", terminalSequence: command.terminalSequence, outcome: command.outcome,
          ...(command.output === undefined ? {} : { output: command.output }), ...(command.error === undefined ? {} : { error: command.error }) };
      await this.inbox.enqueueInTransaction(transaction, { projectId: reference.projectId, runId: reference.logicalRunId, interpreterId: command.targetPartitionId }, event, "partition_notification");
      return null;
    });
  }
}
