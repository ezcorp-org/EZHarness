import type { KernelEvent } from "@ezcorp/factory-sdk/kernel-types";
import { sql } from "drizzle-orm";
import type { MigrationDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import type { FactoryInbox } from "./inbox";
import { assertFactoryIdentity } from "./records";

/**
 * W15f: a signed restore's proven end for the attempts of the epoch it left.
 *
 * After a restore the installation runs in a new execution epoch, and an
 * old-epoch attempt's authority can never pass the run fence again. The signing
 * transaction therefore supersedes every such attempt that was still live: its
 * execution row becomes `superseded` (terminal), and one record here keeps the
 * restore and its signed report digest as the proof, both epochs, the
 * reservation and interpreter the attempt's dispatch named, and the kernel event
 * that tells the run the attempt ended with its cost still unknown. The restore
 * enqueues that event; a settlement that later prices the attempt re-sends it
 * with the uncertainty cleared, exactly as a sealed stop's is re-sent.
 */

type AttemptStopped = Extract<KernelEvent, { readonly kind: "attempt-stopped" }>;

/** Execution states an attempt can still act in. Everything else is terminal. */
export const FACTORY_LIVE_EXECUTION_STATUSES = ["admitted", "running", "cancel_accepted"] as const;

export interface FactoryAttemptSupersession {
  readonly projectId: string;
  readonly runId: string;
  readonly attemptId: string;
  /** Null when the attempt's dispatch named no interpreter; there is then no kernel event. */
  readonly interpreterId: string | null;
  readonly restoreId: string;
  readonly restoreDigest: string;
  readonly event: AttemptStopped | null;
}

function counter(value: number, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error("factory_supersession_invalid");
}

/**
 * Supersedes, inside the caller's transaction, every live attempt of
 * `previousEpoch`. Returns how many. The caller is the restore's signing
 * transaction, so the attempts end in the same commit that moves the runs.
 */
export async function supersedeEpochAttemptsInTransaction(
  transaction: MigrationDb,
  inbox: Pick<FactoryInbox, "enqueueInTransaction">,
  input: { readonly tenantId: string; readonly previousEpoch: number; readonly executionEpoch: number; readonly restoreId: string; readonly restoreDigest: string; readonly atMs: number },
): Promise<number> {
  assertFactoryIdentity(input.tenantId, input.restoreId);
  counter(input.previousEpoch, 1);
  counter(input.atMs);
  if (!Number.isSafeInteger(input.executionEpoch) || input.executionEpoch <= input.previousEpoch || !/^sha256:[0-9a-f]{64}$/.test(input.restoreDigest)) throw new Error("factory_supersession_invalid");
  // The queue stores its reference as JSONB, which a real server can hold as a
  // JSON string (the queue unwraps it the same way when it reads it back).
  const reference = sql`(CASE WHEN jsonb_typeof(queue.reference_json) = 'string' THEN (queue.reference_json #>> '{}')::jsonb ELSE queue.reference_json END)`;
  const live = rows<{ attempt_id: string; project_id: string; run_id: string; node_instance_id: string; candidate_generation: number | string; attempt_number: number | string; reservation_id: string | null; interpreter_id: string | null }>(await transaction.execute(sql`
    SELECT execution.attempt_id, execution.project_id, execution.run_id, execution.node_instance_id, execution.candidate_generation, execution.attempt_number,
      COALESCE(launch.reservation_id, ${reference}->>'reservationId') AS reservation_id,
      ${reference}->'command'->>'interpreterId' AS interpreter_id
    FROM factory_executions execution
    LEFT JOIN factory_attempt_queue queue ON queue.tenant_id = execution.tenant_id AND queue.project_id = execution.project_id AND queue.attempt_id = execution.attempt_id
    LEFT JOIN factory_attempt_launches launch ON launch.attempt_id = execution.attempt_id
    WHERE execution.tenant_id = ${input.tenantId} AND execution.execution_epoch = ${input.previousEpoch}
      AND execution.status IN (${sql.join(FACTORY_LIVE_EXECUTION_STATUSES.map(status => sql`${status}`), sql`, `)})
    ORDER BY execution.attempt_id
    FOR UPDATE OF execution`));
  for (const attempt of live) {
    const event: AttemptStopped | null = attempt.interpreter_id === null ? null : Object.freeze({
      kind: "attempt-stopped", id: `${input.restoreId}:${attempt.attempt_id}:superseded`, atMs: input.atMs,
      nodeId: attempt.node_instance_id, commandId: attempt.attempt_id,
      candidateGeneration: Number(attempt.candidate_generation), attempt: Number(attempt.attempt_number), uncertain: true,
    });
    await transaction.execute(sql`UPDATE factory_executions SET status = 'superseded', updated_at = NOW() WHERE tenant_id = ${input.tenantId} AND attempt_id = ${attempt.attempt_id}`);
    // The event is built in SQL from typed values: a JSON text parameter can
    // reach a real server as a JSON string rather than an object.
    const eventJson = event === null ? sql`NULL` : sql`jsonb_build_object('kind', ${event.kind}::text, 'id', ${event.id}::text, 'atMs', ${event.atMs}::bigint,
      'nodeId', ${event.nodeId}::text, 'commandId', ${event.commandId}::text, 'candidateGeneration', ${event.candidateGeneration}::bigint, 'attempt', ${event.attempt}::bigint, 'uncertain', true)`;
    await transaction.execute(sql`INSERT INTO factory_attempt_supersessions (tenant_id, project_id, run_id, attempt_id, reservation_id, interpreter_id, superseded_epoch, execution_epoch, restore_id, restore_digest, event_json, superseded_at_ms)
      VALUES (${input.tenantId}, ${attempt.project_id}, ${attempt.run_id}, ${attempt.attempt_id}, ${attempt.reservation_id}, ${attempt.interpreter_id}, ${input.previousEpoch}, ${input.executionEpoch}, ${input.restoreId}, ${input.restoreDigest},
        ${eventJson}, ${input.atMs})`);
    if (event !== null) await inbox.enqueueInTransaction(transaction, { projectId: attempt.project_id, runId: attempt.run_id, interpreterId: attempt.interpreter_id! }, event);
  }
  return live.length;
}

/**
 * The supersession of the attempt that held `reservationId`, or undefined. A
 * bound settlement reads it as the attempt's proven end when there is no sealed
 * stop.
 */
export async function readAttemptSupersessionInTransaction(transaction: MigrationDb, tenantId: string, reservationId: string): Promise<FactoryAttemptSupersession | undefined> {
  assertFactoryIdentity(tenantId, reservationId);
  const row = rows<{ project_id: string; run_id: string; attempt_id: string; interpreter_id: string | null; restore_id: string; restore_digest: string; event_json: AttemptStopped | string | null }>(await transaction.execute(sql`
    SELECT project_id, run_id, attempt_id, interpreter_id, restore_id, restore_digest, event_json FROM factory_attempt_supersessions
    WHERE tenant_id = ${tenantId} AND reservation_id = ${reservationId} ORDER BY superseded_at_ms DESC, attempt_id LIMIT 1 FOR SHARE`))[0];
  if (!row) return undefined;
  const event = typeof row.event_json === "string" ? JSON.parse(row.event_json) as AttemptStopped : row.event_json;
  return Object.freeze({ projectId: row.project_id, runId: row.run_id, attemptId: row.attempt_id, interpreterId: row.interpreter_id, restoreId: row.restore_id, restoreDigest: row.restore_digest, event });
}

/**
 * Re-sends a supersession's kernel event with its uncertainty cleared, once the
 * attempt's cost is settled. Returns the event, or undefined when no
 * supersession with a kernel event holds the reservation.
 */
export async function clearResolvedSupersessionInTransaction(
  transaction: MigrationDb,
  inbox: Pick<FactoryInbox, "enqueueInTransaction">,
  tenantId: string,
  reservationId: string,
  atMs: number,
): Promise<AttemptStopped | undefined> {
  counter(atMs);
  const supersession = await readAttemptSupersessionInTransaction(transaction, tenantId, reservationId);
  if (!supersession?.event || supersession.interpreterId === null) return undefined;
  const event: AttemptStopped = Object.freeze({ ...supersession.event, id: `${supersession.restoreId}:${supersession.attemptId}:usage-resolved`, atMs, uncertain: false });
  await inbox.enqueueInTransaction(transaction, { projectId: supersession.projectId, runId: supersession.runId, interpreterId: supersession.interpreterId }, event);
  return event;
}
