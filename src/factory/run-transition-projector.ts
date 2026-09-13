import type { FactoryRunError, FactoryTransportValue, JsonValue } from "@ezcorp/factory-sdk";
import type { KernelCommand } from "@ezcorp/factory-sdk/kernel-types";
import type { FactoryIdentity, TransitionArtifact } from "../../packages/@ezcorp/factory-orchestrator/src/contracts";
import type { TransactionalDb } from "../db/migrations/types";
import { assertFactoryIdentity, FactoryRecords, type FactoryAuditBatch, type FactoryRunKey } from "./records";
import type { FactoryRunLifecycle, FactoryRunProjectionState } from "./run-lifecycle";
import type { FactoryTransitionArtifacts } from "./transition-artifacts";

const CONSUMER_ID = "factory-run-status.v1";
const ROOT_INTERPRETER_ID = "root";

export interface FactoryRunProjectionProgress {
  readonly sequence: number;
  readonly digest: string | null;
  readonly lag: number;
  readonly applied: number;
}

export interface FactoryPendingProjectionResult {
  readonly key: FactoryRunKey;
  readonly progress?: FactoryRunProjectionProgress;
  readonly errorCode?: string;
}

export interface FactoryPendingProjectionPage {
  readonly runs: readonly FactoryPendingProjectionResult[];
}

type TerminalCommand = Extract<KernelCommand, { readonly kind: "complete-run" | "fail-run" | "cancel-run" }>;

function terminalState(command: TerminalCommand): FactoryRunProjectionState {
  if (command.kind === "complete-run") return { status: "succeeded", output: { kind: "inline", value: command.output as JsonValue } satisfies FactoryTransportValue };
  if (command.kind === "fail-run") return { status: "failed", error: error("FACTORY_RUN_FAILED", command.error) };
  return { status: "cancelled", error: error("FACTORY_RUN_CANCELLED", command.reason) };
}

function error(code: string, message: string): FactoryRunError {
  if (!message || message.length > 4096) throw new Error("Factory transition terminal error is invalid.");
  return { code, message };
}

function transitionState(batch: FactoryAuditBatch, transition: TransitionArtifact): FactoryRunProjectionState | null {
  if (batch.interpreterId !== ROOT_INTERPRETER_ID) return null;
  const terminals = transition.commands.filter((command): command is TerminalCommand => command.kind === "complete-run" || command.kind === "fail-run" || command.kind === "cancel-run");
  if (terminals.length > 1) throw new Error("Factory transition contains conflicting root terminal commands.");
  const terminal = terminals[0];
  if (terminal) return terminalState(terminal);
  if (transition.nextState.status === "running" || transition.nextState.status === "created") return { status: "running" };
  if (transition.nextState.status === "waiting") return { status: "waiting" };
  return null;
}

/** Bounded durable worker that makes the public run view consume canonical committed transitions. */
export class FactoryRunTransitionProjector {
  private readonly records: FactoryRecords;

  constructor(private readonly database: TransactionalDb, readonly tenantId: string, private readonly transitions: FactoryTransitionArtifacts, private readonly lifecycle: FactoryRunLifecycle) {
    assertFactoryIdentity(tenantId);
    if (transitions === undefined || lifecycle.tenantId !== tenantId) throw new Error("Factory transition projector scope is invalid.");
    this.records = new FactoryRecords(database, tenantId);
  }

  async project(keyValue: FactoryRunKey, limit = 50): Promise<FactoryRunProjectionProgress> {
    const key = { projectId: keyValue.projectId, runId: keyValue.runId };
    assertFactoryIdentity(key.projectId, key.runId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("Factory transition projection limit is invalid.");
    await this.database.transaction(transaction => this.lifecycle.assertProjectionScopeInTransaction(transaction, key));
    const before = await this.records.projectionProgress(key, CONSUMER_ID);
    const batches = await this.records.readAudit(key, before.sequence, limit);
    let applied = 0;
    for (const batch of batches) {
      const identity: FactoryIdentity = { tenantId: this.tenantId, projectId: key.projectId, logicalRunId: key.runId, interpreterId: batch.interpreterId };
      const transition = await this.transitions.loadCommittedTransition(identity, batch.sourceSequence);
      const next = transitionState(batch, transition);
      const result = await this.database.transaction(async transaction => {
        const projected = await this.records.projectInTransaction(transaction, batch, CONSUMER_ID, () => ({ sourceSequence: batch.sourceSequence, digest: batch.digest, status: next?.status ?? null }));
        if (projected.applied && next) await this.lifecycle.applyProjectionInTransaction(transaction, key, next);
        return projected.applied;
      });
      if (result) applied++;
    }
    const progress = await this.records.projectionProgress(key, CONSUMER_ID);
    return { ...progress, applied };
  }

  async progress(keyValue: FactoryRunKey): Promise<Omit<FactoryRunProjectionProgress, "applied">> {
    const key = { projectId: keyValue.projectId, runId: keyValue.runId };
    assertFactoryIdentity(key.projectId, key.runId);
    await this.database.transaction(transaction => this.lifecycle.assertProjectionScopeInTransaction(transaction, key));
    return this.records.projectionProgress(key, CONSUMER_ID);
  }

  /**
   * Drains a fair, indexed page. Each result uses its durable per-run cursor, so restart needs no in-memory state.
   * A bad run is reported and does not prevent later runs in the same page from progressing.
   */
  async projectPending(options: { readonly runs?: number; readonly batchesPerRun?: number } = {}): Promise<FactoryPendingProjectionPage> {
    const runs = options.runs ?? 20;
    const batchesPerRun = options.batchesPerRun ?? 50;
    if (!Number.isSafeInteger(runs) || runs < 1 || runs > 200 || !Number.isSafeInteger(batchesPerRun) || batchesPerRun < 1 || batchesPerRun > 200) throw new Error("Factory transition projection page is invalid.");
    const pending = await this.records.pendingProjectionRuns(CONSUMER_ID, runs);
    const results: FactoryPendingProjectionResult[] = [];
    for (const key of pending) {
      try {
        const progress = await this.project(key, batchesPerRun);
        await this.records.recordProjectionAttempt(key, CONSUMER_ID, null);
        results.push({ key, progress });
      } catch (cause) {
        const errorCode = cause instanceof Error && "code" in cause && typeof cause.code === "string" ? cause.code : "factory_projection_failed";
        await this.records.recordProjectionAttempt(key, CONSUMER_ID, errorCode);
        results.push({ key, errorCode });
      }
    }
    return { runs: results };
  }
}
