/**
 * Puts a factory database into each C11 alert condition (W4H-34).
 *
 * The collector test and the live evaluator leg both force conditions through
 * these functions, so the condition an alert is proven against is the one the
 * collector is tested on. Each writes the rows that define the condition and
 * nothing else; the parents those rows reference (runs, audit batches,
 * attempts) are not under test, so the writes run with replication-role
 * triggers off. Every CHECK constraint still applies, so each row is one the
 * product could hold.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { TransactionalDb } from "../../db/migrations/types";

export const METRIC_TENANT = "metrics-tenant";
export const METRIC_PROJECT = "metrics-project";
export const METRIC_BUILD = "interpreter-current";

const DIGEST = `sha256:${"a".repeat(64)}`;
const HEX = "b".repeat(64);

/** Milliseconds `ageMs` before `now`, as a timestamp the database compares. */
function at(now: number, ageMs: number) {
  return sql`to_timestamp(${(now - ageMs) / 1000})`;
}

async function unguarded(database: TransactionalDb, work: (execute: (query: ReturnType<typeof sql>) => Promise<unknown>) => Promise<void>): Promise<void> {
  await database.transaction(async (transaction) => {
    await transaction.execute(sql`SET LOCAL session_replication_role = replica`);
    await work((query) => transaction.execute(query));
  });
}

export async function seedMetricInstallation(database: TransactionalDb): Promise<void> {
  await database.execute(sql`INSERT INTO factory_installation(singleton,tenant_id,execution_epoch) VALUES (1,${METRIC_TENANT},1) ON CONFLICT DO NOTHING`);
  await database.execute(sql`INSERT INTO projects(id,name,path) VALUES (${METRIC_PROJECT},'Metrics',${`/tmp/${METRIC_PROJECT}`}) ON CONFLICT DO NOTHING`);
  await database.execute(sql`INSERT INTO factory_projects(tenant_id,project_id) VALUES (${METRIC_TENANT},${METRIC_PROJECT}) ON CONFLICT DO NOTHING`);
}

/** A run with its lifecycle status and build; returns the run ID. */
export async function forceRun(database: TransactionalDb, now: number, options: { status: string; updatedAgeMs?: number; build?: string }): Promise<string> {
  const runId = `run-${randomUUID()}`;
  await unguarded(database, async (execute) => {
    await execute(sql`INSERT INTO factory_runs (tenant_id,project_id,run_id,definition_digest,interpreter_build,execution_epoch,request_digest,request_payload)
      VALUES (${METRIC_TENANT},${METRIC_PROJECT},${runId},${DIGEST},${options.build ?? METRIC_BUILD},1,'request','{}')`);
    await execute(sql`INSERT INTO factory_run_lifecycle (tenant_id,project_id,run_id,factory_id,factory_version,definition_digest,grant_revision,status,deadline_ms,parameters_json,parameters_digest,created_at,updated_at)
      VALUES (${METRIC_TENANT},${METRIC_PROJECT},${runId},'factory','1',${DIGEST},1,${options.status},${now + 3_600_000},'{}',${DIGEST},${at(now, options.updatedAgeMs ?? 0)},${at(now, options.updatedAgeMs ?? 0)})`);
  });
  return runId;
}

/** A ready attempt that has waited `ageMs`, optionally held on its runner package. */
export async function forceReadyWork(database: TransactionalDb, now: number, ageMs: number, failureCode?: string): Promise<void> {
  await unguarded(database, (execute) => execute(sql`INSERT INTO factory_attempt_queue (tenant_id,project_id,attempt_id,run_id,deduplication_id,input_hash,state,max_attempts,available_at,failure_code,reference_json)
    VALUES (${METRIC_TENANT},${METRIC_PROJECT},${randomUUID()},'run-q',${randomUUID()},${DIGEST},'queued',3,${now - ageMs},${failureCode ?? null},'{}'::jsonb)`).then(() => undefined));
}

/** One attempt launch for `runId` in `state`, last updated `ageMs` ago, with an optional terminal status. */
export async function forceAttempt(database: TransactionalDb, now: number, runId: string, state: string, options: { ageMs?: number; terminalStatus?: string; attemptId?: string } = {}): Promise<string> {
  const attemptId = options.attemptId ?? randomUUID();
  const terminal = options.terminalStatus === undefined ? null : JSON.stringify({ status: options.terminalStatus });
  await unguarded(database, (execute) => execute(sql`INSERT INTO factory_attempt_launches (attempt_id,tenant_id,project_id,run_id,request_digest,request_json,reservation_id,grant_revision,allocation_generation,holder_generation,allocation_token,host_id,package_receipt_digest,package_receipt_json,artifact_digest,worker_id,invocation_id,state,terminal_result_json,terminal_result_digest,created_at,updated_at)
    VALUES (${attemptId},${METRIC_TENANT},${METRIC_PROJECT},${runId},${HEX},'{}'::jsonb,${randomUUID()},1,1,1,'token','host-1',${DIGEST},'{}'::jsonb,${HEX},${randomUUID()},${randomUUID()},${state},${terminal}::jsonb,${terminal === null ? null : DIGEST},${at(now, options.ageMs ?? 0)},${at(now, options.ageMs ?? 0)})`).then(() => undefined));
  return attemptId;
}

export async function forceAdmission(database: TransactionalDb, state: string): Promise<void> {
  await unguarded(database, (execute) => execute(sql`INSERT INTO factory_compute_admissions (tenant_id,project_id,run_id,reservation_id,request_digest,request_json,state,next_poll_at)
    VALUES (${METRIC_TENANT},${METRIC_PROJECT},'run-a',${randomUUID()},${DIGEST},'{}',${state},0)`).then(() => undefined));
}

/** An open envelope, exhausted or not, with one reservation in `reservationState`. */
export async function forceBudget(database: TransactionalDb, options: { exhausted: boolean; reservationState: string }): Promise<void> {
  const envelopeId = randomUUID();
  const runId = `run-${randomUUID()}`;
  await unguarded(database, async (execute) => {
    await execute(sql`INSERT INTO factory_budget_envelopes (tenant_id,project_id,run_id,envelope_id,request_digest,limits,allocated,spent,deadline_ms,state,admission_blocked)
      VALUES (${METRIC_TENANT},${METRIC_PROJECT},${runId},${envelopeId},${DIGEST},'{}','{}','{}',1,'open',${options.exhausted})`);
    await execute(sql`INSERT INTO factory_budget_reservations (tenant_id,project_id,run_id,reservation_id,envelope_id,request_digest,amount,state)
      VALUES (${METRIC_TENANT},${METRIC_PROJECT},${runId},${randomUUID()},${envelopeId},${DIGEST},'{}',${options.reservationState})`);
  });
}

/** Audit batches for `runId` up to `sequence`, the oldest `ageMs` old, and the projector's cursor at `projected`. */
export async function forceProjection(database: TransactionalDb, now: number, runId: string, options: { sequence: number; projected: number; ageMs: number; consumerId: string }): Promise<void> {
  await unguarded(database, async (execute) => {
    for (let sequence = 1; sequence <= options.sequence; sequence += 1) {
      await execute(sql`INSERT INTO factory_audit_batches (tenant_id,project_id,run_id,interpreter_id,source_sequence,sequence,digest,payload,created_at)
        VALUES (${METRIC_TENANT},${METRIC_PROJECT},${runId},'root',${sequence},${sequence},${DIGEST},'{}',${at(now, options.ageMs - (sequence - 1))})`);
    }
    // The run's counter, as the records store keeps it: the next sequence to allocate.
    await execute(sql`UPDATE factory_runs SET next_sequence=${options.sequence + 1} WHERE tenant_id=${METRIC_TENANT} AND project_id=${METRIC_PROJECT} AND run_id=${runId}`);
    if (options.projected > 0) {
      await execute(sql`INSERT INTO factory_run_projections (tenant_id,project_id,run_id,consumer_id,sequence,digest,payload)
        VALUES (${METRIC_TENANT},${METRIC_PROJECT},${runId},${options.consumerId},${options.projected},${DIGEST},'{}')`);
    }
  });
}

/** `outcomes` validator attempts for one runner digest, oldest first, each `failed`, `uncertain` or `completed`. */
export async function forceValidatorOutcomes(database: TransactionalDb, now: number, runnerDigestHex: string, outcomes: readonly string[], olderByMs = 0): Promise<void> {
  for (const [index, outcome] of outcomes.entries()) {
    const attemptId = randomUUID();
    await forceAttempt(database, now, "run-v", outcome === "uncertain" ? "uncertain" : "terminal", { attemptId, ageMs: olderByMs + (outcomes.length - index) * 1_000, ...(outcome === "uncertain" ? {} : { terminalStatus: outcome }) });
    await unguarded(database, (execute) => execute(sql`INSERT INTO factory_validator_assignments (tenant_id,project_id,run_id,candidate_node_instance_id,candidate_generation,validator_id,validator_attempt_id,validator_authority_json,definition_digest,validator_lock_digest,candidate_digest,candidate_artifact_id,candidate_artifact_digest,candidate_artifact_bytes,runner_json,runner_digest,environment_digest,configuration_digest,freshness_ms,trust_revision,issuer_grant_revision,assignment_digest)
      VALUES (${METRIC_TENANT},${METRIC_PROJECT},'run-v',${randomUUID()},0,'validator-1',${attemptId},'{}',${DIGEST},${DIGEST},${DIGEST},'artifact-1',${DIGEST},1,'{}',${`sha256:${runnerDigestHex}`},${DIGEST},${DIGEST},1000,1,1,${DIGEST})`).then(() => undefined));
  }
}

/** A release operation in `state`, last updated `ageMs` ago. */
export async function forceRelease(database: TransactionalDb, now: number, state: string, ageMs: number): Promise<void> {
  const resolved = state === "pending" ? sql`NULL,NULL,NULL` : sql`${DIGEST},${DIGEST},1`;
  await unguarded(database, (execute) => execute(sql`INSERT INTO factory_release_operations (tenant_id,project_id,operation_id,run_id,node_instance_id,candidate_generation,candidate_digest,decision_id,contract_digest,execution_epoch,cancellation_epoch,release_enable_epoch,action,destination_provider,destination_account,destination_object,destination_digest,canonical_request,request_digest,material_json,material_digest,estimated_spend_micros,deadline_ms,state,authority_kind,profile_input_digest,profile_result_digest,profile_resolved_at_ms,updated_at)
    VALUES (${METRIC_TENANT},${METRIC_PROJECT},${randomUUID()},'run-r',${randomUUID()},0,${DIGEST},'decision-1',${DIGEST},1,0,1,'publish','s3','account','object',${DIGEST},'{}',${DIGEST},'{}',${DIGEST},0,${now + 3_600_000},${state},'policy',${resolved},${at(now, ageMs)})`).then(() => undefined));
}

/** A sealed checkpoint sealed `ageMs` ago. */
export async function forceCheckpoint(database: TransactionalDb, now: number, ageMs: number): Promise<void> {
  await unguarded(database, (execute) => execute(sql`INSERT INTO factory_checkpoints (tenant_id,checkpoint_id,state,execution_epoch,started_at_ms,duration_ms,product_lsn,manifest_digest,manifest_archive_json,sealed_at)
    VALUES (${METRIC_TENANT},${randomUUID()},'sealed',1,${now - ageMs},0,'0/0',${DIGEST},'{}',${at(now, ageMs)})`).then(() => undefined));
}

/** An outbound notification send in `state`, created `ageMs` ago. Its notification parent is not under test. */
export async function forceSend(database: TransactionalDb, now: number, state: string, ageMs: number): Promise<void> {
  const payload = "{}";
  await unguarded(database, (execute) => execute(sql`INSERT INTO factory_notification_sends (tenant_id,project_id,send_id,notification_id,destination,deduplication_id,input_hash,state,max_attempts,available_at,expires_at,payload,created_at)
    VALUES (${METRIC_TENANT},${METRIC_PROJECT},${randomUUID()},${randomUUID()},'operators',${randomUUID()},${DIGEST},${state},8,${now - ageMs},${now + 3_600_000},${payload},${now - ageMs})`).then(() => undefined));
}
