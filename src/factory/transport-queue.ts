import type { ClaimedFactoryCommand, FactoryCommandQueue, FactoryTransportCommand } from "@ezcorp/factory-sdk/transport-types";
import { canonicalJson } from "@ezcorp/extension-contract";
import type { FactoryInbox } from "./inbox";
import { type FactoryCommandOutbox, FactoryOutboxError, type FactoryCommand, type FactoryCommandDelivery } from "./outbox";

type TransportOutbox = Pick<FactoryCommandOutbox, "tenantId" | "claim" | "settle"> & {
  readonly projectId?: string;
  inspect(commandId: string, projectId: string): Promise<FactoryCommandDelivery | null>;
};

/** Database side of the authenticated Bun-to-Node dispatcher boundary. */
export class FactoryTransportQueue implements FactoryCommandQueue {
  constructor(private readonly outbox: TransportOutbox, private readonly inbox: FactoryInbox) {
    if (outbox.tenantId !== inbox.tenantId) throw new FactoryOutboxError("factory_command_scope_mismatch");
  }

  async claim(): Promise<ClaimedFactoryCommand | null> {
    const delivery = await this.outbox.claim();
    if (!delivery) return null;
    const command = this.transport(delivery.command);
    return { command, claimToken: delivery.leaseToken! };
  }

  async settle(claim: ClaimedFactoryCommand, outcome: "delivered" | "retry" | "outcome_unknown", errorCode?: string): Promise<void> {
    // The request proves possession of a lease; stored bytes remain authoritative.
    const snapshot = JSON.parse(canonicalJson(claim)) as ClaimedFactoryCommand;
    this.transport(snapshot.command);
    const stored = await this.outbox.inspect(snapshot.command.commandId, snapshot.command.projectId);
    if (!stored || canonicalJson(stored.command) !== canonicalJson(snapshot.command)) throw new FactoryOutboxError("factory_command_conflict");
    await this.outbox.settle({ ...stored, leaseToken: snapshot.claimToken }, outcome, errorCode);
  }

  async confirmInboxIdentity(command: FactoryTransportCommand): Promise<boolean> {
    const snapshot = this.transport(JSON.parse(canonicalJson(command)) as FactoryCommand);
    if (snapshot.kind === "start_run") return false;
    const stored = await this.outbox.inspect(snapshot.commandId, snapshot.projectId);
    if (!stored || canonicalJson(stored.command) !== canonicalJson(snapshot)) return false;
    return this.inbox.confirmApplied({ projectId: snapshot.projectId, runId: snapshot.logicalRunId, interpreterId: snapshot.interpreterId! }, { inboxSequence: snapshot.eventSequence!, eventId: snapshot.eventId!, eventHash: snapshot.eventHash! });
  }

  private transport(command: FactoryCommand): FactoryTransportCommand {
    if (command.tenantId !== this.outbox.tenantId || (this.outbox.projectId !== undefined && command.projectId !== this.outbox.projectId)) throw new FactoryOutboxError("factory_command_scope_mismatch");
    if (command.kind === "compute_admission" || !command.interpreterId || (command.kind !== "start_run" && (!command.eventId || !command.eventHash || !Number.isSafeInteger(command.eventSequence) || command.eventSequence! < 1))) throw new FactoryOutboxError("factory_command_transport_invalid");
    return command as FactoryTransportCommand;
  }
}
