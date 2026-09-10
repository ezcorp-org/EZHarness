import { afterAll, beforeAll, expect, test } from "bun:test";
import { closeTestDb, mockDbConnection, setupTestDb } from "../../../src/__tests__/helpers/test-pglite";
import { restoreModuleMocks } from "../../../src/__tests__/helpers/mock-cleanup";

mockDbConnection();
const { seedAgentExtensions } = await import("../lib/server/test-agent-config");
const { getExtension } = await import("../../../src/db/queries/extensions");
const { createUser } = await import("../../../src/db/queries/users");

beforeAll(async () => {
  await setupTestDb();
  for (const id of ["picker-owner", "picker-other"]) {
    await createUser({ id, email: `${id}@example.test`, name: id, passwordHash: "unused", role: "member", status: "active" });
  }
});
afterAll(async () => { await closeTestDb(); restoreModuleMocks(); });

test("picker seeds have separate identities and remain inactive and owned by their caller", async () => {
  const first = await seedAgentExtensions("picker-owner");
  const second = await seedAgentExtensions("picker-other");
  expect(first).toHaveLength(3);
  expect(second).toHaveLength(3);
  expect(new Set([...first, ...second].map(row => row.id)).size).toBe(6);
  for (const [owner, rows] of [["picker-owner", first], ["picker-other", second]] as const) {
    for (const row of rows) {
      const stored = await getExtension(row.id);
      expect(stored).toMatchObject({ id: row.id, name: row.name, creatorUserId: owner, enabled: false, grantedPermissions: { grantedAt: {} } });
      expect(stored?.manifest).toMatchObject({ tools: [], permissions: {} });
    }
  }
});
