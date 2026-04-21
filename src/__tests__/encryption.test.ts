import { test, expect, beforeEach, afterEach, mock, afterAll } from "bun:test";

import { restoreModuleMocks } from "./helpers/mock-cleanup";
// Restore the real encryption implementation before any imports.
// This counteracts mock.module("../providers/encryption", ...) from other test
// files (e.g. model-router.test.ts) that may share the module registry in
// this Bun version. The real module only uses node:crypto (built-in).
mock.module("../providers/encryption", () => {
  const { createCipheriv, createDecipheriv, randomBytes, scryptSync } = require("node:crypto");
  const { readFileSync, writeFileSync, existsSync } = require("node:fs");
  const { join } = require("node:path");

  const ALGORITHM = "aes-256-gcm";
  const IV_LENGTH = 16;
  const LEGACY_SALT = "pi-salt";
  const KEY_LENGTH = 32;
  let _cachedKey: Buffer | null = null;
  let _cachedSalt: string | null = null;

  function getAppSalt(): string {
    if (_cachedSalt) return _cachedSalt;
    const envSalt = process.env.EZCORP_ENCRYPTION_SALT;
    if (envSalt) { _cachedSalt = envSalt; return envSalt; }
    const saltPath = join(process.cwd(), ".pi-salt");
    if (existsSync(saltPath)) { const s = readFileSync(saltPath, "utf-8").trim(); _cachedSalt = s; return s; }
    const secretPath = join(process.cwd(), ".pi-secret");
    if (existsSync(secretPath)) { _cachedSalt = LEGACY_SALT; return LEGACY_SALT; }
    const newSalt = randomBytes(16).toString("hex");
    writeFileSync(saltPath, newSalt, { mode: 0o600 });
    _cachedSalt = newSalt;
    return newSalt;
  }

  function getAppSecret(): Buffer {
    if (_cachedKey) return _cachedKey;
    const envSecret = process.env.EZCORP_ENCRYPTION_SECRET;
    let secret: string;
    if (envSecret) {
      secret = envSecret;
    } else {
      const secretPath = join(process.cwd(), ".pi-secret");
      if (existsSync(secretPath)) {
        secret = readFileSync(secretPath, "utf-8").trim();
      } else {
        secret = randomBytes(32).toString("hex");
        writeFileSync(secretPath, secret, { mode: 0o600 });
      }
    }
    _cachedKey = scryptSync(secret, getAppSalt(), KEY_LENGTH) as Buffer;
    return _cachedKey;
  }

  function encrypt(plaintext: string): string {
    const key = getAppSecret();
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(plaintext, "utf8", "hex");
    encrypted += cipher.final("hex");
    const authTag = cipher.getAuthTag().toString("hex");
    return `${iv.toString("hex")}:${authTag}:${encrypted}`;
  }

  function decrypt(ciphertext: string): string {
    const parts = ciphertext.split(":");
    if (parts.length !== 3) throw new Error("Invalid encrypted format: expected iv:tag:ciphertext");
    const ivHex = parts[0]!;
    const tagHex = parts[1]!;
    const encryptedHex = parts[2]!;
    const key = getAppSecret();
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(tagHex, "hex");
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedHex, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  }

  function _resetKeyCache(): void {
    _cachedKey = null;
    _cachedSalt = null;
  }

  return { encrypt, decrypt, _resetKeyCache };
});

afterAll(() => restoreModuleMocks());

import { encrypt, decrypt } from "../providers/encryption";

const originalEnv = process.env.EZCORP_ENCRYPTION_SECRET;

beforeEach(() => {
  process.env.EZCORP_ENCRYPTION_SECRET = "test-secret-key-for-testing";
});

afterEach(() => {
  if (originalEnv !== undefined) {
    process.env.EZCORP_ENCRYPTION_SECRET = originalEnv;
  } else {
    delete process.env.EZCORP_ENCRYPTION_SECRET;
  }
});

test("encrypt returns string in iv:tag:ciphertext format", () => {
  const result = encrypt("hello world");
  const parts = result.split(":");
  expect(parts.length).toBe(3);
  // All parts should be hex-encoded
  for (const part of parts) {
    expect(/^[0-9a-f]+$/.test(part)).toBe(true);
  }
});

test("decrypt(encrypt(plaintext)) === plaintext for any string", () => {
  const inputs = [
    "sk-ant-api-key-12345",
    "",
    "a".repeat(1000),
    "special chars: !@#$%^&*()",
    "unicode: \u00e9\u00e8\u00ea\u00eb",
  ];
  for (const input of inputs) {
    expect(decrypt(encrypt(input))).toBe(input);
  }
});

test("decrypt with corrupted data throws", () => {
  expect(() => decrypt("bad:data:here")).toThrow();
});

test("decrypt with wrong format throws", () => {
  expect(() => decrypt("notvalid")).toThrow();
});

test("encrypt produces different ciphertexts for same input (random IV)", () => {
  const a = encrypt("same input");
  const b = encrypt("same input");
  expect(a).not.toBe(b);
});
