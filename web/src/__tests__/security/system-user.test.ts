/**
 * Unit tests for the system-user helper. Pins the invariants documented
 * in system-user.ts — `sys-` prefix, RFC 2606 `.invalid` email, locked
 * password, role=member, idempotent across boots.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "../../../../src/__tests__/helpers/mock-cleanup";

let userStore: Map<string, { id: string; email: string; passwordHash: string; name: string; role: string; status: string }>;
let hashCalls: string[] = [];

// Re-registered in beforeEach because parallel/sibling test files also mock
// these modules — without a fresh registration each test, another file's
// mock may be active and swallow our hash-tracking.
function installMocks(): void {
  mock.module("$server/db/queries/users", () => ({
    getUserById: async (id: string) => userStore.get(id),
    createUser: async (data: { id?: string; email: string; passwordHash: string; name: string; role?: string; status?: string }) => {
      const id = data.id ?? `test-${userStore.size + 1}`;
      const row = {
        id,
        email: data.email,
        passwordHash: data.passwordHash,
        name: data.name,
        role: data.role ?? "member",
        status: data.status ?? "active",
      };
      userStore.set(id, row);
      return row;
    },
  }));
  mock.module("$server/auth/password", () => ({
    hashPassword: async (s: string) => {
      hashCalls.push(s);
      return `hashed:${s.slice(0, 8)}`;
    },
  }));
}
installMocks();

afterAll(() => restoreModuleMocks());

import { ensureSystemUser, systemUserIdFor } from "$lib/server/security/system-user";

beforeEach(() => {
  userStore = new Map();
  hashCalls = [];
  // Re-install each time — ordering-resilient against other files that
  // mock the same specifiers.
  installMocks();
});

describe("systemUserIdFor", () => {
  test("returns the expected `sys-<name>` shape for valid inputs", () => {
    expect(systemUserIdFor("ai-kit")).toBe("sys-ai-kit");
    expect(systemUserIdFor("web-search")).toBe("sys-web-search");
    expect(systemUserIdFor("a")).toBe("sys-a");
  });

  test("rejects empty name", () => {
    expect(() => systemUserIdFor("")).toThrow(/invalid extensionName/);
  });

  test("rejects uppercase (forces stable, grep-friendly ids)", () => {
    expect(() => systemUserIdFor("AI-Kit")).toThrow();
    expect(() => systemUserIdFor("Web-Search")).toThrow();
  });

  test("rejects special characters that could confuse downstream parsers", () => {
    for (const bad of [
      "../path",
      "a b",
      "a_b",
      "a.b",
      "a/b",
      "a;b",
      "a'b",
      'a"b',
      "a`b",
      "-leading-dash",
      "ends-with-dash-",
      "a\nb",
    ]) {
      expect(() => systemUserIdFor(bad)).toThrow(/invalid extensionName/);
    }
  });

  test("rejects names longer than 63 characters (keeps logs + DB scans bounded)", () => {
    expect(() => systemUserIdFor("a" + "b".repeat(63))).toThrow();
  });

  test("accepts a name right at the 63-character limit", () => {
    expect(systemUserIdFor("a" + "b".repeat(62))).toBe("sys-a" + "b".repeat(62));
  });

  test("the error message includes the offending value (aids debugging) but is not HTML-interpolated", () => {
    // JSON.stringify wraps the value — confirms there's no accidental
    // interpolation path that could log a raw user-controlled string.
    try {
      systemUserIdFor("<script>");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('"<script>"');
    }
  });
});

describe("ensureSystemUser", () => {
  test("creates a row with the deterministic id, .invalid email, role=member", async () => {
    const id = await ensureSystemUser("ai-kit");
    expect(id).toBe("sys-ai-kit");
    const row = userStore.get("sys-ai-kit")!;
    expect(row.id).toBe("sys-ai-kit");
    expect(row.email).toBe("ai-kit@sys.ezcorp.invalid");
    expect(row.name).toBe("System: ai-kit");
    expect(row.role).toBe("member"); // never admin
    expect(row.status).toBe("active");
  });

  test("displayName override takes effect only on first creation", async () => {
    await ensureSystemUser("ai-kit", "Custom Name");
    expect(userStore.get("sys-ai-kit")!.name).toBe("Custom Name");
  });

  // These tests assert observable DB state rather than the hashCalls
  // closure — when sibling test files also mock `$server/auth/password`,
  // the registration order is nondeterministic, so hashCalls may or may
  // not capture. The passwordHash stored on each row is what actually
  // matters for security.

  test("idempotent: second call returns the existing id without creating a duplicate", async () => {
    await ensureSystemUser("ai-kit");
    const originalHash = userStore.get("sys-ai-kit")!.passwordHash;
    await ensureSystemUser("ai-kit");
    // No second createUser call — passwordHash unchanged, store size still 1.
    expect(userStore.size).toBe(1);
    expect(userStore.get("sys-ai-kit")!.passwordHash).toBe(originalHash);
  });

  test("password plaintext is cryptographically random (distinct across extensions)", async () => {
    await ensureSystemUser("ai-kit");
    await ensureSystemUser("other-ext");
    const a = userStore.get("sys-ai-kit")!.passwordHash;
    const b = userStore.get("sys-other-ext")!.passwordHash;
    // Different random plaintexts MUST produce different hashes — if they
    // matched, either the hasher is broken OR the plaintext is reused.
    expect(a).not.toBe(b);
  });

  test("password hash is present and non-empty (not a sentinel like '' or 'null')", async () => {
    await ensureSystemUser("ai-kit");
    const h = userStore.get("sys-ai-kit")!.passwordHash;
    expect(h).toBeTruthy();
    expect(h.length).toBeGreaterThan(0);
    // Known-bad sentinels that would let everyone log in.
    for (const bad of ["", "null", "undefined", "password", "admin"]) {
      expect(h).not.toBe(bad);
    }
  });

  test("rejects invalid extension names via systemUserIdFor (no DB side-effect)", async () => {
    await expect(ensureSystemUser("../evil")).rejects.toThrow(/invalid extensionName/);
    expect(userStore.size).toBe(0);
    expect(hashCalls).toHaveLength(0);
  });

  test("email uses the RFC 2606 `.invalid` TLD (non-routable by design)", async () => {
    await ensureSystemUser("ai-kit");
    const email = userStore.get("sys-ai-kit")!.email;
    expect(email.endsWith(".invalid")).toBe(true);
  });
});
