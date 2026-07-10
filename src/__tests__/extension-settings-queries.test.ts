import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import {
  setupTestDb,
  closeTestDb,
  mockDbConnection,
  getTestDb,
} from "./helpers/test-pglite";

mockDbConnection();

import {
  getDeclaredDefaults,
  clampSettings,
  getUserSettings,
  setUserSettings,
  clearUserSettings,
  resolveExtensionSettings,
} from "../db/queries/extension-settings";
import { users, extensions } from "../db/schema";
import { sql } from "drizzle-orm";
import type { SettingsSchema } from "../extensions/types";

// Manifest settings schema covering every field type so the
// `isValidForField` clamp logic is exercised across its branches.
const SCHEMA: SettingsSchema = {
  theme: {
    type: "select",
    label: "Theme",
    options: [
      { value: "dark", label: "Dark" },
      { value: "light", label: "Light" },
    ],
    default: "dark",
  },
  nick: { type: "text", label: "Nickname", default: "anon", maxLength: 8 },
  count: { type: "number", label: "Count", default: 3, min: 0, max: 10, integer: true },
  flag: { type: "boolean", label: "Flag" }, // intentionally no default
};

const USER_ID = "11111111-1111-1111-1111-111111111111";
let extId: string;

async function seed(): Promise<void> {
  const db = getTestDb();
  await db.insert(users).values({
    id: USER_ID,
    email: "settings@example.com",
    passwordHash: "x",
    name: "Settings User",
  });
  const rows = await db
    .insert(extensions)
    .values({
      name: "settings-ext",
      version: "1.0.0",
      source: "test:fixture",
      manifest: sql`${JSON.stringify({
        schemaVersion: 2,
        name: "settings-ext",
        version: "1.0.0",
        description: "",
        author: { name: "test" },
        kind: "subprocess",
        entrypoint: { command: ["true"] },
        settings: SCHEMA,
      })}::jsonb`,
    })
    .returning({ id: extensions.id });
  extId = rows[0]!.id;
}

beforeEach(async () => {
  await setupTestDb();
  await seed();
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

describe("getDeclaredDefaults (pure)", () => {
  test("returns {} for undefined schema", () => {
    expect(getDeclaredDefaults(undefined)).toEqual({});
  });

  test("pulls only fields that declare a default", () => {
    expect(getDeclaredDefaults(SCHEMA)).toEqual({
      theme: "dark",
      nick: "anon",
      count: 3,
      // `flag` has no default and is omitted
    });
  });
});

describe("clampSettings (pure)", () => {
  test("returns {} for undefined schema", () => {
    expect(clampSettings(undefined, { theme: "dark" })).toEqual({});
  });

  test("returns {} for non-object / array / null values", () => {
    expect(clampSettings(SCHEMA, null)).toEqual({});
    expect(clampSettings(SCHEMA, "nope")).toEqual({});
    expect(clampSettings(SCHEMA, [1, 2, 3])).toEqual({});
  });

  test("drops unknown keys and invalid values, keeps valid ones", () => {
    const out = clampSettings(SCHEMA, {
      theme: "dark", // valid select
      nick: "toolongtoolong", // invalid: exceeds maxLength 8 → dropped
      count: 4, // valid number
      flag: "yes", // invalid: not boolean → dropped
      bogus: 1, // unknown key → dropped
    });
    expect(out).toEqual({ theme: "dark", count: 4 });
  });

  test("drops secret fields UNCONDITIONALLY — plaintext never persists in the blob", () => {
    const schemaWithSecret: SettingsSchema = {
      ...SCHEMA,
      api_token: { type: "secret", label: "API token", storageKey: "api-token" },
    };
    const out = clampSettings(schemaWithSecret, {
      theme: "light",
      // A value that WOULD pass isValidForField for a secret — the clamp
      // must still drop it (secrets are stored encrypted in extension
      // storage by the host, never in extension_settings_user JSON).
      api_token: "totally-valid-secret-value",
    });
    expect(out).toEqual({ theme: "light" });
    expect(JSON.stringify(out)).not.toContain("totally-valid-secret-value");
  });
});

describe("getDeclaredDefaults — secret fields", () => {
  test("secret fields never contribute a default", () => {
    const schemaWithSecret: SettingsSchema = {
      ...SCHEMA,
      api_token: { type: "secret", label: "API token", storageKey: "api-token" },
    };
    expect(getDeclaredDefaults(schemaWithSecret)).toEqual({
      theme: "dark",
      nick: "anon",
      count: 3,
    });
  });
});

describe("getUserSettings", () => {
  test("returns {} when no row exists", async () => {
    expect(await getUserSettings(USER_ID, extId)).toEqual({});
  });

  test("returns stored values after a write", async () => {
    await setUserSettings(USER_ID, extId, { theme: "light", count: 5 });
    expect(await getUserSettings(USER_ID, extId)).toEqual({ theme: "light", count: 5 });
  });
});

describe("setUserSettings", () => {
  test("clamps against the manifest schema on insert", async () => {
    await setUserSettings(USER_ID, extId, {
      theme: "light",
      nick: "waytoolong", // dropped by clamp
      junk: true, // dropped
    });
    expect(await getUserSettings(USER_ID, extId)).toEqual({ theme: "light" });
  });

  test("upserts on conflict (second write replaces the first)", async () => {
    await setUserSettings(USER_ID, extId, { theme: "dark" });
    await setUserSettings(USER_ID, extId, { theme: "light", count: 2 });
    expect(await getUserSettings(USER_ID, extId)).toEqual({ theme: "light", count: 2 });
  });

  test("writes {} when the extension has no settings schema", async () => {
    const db = getTestDb();
    const rows = await db
      .insert(extensions)
      .values({
        name: "no-settings-ext",
        version: "1.0.0",
        source: "test:fixture",
        manifest: sql`${JSON.stringify({
          schemaVersion: 2,
          name: "no-settings-ext",
          version: "1.0.0",
          description: "",
          author: { name: "test" },
          kind: "subprocess",
          entrypoint: { command: ["true"] },
        })}::jsonb`,
      })
      .returning({ id: extensions.id });
    await setUserSettings(USER_ID, rows[0]!.id, { anything: 1 });
    expect(await getUserSettings(USER_ID, rows[0]!.id)).toEqual({});
  });
});

describe("clearUserSettings", () => {
  test("removes the row", async () => {
    await setUserSettings(USER_ID, extId, { theme: "light" });
    await clearUserSettings(USER_ID, extId);
    expect(await getUserSettings(USER_ID, extId)).toEqual({});
  });

  test("is a no-op when no row exists", async () => {
    await clearUserSettings(USER_ID, extId);
    expect(await getUserSettings(USER_ID, extId)).toEqual({});
  });
});

describe("resolveExtensionSettings", () => {
  test("returns {} when the manifest has no settings block", async () => {
    const db = getTestDb();
    const rows = await db
      .insert(extensions)
      .values({
        name: "bare-ext",
        version: "1.0.0",
        source: "test:fixture",
        manifest: sql`${JSON.stringify({
          schemaVersion: 2,
          name: "bare-ext",
          version: "1.0.0",
          description: "",
          author: { name: "test" },
          kind: "subprocess",
          entrypoint: { command: ["true"] },
        })}::jsonb`,
      })
      .returning({ id: extensions.id });
    expect(await resolveExtensionSettings(rows[0]!.id, USER_ID)).toEqual({});
  });

  test("returns declared defaults only when userId is null", async () => {
    expect(await resolveExtensionSettings(extId, null)).toEqual({
      theme: "dark",
      nick: "anon",
      count: 3,
    });
  });

  test("merges declared defaults under the user override", async () => {
    await setUserSettings(USER_ID, extId, { theme: "light", count: 7 });
    expect(await resolveExtensionSettings(extId, USER_ID)).toEqual({
      theme: "light", // overridden
      nick: "anon", // default
      count: 7, // overridden
    });
  });

  test("accepts an in-hand schema and skips the manifest DB lookup", async () => {
    // A non-existent extensionId would yield {} via the DB path; passing the
    // schema directly proves the lookup is bypassed.
    expect(await resolveExtensionSettings("does-not-exist", null, SCHEMA)).toEqual({
      theme: "dark",
      nick: "anon",
      count: 3,
    });
  });
});
