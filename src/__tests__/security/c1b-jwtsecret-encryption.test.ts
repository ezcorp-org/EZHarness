// Regression test for sec-C1b: instance:jwtSecret must be encrypted at rest in
// the settings KV table. Defense-in-depth follow-on to C1 (54bc523) — even
// though C1 now blocks the settings API from reading the secret, storing it
// plaintext was still a footgun (raw DB access, backups, leaked dumps). This
// test verifies:
//   1. Fresh writes land as encrypted v1: ciphertext in the store.
//   2. Reads round-trip to the original plaintext.
//   3. Legacy plaintext values are lazily migrated on first read.
//   4. Plaintext never appears in the at-rest value.
//   5. Rotated secrets survive multiple write+read cycles.
//
// Tests fix(sec-C1b): 469770f
import { test, expect, describe, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "../helpers/mock-cleanup";

// ── Module-level mocks (BEFORE importing jwt.ts) ─────────────────
// In-memory store backing a fake settings queries module. Tests reseed it in
// beforeEach. The `store` reference is captured by closure, so reassigning it
// is fine for fresh state between tests.
let store = new Map<string, unknown>();
const settingsMock = () => ({
  async getSetting(key: string) {
    return store.has(key) ? store.get(key) : undefined;
  },
  async upsertSetting(key: string, value: unknown) {
    store.set(key, value);
  },
  async getAllSettings() {
    return Object.fromEntries(store.entries());
  },
  async deleteSetting(key: string) {
    return store.delete(key);
  },
  async isListingInstalled() {
    return false;
  },
});
mock.module("../../db/queries/settings", settingsMock);

// ── Source imports (AFTER mocks) ─────────────────────────────────
import { getJwtSecret, _resetSecretCache } from "../../auth/jwt";
import { encrypt, decrypt } from "../../providers/encryption";

afterAll(() => {
  restoreModuleMocks();
});

beforeEach(() => {
  store = new Map<string, unknown>();
  _resetSecretCache();
  // Ensure the env override doesn't bypass the settings path under test.
  delete process.env.EZCORP_JWT_SECRET;
});

describe("sec-C1b: instance:jwtSecret is encrypted at rest", () => {
  test("auto-generated secret is stored as encrypted v1: ciphertext", async () => {
    const secret = await getJwtSecret();

    // Sanity: looks like a 32-byte hex string (64 chars).
    expect(secret).toMatch(/^[0-9a-f]{64}$/);

    // The underlying KV row must be the encrypted form, not the plaintext.
    const stored = store.get("instance:jwtSecret") as string;
    expect(typeof stored).toBe("string");
    expect(stored).not.toBe(secret);
    expect(stored.startsWith("v1:")).toBe(true);

    // Decrypting the stored row round-trips to the same plaintext.
    expect(decrypt(stored)).toBe(secret);
  });

  test("plaintext secret never appears in the KV row", async () => {
    const secret = await getJwtSecret();
    const stored = store.get("instance:jwtSecret") as string;

    // The plaintext HS256 secret must not appear anywhere in the at-rest value.
    expect(stored).not.toContain(secret);
    // Negative check: pre-fix code stored the raw 64-char hex string — the
    // stored row must NOT match that shape.
    expect(/^[0-9a-f]{64}$/.test(stored)).toBe(false);
  });

  test("getJwtSecret round-trips on subsequent reads from the same store", async () => {
    const first = await getJwtSecret();
    const storedAfterFirst = store.get("instance:jwtSecret") as string;

    // Clear the in-process cache so the second call re-reads from the store.
    _resetSecretCache();

    const second = await getJwtSecret();
    expect(second).toBe(first);

    // A clean (already-encrypted) read must NOT rewrite the row.
    const storedAfterSecond = store.get("instance:jwtSecret") as string;
    expect(storedAfterSecond).toBe(storedAfterFirst);
    expect(decrypt(storedAfterSecond)).toBe(first);
  });

  test("legacy plaintext values are lazily migrated to encrypted on first read", async () => {
    // Seed a legacy plaintext value directly into the store — simulating a
    // pre-fix deployment.
    const legacyPlaintext = "deadbeefcafef00d".repeat(4); // 64 hex chars, no colons
    store.set("instance:jwtSecret", legacyPlaintext);

    // Reading via the public getter returns the legacy plaintext (so tokens
    // signed with it still verify) …
    const got = await getJwtSecret();
    expect(got).toBe(legacyPlaintext);

    // … but the underlying row is now the encrypted form (lazy migration).
    const stored = store.get("instance:jwtSecret") as string;
    expect(stored).not.toBe(legacyPlaintext);
    expect(stored.startsWith("v1:")).toBe(true);
    expect(decrypt(stored)).toBe(legacyPlaintext);
  });

  test("rotated secret survives multiple write+read cycles", async () => {
    // First cycle: auto-generate.
    const secret1 = await getJwtSecret();
    const stored1 = store.get("instance:jwtSecret") as string;
    expect(stored1.startsWith("v1:")).toBe(true);

    // Simulate an operator rotating the secret by writing an encrypted value
    // directly to the store, then clearing the cache.
    const rotated = "feedfacefeedface".repeat(4);
    store.set("instance:jwtSecret", encrypt(rotated));
    _resetSecretCache();

    const secret2 = await getJwtSecret();
    expect(secret2).toBe(rotated);
    expect(secret2).not.toBe(secret1);

    // Store row is still encrypted after the read (no spurious rewrite).
    const stored2 = store.get("instance:jwtSecret") as string;
    expect(stored2.startsWith("v1:")).toBe(true);
    expect(decrypt(stored2)).toBe(rotated);
  });
});
