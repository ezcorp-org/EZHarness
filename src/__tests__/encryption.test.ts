import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// preload registers a compatibility mock for a broken two-level relative
// specifier used elsewhere. A query-string import is a distinct module key,
// so this suite executes the shipping implementation itself.
const { _resetKeyCache, decrypt, decryptWithAad, encrypt, encryptWithAad } =
  await import("../providers/encryption.ts?coverage-test");

const originalEnv = process.env.EZCORP_ENCRYPTION_SECRET;

beforeEach(() => {
  process.env.EZCORP_ENCRYPTION_SECRET = "test-secret-key-for-testing";
  _resetKeyCache();
});

afterEach(() => {
  _resetKeyCache();
  if (originalEnv !== undefined) process.env.EZCORP_ENCRYPTION_SECRET = originalEnv;
  else delete process.env.EZCORP_ENCRYPTION_SECRET;
});

test("encrypt returns the tagged v1 ciphertext format with a 12-byte IV", () => {
  const result = encrypt("hello world");
  const parts = result.split(":");
  expect(parts).toHaveLength(4);
  expect(parts[0]).toBe("v1");
  expect(parts[1]).toHaveLength(24);
  for (const part of parts.slice(1)) expect(/^[0-9a-f]+$/.test(part)).toBe(true);
});

test("decrypt(encrypt(plaintext)) === plaintext for any string", () => {
  for (const input of ["sk-ant-api-key-12345", "", "a".repeat(1000), "special chars: !@#$%^&*()", "unicode: éèêë"]) {
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
  expect(encrypt("same input")).not.toBe(encrypt("same input"));
});

test("AAD ciphertext needs the same scope to decrypt", () => {
  const ciphertext = encryptWithAad("scoped secret", "extension:project");
  expect(decryptWithAad(ciphertext, "extension:project")).toBe("scoped secret");
  expect(() => decryptWithAad(ciphertext, "other:project")).toThrow();
});

test("a first run persists its generated secret and retains legacy salt semantics", () => {
  const directory = mkdtempSync(join(tmpdir(), "ezh-encryption-"));
  const originalCwd = process.cwd();
  const previous = {
    directory: process.env.EZCORP_SECRETS_DIR,
    secret: process.env.EZCORP_ENCRYPTION_SECRET,
    salt: process.env.EZCORP_ENCRYPTION_SALT,
  };
  try {
    // Keep compatibility fallbacks in this private directory too: the real
    // worktree may legitimately hold legacy secret files from a prior run.
    process.chdir(directory);
    process.env.EZCORP_SECRETS_DIR = directory;
    delete process.env.EZCORP_ENCRYPTION_SECRET;
    delete process.env.EZCORP_ENCRYPTION_SALT;
    _resetKeyCache();

    const ciphertext = encrypt("first-run secret");

    expect(existsSync(join(directory, ".pi-secret"))).toBe(true);
    expect(existsSync(join(directory, ".pi-salt"))).toBe(false);
    expect(decrypt(ciphertext)).toBe("first-run secret");
    _resetKeyCache();
    expect(decrypt(encrypt("reuses generated secret"))).toBe("reuses generated secret");
  } finally {
    _resetKeyCache();
    process.chdir(originalCwd);
    if (previous.directory === undefined) delete process.env.EZCORP_SECRETS_DIR;
    else process.env.EZCORP_SECRETS_DIR = previous.directory;
    if (previous.secret === undefined) delete process.env.EZCORP_ENCRYPTION_SECRET;
    else process.env.EZCORP_ENCRYPTION_SECRET = previous.secret;
    if (previous.salt === undefined) delete process.env.EZCORP_ENCRYPTION_SALT;
    else process.env.EZCORP_ENCRYPTION_SALT = previous.salt;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an environment salt takes precedence over persisted salt lookup", () => {
  const directory = mkdtempSync(join(tmpdir(), "ezh-encryption-"));
  const originalCwd = process.cwd();
  const previousDirectory = process.env.EZCORP_SECRETS_DIR;
  const previousSalt = process.env.EZCORP_ENCRYPTION_SALT;
  try {
    process.chdir(directory);
    process.env.EZCORP_SECRETS_DIR = directory;
    process.env.EZCORP_ENCRYPTION_SALT = "environment-salt";
    _resetKeyCache();

    expect(decrypt(encrypt("environment salt"))).toBe("environment salt");
  } finally {
    _resetKeyCache();
    process.chdir(originalCwd);
    if (previousDirectory === undefined) delete process.env.EZCORP_SECRETS_DIR;
    else process.env.EZCORP_SECRETS_DIR = previousDirectory;
    if (previousSalt === undefined) delete process.env.EZCORP_ENCRYPTION_SALT;
    else process.env.EZCORP_ENCRYPTION_SALT = previousSalt;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a provided secret gets a persistent salt in the configured directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "ezh-encryption-"));
  const originalCwd = process.cwd();
  const previousDirectory = process.env.EZCORP_SECRETS_DIR;
  try {
    process.chdir(directory);
    process.env.EZCORP_SECRETS_DIR = directory;
    process.env.EZCORP_ENCRYPTION_SECRET = "test-secret-key-for-testing";
    delete process.env.EZCORP_ENCRYPTION_SALT;
    _resetKeyCache();

    expect(decrypt(encrypt("persistent salt"))).toBe("persistent salt");
    expect(readFileSync(join(directory, ".pi-salt"), "utf8").trim()).toHaveLength(32);
  } finally {
    _resetKeyCache();
    process.chdir(originalCwd);
    if (previousDirectory === undefined) delete process.env.EZCORP_SECRETS_DIR;
    else process.env.EZCORP_SECRETS_DIR = previousDirectory;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("uses an existing salt from a Windows-style database directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "ezh-encryption-"));
  const originalCwd = process.cwd();
  const previous = {
    database: process.env.EZCORP_DB_PATH,
    directory: process.env.EZCORP_SECRETS_DIR,
    secret: process.env.EZCORP_ENCRYPTION_SECRET,
    salt: process.env.EZCORP_ENCRYPTION_SALT,
  };
  try {
    process.chdir(directory);
    process.env.EZCORP_DB_PATH = "state\\ezcorp.sqlite";
    delete process.env.EZCORP_SECRETS_DIR;
    process.env.EZCORP_ENCRYPTION_SECRET = "test-secret-key-for-testing";
    delete process.env.EZCORP_ENCRYPTION_SALT;
    mkdirSync(join(directory, "state"));
    writeFileSync(join(directory, "state/.pi-salt"), "existing-salt");
    _resetKeyCache();

    expect(decrypt(encrypt("uses existing salt"))).toBe("uses existing salt");
    expect(readFileSync(join(directory, "state/.pi-salt"), "utf8").trim()).toBe("existing-salt");
  } finally {
    _resetKeyCache();
    process.chdir(originalCwd);
    if (previous.database === undefined) delete process.env.EZCORP_DB_PATH;
    else process.env.EZCORP_DB_PATH = previous.database;
    if (previous.directory === undefined) delete process.env.EZCORP_SECRETS_DIR;
    else process.env.EZCORP_SECRETS_DIR = previous.directory;
    if (previous.secret === undefined) delete process.env.EZCORP_ENCRYPTION_SECRET;
    else process.env.EZCORP_ENCRYPTION_SECRET = previous.secret;
    if (previous.salt === undefined) delete process.env.EZCORP_ENCRYPTION_SALT;
    else process.env.EZCORP_ENCRYPTION_SALT = previous.salt;
    rmSync(directory, { recursive: true, force: true });
  }
});
