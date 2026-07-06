/**
 * Unit tests for the `key mint` CLI command — arg parsing, scope
 * validation, and user resolution. These are the pure/branching pieces of
 * the remote-control auth bootstrap; the settings write is covered by the
 * shared api-key primitives + the mint-key route tests.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

interface FakeUser { id: string; email: string; role: string }

let users: FakeUser[] = [];
let byEmail: Record<string, FakeUser> = {};
let byId: Record<string, FakeUser> = {};

// Mock the users-query module BEFORE importing ../cli (cli.ts imports these
// at module top). Paths are relative to THIS file (src/__tests__/).
function installUserMocks(): void {
  mock.module("../db/queries/users", () => ({
    listUsers: async () => users,
    getUserByEmail: async (email: string) => byEmail[email],
    getUserById: async (id: string) => byId[id],
  }));
}
installUserMocks();

const { parseArgs, parseKeyScopes, resolveKeyMintUser } = await import("../cli");
const { scopesOverCeiling, canMintRole, isApiKeyRole } = await import("../auth/api-key");

beforeEach(() => {
  users = [];
  byEmail = {};
  byId = {};
  installUserMocks();
});

afterAll(() => {
  restoreModuleMocks();
});

/** Run `fn`, capturing a process.exit(code) as a thrown sentinel so we can
 *  assert the exit path without killing the test runner. */
async function captureExit(fn: () => unknown | Promise<unknown>): Promise<number> {
  const orig = process.exit;
  let code: number | undefined;
  process.exit = ((c?: number): never => {
    code = c ?? 0;
    throw new Error(`__exit__:${code}`);
  }) as typeof process.exit;
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

describe("parseArgs: key mint", () => {
  test("bare `key mint` → command with no flags", () => {
    const p = parseArgs(["key", "mint"]);
    expect(p.command).toBe("key:mint");
    expect(p.scopes).toBeUndefined();
    expect(p.userRef).toBeUndefined();
    expect(p.keyName).toBeUndefined();
  });

  test("all flags parsed", () => {
    const p = parseArgs(["key", "mint", "--scopes", "read,admin", "--user", "a@b.com", "--name", "ci"]);
    expect(p.command).toBe("key:mint");
    expect(p.scopes).toBe("read,admin");
    expect(p.userRef).toBe("a@b.com");
    expect(p.keyName).toBe("ci");
  });

  test("unknown key subcommand → help", () => {
    expect(parseArgs(["key", "bogus"]).command).toBe("help");
    expect(parseArgs(["key"]).command).toBe("help");
  });
});

describe("parseKeyScopes", () => {
  test("undefined / empty → default read,chat", () => {
    expect(parseKeyScopes(undefined)).toEqual(["read", "chat"]);
    expect(parseKeyScopes("")).toEqual(["read", "chat"]);
    expect(parseKeyScopes("  ,  ")).toEqual(["read", "chat"]);
  });

  test("all valid scopes pass through", () => {
    expect(parseKeyScopes("read,chat,extensions,admin")).toEqual(["read", "chat", "extensions", "admin"]);
  });

  test("trims + de-dupes preserving order", () => {
    expect(parseKeyScopes(" read , read , admin ")).toEqual(["read", "admin"]);
  });

  test("invalid scope exits(1)", async () => {
    expect(await captureExit(() => parseKeyScopes("read,frobnicate"))).toBe(1);
  });
});

describe("resolveKeyMintUser", () => {
  // role is now part of the result so the scope-ceiling check (FINDING B)
  // can be enforced in the key:mint dispatch.
  test("--user matches by email (carries role)", async () => {
    byEmail["a@b.com"] = { id: "u1", email: "a@b.com", role: "member" };
    expect(await resolveKeyMintUser("a@b.com")).toEqual({ id: "u1", email: "a@b.com", role: "member" });
  });

  test("--user falls back to id lookup when email misses (carries role)", async () => {
    byId["u2"] = { id: "u2", email: "x@y.com", role: "admin" };
    expect(await resolveKeyMintUser("u2")).toEqual({ id: "u2", email: "x@y.com", role: "admin" });
  });

  test("--user with no match exits(1)", async () => {
    expect(await captureExit(() => resolveKeyMintUser("nope"))).toBe(1);
  });

  test("no --user → prefers admin (carries role)", async () => {
    users = [
      { id: "m", email: "m@x", role: "member" },
      { id: "a", email: "a@x", role: "admin" },
    ];
    expect(await resolveKeyMintUser(undefined)).toEqual({ id: "a", email: "a@x", role: "admin" });
  });

  test("no --user, no admin → first user (carries role)", async () => {
    users = [{ id: "m", email: "m@x", role: "member" }];
    expect(await resolveKeyMintUser(undefined)).toEqual({ id: "m", email: "m@x", role: "member" });
  });

  test("no --user, no users → exits(1)", async () => {
    users = [];
    expect(await captureExit(() => resolveKeyMintUser(undefined))).toBe(1);
  });
});

describe("scopesOverCeiling (FINDING B: scope ceiling)", () => {
  test("admin may mint any scope, including admin", () => {
    expect(scopesOverCeiling("admin", ["read", "chat", "extensions", "admin"])).toEqual([]);
  });

  test("non-admin may mint non-privileged scopes", () => {
    expect(scopesOverCeiling("member", ["read", "chat", "extensions"])).toEqual([]);
  });

  test("non-admin requesting admin scope is over ceiling", () => {
    expect(scopesOverCeiling("member", ["read", "admin"])).toEqual(["admin"]);
  });

  test("undefined role is treated as non-admin", () => {
    expect(scopesOverCeiling(undefined, ["admin"])).toEqual(["admin"]);
  });
});

describe("isApiKeyRole", () => {
  test("accepts the two canonical roles", () => {
    expect(isApiKeyRole("member")).toBe(true);
    expect(isApiKeyRole("admin")).toBe(true);
  });

  test("rejects anything else", () => {
    expect(isApiKeyRole("owner")).toBe(false);
    expect(isApiKeyRole("")).toBe(false);
    expect(isApiKeyRole("Admin")).toBe(false);
  });
});

describe("canMintRole (role anti-escalation)", () => {
  test("anyone may mint a member-role key", () => {
    expect(canMintRole("member", "member")).toBe(true);
    expect(canMintRole("admin", "member")).toBe(true);
    expect(canMintRole(undefined, "member")).toBe(true);
  });

  test("only an admin actor may mint an admin-role key", () => {
    expect(canMintRole("admin", "admin")).toBe(true);
  });

  test("a non-admin actor may NOT mint an admin-role key", () => {
    expect(canMintRole("member", "admin")).toBe(false);
    expect(canMintRole(undefined, "admin")).toBe(false);
  });
});
