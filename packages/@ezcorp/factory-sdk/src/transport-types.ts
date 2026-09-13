import type { JsonValue } from "./types.js";

/** Pure durable command contract shared by Bun producers and the Node dispatcher. */
export interface FactoryTransportCommand {
  readonly commandId: string;
  readonly requestId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly logicalRunId: string;
  /** Root workflow ID; the dispatcher derives a partition child from interpreterId. */
  readonly workflowId: string;
  readonly kind: "start_run" | "decision" | "partition_notification";
  readonly interpreterId?: string;
  readonly eventId?: string;
  readonly eventSequence?: number;
  readonly eventHash?: string;
  readonly body: JsonValue;
}

export interface ClaimedFactoryCommand {
  readonly claimToken: string;
  readonly command: FactoryTransportCommand;
}

export interface FactoryCommandQueue {
  claim(): Promise<ClaimedFactoryCommand | null>;
  settle(claim: ClaimedFactoryCommand, outcome: "delivered" | "retry" | "outcome_unknown", errorCode?: string): Promise<void>;
  /** Exact immutable product-inbox tombstone lookup for an already applied decision. */
  confirmInboxIdentity?(command: FactoryTransportCommand): Promise<boolean>;
}
