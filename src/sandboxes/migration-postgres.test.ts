import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import testImages from "../../scripts/test-images.json";
import { up as addSandboxController } from "../db/migrations/add-sandbox-controller";
import { SandboxAdmissionStore } from "./admission";
import { SandboxController } from "./controller";

const container = `sandbox-controller-postgres-${crypto.randomUUID()}`;
let client: SQL | undefined;
let reopenedClient: SQL | undefined;

async function podman(...args: string[]): Promise<string> {
  const child = Bun.spawn(["podman", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(stderr);
  return stdout.trim();
}

beforeAll(async () => {
  await podman(
    "run",
    "-d",
    "--name",
    container,
    "--pull=never",
    "--log-driver=none",
    "--memory=256m",
    "-e",
    "POSTGRES_PASSWORD=fixture",
    "-p",
    "127.0.0.1::5432",
    testImages.postgres,
  );
  const port = (await podman("port", container, "5432/tcp")).split(":").at(-1);
  await podman(
    "exec",
    container,
    "sh",
    "-c",
    "for attempt in $(seq 1 100); do pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && exit 0; sleep 0.1; done; exit 1",
  );
  client = new SQL(`postgres://postgres:fixture@127.0.0.1:${port}/postgres`, {
    max: 2,
    connectionTimeout: 10,
  });
  await client`SELECT 1`;
}, 30_000);

afterAll(async () => {
  await reopenedClient?.close({ timeout: 1 });
  await client?.close({ timeout: 1 });
  await podman("rm", "-f", "--ignore", container);
}, 10_000);

test("controller migration reapplies and reconnects on real PostgreSQL", async () => {
  if (!client) throw new Error("PostgreSQL test client was not initialized");
  await client`CREATE TABLE projects (id TEXT PRIMARY KEY)`;
  await client`INSERT INTO projects (id) VALUES ('local-project')`;
  await addSandboxController(drizzle(client));
  await addSandboxController(drizzle(client));
  await client`INSERT INTO sandbox_bindings (
    id, project_id, provider_installation_id, provider_release_id, connection_id,
    resource_key, desired_state, observed_state, generation, tombstoned_at
  ) VALUES (
    'binding', 'local-project', 'installation', 'release', 'connection',
    'resource', 'ABSENT', 'UNKNOWN', 1, NOW()
  )`;
  await client`INSERT INTO provider_sandbox_operations (
    id, binding_id, kind, generation, idempotency_scope, idempotency_key,
    payload_hash, request_payload, state
  ) VALUES (
    'operation', 'binding', 'DESTROY', 1, 'cleanup', 'destroy-1',
    'hash', '{"reason":"test"}'::jsonb, 'OUTCOME_UNKNOWN'
  )`;
  await client`UPDATE provider_sandbox_operations SET reconcile_order = nextval('sandbox_reconcile_order_seq') WHERE id = 'operation'`;
  // Model an upgrade from a schema that had durable operations but no intent pointer.
  await client`ALTER TABLE sandbox_bindings DROP COLUMN current_operation_id`;
  await addSandboxController(drizzle(client));
  await client`INSERT INTO projects (id) VALUES ('race-one'), ('race-two')`;
  await client`INSERT INTO sandbox_bindings (
    id, project_id, provider_installation_id, provider_release_id, connection_id,
    resource_key, desired_state, observed_state
  ) VALUES
    ('race-binding-one', 'race-one', 'race-provider', 'race-release', 'race-connection', 'race-resource-one', 'STOPPED', 'STOPPED'),
    ('race-binding-two', 'race-two', 'race-provider', 'race-release', 'race-connection', 'race-resource-two', 'STOPPED', 'STOPPED')`;
  const admission = new SandboxAdmissionStore(drizzle(client));
  await admission.configureHostCapacity({
    providerInstallationId: "race-provider",
    connectionId: "race-connection",
    allocatable: { memoryBytes: 200, cpuMillicores: 2_000, pids: 128, diskBytes: 2_000, executionSlots: 2 },
    safetyMargin: { memoryBytes: 100, cpuMillicores: 1_000, pids: 64, diskBytes: 1_000, executionSlots: 1 },
  });
  for (const projectId of ["race-one", "race-two"]) {
    await admission.configureProjectQuota({
      projectId,
      providerInstallationId: "race-provider",
      connectionId: "race-connection",
      limit: { memoryBytes: 100, cpuMillicores: 1_000, pids: 64, diskBytes: 1_000, executionSlots: 1 },
    });
  }
  const concurrent = await Promise.all(["one", "two"].map((suffix) => admission.requestAdmission({
    bindingId: `race-binding-${suffix}`,
    generation: 1,
    kind: "CREATE",
    idempotencyScope: "postgres-race",
    idempotencyKey: suffix,
    resources: { memoryBytes: 100, cpuMillicores: 1_000, pids: 64, diskBytes: 1_000, executionSlots: 1 },
  })));

  const port = (await podman("port", container, "5432/tcp")).split(":").at(-1);
  reopenedClient = new SQL(`postgres://postgres:fixture@127.0.0.1:${port}/postgres`, {
    max: 2,
    connectionTimeout: 10,
  });
  await reopenedClient`SELECT 1`;
  await addSandboxController(drizzle(reopenedClient));

  const projects = await reopenedClient`SELECT id FROM projects WHERE id = 'local-project'`;
  const operations = await reopenedClient`SELECT state, request_payload->>'reason' AS reason FROM provider_sandbox_operations`;
  const persistedFence = await reopenedClient`
    SELECT b.current_operation_id AS operation_id, o.reconcile_order AS reconcile_order
    FROM sandbox_bindings b JOIN provider_sandbox_operations o ON o.binding_id = b.id
    WHERE b.id = 'binding'
  `;
  const indexes = await reopenedClient`
    SELECT indexname
    FROM pg_indexes
    WHERE tablename LIKE 'sandbox_%'
    ORDER BY indexname
  `;
  const checks = await reopenedClient`
    SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid IN (
      'sandbox_bindings'::regclass,
      'provider_sandbox_operations'::regclass,
      'sandbox_host_capacities'::regclass,
      'sandbox_project_quotas'::regclass,
      'sandbox_reservations'::regclass,
      'sandbox_admission_requests'::regclass
    )
      AND contype = 'c'
  `;
  const checkDefinitions = checks.map((row: { definition: string }) => row.definition).join("\n");

  expect(projects).toEqual([{ id: "local-project" }]);
  expect(operations).toEqual([{ state: "OUTCOME_UNKNOWN", reason: "test" }]);
  expect(persistedFence).toEqual([{ operation_id: "operation", reconcile_order: "1" }]);
  expect(concurrent.map((result) => result.state).sort()).toEqual(["ADMITTED", "QUEUED"]);
  expect(concurrent.find((result) => result.state === "QUEUED")?.reason).toBe("HOST_MEMORY_CAPACITY");
  expect(indexes.map((row: { indexname: string }) => row.indexname)).toEqual(expect.arrayContaining([
    "idx_sandbox_bindings_cleanup",
    "idx_sandbox_bindings_provider_resource",
    "idx_provider_sandbox_operations_idempotency",
    "idx_provider_sandbox_operations_reconcile",
    "idx_provider_sandbox_operations_reconcile_order",
    "idx_sandbox_reservations_host",
    "idx_sandbox_reservations_project",
    "idx_sandbox_admission_idempotency",
    "idx_sandbox_admission_queue",
  ]));
  expect(checkDefinitions).toContain("generation > 0");
  expect(checkDefinitions).toContain("OUTCOME_UNKNOWN");
  expect(checkDefinitions).toContain("9007199254740991");
  expect(checkDefinitions).toContain("RELEASE_REQUESTED");
  const recoveredController = new SandboxController(drizzle(reopenedClient), {
    dispatch: async () => { throw new Error("Recovered operation must be inspected"); },
    inspectOperation: async () => ({ outcome: "SUCCEEDED", observedState: "ABSENT" }),
  });
  const recovery = await recoveredController.reconcile();
  expect(recovery).toEqual(expect.objectContaining({ examined: 1, inspected: 1, completed: 1 }));
  expect((await recoveredController.getOperation("operation"))?.state).toBe("SUCCEEDED");
  expect((await recoveredController.getBinding("binding"))?.cleanupConfirmedAt).toBeInstanceOf(Date);
}, 30_000);
