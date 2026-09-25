import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { sql } from "drizzle-orm";
import { closeTestDb, getTestDb, setupTestDb } from "../../../../../../../src/__tests__/helpers/test-pglite";
import { projects, providerConnections, sandboxBindings, sandboxOperations } from "../../../../../../../src/db/schema";

mock.module("$server/db/connection", () => ({ getDb: () => getTestDb() }));
mock.module("$server/auth/middleware", () => ({ requireAdminSession: () => ({ id: "admin", role: "admin" }) }));
mock.module("$server/extensions/extension-lifecycle-service", () => ({ getExtensionLifecycle: async () => undefined }));
mock.module("$server/extensions/release-process", () => ({ getReleaseRuntime: () => ({}), resolveActiveRelease: async () => ({
  installation: { generation: 1 }, release: { id: "release", manifest: { sandboxProviders: [{ id: "incus", kind: "sandbox", protocolMajor: 1,
    presets: [{ id: "compose", profile: "persistent-web-compose.v1" }] }] } },
}) }));
mock.module("$server/infrastructure/incus-qualification", () => ({ IncusQualificationStore: class { async load() { return null; } } }));
const { GET } = await import("./+server");
beforeAll(setupTestDb, 30_000);
afterAll(closeTestDb);

test("real migrated database lists user bindings and excludes fixture projects and sensitive columns", async () => {
  const db = getTestDb();
  await db.execute(sql`INSERT INTO extension_release_installations (id, owner_id, scope, payload)
    VALUES ('installation', 'admin', 'global', '{}')`);
  await db.insert(providerConnections).values({ id: "connection", revision: 1, providerInstallationId: "installation",
    providerReleaseId: "release", endpoint: "https://SECRET.example", project: "Development", configuration: { kind: "incus" },
    serverCertificatePem: "SECRET-server-cert", clientCertificatePem: "SECRET-client-cert", privateKeyCiphertext: "SECRET-key" });
  for (const purpose of ["user", "incus-qualification"] as const) {
    await db.insert(projects).values({ id: purpose, name: purpose, path: `/SECRET/${purpose}`, purpose });
    await db.insert(sandboxBindings).values({ id: `binding-${purpose}`, projectId: purpose,
      providerInstallationId: "installation", providerReleaseId: "release", connectionId: "connection",
      desiredState: "STOPPED", observedState: "UNKNOWN", presetId: "compose", currentOperationId: `operation-${purpose}` });
    await db.insert(sandboxOperations).values({ id: `operation-${purpose}`, bindingId: `binding-${purpose}`, kind: "CREATE",
      generation: 1, idempotencyScope: "test", idempotencyKey: purpose, payloadHash: "hash", requestPayload: { secret: "SECRET-payload" },
      state: "OUTCOME_UNKNOWN", providerOperationId: "SECRET-provider-id" });
  }
  const response = await GET({ locals: {} } as Parameters<typeof GET>[0]);
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.projects).toContainEqual({ id: "user", name: "user" });
  expect(result.projects.some((project: { id: string }) => project.id === "incus-qualification")).toBe(false);
  expect(result.features).toHaveLength(1);
  expect(result.features[0]).toMatchObject({ projectId: "user", bindingId: "binding-user", observedState: "UNKNOWN",
    operation: { id: "operation-user", kind: "CREATE", state: "OUTCOME_UNKNOWN" } });
  expect(result.environments[0]).toMatchObject({ connectionId: "connection", qualified: false });
  expect(JSON.stringify(result)).not.toContain("SECRET");
}, 30_000);
