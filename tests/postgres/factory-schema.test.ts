import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getTableName, is, SQL, sql } from "drizzle-orm";
import { getTableConfig, PgDialect, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../../src/db/schema";
import { releaseRows } from "../../src/db/queries/extension-releases";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

const models = Object.values(schema).flatMap(value => is(value, PgTable) && getTableName(value).startsWith("factory_") ? [getTableConfig(value)] : []);
const dialect = new PgDialect();
const postgresType = (type: string) => type === "timestamp with time zone" || type === "timestamptz" ? "timestamp with time zone" : type;
const normalizeDefault = (value: string) => value.replace(/::[a-z ]+$/u, "").replace(/^\((.*)\)$/u, "$1");

const expectedIndexes = ["idx_factory_command_outbox_ready", "idx_factory_executions_run", "idx_factory_execution_operations_cursor", "idx_factory_inbox_pending", "factory_budget_root", "idx_factory_run_lifecycle_list", "idx_factory_projection_attempts_pending", "uq_factory_validator_assignment_attempt_claim"];

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
    expect([...actual.keys()].sort()).toEqual(models.map(model => model.name).sort());
    for (const model of models) {
      expect([...actual.get(model.name)!.keys()].sort()).toEqual(model.columns.map(column => column.name).sort());
      for (const column of model.columns) {
        const value = actual.get(model.name)!.get(column.name)!;
        expect(value.type).toBe(postgresType(column.getSQLType()));
        expect(value.nullable).toBe(!column.notNull);
        if (column.default === undefined) expect(value.default).toBeNull();
        else {
          const expected = is(column.default, SQL) ? dialect.sqlToQuery(column.default).sql : typeof column.default === "string" ? `'${column.default.replaceAll("'", "''")}'` : String(column.default);
          const actualDefault = normalizeDefault(value.default!);
          expect(typeof column.default === "number" ? actualDefault.replace(/^'(-?\d+)'$/u, "$1") : actualDefault).toBe(normalizeDefault(expected));
        }
      }
    }
  });

  test("Factory migrations retain primary, unique, foreign, and partial-index facts", async () => {
    const constraints = releaseRows<{ table_name: string; contype: string; definition: string }>(await fixture.db.execute(sql`SELECT rel.relname AS table_name, con.contype, pg_get_constraintdef(con.oid) AS definition FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid WHERE rel.relname LIKE 'factory_%'`));
    const byTable = new Map<string, Array<{ type: string; definition: string }>>();
    for (const row of constraints) byTable.set(row.table_name, [...(byTable.get(row.table_name) ?? []), { type: row.contype, definition: row.definition }]);
    for (const model of models) {
      expect(byTable.get(model.name)?.some(({ type }) => type === "p")).toBe(true);
      const foreignKeys = byTable.get(model.name)?.filter(({ type }) => type === "f") ?? [];
      expect({ table: model.name, foreignKeys: foreignKeys.length }).toEqual({ table: model.name, foreignKeys: model.foreignKeys.length });
      for (const key of model.foreignKeys) {
        const reference = key.reference();
        const definition = `FOREIGN KEY (${reference.columns.map(column => column.name).join(", ")}) REFERENCES ${getTableName(reference.foreignTable)}(${reference.foreignColumns.map(column => column.name).join(", ")})`;
        const expected = `${definition}${key.onDelete && key.onDelete !== "no action" ? ` ON DELETE ${key.onDelete.toUpperCase()}` : ""}`;
        expect({ table: model.name, found: foreignKeys.some(value => value.definition === expected) }).toEqual({ table: model.name, found: true });
      }
    }
    expect(byTable.get("factory_execution_operations")?.some(({ type, definition }) => type === "f" && definition.includes("ON DELETE CASCADE"))).toBe(true);
    const indexRows = releaseRows<{ indexname: string; indexdef: string }>(await fixture.db.execute(sql`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename LIKE 'factory_%'`));
    for (const name of expectedIndexes) expect(indexRows.some((row) => row.indexname === name)).toBe(true);
    expect(indexRows.find((row) => row.indexname === "idx_factory_inbox_pending")?.indexdef).toContain("WHERE (applied_source_sequence IS NULL)");
    expect(indexRows.find((row) => row.indexname === "factory_budget_root")?.indexdef).toContain("WHERE (parent_id IS NULL)");
  });
});
