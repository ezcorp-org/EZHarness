import type { JsonValue } from "./types.js";

/** A command is also a Temporal signal or start payload, so it keeps the C08 wire bound. */
export const FACTORY_TRANSPORT_COMMAND_BYTES_LIMIT = 64 * 1024;
/** Private HTTP adds a claim token and settlement metadata outside the Temporal payload. */
export const MAX_TRANSPORT_ENVELOPE_BYTES = FACTORY_TRANSPORT_COMMAND_BYTES_LIMIT + 4 * 1024;

/** Atomic Node process status consumed by Bun before factory admission opens. */
export interface FactoryOrchestrationReadiness {
  readonly schemaVersion: "factory.orchestrator-readiness.v1";
  readonly installationId: string;
  readonly tenantId: string;
  readonly namespace: string;
  readonly taskQueue: string;
  readonly lifecycle: "starting" | "ready" | "stopping" | "failed";
  readonly observedAtMs: number;
  readonly workerPolling: boolean;
  readonly dispatcherLive: boolean;
  readonly credentialGeneration: number;
  readonly errorCode?: string;
}

export interface FactoryOrchestrationReadinessOptions {
  readonly installationId: string;
  readonly tenantId: string;
  readonly namespace: string;
  readonly taskQueue: string;
  readonly readinessFilePath: string;
  readonly readinessHeartbeatMs?: number;
}

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
