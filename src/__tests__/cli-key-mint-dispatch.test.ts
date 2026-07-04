/**
 * Covers the `key:mint` CLI dispatch end-to-end (the `case "key:mint"` block
 * in cli()) and printUsage, by driving `cli([...])` with mocked DB/settings
 * and capturing stdout. Complements cli-key-mint.test.ts (which unit-tests the
 * pure helpers).
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

const settings: Array<[string, unknown]> = [];

// Mutable failure injection for initDb — the mock module's export shape
// freezes at first materialization, so the mock delegates to this flag
// instead of being swapped per-test.
let initDbError: Error | null = null;

// Mock the DB surface the dispatch touches, BEFORE importing ../cli.
mock.module("../db/connection", () => ({
  initDb: async () => {
    if (initDbError) throw initDbError;
  },
  getDb: () => ({}),
  closeDb: async () => {},
}));
mock.module("../db/queries/users", () => ({
  getUserByEmail: async (email: string) => {
    if (email === "admin@x.test") return { id: "u-admin", email, role: "admin" };
    if (email === "member@x.test") return { id: "u-member", email, role: "member" };
    return undefined;
  },
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
let errs: string[] = [];
const origLog = console.log;
const origErr = console.error;
beforeEach(() => {
  logs = []; errs = []; settings.length = 0; initDbError = null;
  console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { errs.push(a.join(" ")); };
});
afterEach(() => { console.log = origLog; console.error = origErr; });
afterAll(() => restoreModuleMocks());

/** Run cli(...), capturing a process.exit(code) as a thrown sentinel. */
async function captureExit(fn: () => Promise<unknown>): Promise<number> {
  const orig = process.exit;
  let code: number | undefined;
  process.exit = ((c?: number): never => { code = c ?? 0; throw new Error(`__exit__:${code}`); }) as typeof process.exit;
  try {
    await fn();
    throw new Error("expected process.exit to be called");
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith("__exit__:")) throw e;
  } finally {
    process.exit = orig;
  }
  return code!;
}

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

  // FINDING B: a non-admin-bound key may NOT carry the admin scope.
  test("rejects minting admin scope for a non-admin user (exit 1, no key written)", async () => {
    const code = await captureExit(() =>
      cli(["key", "mint", "--user", "member@x.test", "--scopes", "read,admin"]),
    );
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("cannot mint scope(s) admin");
    // Nothing persisted — the ceiling check runs BEFORE the mint.
    expect(settings.find(([k]) => k.startsWith("apikey:"))).toBeUndefined();
  });

  test("allows an admin user to mint the admin scope", async () => {
    await cli(["key", "mint", "--user", "admin@x.test", "--scopes", "read,admin"]);
    const out = logs.join("\n");
    expect(out).toContain("Minted API key for admin@x.test");
    expect(out).toContain("read, admin");
    expect(settings.find(([k]) => k.startsWith("apikey:u-admin:"))).toBeDefined();
  });

  // The datadir-in-use guard: minting against a LIVE server's PGlite dir
  // must exit 1 with the remediation message, not a stack trace — and must
  // not mint anything.
  test("DbInUseError from initDb → friendly message + exit 1, nothing minted", async () => {
    const { DbInUseError } = await import("../db/live-holder-guard");
    initDbError = new DbInUseError("/data/ezcorp", 1234);
    const code = await captureExit(() => cli(["key", "mint"]));
    expect(code).toBe(1);
    const err = errs.join("\n");
    expect(err).toContain("Error: The EZCorp database at /data/ezcorp is open in another EZCorp process (pid 1234)");
    expect(err).toContain("single-writer");
    expect(settings.find(([k]) => k.startsWith("apikey:"))).toBeUndefined();
  });

  test("a non-DbInUseError initDb failure still propagates", async () => {
    initDbError = new Error("boom");
    await expect(cli(["key", "mint"])).rejects.toThrow("boom");
  });
});
