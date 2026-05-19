// ── Phase 7 — substack-pilot legacy-namespace migration ─────────
//
// Drives the bundled-install path's `legacyEntityMappings` against a
// real PGlite pre-populated with substack-pilot's pre-port shape:
//
//   post-type:weekly       → __entity:post-type:weekly
//   post-type:monthly      → __entity:post-type:monthly
//   post-type:ad-hoc       → __entity:post-type:ad-hoc
//   post-type-index        → __entity-index:post-type
//
// The renamer is the same one wired into `installFromLocal` via
// `runEntityInstallHooks` → `runEntityNamespaceMigration`. This test
// exercises the substack-pilot-specific mapping; the generic migrator
// behavior (idempotency, audit row, corruption tolerance) lives in
// `entities-installer-migrate.test.ts`.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  closeTestDb,
  getTestDb,
  mockDbConnection,
  setupTestDb,
} from "./helpers/test-pglite";

mockDbConnection();

import { and, eq } from "drizzle-orm";
import { extensions, extensionStorage, users } from "../db/schema";
import { runEntityNamespaceMigration } from "../extensions/entities/migrate";

const SUBSTACK_MAPPING = [
  {
    entityType: "post-type",
    legacyKeyPrefix: "post-type:",
    legacyIndexKey: "post-type-index",
  },
] as const;

let extId: string;
let userId: string;

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  const db = getTestDb();
  await db.delete(extensions);
  await db.delete(users);
  const [u] = await db
    .insert(users)
    .values({
      email: "substack@example.com",
      passwordHash: "x",
      name: "X",
      role: "member",
    })
    .returning();
  userId = u!.id;
  const [e] = await db
    .insert(extensions)
    .values({
      name: "substack-pilot",
      version: "1.0.0",
      description: "test",
      manifest: { schemaVersion: 2, name: "substack-pilot" } as never,
      source: "local:/tmp",
      installPath: "/tmp",
      enabled: true,
      grantedPermissions: { grantedAt: {} } as never,
      checksumVerified: false,
      consecutiveFailures: 0,
    })
    .returning();
  extId = e!.id;
});

async function seedPrePortKeys(scopeId: string): Promise<void> {
  const db = getTestDb();
  await db.insert(extensionStorage).values([
    {
      extensionId: extId,
      scope: "user",
      scopeId,
      key: "post-type:weekly",
      value: {
        name: "Weekly Roundup",
        slug: "weekly",
        systemPrompt: "USER-EDITED weekly prompt",
        cadence: "weekly",
      } as never,
      encrypted: false,
      sizeBytes: 128,
    },
    {
      extensionId: extId,
      scope: "user",
      scopeId,
      key: "post-type:monthly",
      value: {
        name: "Monthly Essay",
        slug: "monthly",
        systemPrompt: "USER-EDITED monthly prompt",
        cadence: "monthly",
      } as never,
      encrypted: false,
      sizeBytes: 128,
    },
    {
      extensionId: extId,
      scope: "user",
      scopeId,
      key: "post-type:ad-hoc",
      value: {
        name: "Ad-hoc Post",
        slug: "ad-hoc",
        systemPrompt: "USER-EDITED ad-hoc prompt",
        cadence: "ad-hoc",
      } as never,
      encrypted: false,
      sizeBytes: 96,
    },
    {
      extensionId: extId,
      scope: "user",
      scopeId,
      key: "post-type-index",
      value: ["weekly", "monthly", "ad-hoc"] as never,
      encrypted: false,
      sizeBytes: 48,
    },
  ]);
}

describe("substack-pilot legacy namespace migration", () => {
  test("renames all three default post types into the managed namespace", async () => {
    await seedPrePortKeys(userId);
    const result = await runEntityNamespaceMigration({
      extensionId: extId,
      mappings: [...SUBSTACK_MAPPING],
    });
    expect(result.scopesMigrated).toBe(1);
    expect(result.recordsRenamed).toBe(3);
    expect(result.slugsByType["post-type"]?.sort()).toEqual(
      ["ad-hoc", "monthly", "weekly"].sort(),
    );

    const db = getTestDb();
    const rows = await db
      .select()
      .from(extensionStorage)
      .where(
        and(
          eq(extensionStorage.extensionId, extId),
          eq(extensionStorage.scopeId, userId),
        ),
      );

    // Legacy keys are gone.
    const legacyRemaining = rows.filter((r) =>
      r.key.startsWith("post-type:") || r.key === "post-type-index",
    );
    expect(legacyRemaining.length).toBe(0);

    // Managed records + index now exist with the SAME values the user
    // had under the legacy keys (no data mutation during rename).
    const managedRows = rows.filter((r) =>
      r.key.startsWith("__entity:post-type:") ||
      r.key === "__entity-index:post-type",
    );
    expect(managedRows.length).toBe(4);
    const weekly = managedRows.find(
      (r) => r.key === "__entity:post-type:weekly",
    );
    expect((weekly?.value as { systemPrompt?: string })?.systemPrompt).toBe(
      "USER-EDITED weekly prompt",
    );
    const index = managedRows.find(
      (r) => r.key === "__entity-index:post-type",
    );
    expect(index?.value).toEqual(["ad-hoc", "monthly", "weekly"]);
  });

  test("preserves user edits over default seeds (no clobber on re-install)", async () => {
    // The migrate is part of the install flow; seed runs AFTER migrate
    // (see installer.ts:runEntityInstallHooks). Once the user's data
    // is in the managed namespace, seed's idempotency check skips
    // every slug already in the index. This test pins that the rename
    // doesn't replace the user's content with the default seed body.
    await seedPrePortKeys(userId);
    await runEntityNamespaceMigration({
      extensionId: extId,
      mappings: [...SUBSTACK_MAPPING],
    });

    const db = getTestDb();
    const weekly = await db
      .select()
      .from(extensionStorage)
      .where(
        and(
          eq(extensionStorage.extensionId, extId),
          eq(extensionStorage.scopeId, userId),
          eq(extensionStorage.key, "__entity:post-type:weekly"),
        ),
      );
    // The system prompt is still the user's edited value, NOT the
    // default seed text the manifest would otherwise insert.
    expect(
      (weekly[0]?.value as { systemPrompt?: string })?.systemPrompt,
    ).toBe("USER-EDITED weekly prompt");
  });
});
