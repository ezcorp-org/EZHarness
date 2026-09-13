import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "./schema";

const factoryTables = [
  schema.factoryInstallation, schema.factoryProjects, schema.factoryRuns, schema.factoryAuditBatches, schema.factoryTransitionCommands, schema.factoryCommandOutbox, schema.factoryRunProjections, schema.factoryRunProjectionAttempts,
  schema.factoryInboxCursors, schema.factoryInboxEvents, schema.factoryGrants, schema.factoryServiceCredentials, schema.factoryBudgetEnvelopes, schema.factoryBudgetReservations, schema.factoryComputeAdmissions,
  schema.factoryMutationReceipts, schema.factoryDrafts, schema.factoryVersions, schema.factoryRunLifecycle, schema.factoryExecutions, schema.factoryExecutionOperationCursors, schema.factoryExecutionOperations,
];

describe("Factory Drizzle schema", () => {
  test("exports each product Factory table with fresh tenant/project/run columns", () => {
    const configs = factoryTables.map(getTableConfig);
    expect(configs.map((config) => config.name)).toEqual([
      "factory_installation", "factory_projects", "factory_runs", "factory_audit_batches", "factory_transition_commands", "factory_command_outbox", "factory_run_projections", "factory_run_projection_attempts",
      "factory_inbox_cursors", "factory_inbox_events", "factory_grants", "factory_service_credentials", "factory_budget_envelopes", "factory_budget_reservations", "factory_compute_admissions",
      "factory_mutation_receipts", "factory_drafts", "factory_versions", "factory_run_lifecycle", "factory_executions", "factory_execution_operation_cursors", "factory_execution_operations",
    ]);
    expect(schema.factoryProjects.tenantId).not.toBe(schema.factoryRuns.tenantId);
    expect(schema.factoryRuns.runId).not.toBe(schema.factoryAuditBatches.runId);
    expect(schema.factoryExecutions.cancellationEpoch.default).toBe(0);
    expect(configs.flatMap((config) => config.foreignKeys)).toHaveLength(28);
  });

  test("imports schema in a clean Bun runtime without a database-module cycle", async () => {
    const child = Bun.spawn([process.execPath, "-e", "await import('./src/db/schema.ts')"], { cwd: import.meta.dir + "/../..", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stderr).text()).toBe("");
  });
});
