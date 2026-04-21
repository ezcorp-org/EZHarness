import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
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

function getAppSalt(): string {
  if (_cachedSalt) return _cachedSalt;

  const envSalt = process.env.EZCORP_ENCRYPTION_SALT;
  if (envSalt) {
    _cachedSalt = envSalt;
    return _cachedSalt;
  }

  const saltPath = join(process.cwd(), ".pi-salt");
  if (existsSync(saltPath)) {
    _cachedSalt = readFileSync(saltPath, "utf-8").trim();
    return _cachedSalt;
  }

  // Backward compatibility: if .pi-secret already exists, encrypted data may
  // exist using the legacy hardcoded salt — keep using it to avoid breakage.
  const secretPath = join(process.cwd(), ".pi-secret");
  if (existsSync(secretPath)) {
    _cachedSalt = LEGACY_SALT;
    return _cachedSalt;
  }

  // Fresh installation: generate a random 16-byte salt and persist it.
  const newSalt = randomBytes(16).toString("hex");
  writeFileSync(saltPath, newSalt, { mode: 0o600 });
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
    const secretPath = join(process.cwd(), ".pi-secret");
    if (existsSync(secretPath)) {
      secret = readFileSync(secretPath, "utf-8").trim();
    } else {
      secret = randomBytes(32).toString("hex");
      writeFileSync(secretPath, secret, { mode: 0o600 });
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
