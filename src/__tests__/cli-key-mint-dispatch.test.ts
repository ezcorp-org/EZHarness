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
// `--locked-mode` is validated against the modes the KEY OWNER can see, so the
// dispatch reads the modes table. `mode-ok` is the one visible mode.
mock.module("../db/queries/modes", () => ({
  getVisibleMode: async (id: string) => (id === "mode-ok" ? { id } : null),
}));

const { cli } = await import("../cli");

let logs: string[] = [];
let errs: string[] = [];
let warns: string[] = [];
const origLog = console.log;
const origErr = console.error;
const origWarn = console.warn;
beforeEach(() => {
  logs = []; errs = []; warns = []; settings.length = 0; initDbError = null;
  console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { errs.push(a.join(" ")); };
  console.warn = (...a: unknown[]) => { warns.push(a.join(" ")); };
});
afterEach(() => { console.log = origLog; console.error = origErr; console.warn = origWarn; });
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

  test("defaults user to the admin and scopes to read,write,chat", async () => {
    // `write` joined the default in 2026-08 when the mutating handlers moved
    // off `read` — without it the default key could observe a conversation but
    // not save a memory, an authority the old default did carry. See
    // docs/audit/2026-08-read-scope-mutation-inventory.md.
    await cli(["key", "mint"]);
    const out = logs.join("\n");
    expect(out).toContain("admin@x.test");
    expect(out).toContain("read, write, chat");
  });

  test("help lists the key mint command", async () => {
    await cli(["help"]);
    expect(logs.join("\n")).toContain("key mint");
  });

  // F2 follow-up: admin routes authorize on BOTH axes, so an admin-ROLE key
  // minted without the admin SCOPE is refused by every admin surface. That is
  // intended, but it must not be minted SILENTLY — the operator would only
  // discover it from a 403 later.
  test("warns (but still mints) when --role admin lacks the admin scope", async () => {
    await cli(["key", "mint", "--user", "admin@x.test", "--scopes", "read", "--role", "admin"]);
    const warned = warns.join("\n");
    expect(warned).toContain('role "admin" but NOT the "admin" scope');
    // Names the symptom the operator will otherwise meet…
    expect(warned).toContain("Insufficient scope");
    // …and the exact fix.
    expect(warned).toContain("--scopes admin --role admin");
    // NOT a refusal: the key is still minted and printed.
    expect(logs.join("\n")).toMatch(/ezk_[A-Za-z0-9_-]+/);
    expect(settings.find(([k]) => k.startsWith("apikey:u-admin:"))).toBeDefined();
    // Warning goes to stderr so stdout stays scrapeable for the raw key.
    expect(logs.join("\n")).not.toContain("WARNING");
  });

  test("does NOT warn when --role admin carries the admin scope", async () => {
    await cli([
      "key", "mint", "--user", "admin@x.test", "--scopes", "read,admin", "--role", "admin",
    ]);
    expect(warns.join("\n")).toBe("");
    expect(logs.join("\n")).toContain("role:   admin");
  });

  test("does NOT warn for a plain member-role key", async () => {
    await cli(["key", "mint", "--user", "admin@x.test", "--scopes", "read"]);
    expect(warns.join("\n")).toBe("");
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

  // Role-carrying keys: default is member; --role admin is allowed only for an
  // admin owner (role ceiling), mirroring the scope ceiling.
  test("mints a member-role key by default (prints role: member)", async () => {
    await cli(["key", "mint", "--user", "admin@x.test"]);
    expect(logs.join("\n")).toContain("role:   member");
    const row = settings.find(([k]) => k.startsWith("apikey:u-admin:"));
    expect(row?.[1]).toMatchObject({ role: "member" });
  });

  test("--role admin persists an admin-role key for an admin owner and prints it", async () => {
    await cli(["key", "mint", "--user", "admin@x.test", "--role", "admin"]);
    expect(logs.join("\n")).toContain("role:   admin");
    const row = settings.find(([k]) => k.startsWith("apikey:u-admin:"));
    expect(row?.[1]).toMatchObject({ role: "admin" });
  });

  // Role ceiling: an admin-role key for a NON-admin owner is refused up front
  // (it would clamp to member at verify time anyway).
  test("--role admin for a member owner exits(1) and mints nothing", async () => {
    const code = await captureExit(() =>
      cli(["key", "mint", "--user", "member@x.test", "--role", "admin"]),
    );
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain('cannot mint a "admin"-role key for member@x.test');
    expect(settings.find(([k]) => k.startsWith("apikey:"))).toBeUndefined();
  });

  test("--role member for a member owner is allowed", async () => {
    await cli(["key", "mint", "--user", "member@x.test", "--role", "member"]);
    expect(logs.join("\n")).toContain("role:   member");
    expect(settings.find(([k]) => k.startsWith("apikey:u-member:"))).toBeDefined();
  });

  test("an invalid --role exits(1) and mints nothing", async () => {
    const code = await captureExit(() =>
      cli(["key", "mint", "--user", "admin@x.test", "--role", "superuser"]),
    );
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain('invalid role "superuser"');
    expect(settings.find(([k]) => k.startsWith("apikey:"))).toBeUndefined();
  });

  // ── tool policy ───────────────────────────────────────────────────────
  test("--route-bundle mints a policied key and prints the policy", async () => {
    await cli([
      "key", "mint",
      "--user", "admin@x.test",
      "--route-bundle", "desktop-companion",
      "--locked-mode", "mode-ok",
      "--caller-tools", "open_app",
      "--max-caller-tools", "1",
    ]);
    const row = settings.find(([k]) => k.startsWith("apikey:"));
    expect(row).toBeDefined();
    const policy = (row![1] as { toolPolicy?: Record<string, unknown> }).toolPolicy!;
    expect(policy.lockedModeId).toBe("mode-ok");
    expect(policy.allowedCallerTools).toEqual(["open_app"]);
    expect(policy.maxCallerTools).toBe(1);
    expect((policy.routeAllowlist as string[]).length).toBe(14);
    expect(logs.join("\n")).toContain("policy:");
  });

  test("an unpolicied mint stores NO toolPolicy field and prints no policy line", async () => {
    await cli(["key", "mint", "--user", "admin@x.test"]);
    const row = settings.find(([k]) => k.startsWith("apikey:"));
    expect(Object.keys(row![1] as object)).not.toContain("toolPolicy");
    expect(logs.join("\n")).not.toContain("policy:");
  });

  test("a --locked-mode the owner cannot see exits(1) and mints nothing", async () => {
    const code = await captureExit(() =>
      cli(["key", "mint", "--user", "admin@x.test", "--locked-mode", "mode-nope"]),
    );
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("not a mode visible to the key owner");
    expect(settings.find(([k]) => k.startsWith("apikey:"))).toBeUndefined();
  });

  test("--locked-mode WITHOUT --route-bundle exits(1) and mints nothing", async () => {
    // THE VULNERABILITY, at the surface an operator actually types. This mint
    // used to SUCCEED and print a key whose policy line read like confinement:
    // `{"lockedModeId":"mode-ok"}`. With no routeAllowlist, Boundary 1 binds on
    // positive presence and never engages, so the key reached every route —
    // including the run-start routes that never call `mayUseMode`, where the
    // holder got back the unfiltered tool surface the mode was chosen to deny.
    const code = await captureExit(() =>
      cli(["key", "mint", "--user", "admin@x.test", "--locked-mode", "mode-ok"]),
    );
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("lockedModeId requires a routeAllowlist");
    expect(settings.find(([k]) => k.startsWith("apikey:"))).toBeUndefined();
  });

  test("the refusal tells the operator which flag fixes it", async () => {
    // An operator hits this by writing a reasonable command, so the remedy is
    // part of the contract, not decoration.
    await captureExit(() =>
      cli(["key", "mint", "--user", "admin@x.test", "--locked-mode", "mode-ok"]),
    );
    const out = errs.join("\n");
    expect(out).toContain("--route-bundle");
    expect(out).toContain("desktop-companion");
  });

  test("--locked-mode WITH --route-bundle still mints (the refusal is about reach, not locks)", async () => {
    await cli([
      "key", "mint",
      "--user", "admin@x.test",
      "--route-bundle", "desktop-companion",
      "--locked-mode", "mode-ok",
    ]);
    const row = settings.find(([k]) => k.startsWith("apikey:"));
    expect((row![1] as { toolPolicy: { lockedModeId: string } }).toolPolicy.lockedModeId).toBe("mode-ok");
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
