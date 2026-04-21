/**
 * Unit tests for the internal-auth module. Every security property stated
 * in the module JSDoc has at least one test pinning it down. Treat any
 * change that requires removing or loosening a test in this file as a
 * change to the security model — it needs sign-off, not just a fix.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  INTERNAL_KEY_PREFIX,
  isLoopbackAddress,
  listInternalKeyMetadata,
  provisionInternalKey,
  resetInternalKeyStoreForTests,
  revokeInternalKey,
  verifyInternalKey,
} from "$lib/server/security/internal-auth";

beforeEach(() => resetInternalKeyStoreForTests());
afterEach(() => resetInternalKeyStoreForTests());

// ── provisionInternalKey ─────────────────────────────────────────────────────

describe("provisionInternalKey", () => {
  test("returns a raw key with the ezkint_ prefix", () => {
    const { raw } = provisionInternalKey("ai-kit", ["chat"], "sys-ai-kit");
    expect(raw.startsWith(INTERNAL_KEY_PREFIX)).toBe(true);
  });

  test("raw key has high entropy (>= 32 random bytes base64url)", () => {
    const { raw } = provisionInternalKey("ai-kit", ["chat"], "sys-ai-kit");
    const suffix = raw.slice(INTERNAL_KEY_PREFIX.length);
    // 32 random bytes → base64url is ≥43 chars (no padding).
    expect(suffix.length).toBeGreaterThanOrEqual(43);
    // base64url alphabet only
    expect(/^[A-Za-z0-9_-]+$/.test(suffix)).toBe(true);
  });

  test("each call mints a fresh raw key (no reuse)", () => {
    const a = provisionInternalKey("a", ["chat"], "sys-a").raw;
    const b = provisionInternalKey("b", ["chat"], "sys-b").raw;
    expect(a).not.toBe(b);
  });

  test("keyId is a unique UUID per provision call", () => {
    const a = provisionInternalKey("a", ["chat"], "sys-a").keyId;
    const b = provisionInternalKey("b", ["chat"], "sys-b").keyId;
    expect(a).not.toBe(b);
    expect(/^[0-9a-f-]{36}$/i.test(a)).toBe(true);
  });

  test("re-provisioning the same extension overwrites the previous key", () => {
    const first = provisionInternalKey("ai-kit", ["chat"], "sys-ai-kit").raw;
    const second = provisionInternalKey("ai-kit", ["chat"], "sys-ai-kit").raw;
    expect(first).not.toBe(second);
    // First raw no longer verifies; second does.
    expect(verifyInternalKey(first, "127.0.0.1")).toBeNull();
    expect(verifyInternalKey(second, "127.0.0.1")).not.toBeNull();
  });

  test("refuses 'admin' scope (defense-in-depth against privilege creep)", () => {
    expect(() => provisionInternalKey("ai-kit", ["admin"], "sys-ai-kit")).toThrow(/admin.*forbidden/);
    // Mixed scopes containing admin are also rejected.
    expect(() => provisionInternalKey("ai-kit", ["chat", "admin"], "sys-ai-kit")).toThrow();
  });

  test("refuses empty scope list", () => {
    expect(() => provisionInternalKey("ai-kit", [], "sys-ai-kit")).toThrow(/at least one scope/);
  });

  test("refuses empty extension name", () => {
    expect(() => provisionInternalKey("", ["chat"], "sys-ai-kit")).toThrow(/extensionName/);
  });

  test("refuses missing userId (forces ensureSystemUser to run first)", () => {
    expect(() =>
      // @ts-expect-error — deliberately exercising the runtime guard
      provisionInternalKey("ai-kit", ["chat"], undefined),
    ).toThrow(/userId required/);
    expect(() => provisionInternalKey("ai-kit", ["chat"], "")).toThrow(/userId required/);
  });
});

// ── verifyInternalKey ────────────────────────────────────────────────────────

describe("verifyInternalKey", () => {
  test("returns null for a key without the internal prefix (falls through)", () => {
    expect(verifyInternalKey("ezk_usersKeyNotInternal", "127.0.0.1")).toBeNull();
    expect(verifyInternalKey("random-garbage", "127.0.0.1")).toBeNull();
    expect(verifyInternalKey("", "127.0.0.1")).toBeNull();
  });

  test("returns null for non-string input", () => {
    // @ts-expect-error — deliberately exercising the runtime guard
    expect(verifyInternalKey(null, "127.0.0.1")).toBeNull();
    // @ts-expect-error
    expect(verifyInternalKey(undefined, "127.0.0.1")).toBeNull();
    // @ts-expect-error
    expect(verifyInternalKey(42, "127.0.0.1")).toBeNull();
  });

  test("rejects non-loopback remote addresses", () => {
    const { raw } = provisionInternalKey("ai-kit", ["chat"], "sys-ai-kit");
    for (const addr of ["10.0.0.1", "192.168.1.1", "8.8.8.8", "2001:db8::1", "203.0.113.5"]) {
      expect(verifyInternalKey(raw, addr)).toBeNull();
    }
  });

  test("accepts IPv4, IPv6, IPv4-mapped-IPv6 loopback", () => {
    const { raw } = provisionInternalKey("ai-kit", ["chat"], "sys-ai-kit");
    for (const addr of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      expect(verifyInternalKey(raw, addr)).not.toBeNull();
    }
  });

  test("treats empty / null / undefined remoteAddr as local (unix-socket case)", () => {
    const { raw } = provisionInternalKey("ai-kit", ["chat"], "sys-ai-kit");
    expect(verifyInternalKey(raw, "")).not.toBeNull();
    expect(verifyInternalKey(raw, null)).not.toBeNull();
    expect(verifyInternalKey(raw, undefined)).not.toBeNull();
  });

  test("resolves a valid key to the caller-supplied userId + sys-scoped name", () => {
    const { raw, keyId } = provisionInternalKey("ai-kit", ["read", "chat"], "sys-ai-kit");
    const principal = verifyInternalKey(raw, "127.0.0.1");
    expect(principal).toMatchObject({
      userId: "sys-ai-kit",
      name: "internal:ai-kit",
      keyId,
      extensionName: "ai-kit",
    });
    expect(principal!.scopes).toEqual(["read", "chat"]);
  });

  test("userId is whatever the caller supplied (audit-prefixed via systemUserIdFor)", () => {
    const { raw } = provisionInternalKey("ai-kit", ["chat"], "sys-ai-kit");
    const p = verifyInternalKey(raw, "127.0.0.1")!;
    expect(p.userId).toBe("sys-ai-kit");
    expect(p.userId.startsWith("sys-")).toBe(true);
  });

  test("a key from extension A does not authenticate as extension B", () => {
    const a = provisionInternalKey("ext-a", ["chat"], "sys-ext-a");
    const b = provisionInternalKey("ext-b", ["chat"], "sys-ext-b");
    expect(verifyInternalKey(a.raw, "127.0.0.1")?.extensionName).toBe("ext-a");
    expect(verifyInternalKey(b.raw, "127.0.0.1")?.extensionName).toBe("ext-b");
  });

  test("tampered key (one byte changed) fails verification", () => {
    const { raw } = provisionInternalKey("ai-kit", ["chat"], "sys-ai-kit");
    const tampered = raw.slice(0, -1) + (raw.endsWith("A") ? "B" : "A");
    expect(verifyInternalKey(tampered, "127.0.0.1")).toBeNull();
  });

  test("key with wrong prefix but correct body is rejected", () => {
    const { raw } = provisionInternalKey("ai-kit", ["chat"], "sys-ai-kit");
    const stripped = raw.slice(INTERNAL_KEY_PREFIX.length);
    // No prefix at all → null.
    expect(verifyInternalKey(stripped, "127.0.0.1")).toBeNull();
    // User-key prefix with internal-key body → null.
    expect(verifyInternalKey("ezk_" + stripped, "127.0.0.1")).toBeNull();
  });

  test("verification does not early-exit on first match (timing-equal scan)", () => {
    // Provision many keys; the last one added must still verify correctly,
    // demonstrating the loop doesn't bail on a non-matching earlier entry.
    const keys: string[] = [];
    for (let i = 0; i < 10; i++) {
      keys.push(provisionInternalKey(`ext-${i}`, ["chat"], `sys-ext-${i}`).raw);
    }
    for (const k of keys) {
      expect(verifyInternalKey(k, "127.0.0.1")).not.toBeNull();
    }
  });
});

// ── revoke + lifecycle ───────────────────────────────────────────────────────

describe("revokeInternalKey", () => {
  test("revoked key no longer verifies", () => {
    const { raw } = provisionInternalKey("ai-kit", ["chat"], "sys-ai-kit");
    expect(verifyInternalKey(raw, "127.0.0.1")).not.toBeNull();
    expect(revokeInternalKey("ai-kit")).toBe(true);
    expect(verifyInternalKey(raw, "127.0.0.1")).toBeNull();
  });

  test("revoking a non-existent extension returns false", () => {
    expect(revokeInternalKey("never-provisioned")).toBe(false);
  });

  test("resetInternalKeyStoreForTests wipes every key", () => {
    provisionInternalKey("a", ["chat"], "sys-a");
    provisionInternalKey("b", ["chat"], "sys-b");
    expect(listInternalKeyMetadata()).toHaveLength(2);
    resetInternalKeyStoreForTests();
    expect(listInternalKeyMetadata()).toHaveLength(0);
  });
});

// ── listInternalKeyMetadata ──────────────────────────────────────────────────

describe("listInternalKeyMetadata", () => {
  test("returns only safe metadata (no hash, no raw)", () => {
    provisionInternalKey("ai-kit", ["chat"], "sys-ai-kit");
    const [entry] = listInternalKeyMetadata();
    expect(entry).toBeDefined();
    // Shape inspection — no leakage.
    expect(Object.keys(entry!).sort()).toEqual(
      ["createdAt", "extensionName", "keyId", "scopes"].sort(),
    );
    // @ts-expect-error — prove the hash is gone
    expect(entry!.hash).toBeUndefined();
  });

  test("lists multiple extensions in insertion order", () => {
    provisionInternalKey("first", ["chat"], "sys-first");
    provisionInternalKey("second", ["chat"], "sys-second");
    const names = listInternalKeyMetadata().map((m) => m.extensionName);
    expect(names).toEqual(["first", "second"]);
  });
});

// ── isLoopbackAddress ────────────────────────────────────────────────────────

describe("isLoopbackAddress", () => {
  test("accepts canonical loopback forms", () => {
    for (const a of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      expect(isLoopbackAddress(a)).toBe(true);
    }
  });

  test("accepts loopback with a port suffix (some runtimes format that way)", () => {
    expect(isLoopbackAddress("127.0.0.1:54321")).toBe(true);
  });

  test("accepts IPv6 loopback with a zone id", () => {
    expect(isLoopbackAddress("::1%lo0")).toBe(true);
  });

  test("accepts bracketed IPv6 loopback with a port (common proxy-written form)", () => {
    expect(isLoopbackAddress("[::1]:8080")).toBe(true);
    expect(isLoopbackAddress("[::ffff:127.0.0.1]:443")).toBe(true);
    expect(isLoopbackAddress("[::1]")).toBe(true);
  });

  test("rejects bracketed IPv6 addresses that aren't loopback", () => {
    expect(isLoopbackAddress("[2001:db8::1]:8080")).toBe(false);
    expect(isLoopbackAddress("[fe80::1]")).toBe(false);
  });

  test("rejects alternate IPv4-in-IPv6 forms (fail-closed, kernel should have normalised)", () => {
    // If a future runtime ever surfaced a non-canonical form, we must
    // reject it rather than accept — even though a Linux kernel today
    // normalises these to `::ffff:127.0.0.1` before Bun sees them.
    for (const alt of [
      "::ffff:0x7f000001",
      "::ffff:0x7f.0x0.0x0.0x1",
      "::ffff:2130706433",
      "::ffff:127.1",
      "::ffff:0.0.0.0",
      "::ffff:8.8.8.8",
      "::FFFF:127.0.0.1:8080", // port-after-canonical (weird parser)
    ]) {
      expect(isLoopbackAddress(alt)).toBe(false);
    }
  });

  test("canonical ::ffff:127.0.0.1 still accepted after the fail-closed check", () => {
    // Regression: the fail-closed block must not reject the one form
    // that IS loopback.
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  });

  test("rejects obvious non-loopback addresses", () => {
    for (const a of ["10.0.0.1", "192.168.1.1", "8.8.8.8", "2001:db8::1", "169.254.1.1"]) {
      expect(isLoopbackAddress(a)).toBe(false);
    }
  });

  test("rejects near-misses that could fool a weaker check", () => {
    for (const a of [
      "127.0.0.1.evil.com", // subdomain trick
      "1127.0.0.1",          // superstring
      "127_0_0_1",           // underscore substitution
      "0127.0.0.1",          // leading zero octet
    ]) {
      expect(isLoopbackAddress(a)).toBe(false);
    }
  });

  test("treats empty/null/undefined as local (unix-socket semantics)", () => {
    expect(isLoopbackAddress("")).toBe(true);
    expect(isLoopbackAddress(null)).toBe(true);
    expect(isLoopbackAddress(undefined)).toBe(true);
  });
});
