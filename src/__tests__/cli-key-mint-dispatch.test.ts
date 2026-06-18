/**
 * Covers the `key:mint` CLI dispatch end-to-end (the `case "key:mint"` block
 * in cli()) and printUsage, by driving `cli([...])` with mocked DB/settings
 * and capturing stdout. Complements cli-key-mint.test.ts (which unit-tests the
 * pure helpers).
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

const settings: Array<[string, unknown]> = [];

// Mock the DB surface the dispatch touches, BEFORE importing ../cli.
mock.module("../db/connection", () => ({
  initDb: async () => {},
  getDb: () => ({}),
  closeDb: async () => {},
}));
mock.module("../db/queries/users", () => ({
  getUserByEmail: async (email: string) =>
    email === "admin@x.test" ? { id: "u-admin", email, role: "admin" } : undefined,
  getUserById: async () => undefined,
  listUsers: async () => [{ id: "u-admin", email: "admin@x.test", role: "admin" }],
}));
mock.module("../db/queries/settings", () => ({
  upsertSetting: async (k: string, v: unknown) => { settings.push([k, v]); },
  getSetting: async () => undefined,
  getAllSettings: async () => ({}),
}));

const { cli } = await import("../cli");

let logs: string[] = [];
const origLog = console.log;
beforeEach(() => { logs = []; settings.length = 0; console.log = (...a: unknown[]) => { logs.push(a.join(" ")); }; });
afterEach(() => { console.log = origLog; });
afterAll(() => restoreModuleMocks());

describe("cli key:mint dispatch", () => {
  test("mints a key for the resolved user, prints it once, persists the hash", async () => {
    await cli(["key", "mint", "--user", "admin@x.test", "--scopes", "read,chat"]);
    const out = logs.join("\n");
    expect(out).toContain("Minted API key for admin@x.test");
    expect(out).toContain("read, chat");
    expect(out).toMatch(/ezk_[A-Za-z0-9_-]+/); // raw key printed once
    // Persisted under the user's apikey: prefix, hash only (no raw key in value).
    const row = settings.find(([k]) => k.startsWith("apikey:u-admin:"));
    expect(row).toBeDefined();
    expect(JSON.stringify(row?.[1])).not.toMatch(/ezk_/);
  });

  test("defaults user to the admin and scopes to read,chat", async () => {
    await cli(["key", "mint"]);
    const out = logs.join("\n");
    expect(out).toContain("admin@x.test");
    expect(out).toContain("read, chat");
  });

  test("help lists the key mint command", async () => {
    await cli(["help"]);
    expect(logs.join("\n")).toContain("key mint");
  });
});
