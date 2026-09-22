/**
 * The purge precondition: how much work is still active or uncertain.
 *
 * COUNTS ONLY. The operator has infrastructure access, not product access
 * (C01), so this reads aggregate row counts by state from the torn-down
 * tenant's database and nothing else: no identifier, no payload, no person.
 * A purge refuses while any count is non-zero, because deleting the only
 * record of an uncertain effect would turn "we do not know" into "it never
 * happened".
 *
 * A table that does not exist counts zero, so an installation that never
 * migrated a later table is not held open by it.
 */
import { SQL } from "bun";
import type { FactoryInstallationContext } from "./installation";
import type { FactoryWorkCensus } from "./local";

export interface FactoryCensusTable {
  readonly table: string;
  readonly column: "state" | "status";
  readonly active: readonly string[];
  readonly uncertain: readonly string[];
}

/** Every durable state machine whose open rows mean work has not closed. */
export const FACTORY_OPEN_WORK_TABLES: readonly FactoryCensusTable[] = Object.freeze([
  { table: "factory_run_lifecycle", column: "status", active: ["queued", "running", "waiting", "cancelling"], uncertain: ["uncertain"] },
  { table: "factory_attempt_launches", column: "state", active: ["prepared", "launching", "launched"], uncertain: ["uncertain"] },
  { table: "factory_budget_reservations", column: "state", active: ["held", "running"], uncertain: ["uncertain"] },
  { table: "factory_release_operations", column: "state", active: ["pending", "executing"], uncertain: ["uncertain"] },
  { table: "factory_task_stops", column: "state", active: ["accepted"], uncertain: ["uncertain"] },
  { table: "factory_child_runs", column: "state", active: ["open"], uncertain: ["uncertain"] },
]);

const IDENTIFIER = /^[a-z_]{1,63}$/;

export function factoryDatabaseCensus(adminUrl: string, tables: readonly FactoryCensusTable[] = FACTORY_OPEN_WORK_TABLES): FactoryWorkCensus {
  return {
    async count(installation: FactoryInstallationContext) {
      const url = new URL(adminUrl); url.pathname = `/${installation.productDatabase}`;
      const client = new SQL(url.toString(), { max: 1 });
      let active = 0, uncertain = 0;
      try {
        for (const entry of tables) {
          if (!IDENTIFIER.test(entry.table) || !IDENTIFIER.test(entry.column)) throw new Error("census table name is invalid");
          const exists = (await client`SELECT to_regclass(${`public.${entry.table}`}) IS NOT NULL AS present`)[0] as { present: boolean };
          if (!exists.present) continue;
          const row = (await client.unsafe(`SELECT count(*) FILTER (WHERE ${entry.column} IN (SELECT jsonb_array_elements_text($1::text::jsonb)))::int AS active, count(*) FILTER (WHERE ${entry.column} IN (SELECT jsonb_array_elements_text($2::text::jsonb)))::int AS uncertain FROM ${entry.table}`, [JSON.stringify(entry.active), JSON.stringify(entry.uncertain)]))[0] as { active: number; uncertain: number };
          active += Number(row.active); uncertain += Number(row.uncertain);
        }
      } finally { await client.close(); }
      return { active, uncertain };
    },
  };
}
