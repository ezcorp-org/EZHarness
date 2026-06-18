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
  test("--user matches by email", async () => {
    byEmail["a@b.com"] = { id: "u1", email: "a@b.com", role: "member" };
    expect(await resolveKeyMintUser("a@b.com")).toEqual({ id: "u1", email: "a@b.com" });
  });

  test("--user falls back to id lookup when email misses", async () => {
    byId["u2"] = { id: "u2", email: "x@y.com", role: "member" };
    expect(await resolveKeyMintUser("u2")).toEqual({ id: "u2", email: "x@y.com" });
  });

  test("--user with no match exits(1)", async () => {
    expect(await captureExit(() => resolveKeyMintUser("nope"))).toBe(1);
  });

  test("no --user → prefers admin", async () => {
    users = [
      { id: "m", email: "m@x", role: "member" },
      { id: "a", email: "a@x", role: "admin" },
    ];
    expect(await resolveKeyMintUser(undefined)).toEqual({ id: "a", email: "a@x" });
  });

  test("no --user, no admin → first user", async () => {
    users = [{ id: "m", email: "m@x", role: "member" }];
    expect(await resolveKeyMintUser(undefined)).toEqual({ id: "m", email: "m@x" });
  });

  test("no --user, no users → exits(1)", async () => {
    users = [];
    expect(await captureExit(() => resolveKeyMintUser(undefined))).toBe(1);
  });
});
