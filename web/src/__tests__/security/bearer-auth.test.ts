/**
 * Integration tests for the Bearer-token router that lives between the
 * SvelteKit hook and the verifier modules. Validates the security
 * contract:
 *
 *   - Internal-prefixed tokens route to verifyInternalKey only.
 *   - A failed internal verification NEVER falls through to verifyApiKey.
 *   - A non-loopback request carrying an internal-prefixed token looks
 *     identical to an unauth'd request (event.locals unchanged, no DB
 *     call observed).
 *   - User-prefixed tokens route to verifyApiKey.
 *   - Missing / malformed headers no-op.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  provisionInternalKey,
  resetInternalKeyStoreForTests,
  INTERNAL_KEY_PREFIX,
} from "$lib/server/security/internal-auth";
import { restoreModuleMocks } from "../../../../src/__tests__/helpers/mock-cleanup";

// Observe calls to the user-key verifier so we can assert it is NOT
// invoked on the internal-key path. The impl is a mutable let so a
// single test can swap in a throwing body without re-mocking the module
// (which would persist across subsequent tests and cause order-dependent
// failures).
let verifyApiKeyCalls: string[];
let verifyApiKeyImpl: (raw: string) => Promise<
  { userId: string; name: string; scopes: readonly string[]; role: "member" | "admin" } | null
> = async (raw: string) => {
  verifyApiKeyCalls.push(raw);
  if (raw === "ezk_valid") return { userId: "user-1", name: "Test", scopes: ["chat"], role: "member" };
  // A role-carrying admin key whose owner is a current admin.
  if (raw === "ezk_admin") return { userId: "user-2", name: "Admin Key", scopes: ["read", "admin"], role: "admin" };
  // Admin-ROLE key whose owner has since been DEMOTED to member.
  if (raw === "ezk_demoted") return { userId: "user-demoted", name: "Demoted Key", scopes: ["read", "admin"], role: "admin" };
  // Admin-ROLE key whose owner has since been BANNED (status inactive).
  if (raw === "ezk_banned") return { userId: "user-banned", name: "Banned Key", scopes: ["read", "admin"], role: "admin" };
  // Key whose owner row no longer exists (deleted out of band).
  if (raw === "ezk_orphan") return { userId: "user-orphan", name: "Orphan Key", scopes: ["read"], role: "admin" };
  // Member-ROLE key owned by a current admin — the min-clamp keeps it member.
  if (raw === "ezk_member_adminowner") return { userId: "user-2", name: "Member Key", scopes: ["read"], role: "member" };
  return null;
};
mock.module("$lib/server/security/api-keys", () => ({
  verifyApiKey: (raw: string) => verifyApiKeyImpl(raw),
}));

// Stub the users query so on-behalf-of validation has a real user row to
// resolve. `geff` is our canonical human user; `ghost` is an id that does
// NOT exist — used to assert the middleware refuses to override onto
// non-existent users. The `status` field lets individual tests assert the
// inactive-user rejection path.
interface StubUser { id: string; name: string; role: string; status: string }
const userStore = new Map<string, StubUser>();
mock.module("$server/db/queries/users", () => ({
  getUserById: async (id: string) => userStore.get(id),
}));

afterAll(() => restoreModuleMocks());

// Import AFTER the mock so attachBearerAuth resolves to the stubbed verifier.
import { attachBearerAuth, type BearerAuthEvent } from "$lib/server/security/bearer-auth";

function makeEvent(
  remoteAddress: string | undefined = "127.0.0.1",
  onBehalfOfHeader: string | null = null,
  proxyForwardedHeadersPresent = false,
): BearerAuthEvent {
  return {
    locals: {},
    remoteAddress,
    onBehalfOfHeader,
    proxyForwardedHeadersPresent,
  };
}

beforeEach(() => {
  resetInternalKeyStoreForTests();
  verifyApiKeyCalls = [];
  userStore.clear();
  userStore.set("geff", { id: "geff", name: "Geff", role: "member", status: "active" });
  userStore.set("admin-123", { id: "admin-123", name: "Admin", role: "admin", status: "active" });
  // Owners for the ezk_ user-key fixtures. Owner re-validation loads these.
  userStore.set("user-1", { id: "user-1", name: "Test", role: "member", status: "active" });
  userStore.set("user-2", { id: "user-2", name: "Admin Owner", role: "admin", status: "active" });
  userStore.set("user-demoted", { id: "user-demoted", name: "Demoted", role: "member", status: "active" });
  userStore.set("user-banned", { id: "user-banned", name: "Banned", role: "admin", status: "inactive" });
  // `user-orphan` intentionally absent — models a deleted owner.
});

// ── No header / wrong scheme ─────────────────────────────────────────────────

describe("attachBearerAuth — headers", () => {
  test("no-op when header is null", async () => {
    const evt = makeEvent();
    expect(await attachBearerAuth(evt, null)).toBe(false);
    expect(evt.locals.user).toBeUndefined();
  });

  test("no-op when header is undefined", async () => {
    const evt = makeEvent();
    expect(await attachBearerAuth(evt, undefined)).toBe(false);
    expect(evt.locals.user).toBeUndefined();
  });

  test("no-op for non-Bearer scheme (Basic, Negotiate)", async () => {
    const evt = makeEvent();
    expect(await attachBearerAuth(evt, "Basic dXNlcjpwYXNz")).toBe(false);
    expect(await attachBearerAuth(evt, "Negotiate abc")).toBe(false);
    expect(evt.locals.user).toBeUndefined();
  });
});

// ── Internal key routing ─────────────────────────────────────────────────────

describe("attachBearerAuth — internal keys", () => {
  test("valid internal key from loopback populates sys: principal", async () => {
    const { raw } = provisionInternalKey("ai-kit", ["chat", "read"], "sys-ai-kit");
    const evt = makeEvent("127.0.0.1");
    expect(await attachBearerAuth(evt, `Bearer ${raw}`)).toBe(true);
    expect(evt.locals.user).toMatchObject({
      id: "sys-ai-kit",
      name: "internal:ai-kit",
      role: "member",
    });
    expect(evt.locals.apiKeyScopes).toEqual(["chat", "read"]);
    // Critical: user-key verifier must NOT have been consulted.
    expect(verifyApiKeyCalls).toHaveLength(0);
  });

  test("internal key from non-loopback is rejected WITHOUT falling through to verifyApiKey", async () => {
    const { raw } = provisionInternalKey("ai-kit", ["chat"], "sys-ai-kit");
    const evt = makeEvent("10.0.0.1");
    expect(await attachBearerAuth(evt, `Bearer ${raw}`)).toBe(false);
    expect(evt.locals.user).toBeUndefined();
    expect(verifyApiKeyCalls).toHaveLength(0);
  });

  test("forged internal-prefixed token (not in store) is rejected without fallthrough", async () => {
    const forged = INTERNAL_KEY_PREFIX + "A".repeat(43);
    const evt = makeEvent("127.0.0.1");
    expect(await attachBearerAuth(evt, `Bearer ${forged}`)).toBe(false);
    expect(evt.locals.user).toBeUndefined();
    // The fallthrough-prevention rule: even if the "key" looks like a user
    // key once you strip the prefix, we must not probe verifyApiKey.
    expect(verifyApiKeyCalls).toHaveLength(0);
  });

  test("revoked internal key rejected, no fallthrough", async () => {
    const { raw } = provisionInternalKey("ai-kit", ["chat"], "sys-ai-kit");
    resetInternalKeyStoreForTests(); // simulates revoke / server restart
    const evt = makeEvent("127.0.0.1");
    expect(await attachBearerAuth(evt, `Bearer ${raw}`)).toBe(false);
    expect(verifyApiKeyCalls).toHaveLength(0);
  });

  test("undefined remoteAddress (unix-socket case) still verifies internal key", async () => {
    const { raw } = provisionInternalKey("ai-kit", ["chat"], "sys-ai-kit");
    const evt = makeEvent(undefined);
    expect(await attachBearerAuth(evt, `Bearer ${raw}`)).toBe(true);
    expect(evt.locals.user?.id).toBe("sys-ai-kit");
  });

  test("internal key from loopback BUT behind a reverse proxy is REJECTED (x-forwarded-for present)", async () => {
    // Production scenario: nginx terminates TLS and proxies to
    // http://127.0.0.1:3000. Every proxied request appears to come from
    // the loopback peer. Without this defense, a remote attacker with a
    // leaked internal key could auth as a system principal.
    const { raw } = provisionInternalKey("ai-kit", ["chat"], "sys-ai-kit");
    const evt = makeEvent("127.0.0.1", null, true); // proxy header present
    expect(await attachBearerAuth(evt, `Bearer ${raw}`)).toBe(false);
    expect(evt.locals.user).toBeUndefined();
  });

  test("direct bundled-subprocess call (no proxy headers, loopback peer) still accepted", async () => {
    // Contrapositive of the proxy-rejection test: the legitimate flow
    // must still work. ai-kit's subprocess calls http://127.0.0.1:PORT
    // directly without any proxy headers.
    const { raw } = provisionInternalKey("ai-kit", ["chat"], "sys-ai-kit");
    const evt = makeEvent("127.0.0.1", null, false);
    expect(await attachBearerAuth(evt, `Bearer ${raw}`)).toBe(true);
    expect(evt.locals.user?.id).toBe("sys-ai-kit");
  });
});

// ── User key routing ─────────────────────────────────────────────────────────

describe("attachBearerAuth — user keys", () => {
  test("user-key prefix routes to verifyApiKey", async () => {
    const evt = makeEvent("127.0.0.1");
    expect(await attachBearerAuth(evt, "Bearer ezk_valid")).toBe(true);
    expect(evt.locals.user).toMatchObject({ id: "user-1", name: "Test" });
    expect(evt.locals.apiKeyScopes).toEqual(["chat"]);
    expect(verifyApiKeyCalls).toEqual(["ezk_valid"]);
  });

  test("a member-role key yields a member principal", async () => {
    const evt = makeEvent("127.0.0.1");
    await attachBearerAuth(evt, "Bearer ezk_valid");
    expect(evt.locals.user?.role).toBe("member");
  });

  test("an admin-ROLE key yields an admin principal (reaches requireRole routes)", async () => {
    // The core of role-carrying keys: the ezk_ principal's role comes from
    // the key's stored role CLAMPED to the (currently admin) owner, NOT a
    // hard-coded "member". This is what makes requireRole(admin) routes
    // reachable by an explicitly minted admin key with an admin owner.
    const evt = makeEvent("127.0.0.1");
    expect(await attachBearerAuth(evt, "Bearer ezk_admin")).toBe(true);
    expect(evt.locals.user?.id).toBe("user-2");
    expect(evt.locals.user?.role).toBe("admin");
    expect(evt.locals.apiKeyScopes).toEqual(["read", "admin"]);
  });

  // ── Owner re-validation + role clamp (role is snapshotted at mint) ────
  test("admin-role key whose owner was DEMOTED clamps down to a member principal", async () => {
    const evt = makeEvent("127.0.0.1");
    // Auth still succeeds (the key is valid + owner active) …
    expect(await attachBearerAuth(evt, "Bearer ezk_demoted")).toBe(true);
    // … but the stored admin role is clamped to the owner's CURRENT member role.
    expect(evt.locals.user?.role).toBe("member");
    // Scopes are NOT clamped — pre-existing semantics.
    expect(evt.locals.apiKeyScopes).toEqual(["read", "admin"]);
  });

  test("member-role key owned by a current admin stays member (min-clamp)", async () => {
    const evt = makeEvent("127.0.0.1");
    expect(await attachBearerAuth(evt, "Bearer ezk_member_adminowner")).toBe(true);
    expect(evt.locals.user?.role).toBe("member");
  });

  test("key whose owner is BANNED (status inactive) is rejected outright (401)", async () => {
    const evt = makeEvent("127.0.0.1");
    expect(await attachBearerAuth(evt, "Bearer ezk_banned")).toBe(false);
    expect(evt.locals.user).toBeUndefined();
    expect(evt.locals.apiKeyScopes).toBeUndefined();
  });

  test("key whose owner no longer exists is rejected outright", async () => {
    const evt = makeEvent("127.0.0.1");
    expect(await attachBearerAuth(evt, "Bearer ezk_orphan")).toBe(false);
    expect(evt.locals.user).toBeUndefined();
  });

  test("user-key rejection leaves locals untouched", async () => {
    const evt = makeEvent("127.0.0.1");
    expect(await attachBearerAuth(evt, "Bearer ezk_nope")).toBe(false);
    expect(evt.locals.user).toBeUndefined();
  });

  test("user-key verifyApiKey throw (DB unavailable) is swallowed", async () => {
    const saved = verifyApiKeyImpl;
    verifyApiKeyImpl = async () => {
      throw new Error("DB down");
    };
    try {
      const evt = makeEvent("127.0.0.1");
      expect(await attachBearerAuth(evt, "Bearer ezk_anything")).toBe(false);
      expect(evt.locals.user).toBeUndefined();
    } finally {
      verifyApiKeyImpl = saved;
    }
  });

  test("user-key requests from non-loopback are still processed (no loopback rule for ezk_)", async () => {
    const evt = makeEvent("203.0.113.5");
    expect(await attachBearerAuth(evt, "Bearer ezk_valid")).toBe(true);
    expect(evt.locals.user?.id).toBe("user-1");
  });
});

// ── On-behalf-of override (bundled extension impersonating a human user) ────

describe("attachBearerAuth — on-behalf-of header", () => {
  test("internal key + valid OBO header sets locals.user.id to the target", async () => {
    const { raw } = provisionInternalKey("ai-kit", ["chat"], "sys-ai-kit");
    const evt = makeEvent("127.0.0.1", "geff");
    expect(await attachBearerAuth(evt, `Bearer ${raw}`)).toBe(true);
    expect(evt.locals.user?.id).toBe("geff");
    // Audit breadcrumb: the principal name records both identities.
    expect(evt.locals.user?.name).toBe("internal:ai-kit on-behalf-of geff");
    // Scopes remain what the internal key was provisioned with — OBO does
    // not escalate scopes.
    expect(evt.locals.apiKeyScopes).toEqual(["chat"]);
  });

  test("OBO header pointing at a non-existent user is IGNORED, falls back to sys principal", async () => {
    const { raw } = provisionInternalKey("ai-kit", ["chat"], "sys-ai-kit");
    const evt = makeEvent("127.0.0.1", "ghost-user");
    expect(await attachBearerAuth(evt, `Bearer ${raw}`)).toBe(true);
    // Ghost isn't in the user store — no override happens, principal stays
    // as the system user. Importantly, auth still succeeds; the call just
    // runs under its own system identity (safe fallback, no 401).
    expect(evt.locals.user?.id).toBe("sys-ai-kit");
  });

  test("OBO header naming another sys-* identity is REJECTED (no cross-system pivot)", async () => {
    userStore.set("sys-other-ext", { id: "sys-other-ext", name: "Other", role: "member", status: "active" });
    const { raw } = provisionInternalKey("ai-kit", ["chat"], "sys-ai-kit");
    const evt = makeEvent("127.0.0.1", "sys-other-ext");
    await attachBearerAuth(evt, `Bearer ${raw}`);
    // Must stay as the CALLING system principal, never pivot to another.
    expect(evt.locals.user?.id).toBe("sys-ai-kit");
  });

  test("OBO header empty string is ignored", async () => {
    const { raw } = provisionInternalKey("ai-kit", ["chat"], "sys-ai-kit");
    const evt = makeEvent("127.0.0.1", "");
    await attachBearerAuth(evt, `Bearer ${raw}`);
    expect(evt.locals.user?.id).toBe("sys-ai-kit");
  });

  test("OBO header with only whitespace is ignored (treated as absent)", async () => {
    const { raw } = provisionInternalKey("ai-kit", ["chat"], "sys-ai-kit");
    for (const ws of [" ", "\t", "\n", " \t\n "]) {
      const evt = makeEvent("127.0.0.1", ws);
      await attachBearerAuth(evt, `Bearer ${raw}`);
      expect(evt.locals.user?.id).toBe("sys-ai-kit");
    }
  });

  test("OBO header with leading/trailing whitespace is TRIMMED before lookup", async () => {
    // A proxy might append whitespace; we should still resolve `geff`.
    const { raw } = provisionInternalKey("ai-kit", ["chat"], "sys-ai-kit");
    const evt = makeEvent("127.0.0.1", "  geff  ");
    await attachBearerAuth(evt, `Bearer ${raw}`);
    expect(evt.locals.user?.id).toBe("geff");
  });

  test("OBO target is REJECTED when user.status !== 'active' (admin-suspension respected)", async () => {
    // Real threat: an admin suspends a user; later, a bundled extension
    // call arrives with that user's id in the OBO header. Pre-fix, the
    // suspended user was still treated as a valid target.
    userStore.set("banned", { id: "banned", name: "Banned", role: "member", status: "inactive" });
    const { raw } = provisionInternalKey("ai-kit", ["chat"], "sys-ai-kit");
    const evt = makeEvent("127.0.0.1", "banned");
    await attachBearerAuth(evt, `Bearer ${raw}`);
    // Must NOT elevate — falls back to the system principal.
    expect(evt.locals.user?.id).toBe("sys-ai-kit");
  });

  test("OBO target with any non-'active' status is rejected (future-proofs against new states)", async () => {
    const { raw } = provisionInternalKey("ai-kit", ["chat"], "sys-ai-kit");
    for (const status of ["inactive", "pending", "deleted", "suspended", ""]) {
      userStore.set("u-" + status, { id: "u-" + status, name: "x", role: "member", status });
      const evt = makeEvent("127.0.0.1", "u-" + status);
      await attachBearerAuth(evt, `Bearer ${raw}`);
      expect(evt.locals.user?.id).toBe("sys-ai-kit");
    }
  });

  test("OBO header is IGNORED for user-issued keys (never applies outside internal-auth)", async () => {
    const evt = makeEvent("127.0.0.1", "geff");
    await attachBearerAuth(evt, "Bearer ezk_valid");
    // User key path used verifyApiKey, which returned user-1 — OBO is not
    // a concept for human-held keys.
    expect(evt.locals.user?.id).toBe("user-1");
  });

  test("OBO header is IGNORED from non-loopback (internal key already rejected before OBO check)", async () => {
    const { raw } = provisionInternalKey("ai-kit", ["chat"], "sys-ai-kit");
    const evt = makeEvent("10.0.0.1", "geff");
    expect(await attachBearerAuth(evt, `Bearer ${raw}`)).toBe(false);
    expect(evt.locals.user).toBeUndefined();
  });

  test("OBO override does not grant admin privileges even when target is admin", async () => {
    const { raw } = provisionInternalKey("ai-kit", ["chat"], "sys-ai-kit");
    const evt = makeEvent("127.0.0.1", "admin-123");
    await attachBearerAuth(evt, `Bearer ${raw}`);
    // The target IS an admin user, but the principal's role stays member.
    // apiKeyScopes stays as the internal key's provisioned scopes — a
    // compromised extension can't elevate to admin by picking an admin
    // target. (Role-based gating downstream would still see role=member.)
    expect(evt.locals.user?.role).toBe("member");
    expect(evt.locals.apiKeyScopes).toEqual(["chat"]);
  });

  test("OBO header with DB error falls back to sys principal (fail-closed)", async () => {
    // Temporarily poison getUserById.
    mock.module("$server/db/queries/users", () => ({
      getUserById: async () => {
        throw new Error("DB down");
      },
    }));
    const mod = await import("$lib/server/security/bearer-auth");
    const { raw } = provisionInternalKey("ai-kit", ["chat"], "sys-ai-kit");
    const evt = makeEvent("127.0.0.1", "geff");
    await mod.attachBearerAuth(evt, `Bearer ${raw}`);
    expect(evt.locals.user?.id).toBe("sys-ai-kit");

    // Restore the mock for subsequent tests.
    mock.module("$server/db/queries/users", () => ({
      getUserById: async (id: string) => userStore.get(id),
    }));
  });
});

// ── OBO audit-log injection hardening ────────────────────────────────────────
// The logger emits JSON.stringify'd lines (src/logger.ts:33). JSON.stringify
// escapes every control character (\n, \r, \x00, \x1b, \u2028, \u2029) and
// special JSON characters (\", \\), so a crafted targetUserId can NEVER
// produce an additional newline-delimited log frame. These tests pin that
// invariant so a future logger refactor can't silently introduce plain-text
// concatenation.

describe("attachBearerAuth — OBO audit-log injection hardening", () => {
  // Intercept what the logger actually emits to stdout.
  let logLines: string[];
  let originalWrite: typeof process.stdout.write;

  beforeEach(() => {
    logLines = [];
    originalWrite = process.stdout.write.bind(process.stdout);
    // Overriding stdout.write for test interception; the narrow stub
    // ignores the encoding/callback overloads since we only care about
    // the payload string in this file.
    process.stdout.write = ((chunk: string | Uint8Array) => {
      if (typeof chunk === "string") logLines.push(chunk);
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  // Payloads that would break a plain-text logger but must be safe in JSON.
  const injectionPayloads: Array<[string, string]> = [
    ["LF newline",          "geff\nINFO: forged log line"],
    ["CRLF newline",        "geff\r\nINFO: forged log line"],
    ["null byte",           "geff\x00injected"],
    ["ANSI escape",         "geff\x1b[31mred"],
    ["Unicode LS (\\u2028)","geff\u2028injected"],
    ["Unicode PS (\\u2029)","geff\u2029injected"],
    ["JSON quote",          'geff"injected"'],
    ["backslash",           "geff\\nfake"],
  ];

  for (const [label, userId] of injectionPayloads) {
    test(`log line is single JSON object with no raw newlines — ${label}`, async () => {
      // Seed the user store so the OBO path actually executes and the
      // audit log.info() call is reached.
      userStore.set(userId, { id: userId, name: "test", role: "member", status: "active" });

      const { raw } = provisionInternalKey("ai-kit", ["chat"], "sys-ai-kit");
      const evt = makeEvent("127.0.0.1", userId);
      await attachBearerAuth(evt, `Bearer ${raw}`);

      // Find the elevation audit entry.
      const elevationLines = logLines.filter(l => {
        try { return JSON.parse(l.trim()).msg === "internal-auth: on-behalf-of elevation"; }
        catch { return false; }
      });
      expect(elevationLines).toHaveLength(1);

      // The logger appends a single "\n" as the record delimiter; strip it
      // before checking for injected newlines inside the JSON payload itself.
      const entry = elevationLines[0].replace(/\n$/, "");

      // Key invariant: the JSON payload has NO embedded newlines (the only
      // newline is the record-delimiter that was just stripped above).
      expect(entry).not.toContain("\n");
      expect(entry).not.toContain("\r");

      // The targetUserId field round-trips correctly through JSON.stringify/parse.
      const parsed = JSON.parse(entry);
      expect(parsed.targetUserId).toBe(userId);
    });
  }
});

// ── Cross-path isolation ─────────────────────────────────────────────────────

describe("attachBearerAuth — cross-path isolation", () => {
  test("token with neither prefix is rejected by verifyApiKey (no crash)", async () => {
    const evt = makeEvent("127.0.0.1");
    expect(await attachBearerAuth(evt, "Bearer random-token")).toBe(false);
    expect(evt.locals.user).toBeUndefined();
    // Does get probed (non-internal prefix → user-key path).
    expect(verifyApiKeyCalls).toEqual(["random-token"]);
  });
});
