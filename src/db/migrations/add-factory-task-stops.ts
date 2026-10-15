import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/**
 * Sealed cancellation acceptance, uncertain stop, and host-confirmed stop facts.
 *
 * `attempt_command_id` is nullable because a live cancellation derives its
 * authority from the sealed compute admission plus the durable launch record,
 * not from a terminal outcome. The composite foreign key to
 * `factory_task_outcomes` is MATCH SIMPLE, so PostgreSQL skips it when any
 * column is NULL; `source` records which authority produced the row, and the
 * paired CHECK keeps a `terminal-outcome` stop bound to its outcome command.
 *
 * Every constraint is named, so a fresh database and an upgraded one carry the
 * same catalog entries rather than generated names that differ by path.
 */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_task_stops (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL, interpreter_id TEXT NOT NULL,
    cancel_command_id TEXT NOT NULL, attempt_command_id TEXT, attempt_id TEXT NOT NULL, reservation_id TEXT NOT NULL,
    request_json TEXT NOT NULL, request_digest TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'terminal-outcome',
    state TEXT NOT NULL,
    uncertain_event_json TEXT, uncertain_event_digest TEXT,
    stop_receipt_json TEXT, stop_receipt_digest TEXT,
    stopped_event_json TEXT, stopped_event_digest TEXT,
    accepted_at_ms BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT factory_task_stops_pkey PRIMARY KEY (tenant_id,project_id,run_id,interpreter_id,cancel_command_id),
    CONSTRAINT factory_task_stops_attempt_id_key UNIQUE (attempt_id),
    CONSTRAINT factory_task_stops_execution_fk FOREIGN KEY (attempt_id,tenant_id,project_id,run_id) REFERENCES factory_executions(attempt_id,tenant_id,project_id,run_id) ON DELETE RESTRICT,
    CONSTRAINT factory_task_stops_launch_fk FOREIGN KEY (attempt_id) REFERENCES factory_attempt_launches(attempt_id) ON DELETE RESTRICT,
    CONSTRAINT factory_task_stops_outcome_fk FOREIGN KEY (tenant_id,project_id,run_id,interpreter_id,attempt_command_id) REFERENCES factory_task_outcomes(tenant_id,project_id,run_id,interpreter_id,command_id) ON DELETE RESTRICT,
    CONSTRAINT factory_task_stops_command_fk FOREIGN KEY (tenant_id,project_id,run_id,interpreter_id,cancel_command_id) REFERENCES factory_transition_commands(tenant_id,project_id,run_id,interpreter_id,command_id) ON DELETE RESTRICT,
    CONSTRAINT factory_task_stops_request_digest_check CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT factory_task_stops_source_check CHECK (source IN ('terminal-outcome','sealed-launch')),
    CONSTRAINT factory_task_stops_state_check CHECK (state IN ('accepted','uncertain','stopped')),
    CONSTRAINT factory_task_stops_accepted_at_ms_check CHECK (accepted_at_ms >= 0),
    CONSTRAINT factory_task_stops_uncertain_event_digest_check CHECK (uncertain_event_digest IS NULL OR uncertain_event_digest ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT factory_task_stops_stop_receipt_digest_check CHECK (stop_receipt_digest IS NULL OR stop_receipt_digest ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT factory_task_stops_stopped_event_digest_check CHECK (stopped_event_digest IS NULL OR stopped_event_digest ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT factory_task_stops_outcome_source_check CHECK (source <> 'terminal-outcome' OR attempt_command_id IS NOT NULL),
    CONSTRAINT factory_task_stops_accepted_state_check CHECK ((state = 'accepted') = (uncertain_event_json IS NULL AND uncertain_event_digest IS NULL AND stop_receipt_json IS NULL AND stop_receipt_digest IS NULL AND stopped_event_json IS NULL AND stopped_event_digest IS NULL)),
    CONSTRAINT factory_task_stops_uncertain_pair_check CHECK ((uncertain_event_json IS NULL) = (uncertain_event_digest IS NULL)),
    CONSTRAINT factory_task_stops_receipt_pair_check CHECK ((stop_receipt_json IS NULL) = (stop_receipt_digest IS NULL)),
    CONSTRAINT factory_task_stops_stopped_pair_check CHECK ((stopped_event_json IS NULL) = (stopped_event_digest IS NULL)),
    CONSTRAINT factory_task_stops_stopped_state_check CHECK ((state = 'stopped') = (stop_receipt_json IS NOT NULL AND stopped_event_json IS NOT NULL))
  )`);
}
