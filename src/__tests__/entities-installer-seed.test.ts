// ── Phase 3 — entities seed-on-install (host integration) ──────
//
// Runs against the real PGlite setup via setupTestDb(). Covers:
//   - seed runs on fresh install
//   - seed is idempotent (re-runs skip already-present slugs)
//   - seed validates each record (hard-fail on schema violation)
//   - missing user id defers user-scoped seeds (no rows written)
//   - conversation-scoped declarations are skipped at install time

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  closeTestDb,
  getTestDb,
  mockDbConnection,
  setupTestDb,
} from "./helpers/test-pglite";

mockDbConnection();

import { extensions, extensionStorage, users } from "../db/schema";
import { runEntitySeed } from "../extensions/entities/seed";
import type { EntityDeclaration } from "@ezcorp/sdk/entities";

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
  // Cascade clears storage rows via the FK
  await db.delete(extensions);
  await db.delete(users);
  const [u] = await db
    .insert(users)
    .values({
      email: "seed-test@example.com",
      passwordHash: "x",
      name: "Seed Tester",
      role: "member",
    })
    .returning();
  userId = u!.id;
  const [e] = await db
    .insert(extensions)
    .values({
      name: "test-ext",
      version: "1.0.0",
      description: "test",
      manifest: { schemaVersion: 2, name: "test-ext" } as never,
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

const POST_TYPE_DECL: EntityDeclaration = {
  type: "post-type",
  label: "Post Type",
  pluralLabel: "Post Types",
  scope: "user",
  schema: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1 },
      cadence: {
        type: "string",
        enum: ["weekly", "monthly", "ad-hoc"],
      },
    },
    required: ["name", "cadence"],
    additionalProperties: false,
  },
  seed: [
    { slug: "weekly", data: { name: "Weekly", cadence: "weekly" } },
    { slug: "monthly", data: { name: "Monthly", cadence: "monthly" } },
  ],
};

describe("runEntitySeed — fresh install", () => {
  test("inserts both seed records and writes the index", async () => {
    const result = await runEntitySeed({
      extensionId: extId,
      entities: [POST_TYPE_DECL],
      sourceDir: "/tmp",
      userId,
    });
    expect(result.seededByType["post-type"]?.slice().sort()).toEqual(
      ["monthly", "weekly"].sort(),
    );

    const db = getTestDb();
    const rows = await db
      .select()
      .from(extensionStorage)
      .where(
        // raw filter via drizzle-style — just pull all rows for this ext
        // and verify the count + keys.
        // We don't need a where filter beyond extensionId.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (extensionStorage.extensionId as any).eq?.(extId) ??
          undefined,
      );
    // Drizzle's pglite returns ALL rows when filter is undefined; we
    // filter in JS.
    const ourRows = rows.filter((r) => r.extensionId === extId);
    const keys = ourRows.map((r) => r.key).sort();
    expect(keys).toEqual(
      [
        "__entity-index:post-type",
        "__entity:post-type:monthly",
        "__entity:post-type:weekly",
      ].sort(),
    );
    const indexRow = ourRows.find((r) => r.key === "__entity-index:post-type")!;
    expect(indexRow.value).toEqual(["monthly", "weekly"]);
  });

  test("is idempotent on re-run (no double-seed)", async () => {
    await runEntitySeed({
      extensionId: extId,
      entities: [POST_TYPE_DECL],
      sourceDir: "/tmp",
      userId,
    });
    const second = await runEntitySeed({
      extensionId: extId,
      entities: [POST_TYPE_DECL],
      sourceDir: "/tmp",
      userId,
    });
    expect(second.seededByType["post-type"] ?? []).toEqual([]);
    expect(second.skippedByType["post-type"]?.sort()).toEqual(
      ["monthly", "weekly"].sort(),
    );
  });

  test("inserts only newly-added slugs on schema bump", async () => {
    await runEntitySeed({
      extensionId: extId,
      entities: [POST_TYPE_DECL],
      sourceDir: "/tmp",
      userId,
    });
    const bumped: EntityDeclaration = {
      ...POST_TYPE_DECL,
      seed: [
        ...(POST_TYPE_DECL.seed ?? []),
        { slug: "ad-hoc", data: { name: "Ad-Hoc", cadence: "ad-hoc" } },
      ],
    };
    const result = await runEntitySeed({
      extensionId: extId,
      entities: [bumped],
      sourceDir: "/tmp",
      userId,
    });
    expect(result.seededByType["post-type"]).toEqual(["ad-hoc"]);
    expect(result.skippedByType["post-type"]?.sort()).toEqual(
      ["monthly", "weekly"].sort(),
    );
  });
});

describe("runEntitySeed — validation", () => {
  test("hard-fails on a seed record that fails schema validation", async () => {
    const bad: EntityDeclaration = {
      ...POST_TYPE_DECL,
      seed: [
        // Missing required `cadence`
        { slug: "broken", data: { name: "Broken" } },
      ],
    };
    expect(
      runEntitySeed({
        extensionId: extId,
        entities: [bad],
        sourceDir: "/tmp",
        userId,
      }),
    ).rejects.toThrow(/cadence/);
  });

  test("rejects malformed slug at validation time", async () => {
    const bad: EntityDeclaration = {
      ...POST_TYPE_DECL,
      seed: [
        { slug: "Bad Slug With Spaces", data: { name: "x", cadence: "weekly" } },
      ],
    };
    expect(
      runEntitySeed({
        extensionId: extId,
        entities: [bad],
        sourceDir: "/tmp",
        userId,
      }),
    ).rejects.toThrow(/slug/);
  });
});

describe("runEntitySeed — scope handling", () => {
  test("user-scoped seeds defer when no userId is supplied", async () => {
    const result = await runEntitySeed({
      extensionId: extId,
      entities: [POST_TYPE_DECL],
      sourceDir: "/tmp",
      userId: null,
    });
    expect(result.seededByType).toEqual({});
    expect(result.skippedByType["post-type"]?.sort()).toEqual(
      ["monthly", "weekly"].sort(),
    );

    const db = getTestDb();
    const rows = await db.select().from(extensionStorage);
    const ourRows = rows.filter((r) => r.extensionId === extId);
    expect(ourRows.length).toBe(0);
  });

  test("conversation-scoped seeds are skipped at install time", async () => {
    const conv: EntityDeclaration = {
      ...POST_TYPE_DECL,
      scope: "conversation",
    };
    const result = await runEntitySeed({
      extensionId: extId,
      entities: [conv],
      sourceDir: "/tmp",
      userId,
    });
    expect(result.seededByType).toEqual({});
    expect(result.skippedByType["post-type"]?.sort()).toEqual(
      ["monthly", "weekly"].sort(),
    );
  });
});

describe("runEntitySeed — declaration-less", () => {
  test("no-op when entities[] is empty / undefined", async () => {
    const result1 = await runEntitySeed({
      extensionId: extId,
      entities: undefined,
      sourceDir: "/tmp",
      userId,
    });
    const result2 = await runEntitySeed({
      extensionId: extId,
      entities: [],
      sourceDir: "/tmp",
      userId,
    });
    expect(result1.seededByType).toEqual({});
    expect(result2.seededByType).toEqual({});
  });
});
