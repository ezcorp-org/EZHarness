/**
 * Migration replay + END-TO-END proof for the `write`-scope backfill.
 *
 * The whole "re-scoping breaks nobody" argument rests on ONE claim: a key's
 * authority is stored beside its hash in a mutable JSONB settings row, not
 * sealed into the secret — so an already-issued key can be granted `write`
 * and keep working with the SAME raw token. This file proves that by
 * execution rather than asserting it in prose:
 *
 *   1. Seed a settings row exactly as the pre-change mint path wrote it
 *      (`generateApiKey()` → `{hash, userId, scopes:["read"], …}`), against a
 *      REAL PGlite database — so the migration's jsonb operators run on real
 *      Postgres, not a mock.
 *   2. Run the published `up()`.
 *   3. Feed the ORIGINAL raw token to the REAL `verifyApiKey`, backed by the
 *      migrated table, and assert it still resolves AND now carries `write`.
 *   4. Assert `requireScope(locals, "write")` then admits it — i.e. the key
 *      reaches the re-scoped handlers it used to reach under `read`.
 *
 * The migration must also NOT escalate: a `chat`-only key never had access to
 * those handlers (scopes are flat — `chat` does not subsume `read`), so
 * granting it `write` would be a privilege escalation performed by a
 * migration. That direction is asserted too.
 */
import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import {
  apiKeyHashIndexKey,
  apiKeySettingsKey,
  generateApiKey,
  hashApiKey,
  type ApiKeyEntry,
} from "../auth/api-key";
import { up } from "../db/migrations/backfill-api-key-write-scope";

let pglite: PGlite | null = null;
let db: ReturnType<typeof drizzle>;

/** The real `settings` DDL from src/db/migrate.ts (jsonb value column). */
async function makeSettingsDb() {
  pglite = new PGlite();
  await pglite.waitReady;
  db = drizzle(pglite);
  await db.execute(sql`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
}

async function putSetting(key: string, value: unknown): Promise<void> {
  await db.execute(sql`
    INSERT INTO settings (key, value) VALUES (${key}, ${JSON.stringify(value)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `);
}

async function readSetting(key: string): Promise<unknown | undefined> {
  const rows = (await db.execute(sql`SELECT value FROM settings WHERE key = ${key}`)) as {
    rows: { value: unknown }[];
  };
  return rows.rows[0]?.value;
}

async function scopesOf(key: string): Promise<string[] | undefined> {
  return (await readSetting(key)) === undefined
    ? undefined
    : ((await readSetting(key)) as ApiKeyEntry).scopes;
}

// `verifyApiKey` reads the settings store through these functions. Backing the
// mock with the REAL PGlite table means the migration's own SQL decides what
// verification sees — nothing is replicated or hand-fed.
//
// The specifier is the RESOLVED relative path, not the `$server/...` alias the
// module under test writes. Under the web runtime that alias is the module
// identity; from this backend test it resolves to `src/db/queries/settings`,
// so mocking the alias string alone leaves the real (uninitialised) DB module
// in place and every lookup throws "Database not initialized".
const settingsStub = () => ({
  getSetting: async (key: string) => readSetting(key),
  upsertSetting: async (key: string, value: unknown) => putSetting(key, value),
  getAllSettings: async () => {
    const rows = (await db.execute(sql`SELECT key, value FROM settings`)) as {
      rows: { key: string; value: unknown }[];
    };
    return Object.fromEntries(rows.rows.map((r) => [r.key, r.value]));
  },
  deleteSetting: async () => true,
});
mock.module("../db/queries/settings", settingsStub);
mock.module("$server/db/queries/settings", settingsStub);

const { verifyApiKey, requireScope } = await import("../../web/src/lib/server/security/api-keys");

/** Mint a key the way the pre-change code did, and store it. */
async function seedLegacyKey(userId: string, scopes: string[]) {
  const { raw, hash, keyId } = generateApiKey();
  const entry: ApiKeyEntry = {
    hash,
    userId,
    scopes: scopes as ApiKeyEntry["scopes"],
    name: `${userId}-key`,
    createdAt: Date.now(),
  };
  await putSetting(apiKeySettingsKey(userId, keyId), entry);
  await putSetting(apiKeyHashIndexKey(hash), { userId, keyId });
  return { raw, hash, keyId, settingsKey: apiKeySettingsKey(userId, keyId) };
}

beforeEach(async () => {
  await pglite?.close();
  await makeSettingsDb();
});

afterAll(async () => {
  await pglite?.close();
});

describe("backfill: a pre-existing read key survives and gains write", () => {
  test("the SAME raw token still verifies, and now carries write", async () => {
    const key = await seedLegacyKey("user-a", ["read"]);

    // Before: the key cannot reach a `write`-gated handler.
    const before = await verifyApiKey(key.raw);
    expect(before?.scopes).toEqual(["read"]);
    expect(requireScope({ apiKeyScopes: before!.scopes }, "write")).not.toBeNull();

    await up(db);

    // After: same secret, no re-issue, and the write gate now admits it.
    const after = await verifyApiKey(key.raw);
    expect(after).not.toBeNull();
    expect(after!.userId).toBe("user-a");
    expect(after!.scopes).toEqual(["read", "write"]);
    expect(requireScope({ apiKeyScopes: after!.scopes }, "write")).toBeNull();
    // …and it has not lost the read authority it already had.
    expect(requireScope({ apiKeyScopes: after!.scopes }, "read")).toBeNull();
  });

  test("the stored hash is untouched — nothing about the secret changes", async () => {
    const key = await seedLegacyKey("user-b", ["read", "chat"]);
    await up(db);
    const entry = (await readSetting(key.settingsKey)) as ApiKeyEntry;
    expect(entry.hash).toBe(hashApiKey(key.raw));
    // Existing scopes are preserved in place; `write` is appended.
    expect(entry.scopes).toEqual(["read", "chat", "write"]);
  });

  test("non-scope fields are preserved verbatim", async () => {
    const key = await seedLegacyKey("user-c", ["read"]);
    const before = (await readSetting(key.settingsKey)) as ApiKeyEntry;
    await up(db);
    const after = (await readSetting(key.settingsKey)) as ApiKeyEntry;
    expect(after.userId).toBe(before.userId);
    expect(after.name).toBe(before.name);
    expect(after.createdAt).toBe(before.createdAt);
  });
});

describe("backfill: never escalates", () => {
  test("a chat-only key is NOT granted write", async () => {
    // It could not reach the re-scoped handlers before (flat scopes: `chat`
    // does not subsume `read`), so granting `write` would hand it authority
    // it never had — an escalation performed by a migration.
    const key = await seedLegacyKey("user-d", ["chat"]);
    await up(db);
    expect(await scopesOf(key.settingsKey)).toEqual(["chat"]);
    const v = await verifyApiKey(key.raw);
    expect(requireScope({ apiKeyScopes: v!.scopes }, "write")).not.toBeNull();
  });

  test("an admin-scope key without read is NOT granted write", async () => {
    const key = await seedLegacyKey("user-e", ["admin"]);
    await up(db);
    expect(await scopesOf(key.settingsKey)).toEqual(["admin"]);
  });
});

describe("backfill: safety properties", () => {
  test("idempotent — a second run appends nothing", async () => {
    const key = await seedLegacyKey("user-f", ["read"]);
    await up(db);
    await up(db);
    await up(db);
    expect(await scopesOf(key.settingsKey)).toEqual(["read", "write"]);
  });

  test("a key that already had write is left alone", async () => {
    const key = await seedLegacyKey("user-g", ["read", "write"]);
    await up(db);
    expect(await scopesOf(key.settingsKey)).toEqual(["read", "write"]);
  });

  test("the apikeyhash: index rows are NOT rewritten", async () => {
    // `LIKE 'apikey:%'` must not catch `apikeyhash:<hash>` — those rows carry
    // a {userId,keyId} pointer and no scopes. A `jsonb_set` on them would
    // corrupt the O(1) verification index.
    const key = await seedLegacyKey("user-h", ["read"]);
    const indexKey = apiKeyHashIndexKey(key.hash);
    const before = await readSetting(indexKey);
    await up(db);
    expect(await readSetting(indexKey)).toEqual(before);
    expect(before).toEqual({ userId: "user-h", keyId: key.keyId });
    // And the key still resolves through that index afterwards.
    expect((await verifyApiKey(key.raw))?.userId).toBe("user-h");
  });

  test("unrelated settings rows are untouched", async () => {
    await putSetting("limits:rateLimit", { chat: 20 });
    await putSetting("apikey-not-a-key", { scopes: ["read"] });
    await up(db);
    expect(await readSetting("limits:rateLimit")).toEqual({ chat: 20 });
    // No colon after `apikey` ⇒ not a key row ⇒ not rewritten.
    expect(await readSetting("apikey-not-a-key")).toEqual({ scopes: ["read"] });
  });

  test("a malformed scopes field is skipped, not corrupted", async () => {
    await putSetting("apikey:user-i:k1", { hash: "x", userId: "user-i", name: "n", createdAt: 1 });
    await putSetting("apikey:user-j:k2", {
      hash: "x",
      userId: "user-j",
      scopes: "read",
      name: "n",
      createdAt: 1,
    });
    await up(db);
    expect((await readSetting("apikey:user-i:k1")) as Record<string, unknown>).not.toHaveProperty(
      "scopes",
    );
    expect(((await readSetting("apikey:user-j:k2")) as Record<string, unknown>).scopes).toBe(
      "read",
    );
  });

  test("no-op on an empty settings table", async () => {
    await up(db);
    const rows = (await db.execute(sql`SELECT count(*)::int AS n FROM settings`)) as {
      rows: { n: number }[];
    };
    expect(rows.rows[0]!.n).toBe(0);
  });

  test("migrates every read-holding key, not just the first", async () => {
    const a = await seedLegacyKey("user-k", ["read"]);
    const b = await seedLegacyKey("user-l", ["read", "extensions"]);
    const c = await seedLegacyKey("user-m", ["chat"]);
    await up(db);
    expect(await scopesOf(a.settingsKey)).toEqual(["read", "write"]);
    expect(await scopesOf(b.settingsKey)).toEqual(["read", "extensions", "write"]);
    expect(await scopesOf(c.settingsKey)).toEqual(["chat"]);
  });
});
