/**
 * A settled release, delivered back to the run that asked for it.
 *
 * `requestRelease` answers the orchestrator with `null`: a prepared release is
 * not a completed Release node, so the workflow waits for an inbox event. This
 * module writes that event once the operation has settled. The rules are C04's:
 *
 * - `succeeded` becomes one `node-result` whose output is the release receipt.
 * - `failed` becomes one `node-failed` carrying the operation's outcome code.
 * - `uncertain`, `pending` and `executing` enqueue nothing. An uncertain
 *   release stays visible to its operator; it is never reported as an answer.
 *
 * **Exactly once.** The event id is derived from the operation id alone, and
 * its time from the settled row, so every retry builds the same bytes. The
 * inbox is idempotent on that id and hash, and the scan skips an operation
 * whose event already exists. A driver that crashes after settlement and
 * before delivery finds the operation again on its next pass and delivers it
 * once.
 *
 * **Never another run.** The run, project and tenant come from the operation
 * row. The command comes from `FactoryProtectedCommandEffects`, which reads
 * only the verified receipt of that same run. The command authority then
 * re-derives the command as still current before anything is written, all in
 * one transaction with the inbox write.
 */
import type { KernelEvent } from "@ezcorp/factory-sdk/kernel-types";
import { validateNodeOutput } from "@ezcorp/factory-sdk/kernel";
import type { JsonValue } from "@ezcorp/factory-sdk";
import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import type { FactoryCommandAuthority } from "./command-authority";
import type { FactoryInbox } from "./inbox";
import type { FactoryProtectedCommandEffects } from "./protected-command-effects";
import { assertFactoryIdentity } from "./records";
import type { TrustedFactoryServiceIdentity } from "./trusted-command-gateway";

/** The inbox event id of one operation's outcome. One operation, one id. */
export function factoryReleaseOutcomeEventId(operationId: string): string {
  return `release-outcome:${operationId}`;
}

/** How many settled, undelivered operations one scan returns. */
export const FACTORY_RELEASE_OUTCOME_SCAN_LIMIT = 16;

export class FactoryReleaseOutcomeDeliveryError extends Error {
  constructor(readonly code: "factory_release_outcome_missing" | "factory_release_outcome_command_missing" | "factory_release_outcome_invalid" | "factory_release_stopped") {
    super(code);
    this.name = "FactoryReleaseOutcomeDeliveryError";
  }
}

export interface FactoryReleaseOutcomeDeliveryOptions {
  readonly database: TransactionalDb;
  readonly tenantId: string;
  readonly service: TrustedFactoryServiceIdentity;
  readonly effects: Pick<FactoryProtectedCommandEffects, "readReleaseCommandInTransaction">;
  readonly authority: Pick<FactoryCommandAuthority, "withCurrentReleaseInTransaction">;
  readonly inbox: Pick<FactoryInbox, "enqueueInTransaction">;
}

/** One settled operation that still needs its event. */
export interface FactoryUndeliveredReleaseOutcome {
  readonly projectId: string;
  readonly operationId: string;
}

interface SettledRow {
  readonly run_id: string;
  readonly state: string;
  readonly request_digest: string;
  readonly receipt_json: string | null;
  readonly outcome_code: string | null;
  readonly settled_at_ms: number | string;
}

export class FactoryReleaseOutcomeDelivery {
  readonly tenantId: string;

  constructor(private readonly options: FactoryReleaseOutcomeDeliveryOptions) {
    assertFactoryIdentity(options.tenantId);
    if (options.service.tenantId !== options.tenantId) throw new FactoryReleaseOutcomeDeliveryError("factory_release_outcome_invalid");
    this.tenantId = options.tenantId;
  }

  /**
   * Settled operations of this tenant whose event does not exist yet.
   *
   * Only operations a protected command prepared are returned, because only
   * those have a Release node waiting. A release prepared through the direct
   * API answers no run. A run that already ended waits for nothing either.
   */
  async undelivered(limit = FACTORY_RELEASE_OUTCOME_SCAN_LIMIT): Promise<readonly FactoryUndeliveredReleaseOutcome[]> {
    const found = rows<{ project_id: string; operation_id: string }>(await this.options.database.execute(sql`
      SELECT o.project_id, o.operation_id FROM factory_release_operations o
      JOIN factory_run_lifecycle r ON r.tenant_id=o.tenant_id AND r.project_id=o.project_id AND r.run_id=o.run_id
      WHERE o.tenant_id=${this.tenantId} AND o.state IN ('succeeded','failed')
        -- W09e: a stopped release's node already has its stop; its outcome is evidence, never a node event.
        AND o.stop_command_id IS NULL
        AND r.status NOT IN ('succeeded','failed','cancelled')
        AND EXISTS (SELECT 1 FROM factory_protected_command_effects p WHERE p.tenant_id=o.tenant_id AND p.project_id=o.project_id AND p.run_id=o.run_id AND p.kind='request-release' AND p.receipt_json LIKE '%"operationId":"' || o.operation_id || '"%')
        AND NOT EXISTS (SELECT 1 FROM factory_inbox_events e WHERE e.tenant_id=o.tenant_id AND e.project_id=o.project_id AND e.run_id=o.run_id AND e.event_id='release-outcome:' || o.operation_id)
      ORDER BY o.updated_at, o.operation_id LIMIT ${limit}`));
    return found.map(row => Object.freeze({ projectId: row.project_id, operationId: row.operation_id }));
  }

  /** Delivers one operation's outcome in its own transaction. */
  deliver(projectId: string, operationId: string): Promise<KernelEvent | null> {
    return this.options.database.transaction(transaction => this.deliverInTransaction(transaction, projectId, operationId));
  }

  /**
   * The event for one settled operation, enqueued, or `null` when it has none.
   *
   * The operation row is read under a share lock, so a settlement cannot move
   * under the event built from it.
   */
  async deliverInTransaction(transaction: MigrationDb, projectId: string, operationId: string): Promise<KernelEvent | null> {
    assertFactoryIdentity(projectId, operationId);
    const row = rows<SettledRow & { stop_command_id: string | null }>(await transaction.execute(sql`SELECT run_id,state,request_digest,receipt_json,outcome_code,stop_command_id,
      FLOOR(EXTRACT(EPOCH FROM updated_at) * 1000)::bigint AS settled_at_ms
      FROM factory_release_operations WHERE tenant_id=${this.tenantId} AND project_id=${projectId} AND operation_id=${operationId} FOR SHARE`))[0];
    if (!row) throw new FactoryReleaseOutcomeDeliveryError("factory_release_outcome_missing");
    // W09e R4: the node of a stopped release already has its stop. What the release did later is evidence on the
    // release record, never the node's status.
    if (row.stop_command_id !== null) throw new FactoryReleaseOutcomeDeliveryError("factory_release_stopped");
    if (row.state !== "succeeded" && row.state !== "failed") return null;
    const reference = await this.options.effects.readReleaseCommandInTransaction(transaction, {
      tenantId: this.tenantId, projectId, runId: row.run_id, operationId, requestDigest: row.request_digest,
    });
    if (!reference) throw new FactoryReleaseOutcomeDeliveryError("factory_release_outcome_command_missing");
    return this.options.authority.withCurrentReleaseInTransaction(transaction, this.options.service, reference, async (tx, context) => {
      const base = {
        id: factoryReleaseOutcomeEventId(operationId), atMs: Number(row.settled_at_ms),
        nodeId: context.command.nodeId, commandId: context.command.id, candidateGeneration: context.command.candidateGeneration, attempt: context.attempt.attempt,
      };
      let event: KernelEvent;
      if (row.state === "succeeded") {
        const output = { receipt: JSON.parse(row.receipt_json ?? "null") as JsonValue };
        if (!validateNodeOutput(context.node, output)) throw new FactoryReleaseOutcomeDeliveryError("factory_release_outcome_invalid");
        event = { kind: "node-result", ...base, output };
      } else {
        event = { kind: "node-failed", ...base, error: row.outcome_code ?? "factory_release_failed", failureKind: "execution" };
      }
      await this.options.inbox.enqueueInTransaction(tx, { projectId, runId: reference.logicalRunId, interpreterId: reference.interpreterId }, event);
      return event;
    });
  }
}
