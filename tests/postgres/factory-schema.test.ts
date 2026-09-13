import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { releaseRows } from "../../src/db/queries/extension-releases";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

const expectedColumns: Record<string, Record<string, { type: string; nullable?: boolean; default?: string }>> = {
  factory_installation: { singleton: { type: "integer" }, tenant_id: { type: "text" }, execution_epoch: { type: "integer", default: "1" } },
  factory_projects: { tenant_id: { type: "text" }, project_id: { type: "text" } },
  factory_runs: { tenant_id: { type: "text" }, project_id: { type: "text" }, run_id: { type: "text" }, definition_digest: { type: "text" }, interpreter_build: { type: "text" }, execution_epoch: { type: "integer" }, request_digest: { type: "text" }, request_payload: { type: "text" }, next_sequence: { type: "bigint", default: "1" }, created_at: { type: "timestamp with time zone", default: "now" } },
  factory_audit_batches: { tenant_id: { type: "text" }, project_id: { type: "text" }, run_id: { type: "text" }, interpreter_id: { type: "text" }, source_sequence: { type: "bigint" }, sequence: { type: "bigint" }, predecessor_digest: { type: "text", nullable: true }, digest: { type: "text" }, payload: { type: "text" }, created_at: { type: "timestamp with time zone", default: "now" } },
  factory_command_outbox: { id: { type: "text" }, tenant_id: { type: "text" }, project_id: { type: "text" }, logical_run_id: { type: "text" }, deduplication_id: { type: "text" }, input_hash: { type: "text" }, state: { type: "text" }, available_at: { type: "bigint" }, lease_until: { type: "bigint", default: "0" }, payload: { type: "text" }, created_at: { type: "timestamp with time zone", default: "now" }, updated_at: { type: "timestamp with time zone", default: "now" } },
  factory_run_projections: { tenant_id: { type: "text" }, project_id: { type: "text" }, run_id: { type: "text" }, consumer_id: { type: "text" }, sequence: { type: "bigint" }, digest: { type: "text" }, payload: { type: "text" }, updated_at: { type: "timestamp with time zone", default: "now" } },
  factory_inbox_cursors: { tenant_id: { type: "text" }, project_id: { type: "text" }, run_id: { type: "text" }, interpreter_id: { type: "text" }, next_sequence: { type: "bigint", default: "1" } },
  factory_inbox_events: { tenant_id: { type: "text" }, project_id: { type: "text" }, run_id: { type: "text" }, interpreter_id: { type: "text" }, sequence: { type: "bigint" }, event_id: { type: "text" }, event_hash: { type: "text" }, kind: { type: "text" }, payload: { type: "text" }, applied_source_sequence: { type: "bigint", nullable: true }, applied_digest: { type: "text", nullable: true } },
  factory_grants: { tenant_id: { type: "text" }, project_id: { type: "text" }, principal_kind: { type: "text" }, principal_id: { type: "text" }, action: { type: "text" }, issuer_id: { type: "text" }, expires_at: { type: "timestamp with time zone", nullable: true }, revision: { type: "bigint" }, revoked_at: { type: "timestamp with time zone", nullable: true }, updated_at: { type: "timestamp with time zone", default: "now" } },
  factory_budget_envelopes: { tenant_id: { type: "text" }, project_id: { type: "text" }, run_id: { type: "text" }, envelope_id: { type: "text" }, parent_id: { type: "text", nullable: true }, request_digest: { type: "text" }, limits: { type: "text" }, allocated: { type: "text" }, spent: { type: "text" }, deadline_ms: { type: "bigint" }, state: { type: "text" }, admission_blocked: { type: "boolean", default: "false" } },
  factory_budget_reservations: { tenant_id: { type: "text" }, project_id: { type: "text" }, run_id: { type: "text" }, reservation_id: { type: "text" }, envelope_id: { type: "text" }, request_digest: { type: "text" }, amount: { type: "text" }, actual: { type: "text", nullable: true }, receipt_digest: { type: "text", nullable: true }, compute_allocation: { type: "text", nullable: true }, uncertainty: { type: "text", nullable: true }, state: { type: "text" } },
  factory_mutation_receipts: { tenant_id: { type: "text" }, project_id: { type: "text" }, principal_kind: { type: "text" }, principal_id: { type: "text" }, idempotency_key: { type: "text" }, input_digest: { type: "text" }, response_json: { type: "text", nullable: true }, response_digest: { type: "text", nullable: true }, created_at: { type: "timestamp with time zone", default: "now" } },
  factory_drafts: { tenant_id: { type: "text" }, project_id: { type: "text" }, factory_id: { type: "text" }, revision: { type: "bigint" }, source_digest: { type: "text" }, source_json: { type: "text" }, archived: { type: "boolean", default: "false" }, created_at: { type: "timestamp with time zone", default: "now" }, updated_at: { type: "timestamp with time zone", default: "now" } },
  factory_versions: { tenant_id: { type: "text" }, project_id: { type: "text" }, factory_id: { type: "text" }, version: { type: "text" }, draft_revision: { type: "bigint" }, definition_digest: { type: "text" }, compiled_blob_digest: { type: "text" }, compiled_bytes: { type: "integer" }, lock_json: { type: "text" }, created_at: { type: "timestamp with time zone", default: "now" } },
  factory_executions: { attempt_id: { type: "text" }, tenant_id: { type: "text" }, project_id: { type: "text" }, run_id: { type: "text" }, node_instance_id: { type: "text" }, candidate_generation: { type: "bigint" }, attempt_number: { type: "bigint" }, grant_revision: { type: "bigint" }, reservation_generation: { type: "bigint" }, execution_epoch: { type: "bigint" }, cancellation_epoch: { type: "bigint", default: "0" }, deadline_at: { type: "timestamp with time zone" }, request_hash: { type: "text" }, request_json: { type: "jsonb" }, operation_initial_index: { type: "bigint", default: "0" }, status: { type: "text" }, journal_cursor: { type: "bigint", default: "-1" }, cancel_accepted_at: { type: "timestamp with time zone", nullable: true }, stopped_at: { type: "timestamp with time zone", nullable: true }, created_at: { type: "timestamp with time zone", default: "now" }, updated_at: { type: "timestamp with time zone", default: "now" } },
  factory_execution_operation_cursors: { tenant_id: { type: "text" }, project_id: { type: "text" }, run_id: { type: "text" }, node_instance_id: { type: "text" }, candidate_generation: { type: "bigint" }, next_operation_index: { type: "bigint", default: "0" } },
  factory_execution_operations: { attempt_id: { type: "text" }, operation_id: { type: "text" }, operation_index: { type: "bigint" }, kind: { type: "text" }, state: { type: "text" }, request_digest: { type: "text" }, provider_receipt_digest: { type: "text", nullable: true }, result_digest: { type: "text", nullable: true }, result_json: { type: "jsonb", nullable: true }, usage_json: { type: "jsonb", nullable: true }, workspace_checkpoint: { type: "jsonb", nullable: true }, created_at: { type: "timestamp with time zone", default: "now" }, updated_at: { type: "timestamp with time zone", default: "now" } },
};

const expectedIndexes = ["idx_factory_command_outbox_ready", "idx_factory_executions_run", "idx_factory_execution_operations_cursor", "idx_factory_inbox_pending", "factory_budget_root"];
const expectedForeignKeys = [
  "factory_projects", "factory_runs", "factory_audit_batches", "factory_command_outbox", "factory_run_projections", "factory_inbox_cursors", "factory_inbox_events", "factory_grants", "factory_budget_envelopes", "factory_budget_reservations", "factory_mutation_receipts", "factory_drafts", "factory_versions", "factory_executions", "factory_execution_operation_cursors",
];

describe("Factory schema PostgreSQL conformance", () => {
  let fixture: Awaited<ReturnType<typeof setupFactoryPostgres>>;

  beforeAll(async () => { fixture = await setupFactoryPostgres(); });
  afterAll(async () => { await fixture?.close(); });

  test("Factory migrations create the modeled columns, PostgreSQL types, nullability, and defaults", async () => {
    const result = releaseRows<Record<string, string | null>>(await fixture.db.execute(sql`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name LIKE 'factory_%' ORDER BY table_name, ordinal_position`));
    const actual = new Map<string, Map<string, { type: string; nullable: boolean; default: string | null }>>();
    for (const row of result) {
      const columns = actual.get(row.table_name!) ?? new Map();
      columns.set(row.column_name!, { type: row.data_type!, nullable: row.is_nullable === "YES", default: row.column_default });
      actual.set(row.table_name!, columns);
    }
    expect([...actual.keys()].sort()).toEqual(Object.keys(expectedColumns).sort());
    for (const [table, columns] of Object.entries(expectedColumns)) {
      expect([...actual.get(table)!.keys()].sort()).toEqual(Object.keys(columns).sort());
      for (const [column, expected] of Object.entries(columns)) {
        const value = actual.get(table)!.get(column)!;
        expect(value.type).toBe(expected.type);
        expect(value.nullable).toBe(expected.nullable === true);
        if (expected.default) expect(value.default).toContain(expected.default);
        else expect(value.default).toBeNull();
      }
    }
  });

  test("Factory migrations retain primary, unique, foreign, and partial-index facts", async () => {
    const constraints = releaseRows<{ table_name: string; contype: string; definition: string }>(await fixture.db.execute(sql`SELECT rel.relname AS table_name, con.contype, pg_get_constraintdef(con.oid) AS definition FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid WHERE rel.relname LIKE 'factory_%'`));
    const byTable = new Map<string, Array<{ type: string; definition: string }>>();
    for (const row of constraints) byTable.set(row.table_name, [...(byTable.get(row.table_name) ?? []), { type: row.contype, definition: row.definition }]);
    for (const table of Object.keys(expectedColumns)) expect(byTable.get(table)?.some(({ type }) => type === "p")).toBe(true);
    for (const table of expectedForeignKeys) expect(byTable.get(table)?.some(({ type, definition }) => type === "f" && definition.includes("ON DELETE RESTRICT"))).toBe(true);
    expect(byTable.get("factory_execution_operations")?.some(({ type, definition }) => type === "f" && definition.includes("ON DELETE CASCADE"))).toBe(true);
    const indexRows = releaseRows<{ indexname: string; indexdef: string }>(await fixture.db.execute(sql`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename LIKE 'factory_%'`));
    for (const name of expectedIndexes) expect(indexRows.some((row) => row.indexname === name)).toBe(true);
    expect(indexRows.find((row) => row.indexname === "idx_factory_inbox_pending")?.indexdef).toContain("WHERE (applied_source_sequence IS NULL)");
    expect(indexRows.find((row) => row.indexname === "factory_budget_root")?.indexdef).toContain("WHERE (parent_id IS NULL)");
  });
});
