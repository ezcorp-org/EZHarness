import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** Durable host-owned sandbox state. Provider-specific state stays behind the adapter. */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`CREATE TABLE IF NOT EXISTS sandbox_bindings (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    provider_installation_id TEXT NOT NULL,
    provider_release_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    resource_key TEXT,
    desired_state TEXT NOT NULL CHECK (desired_state IN ('ABSENT', 'STOPPED', 'RUNNING')),
    observed_state TEXT NOT NULL CHECK (observed_state IN ('UNKNOWN', 'ABSENT', 'STOPPED', 'RUNNING', 'ERROR')),
    generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
    current_operation_id TEXT,
    tombstoned_at TIMESTAMPTZ,
    cleanup_confirmed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (project_id)
  )`);
  await database.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_sandbox_bindings_provider_resource
    ON sandbox_bindings(provider_installation_id, connection_id, resource_key)
    WHERE resource_key IS NOT NULL`);
  await database.execute(sql`CREATE INDEX IF NOT EXISTS idx_sandbox_bindings_cleanup
    ON sandbox_bindings(tombstoned_at)
    WHERE tombstoned_at IS NOT NULL AND cleanup_confirmed_at IS NULL`);

  await database.execute(sql`CREATE TABLE IF NOT EXISTS provider_sandbox_operations (
    id TEXT PRIMARY KEY,
    binding_id TEXT NOT NULL REFERENCES sandbox_bindings(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind IN ('CREATE', 'START', 'STOP', 'DESTROY')),
    generation INTEGER NOT NULL CHECK (generation > 0),
    idempotency_scope TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    request_payload JSONB NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('JOURNALED', 'DISPATCHING', 'PROVIDER_PENDING', 'SUCCEEDED', 'FAILED', 'OUTCOME_UNKNOWN')),
    provider_operation_id TEXT,
    error_code TEXT,
    error_message TEXT,
    reconcile_order BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT idx_provider_sandbox_operations_idempotency
      UNIQUE (binding_id, idempotency_scope, idempotency_key)
  )`);
  await database.execute(sql`CREATE INDEX IF NOT EXISTS idx_provider_sandbox_operations_reconcile
    ON provider_sandbox_operations(state, created_at)`);
  await database.execute(sql`ALTER TABLE sandbox_bindings ADD COLUMN IF NOT EXISTS current_operation_id TEXT`);
  await database.execute(sql`ALTER TABLE provider_sandbox_operations ADD COLUMN IF NOT EXISTS reconcile_order BIGINT`);
  await database.execute(sql`CREATE SEQUENCE IF NOT EXISTS sandbox_reconcile_order_seq`);
  await database.execute(sql`CREATE INDEX IF NOT EXISTS idx_provider_sandbox_operations_reconcile_order
    ON provider_sandbox_operations(state, reconcile_order)`);
  // Older databases gained this column after operations had already been
  // journaled. Recover the active intent before reconciliation can settle it.
  await database.execute(sql`UPDATE sandbox_bindings AS binding
    SET current_operation_id = (
      SELECT operation.id FROM provider_sandbox_operations AS operation
      WHERE operation.binding_id = binding.id AND operation.generation = binding.generation
      ORDER BY
        CASE WHEN binding.tombstoned_at IS NOT NULL AND operation.kind = 'DESTROY' THEN 1 ELSE 0 END DESC,
        operation.created_at DESC,
        operation.id DESC
      LIMIT 1
    )
    WHERE binding.current_operation_id IS NULL
      AND EXISTS (
        SELECT 1 FROM provider_sandbox_operations AS operation
        WHERE operation.binding_id = binding.id AND operation.generation = binding.generation
      )`);

  await database.execute(sql`CREATE TABLE IF NOT EXISTS sandbox_host_capacities (
    provider_installation_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    allocatable_memory_bytes BIGINT NOT NULL,
    allocatable_cpu_millicores BIGINT NOT NULL,
    allocatable_pids BIGINT NOT NULL,
    allocatable_disk_bytes BIGINT NOT NULL,
    allocatable_execution_slots BIGINT NOT NULL,
    safety_memory_bytes BIGINT NOT NULL,
    safety_cpu_millicores BIGINT NOT NULL,
    safety_pids BIGINT NOT NULL,
    safety_disk_bytes BIGINT NOT NULL,
    safety_execution_slots BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (provider_installation_id, connection_id),
    CHECK (allocatable_memory_bytes > 0 AND allocatable_memory_bytes <= 9007199254740991),
    CHECK (allocatable_cpu_millicores > 0 AND allocatable_cpu_millicores <= 9007199254740991),
    CHECK (allocatable_pids > 0 AND allocatable_pids <= 9007199254740991),
    CHECK (allocatable_disk_bytes > 0 AND allocatable_disk_bytes <= 9007199254740991),
    CHECK (allocatable_execution_slots > 0 AND allocatable_execution_slots <= 9007199254740991),
    CHECK (safety_memory_bytes >= 0 AND safety_memory_bytes < allocatable_memory_bytes),
    CHECK (safety_cpu_millicores >= 0 AND safety_cpu_millicores < allocatable_cpu_millicores),
    CHECK (safety_pids >= 0 AND safety_pids < allocatable_pids),
    CHECK (safety_disk_bytes >= 0 AND safety_disk_bytes < allocatable_disk_bytes),
    CHECK (safety_execution_slots >= 0 AND safety_execution_slots < allocatable_execution_slots)
  )`);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS sandbox_project_quotas (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    provider_installation_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    memory_bytes BIGINT NOT NULL CHECK (memory_bytes > 0 AND memory_bytes <= 9007199254740991),
    cpu_millicores BIGINT NOT NULL CHECK (cpu_millicores > 0 AND cpu_millicores <= 9007199254740991),
    pids BIGINT NOT NULL CHECK (pids > 0 AND pids <= 9007199254740991),
    disk_bytes BIGINT NOT NULL CHECK (disk_bytes > 0 AND disk_bytes <= 9007199254740991),
    execution_slots BIGINT NOT NULL CHECK (execution_slots > 0 AND execution_slots <= 9007199254740991),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (provider_installation_id, connection_id)
      REFERENCES sandbox_host_capacities(provider_installation_id, connection_id) ON DELETE RESTRICT
  )`);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS sandbox_reservations (
    binding_id TEXT PRIMARY KEY REFERENCES sandbox_bindings(id) ON DELETE RESTRICT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    provider_installation_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    memory_bytes BIGINT NOT NULL CHECK (memory_bytes > 0 AND memory_bytes <= 9007199254740991),
    cpu_millicores BIGINT NOT NULL CHECK (cpu_millicores > 0 AND cpu_millicores <= 9007199254740991),
    pids BIGINT NOT NULL CHECK (pids > 0 AND pids <= 9007199254740991),
    disk_bytes BIGINT NOT NULL CHECK (disk_bytes > 0 AND disk_bytes <= 9007199254740991),
    execution_slots BIGINT NOT NULL CHECK (execution_slots > 0 AND execution_slots <= 9007199254740991),
    compute_state TEXT NOT NULL CHECK (compute_state IN ('RESERVED', 'RELEASE_REQUESTED', 'RELEASED')),
    disk_state TEXT NOT NULL CHECK (disk_state IN ('RESERVED', 'RELEASE_REQUESTED', 'RELEASED')),
    stop_intent_id TEXT,
    cleanup_intent_id TEXT,
    stop_requested_at TIMESTAMPTZ,
    cleanup_requested_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (provider_installation_id, connection_id)
      REFERENCES sandbox_host_capacities(provider_installation_id, connection_id) ON DELETE RESTRICT
  )`);
  await database.execute(sql`CREATE INDEX IF NOT EXISTS idx_sandbox_reservations_host
    ON sandbox_reservations(provider_installation_id, connection_id)`);
  await database.execute(sql`CREATE INDEX IF NOT EXISTS idx_sandbox_reservations_project
    ON sandbox_reservations(project_id)`);
  await database.execute(sql`ALTER TABLE sandbox_reservations ADD COLUMN IF NOT EXISTS stop_intent_id TEXT`);
  await database.execute(sql`ALTER TABLE sandbox_reservations ADD COLUMN IF NOT EXISTS cleanup_intent_id TEXT`);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS sandbox_admission_requests (
    id TEXT PRIMARY KEY,
    binding_id TEXT NOT NULL REFERENCES sandbox_bindings(id) ON DELETE RESTRICT,
    generation INTEGER NOT NULL CHECK (generation > 0),
    kind TEXT NOT NULL CHECK (kind IN ('CREATE', 'START')),
    idempotency_scope TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    memory_bytes BIGINT NOT NULL CHECK (memory_bytes > 0 AND memory_bytes <= 9007199254740991),
    cpu_millicores BIGINT NOT NULL CHECK (cpu_millicores > 0 AND cpu_millicores <= 9007199254740991),
    pids BIGINT NOT NULL CHECK (pids > 0 AND pids <= 9007199254740991),
    disk_bytes BIGINT NOT NULL CHECK (disk_bytes > 0 AND disk_bytes <= 9007199254740991),
    execution_slots BIGINT NOT NULL CHECK (execution_slots > 0 AND execution_slots <= 9007199254740991),
    state TEXT NOT NULL CHECK (state IN ('ADMITTED', 'QUEUED', 'REJECTED')),
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT idx_sandbox_admission_idempotency
      UNIQUE (binding_id, idempotency_scope, idempotency_key),
    CHECK ((state = 'ADMITTED' AND reason IS NULL) OR (state <> 'ADMITTED' AND reason IS NOT NULL))
  )`);
  await database.execute(sql`CREATE INDEX IF NOT EXISTS idx_sandbox_admission_queue
    ON sandbox_admission_requests(state, created_at)`);
}
