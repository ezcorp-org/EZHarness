import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "../db/migrate";
import * as schema from "../db/schema";
import { SandboxAdmissionStore } from "./admission";
import { SandboxController, type SandboxProviderDispatcher } from "./controller";

const provider: SandboxProviderDispatcher = {
  dispatch: async () => ({ outcome: "UNKNOWN" }),
  inspectOperation: async () => ({ outcome: "UNKNOWN" }),
};

test("migration preserves a local project and durable controller rows reopen cleanly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandbox-controller-reopen-"));
  try {
    let database = new PGlite(directory, { extensions: { vector, pg_trgm } });
    await database.waitReady;
    await database.exec(`CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      icon TEXT,
      variables JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await database.query("INSERT INTO projects (id, name, path) VALUES ($1, $2, $3)", [
      "local-project",
      "Local project",
      "/work/local-project",
    ]);
    let db = drizzle(database, { schema });
    await migrate(db);
    const controller = new SandboxController(db, provider);
    const createdBinding = await controller.createBinding({
      id: "persistent-binding",
      projectId: "local-project",
      providerInstallationId: "provider-installation",
      providerReleaseId: "provider-release",
      connectionId: "connection",
      resourceKey: "resource-persistent",
    });
    const admission = new SandboxAdmissionStore(db);
    await admission.configureHostCapacity({
      providerInstallationId: "provider-installation",
      connectionId: "connection",
      allocatable: {
        memoryBytes: 2_000,
        cpuMillicores: 2_000,
        pids: 200,
        diskBytes: 20_000,
        executionSlots: 2,
      },
      safetyMargin: {
        memoryBytes: 1_000,
        cpuMillicores: 1_000,
        pids: 100,
        diskBytes: 10_000,
        executionSlots: 1,
      },
    });
    await admission.configureProjectQuota({
      projectId: "local-project",
      providerInstallationId: "provider-installation",
      connectionId: "connection",
      limit: {
        memoryBytes: 1_000,
        cpuMillicores: 1_000,
        pids: 100,
        diskBytes: 10_000,
        executionSlots: 1,
      },
    });
    const admissionReceipt = await admission.requestAdmission({
      bindingId: createdBinding.id,
      generation: 1,
      kind: "CREATE",
      idempotencyScope: "capacity",
      idempotencyKey: "persistent-admission",
      resources: {
        memoryBytes: 1_000,
        cpuMillicores: 1_000,
        pids: 100,
        diskBytes: 10_000,
        executionSlots: 1,
      },
    });
    const operation = await controller.journalOperation({
      bindingId: createdBinding.id,
      kind: "DESTROY",
      generation: 1,
      idempotencyScope: "cleanup",
      idempotencyKey: "persistent-destroy",
      payload: { reason: "test" },
    });
    await controller.reconcile();
    await database.close();

    database = new PGlite(directory, { extensions: { vector, pg_trgm } });
    await database.waitReady;
    db = drizzle(database, { schema });
    await migrate(db);
    const reopened = new SandboxController(db, provider);
    const reopenedAdmission = new SandboxAdmissionStore(db);
    const local = await database.query<{ name: string; path: string }>(
      "SELECT name, path FROM projects WHERE id = 'local-project'",
    );

    expect(local.rows).toEqual([{ name: "Local project", path: "/work/local-project" }]);
    expect(await reopened.getOperation(operation.id)).toEqual(expect.objectContaining({
      state: "OUTCOME_UNKNOWN",
      reconcileOrder: 2n,
    }));
    expect((await reopened.getBinding(createdBinding.id))?.currentOperationId).toBe(operation.id);
    expect((await reopened.getBinding(createdBinding.id))?.tombstonedAt).toBeInstanceOf(Date);
    expect(await reopenedAdmission.getAdmission(admissionReceipt.id)).toEqual(expect.objectContaining({
      state: "ADMITTED",
      reason: null,
    }));
    expect(await reopenedAdmission.getReservation(createdBinding.id)).toEqual(expect.objectContaining({
      computeState: "RESERVED",
      diskState: "RESERVED",
      diskBytes: 10_000,
    }));
    const indexes = await database.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename LIKE 'sandbox_%' OR tablename = 'provider_sandbox_operations'",
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual(expect.arrayContaining([
      "idx_sandbox_bindings_provider_resource",
      "idx_sandbox_bindings_cleanup",
      "idx_provider_sandbox_operations_idempotency",
      "idx_provider_sandbox_operations_reconcile",
      "idx_provider_sandbox_operations_reconcile_order",
      "idx_sandbox_reservations_host",
      "idx_sandbox_reservations_project",
      "idx_sandbox_admission_idempotency",
      "idx_sandbox_admission_queue",
    ]));
    await database.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
