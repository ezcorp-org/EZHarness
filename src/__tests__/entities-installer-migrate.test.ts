// ── Phase 3 — entities legacy-namespace migration ──────────────
//
// Exercises `runEntityNamespaceMigration` against a PGlite seeded with
// substack-pilot-shaped legacy keys. Asserts:
//   - rename of post-type:<slug> → __entity:post-type:<slug>
//   - rename of post-type-index → __entity-index:post-type (sorted+deduped)
//   - per-user transaction isolation (two users migrate independently)
//   - idempotency (second run is a no-op)
//   - skip-on-invalid-slug (corrupted source row left out of managed index)
//   - audit row written

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  closeTestDb,
  getTestDb,
  mockDbConnection,
  setupTestDb,
} from "./helpers/test-pglite";

mockDbConnection();

import { and, eq, like } from "drizzle-orm";
import {
  auditLog,
  extensions,
  extensionStorage,
  users,
} from "../db/schema";
import { runEntityNamespaceMigration } from "../extensions/entities/migrate";

let extId: string;
let userA: string;
let userB: string;

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  const db = getTestDb();
  await db.delete(auditLog);
  await db.delete(extensions);
  await db.delete(users);
  const [a] = await db
    .insert(users)
    .values({
      email: "a@example.com",
      passwordHash: "x",
      name: "A",
      role: "member",
    })
    .returning();
  const [b] = await db
    .insert(users)
    .values({
      email: "b@example.com",
      passwordHash: "x",
      name: "B",
      role: "member",
    })
    .returning();
  userA = a!.id;
  userB = b!.id;
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

async function seedLegacyKeys(
  ownerScopeId: string,
  slugs: string[],
  options?: { includeIndex?: boolean; corruptSlug?: string },
) {
  const db = getTestDb();
  const rows = slugs.map((slug) => ({
    extensionId: extId,
    scope: "user" as const,
    scopeId: ownerScopeId,
    key: `post-type:${slug}`,
    value: { name: slug, cadence: "weekly" } as never,
    encrypted: false,
    sizeBytes: 32,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  if (options?.corruptSlug) {
    rows.push({
      extensionId: extId,
      scope: "user" as const,
      scopeId: ownerScopeId,
      key: `post-type:${options.corruptSlug}`,
      value: { name: "broken" } as never,
      encrypted: false,
      sizeBytes: 16,
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  if (options?.includeIndex !== false) {
    rows.push({
      extensionId: extId,
      scope: "user" as const,
      scopeId: ownerScopeId,
      key: "post-type-index",
      value: slugs as never,
      encrypted: false,
      sizeBytes: 32,
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  await db.insert(extensionStorage).values(rows);
}

async function listExtKeys(scopeId: string): Promise<string[]> {
  const db = getTestDb();
  const rows = await db
    .select()
    .from(extensionStorage)
    .where(
      and(
        eq(extensionStorage.extensionId, extId),
        eq(extensionStorage.scopeId, scopeId),
      ),
    );
  return rows.map((r) => r.key).sort();
}

const MAPPINGS = [
  {
    entityType: "post-type",
    legacyKeyPrefix: "post-type:",
    legacyIndexKey: "post-type-index",
  },
];

describe("runEntityNamespaceMigration — happy path", () => {
  test("renames legacy post-type:* keys to managed namespace", async () => {
    await seedLegacyKeys(userA, ["weekly", "monthly"]);
    const result = await runEntityNamespaceMigration({
      extensionId: extId,
      mappings: MAPPINGS,
    });
    expect(result.recordsRenamed).toBe(2);
    expect(result.scopesMigrated).toBe(1);
    expect(result.slugsByType["post-type"]?.sort()).toEqual(
      ["monthly", "weekly"].sort(),
    );

    const keys = await listExtKeys(userA);
    expect(keys).toEqual(
      [
        "__entity-index:post-type",
        "__entity:post-type:monthly",
        "__entity:post-type:weekly",
      ].sort(),
    );

    const db = getTestDb();
    const indexRow = await db
      .select()
      .from(extensionStorage)
      .where(
        and(
          eq(extensionStorage.extensionId, extId),
          eq(extensionStorage.scopeId, userA),
          eq(extensionStorage.key, "__entity-index:post-type"),
        ),
      );
    expect(indexRow[0]?.value).toEqual(["monthly", "weekly"]);
  });

  test("migrates two users independently", async () => {
    await seedLegacyKeys(userA, ["weekly"]);
    await seedLegacyKeys(userB, ["monthly", "ad-hoc"]);
    const result = await runEntityNamespaceMigration({
      extensionId: extId,
      mappings: MAPPINGS,
    });
    expect(result.scopesMigrated).toBe(2);
    expect(result.recordsRenamed).toBe(3);

    const keysA = await listExtKeys(userA);
    const keysB = await listExtKeys(userB);
    expect(keysA).toEqual([
      "__entity-index:post-type",
      "__entity:post-type:weekly",
    ]);
    expect(keysB).toEqual(
      [
        "__entity-index:post-type",
        "__entity:post-type:monthly",
        "__entity:post-type:ad-hoc",
      ].sort(),
    );
  });

  test("writes one audit row per migrated scope", async () => {
    await seedLegacyKeys(userA, ["weekly"]);
    await seedLegacyKeys(userB, ["monthly"]);
    await runEntityNamespaceMigration({
      extensionId: extId,
      mappings: MAPPINGS,
    });
    const db = getTestDb();
    const rows = await db.select().from(auditLog);
    const ours = rows.filter(
      (r) => r.action === "ext:entity-namespace-migrated",
    );
    expect(ours.length).toBe(2);
    const userIds = ours.map((r) => r.userId).sort();
    expect(userIds).toEqual([userA, userB].sort());
  });
});

describe("runEntityNamespaceMigration — idempotency", () => {
  test("second run is a no-op (no rows changed)", async () => {
    await seedLegacyKeys(userA, ["weekly", "monthly"]);
    await runEntityNamespaceMigration({
      extensionId: extId,
      mappings: MAPPINGS,
    });
    const keysBefore = await listExtKeys(userA);

    const result2 = await runEntityNamespaceMigration({
      extensionId: extId,
      mappings: MAPPINGS,
    });
    expect(result2.scopesMigrated).toBe(0);
    expect(result2.recordsRenamed).toBe(0);

    const keysAfter = await listExtKeys(userA);
    expect(keysAfter).toEqual(keysBefore);
  });

  test("re-running cleans up stragglers when managed keys already exist", async () => {
    // Simulate a crashed-mid-migration state: managed rows exist for
    // userA, but the legacy keys also linger.
    const db = getTestDb();
    await db.insert(extensionStorage).values([
      {
        extensionId: extId,
        scope: "user",
        scopeId: userA,
        key: "__entity:post-type:weekly",
        value: { name: "weekly", cadence: "weekly" } as never,
        encrypted: false,
        sizeBytes: 32,
      },
      {
        extensionId: extId,
        scope: "user",
        scopeId: userA,
        key: "__entity-index:post-type",
        value: ["weekly"] as never,
        encrypted: false,
        sizeBytes: 16,
      },
      // Straggling legacy row that should be cleaned up.
      {
        extensionId: extId,
        scope: "user",
        scopeId: userA,
        key: "post-type:weekly",
        value: { name: "weekly", cadence: "weekly" } as never,
        encrypted: false,
        sizeBytes: 32,
      },
    ]);

    await runEntityNamespaceMigration({
      extensionId: extId,
      mappings: MAPPINGS,
    });

    // The legacy row should now be gone.
    const legacy = await db
      .select()
      .from(extensionStorage)
      .where(
        and(
          eq(extensionStorage.extensionId, extId),
          eq(extensionStorage.scopeId, userA),
          like(extensionStorage.key, "post-type:%"),
        ),
      );
    expect(legacy.length).toBe(0);

    // And an audit row records the cleanup.
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "ext:entity-namespace-migrated"));
    expect(audits.length).toBe(1);
    expect(audits[0]?.metadata).toMatchObject({
      cleanedStragglers: 1,
    });
  });
});

describe("runEntityNamespaceMigration — corruption tolerance", () => {
  test("skips rows whose slug doesn't match the SDK regex", async () => {
    await seedLegacyKeys(userA, ["weekly"], {
      corruptSlug: "BAD_SLUG_with_UPPER",
    });
    const result = await runEntityNamespaceMigration({
      extensionId: extId,
      mappings: MAPPINGS,
    });
    // The valid one migrated; the invalid one didn't.
    expect(result.recordsRenamed).toBe(1);
    expect(result.slugsByType["post-type"]).toEqual(["weekly"]);

    // Audit metadata should mention the skipped slug.
    const db = getTestDb();
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "ext:entity-namespace-migrated"));
    expect(audits[0]?.metadata).toMatchObject({
      skippedSlugs: ["BAD_SLUG_with_UPPER"],
    });
  });
});

describe("runEntityNamespaceMigration — empty inputs", () => {
  test("no-op when no mappings supplied", async () => {
    await seedLegacyKeys(userA, ["weekly"]);
    const result = await runEntityNamespaceMigration({
      extensionId: extId,
      mappings: [],
    });
    expect(result.scopesMigrated).toBe(0);
    // Legacy keys still present (no rename ran).
    const keys = await listExtKeys(userA);
    expect(keys.includes("post-type:weekly")).toBe(true);
  });

  test("no-op when no legacy rows exist for the mapping", async () => {
    const result = await runEntityNamespaceMigration({
      extensionId: extId,
      mappings: MAPPINGS,
    });
    expect(result.scopesMigrated).toBe(0);
    expect(result.recordsRenamed).toBe(0);
  });
});
