/**
 * Regression coverage for #15 — createExtension/updateExtension must persist
 * `manifest` and `grantedPermissions` as structured jsonb objects, not as
 * jsonb string scalars, "[object Object]" text, or double-encoded text.
 *
 * Before the fix, passing the manifest JS object through drizzle's default
 * mapper (PGlite) or the identity-patched mapper (bun-sql) produced broken
 * rows on the external-Postgres path and left the door open to the same
 * regression on PGlite. The fix routes both fields through an explicit
 * `::jsonb` cast, so Postgres parses them consistently. This test exercises
 * the real PGlite driver — same runtime characteristics as the prod write.
 */
import { test, expect, beforeAll, afterAll, mock, afterEach } from "bun:test";
import {
  setupTestDb,
  closeTestDb,
  mockDbConnection,
  getTestPglite,
} from "./helpers/test-pglite";

mockDbConnection();

const { createExtension, updateExtension, getExtension, deleteExtension } = await import(
  "../db/queries/extensions"
);

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await closeTestDb();
  mock.restore();
});

const createdIds: string[] = [];
afterEach(async () => {
  for (const id of createdIds.splice(0)) {
    await deleteExtension(id).catch(() => {});
  }
});

function makeInput(name: string) {
  return {
    name,
    version: "1.0.0",
    description: "jsonb-roundtrip",
    manifest: {
      schemaVersion: 2 as const,
      name,
      version: "1.0.0",
      description: "jsonb-roundtrip",
      author: { name: "tester" },
      permissions: { network: ["https://example.com"] },
    },
    source: "local:/tmp/x",
    installPath: "/tmp/x",
    enabled: false,
    grantedPermissions: { grantedAt: { network: 1700000000000 } },
    checksumVerified: true,
    consecutiveFailures: 0,
  } as any;
}

test("createExtension persists manifest as jsonb object (not string scalar)", async () => {
  const input = makeInput("jsonb-create");
  const ext = await createExtension(input);
  createdIds.push(ext.id);

  expect(typeof ext.manifest).toBe("object");
  expect((ext.manifest as any).schemaVersion).toBe(2);
  expect((ext.manifest as any).permissions.network).toEqual(["https://example.com"]);
  expect(typeof ext.grantedPermissions).toBe("object");
  expect((ext.grantedPermissions as any).grantedAt.network).toBe(1700000000000);

  // Reload from DB — proves the row was stored as a parseable jsonb object
  // rather than as a string scalar that happens to re-inflate via the column
  // mapper's JSON.parse fallback.
  const reloaded = await getExtension(ext.id);
  expect(reloaded).not.toBeNull();
  expect(typeof reloaded!.manifest).toBe("object");
  expect((reloaded!.manifest as any).name).toBe("jsonb-create");
});

test("createExtension stores jsonb as parsed object at the Postgres layer", async () => {
  const input = makeInput("jsonb-pg-check");
  const ext = await createExtension(input);
  createdIds.push(ext.id);

  // jsonb_typeof on the raw column catches the specific bug where the value
  // is stored as a jsonb STRING scalar (what happens when bun-sql binds the
  // serialized JSON as a text parameter without a cast) or as the literal
  // "[object Object]" (what happens when an unserialized JS object is
  // coerced to string). Both pass a naive JS-side roundtrip but fail here.
  const pg = getTestPglite();
  const res = await pg.query<{
    manifest_type: string;
    granted_type: string;
    manifest_name: string;
  }>(
    `SELECT jsonb_typeof(manifest) AS manifest_type,
            jsonb_typeof(granted_permissions) AS granted_type,
            manifest->>'name' AS manifest_name
       FROM extensions WHERE id = $1`,
    [ext.id],
  );
  expect(res.rows[0]?.manifest_type).toBe("object");
  expect(res.rows[0]?.granted_type).toBe("object");
  expect(res.rows[0]?.manifest_name).toBe("jsonb-pg-check");
});

test("updateExtension preserves jsonb structure on partial writes", async () => {
  const ext = await createExtension(makeInput("jsonb-update"));
  createdIds.push(ext.id);

  const nextManifest = {
    ...(ext.manifest as any),
    description: "updated",
    permissions: { network: ["https://new.example"], shell: true },
  };
  const updated = await updateExtension(ext.id, {
    manifest: nextManifest,
    grantedPermissions: { grantedAt: { network: 42, shell: 43 } },
  } as any);

  expect(updated).not.toBeNull();
  expect((updated!.manifest as any).description).toBe("updated");
  expect((updated!.manifest as any).permissions.shell).toBe(true);
  expect((updated!.grantedPermissions as any).grantedAt.shell).toBe(43);

  const pg = getTestPglite();
  const res = await pg.query<{ typ: string }>(
    `SELECT jsonb_typeof(manifest) AS typ FROM extensions WHERE id = $1`,
    [ext.id],
  );
  expect(res.rows[0]?.typ).toBe("object");
});
