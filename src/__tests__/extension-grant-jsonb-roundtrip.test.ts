/**
 * Regression: extension `granted_permissions` must round-trip as a jsonb
 * OBJECT, never a double-encoded jsonb STRING scalar.
 *
 * The web-search "Web search is disabled for this extension." bug: a
 * runtime grant write (reapprove-drift / capability-override PUT) on the
 * external-Postgres (bun-sql) driver double-encoded the grant into a jsonb
 * string ({"search":"inherit"} → "{\"search\":\"inherit\"}"), so
 * `granted.search` read back as `undefined` and the handler denied
 * (-32101) until the next boot's jsonb-repair ran. `serializeJsonbFields`
 * now passes a PLAIN OBJECT on bun-sql (the identity mapper serializes it
 * correctly) and only applies the explicit `::jsonb` cast on PGlite.
 *
 * This suite exercises the PGlite path (the test driver): a grant written
 * via createExtension AND mutated via updateExtension must read back as a
 * jsonb OBJECT with the `search` key intact — i.e. `jsonb_typeof = object`,
 * never `string`. (The bun-sql branch is verified live against a real
 * Postgres; it can't run in-suite.)
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  setupTestDb,
  closeTestDb,
  getTestPglite,
  mockDbConnection,
} from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { ExtensionPermissions } from "../extensions/types";

// Route db/connection at the test PGlite — `getPglite()` returns the test
// instance (non-null), so serializeJsonbFields takes the PGlite (cast) path.
mockDbConnection();

describe("extension granted_permissions jsonb round-trip (no double-encode)", () => {
  beforeAll(async () => {
    await setupTestDb();
  }, 30_000);

  afterAll(async () => {
    await closeTestDb();
    restoreModuleMocks();
  });

  async function jsonbType(extId: string): Promise<string> {
    const pg = getTestPglite()!;
    const res = await pg.query<{ typ: string }>(
      "select jsonb_typeof(granted_permissions) as typ from extensions where id = $1",
      [extId],
    );
    return res.rows[0]!.typ;
  }

  test("createExtension + updateExtension grant reads back as a jsonb OBJECT with search:'inherit'", async () => {
    const { createExtension, updateExtension, getExtension } = await import(
      "../db/queries/extensions"
    );

    const grant: ExtensionPermissions = {
      search: "inherit",
      grantedAt: { search: 1 },
    };
    const created = await createExtension({
      name: "jsonb-roundtrip-fixture",
      version: "1.0.0",
      description: "fixture",
      manifest: {
        schemaVersion: 2,
        name: "jsonb-roundtrip-fixture",
        version: "1.0.0",
        permissions: { search: "inherit" },
      },
      source: "local:/tmp/jsonb-roundtrip-fixture",
      installPath: "/tmp/jsonb-roundtrip-fixture",
      enabled: true,
      grantedPermissions: grant,
    } as never);

    // Read back through the query layer: the grant is an OBJECT, and
    // property access (what the handler does via `granted.search`) works.
    const read = await getExtension(created.id);
    expect(read?.grantedPermissions).toBeDefined();
    expect((read!.grantedPermissions as ExtensionPermissions).search).toBe("inherit");
    // And the column is a jsonb OBJECT, NOT a double-encoded string scalar.
    expect(await jsonbType(created.id)).toBe("object");

    // A RUNTIME mutation (the reapprove-drift / capability-override path)
    // must also stay an object — this is the exact write that double-
    // encoded on bun-sql.
    await updateExtension(created.id, {
      grantedPermissions: {
        search: { quota: 500 },
        grantedAt: { search: 2 },
      } as ExtensionPermissions,
    });
    const reread = await getExtension(created.id);
    const g = reread!.grantedPermissions as ExtensionPermissions;
    expect(typeof g).toBe("object");
    expect((g.search as { quota?: number })?.quota).toBe(500);
    expect(await jsonbType(created.id)).toBe("object");
  }, 30_000);
});
