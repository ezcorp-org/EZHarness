/**
 * `extensions.disabled_by_user` against a REAL database.
 *
 * Everything else that touches this column mocks the query layer, so the
 * whole feature rests on three independent spellings agreeing:
 * `disabledByUser` in `src/db/schema.ts`, `disabled_by_user` in the
 * `ALTER TABLE` in `src/db/migrate.ts`, and Drizzle's camel↔snake mapping
 * between them. A typo in any one of those passes every mocked test and
 * fails at runtime — as `enabled` silently reverting on the next restart,
 * which is the exact bug the column exists to fix and the hardest kind to
 * notice.
 *
 * Same shape and same reason as `extensions-list-bundled-filter.test.ts`,
 * written when `is_bundled` landed.
 */
import { test, expect, beforeAll, afterAll, mock, afterEach } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const { createExtension, deleteExtension, getExtensionByName, updateExtension } =
  await import("../db/queries/extensions");

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
    description: "test",
    manifest: {
      schemaVersion: 2 as const,
      name,
      version: "1.0.0",
      description: "test",
      author: { name: "tester" },
      permissions: {},
    },
    source: "local:/tmp/x",
    installPath: "/tmp/x",
    enabled: true,
    grantedPermissions: { grantedAt: {} },
    checksumVerified: false,
    consecutiveFailures: 0,
    isBundled: false,
    // biome-ignore lint/suspicious/noExplicitAny: NewExtension's jsonb columns
    // are typed to the manifest/permission shapes; the fixture is deliberately
    // minimal, matching `extensions-list-bundled-filter.test.ts`.
  } as any;
}

test("a fresh row defaults to disabled_by_user = false", async () => {
  // The migration's DEFAULT FALSE is what keeps every pre-existing row
  // eligible for the boot reconcilers' repair path. A default of true would
  // strand every extension that was disabled before this column existed.
  const row = await createExtension(makeInput("dbu-default"));
  createdIds.push(row.id);

  expect(row.disabledByUser).toBe(false);
  expect((await getExtensionByName("dbu-default"))?.disabledByUser).toBe(false);
});

test("setting it survives a write → read-back round trip", async () => {
  // The write the PATCH route makes, then the read `ensureBundledExtensions`
  // does at the next boot. This is the whole contract, end to end.
  const row = await createExtension(makeInput("dbu-roundtrip"));
  createdIds.push(row.id);

  const updated = await updateExtension(row.id, { enabled: false, disabledByUser: true });
  expect(updated?.disabledByUser).toBe(true);
  expect(updated?.enabled).toBe(false);

  const reread = await getExtensionByName("dbu-roundtrip");
  expect(reread?.disabledByUser).toBe(true);
  expect(reread?.enabled).toBe(false);
});

test("clearing it round-trips too", async () => {
  // The enable path (`activateExtension`). If the column could be set but
  // not cleared, a user could turn a built-in off exactly once.
  const row = await createExtension(makeInput("dbu-clear"));
  createdIds.push(row.id);

  await updateExtension(row.id, { enabled: false, disabledByUser: true });
  await updateExtension(row.id, { enabled: true, disabledByUser: false });

  const reread = await getExtensionByName("dbu-clear");
  expect(reread?.disabledByUser).toBe(false);
  expect(reread?.enabled).toBe(true);
});

test("it is independent of `enabled` — neither write disturbs the other", async () => {
  // They are separate facts: `enabled` is the state, `disabled_by_user` is
  // the REASON. A boot reconciler that flips `enabled` must not clear the
  // reason, or the next boot forgets the user's choice.
  const row = await createExtension(makeInput("dbu-independent"));
  createdIds.push(row.id);

  await updateExtension(row.id, { disabledByUser: true });
  expect((await getExtensionByName("dbu-independent"))?.enabled).toBe(true);

  await updateExtension(row.id, { enabled: false });
  expect((await getExtensionByName("dbu-independent"))?.disabledByUser).toBe(true);
});
