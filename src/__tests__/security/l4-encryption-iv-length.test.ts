// Regression test for sec-L4: AES-GCM IV length must be NIST-recommended 12
// bytes and ciphertexts must carry a `v1:` format tag so decrypt() can
// unambiguously round-trip both v1 and legacy untagged (16-byte IV) payloads.
//
// Pre-fix (src/providers/encryption.ts@6-75):
//   const IV_LENGTH = 16;
//   return `${iv.toString("hex")}:${authTag}:${encrypted}`;
// — the IV is 16 bytes (outside NIST SP 800-38D's recommended 96-bit J0
// construction) and the 3-part format has no version marker, so future
// changes cannot distinguish old vs new without a migration sweep.
//
// Fix (120b1c1):
//   - IV_LENGTH = 12 for fresh encryptions.
//   - encrypt() emits "v1:<iv-hex>:<tag-hex>:<ct-hex>" (4 parts).
//   - decrypt() branches: "v1:" prefix → 12-byte IV; 3-part legacy → 16-byte
//     IV. Each branch validates IV length and throws on mismatch. Legacy
//     ciphertexts already persisted in settings continue to decrypt.
//
// Strategy: import encrypt/decrypt directly (no mocks). Pin the key via env
// vars so both this test and our hand-crafted legacy ciphertext share the
// same derived key. Assert:
//   1. Fresh encrypt() output starts with "v1:" and has exactly 4 parts.
//   2. The IV component is exactly 12 bytes (24 hex chars).
//   3. encrypt → decrypt round-trips the original plaintext.
//   4. A hand-crafted legacy 3-part ciphertext with a 16-byte IV decrypts
//      successfully (backward compatibility).
//   5. A v1 ciphertext with an 11-byte IV is rejected with an IV-length
//      error (negative: proves the expectedIvLength guard fires).
//
// Tests fix(sec-L4): 120b1c1

// Pin encryption key/salt BEFORE importing the encryption module so
// getAppSecret()'s cached key is derived from our deterministic values
// (rather than generating or reading from disk).
process.env.EZCORP_ENCRYPTION_SECRET = "sec-l4-test-secret-deadbeef-1234567890abcdef";
process.env.EZCORP_ENCRYPTION_SALT = "sec-l4-test-salt-cafebabe";

import { test, expect, describe, beforeAll } from "bun:test";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { encrypt, decrypt, _resetKeyCache } from "../../providers/encryption";

// Rebuild the same key the module will derive so we can forge a legacy
// 16-byte-IV ciphertext that the fixed decrypt() must accept.
function deriveKey(): Buffer {
  return scryptSync(
    process.env.EZCORP_ENCRYPTION_SECRET!,
    process.env.EZCORP_ENCRYPTION_SALT!,
    32,
  );
}

function makeLegacyCiphertext(plaintext: string): string {
  const key = deriveKey();
  const iv = randomBytes(16); // legacy 16-byte IV
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${tag}:${encrypted}`;
}

function makeV1CiphertextWithIvLength(plaintext: string, ivLen: number): string {
  const key = deriveKey();
  const iv = randomBytes(ivLen);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");
  return `v1:${iv.toString("hex")}:${tag}:${encrypted}`;
}

beforeAll(() => {
  // Ensure the key cache is primed from our env vars, not a prior test's.
  _resetKeyCache();
});

describe("sec-L4: AES-GCM IV length and v1 format tag", () => {
  test("fresh encrypt() emits v1-tagged 4-part ciphertext", () => {
    const plaintext = "sk-test-sec-l4-key-0001";
    const ct = encrypt(plaintext);

    const parts = ct.split(":");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
  });

  test("fresh encrypt() IV is exactly 12 bytes (24 hex chars)", () => {
    const ct = encrypt("round-trip-payload");
    const parts = ct.split(":");
    const ivHex = parts[1]!;
    // 12 bytes = 24 hex characters; each hex pair is one byte.
    expect(ivHex.length).toBe(24);
    expect(Buffer.from(ivHex, "hex").length).toBe(12);
  });

  test("encrypt → decrypt round-trips the original plaintext", () => {
    const plaintext = "sec-L4 round trip — 🔐 unicode too";
    const ct = encrypt(plaintext);
    expect(ct).not.toBe(plaintext);
    expect(decrypt(ct)).toBe(plaintext);
  });

  test("fresh encrypt() uses a fresh random IV each call", () => {
    const a = encrypt("same-plaintext");
    const b = encrypt("same-plaintext");
    expect(a).not.toBe(b);
    expect(a.split(":")[1]).not.toBe(b.split(":")[1]); // different IVs
  });

  test("backwards-compat: legacy 3-part ciphertext (16-byte IV) still decrypts", () => {
    // This is the exact shape encrypt() produced PRE-FIX. The fix must keep
    // decrypting these without a migration step because existing settings
    // rows hold ciphertexts in this shape.
    const plaintext = "legacy-api-key-abc123";
    const legacyCt = makeLegacyCiphertext(plaintext);
    // Sanity-check we built a 3-part legacy blob with a 16-byte IV.
    const legacyParts = legacyCt.split(":");
    expect(legacyParts).toHaveLength(3);
    expect(Buffer.from(legacyParts[0]!, "hex").length).toBe(16);

    expect(decrypt(legacyCt)).toBe(plaintext);
  });

  test("v1 ciphertext with wrong IV length is rejected", () => {
    // 11 bytes ≠ IV_LENGTH (12). The fixed decrypt() has an explicit
    // `iv.length !== expectedIvLength` guard — this proves it fires on the
    // v1 branch. (On the pre-fix code this test is irrelevant because v1
    // wasn't recognized, but the test above already pins pre-fix failure.)
    const bogus = makeV1CiphertextWithIvLength("nope", 11);
    expect(() => decrypt(bogus)).toThrow(/IV length/i);
  });
});
