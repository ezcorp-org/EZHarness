import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ALGORITHM = "aes-256-gcm";
// sec-L4: new ciphertexts use the NIST-recommended 12-byte IV for AES-GCM.
// Legacy ciphertexts (without a format tag) used 16 bytes and are decrypted
// against that length for backward compatibility.
const IV_LENGTH = 12;
const LEGACY_IV_LENGTH = 16;
const FORMAT_TAG_V1 = "v1";
const LEGACY_SALT = "pi-salt";
const KEY_LENGTH = 32;

let _cachedKey: Buffer | null = null;
let _cachedSalt: string | null = null;

/**
 * Directory for persistent auto-generated secrets (`.pi-secret`, `.pi-salt`).
 * Defaults to the dir containing `EZCORP_DB_PATH` so that in Docker the
 * secret lives under `/app/data` (a declared VOLUME) and survives image
 * upgrades. Dev installations without `EZCORP_DB_PATH` fall back to CWD.
 *
 * Override with `EZCORP_SECRETS_DIR` if you want secrets on a separate mount
 * from the DB.
 *
 * **Production best practice:** set `EZCORP_ENCRYPTION_SECRET` explicitly;
 * this auto-generation path is a convenience for dev and first-run docker,
 * not a substitute for managed secret storage.
 */
function getSecretsDir(): string {
  const override = process.env.EZCORP_SECRETS_DIR;
  if (override) return override;
  const dbPath = process.env.EZCORP_DB_PATH;
  if (dbPath && dbPath !== ":memory:") {
    // dirname without pulling in node:path as a new dep — we already import
    // join from path, but keeping the logic inline for clarity.
    const sep = dbPath.includes("\\") ? "\\" : "/";
    const idx = dbPath.lastIndexOf(sep);
    if (idx > 0) return dbPath.slice(0, idx);
  }
  return process.cwd();
}

function readFirstExisting(paths: string[]): string | null {
  for (const p of paths) {
    if (existsSync(p)) return readFileSync(p, "utf-8").trim();
  }
  return null;
}

function getAppSalt(): string {
  if (_cachedSalt) return _cachedSalt;

  const envSalt = process.env.EZCORP_ENCRYPTION_SALT;
  if (envSalt) {
    _cachedSalt = envSalt;
    return _cachedSalt;
  }

  const primarySaltPath = join(getSecretsDir(), ".pi-salt");
  const legacySaltPath = join(process.cwd(), ".pi-salt");
  const existing = readFirstExisting([primarySaltPath, legacySaltPath]);
  if (existing) {
    _cachedSalt = existing;
    return _cachedSalt;
  }

  // Backward compatibility: if a secret already exists (in either location)
  // WITHOUT a corresponding salt, it was written with the legacy hardcoded
  // salt — keep using it to avoid breaking decryption of historical rows.
  const primarySecretPath = join(getSecretsDir(), ".pi-secret");
  const legacySecretPath = join(process.cwd(), ".pi-secret");
  if (existsSync(primarySecretPath) || existsSync(legacySecretPath)) {
    _cachedSalt = LEGACY_SALT;
    return _cachedSalt;
  }

  // Fresh installation: generate a random 16-byte salt and persist it in the
  // primary location (which, in Docker, is under the data VOLUME).
  const newSalt = randomBytes(16).toString("hex");
  mkdirSync(getSecretsDir(), { recursive: true });
  writeFileSync(primarySaltPath, newSalt, { mode: 0o600 });
  _cachedSalt = newSalt;
  return _cachedSalt;
}

function getAppSecret(): Buffer {
  if (_cachedKey) return _cachedKey;

  const envSecret = process.env.EZCORP_ENCRYPTION_SECRET;
  let secret: string;

  if (envSecret) {
    secret = envSecret;
  } else {
    const primary = join(getSecretsDir(), ".pi-secret");
    const legacy = join(process.cwd(), ".pi-secret");
    const existing = readFirstExisting([primary, legacy]);
    if (existing) {
      secret = existing;
    } else {
      secret = randomBytes(32).toString("hex");
      mkdirSync(getSecretsDir(), { recursive: true });
      writeFileSync(primary, secret, { mode: 0o600 });
    }
  }

  _cachedKey = scryptSync(secret, getAppSalt(), KEY_LENGTH);
  return _cachedKey;
}

export function encrypt(plaintext: string): string {
  const key = getAppSecret();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");

  // sec-L4: tagged v1 format with 12-byte IV.
  return `${FORMAT_TAG_V1}:${iv.toString("hex")}:${authTag}:${encrypted}`;
}

export function decrypt(ciphertext: string): string {
  const parts = ciphertext.split(":");

  let ivHex: string;
  let tagHex: string;
  let encryptedHex: string;
  let expectedIvLength: number;

  if (parts.length === 4 && parts[0] === FORMAT_TAG_V1) {
    // sec-L4: new v1 format — 12-byte IV.
    ivHex = parts[1]!;
    tagHex = parts[2]!;
    encryptedHex = parts[3]!;
    expectedIvLength = IV_LENGTH;
  } else if (parts.length === 3) {
    // Legacy untagged format — 16-byte IV. Kept for backward compatibility
    // so ciphertexts written before sec-L4 can still be read.
    ivHex = parts[0]!;
    tagHex = parts[1]!;
    encryptedHex = parts[2]!;
    expectedIvLength = LEGACY_IV_LENGTH;
  } else {
    throw new Error("Invalid encrypted format: expected [v1:]iv:tag:ciphertext");
  }

  const key = getAppSecret();
  const iv = Buffer.from(ivHex, "hex");
  if (iv.length !== expectedIvLength) {
    throw new Error(`Invalid encrypted format: IV length ${iv.length} does not match expected ${expectedIvLength}`);
  }
  const authTag = Buffer.from(tagHex, "hex");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedHex, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

/** Reset cached key and salt (for testing) */
export function _resetKeyCache(): void {
  _cachedKey = null;
  _cachedSalt = null;
}
