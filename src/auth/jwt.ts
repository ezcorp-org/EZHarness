import type { AuthUser, JWTPayload } from "./types";
import { getSetting, upsertSetting } from "../db/queries/settings";
import { encrypt, decrypt } from "../providers/encryption";
import { factoryBootConfig } from "../factory/boot";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64UrlEncode(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(str: string): Uint8Array<ArrayBuffer> {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function installationId(secret: string, supplied?: string): Promise<string> {
  const configured = supplied ?? process.env.EZCORP_INSTALLATION_ID;
  if (configured?.trim()) return configured;

  if (factoryBootConfig.enabled) {
    throw new Error("Factory JWT requires EZCORP_INSTALLATION_ID.");
  }

  // Self-hosted installations may not yet have a provisioned identifier. A
  // one-way value derived from their distinct JWT secret still binds tokens to
  // that installation without disclosing the secret in the token.
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return `local:${base64UrlEncode(new Uint8Array(digest))}`;
}

export async function signJWT(
  payload: AuthUser,
  secret: string,
  expiresInSeconds: number = 30 * 24 * 3600,
  installation?: string,
): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  // jti = JWT ID (RFC 7519 §4.1.7). 16 random bytes hex-encoded = 32 chars.
  // Without it, two JWTs signed in the same second with the same payload
  // produce identical tokens — and the sessions.token_hash UNIQUE constraint
  // rejects the second insert (auth-layout-e2e was hitting this). The jti is
  // for collision avoidance only; verifyJWT does not enforce uniqueness.
  const jtiBytes = new Uint8Array(16);
  crypto.getRandomValues(jtiBytes);
  const jti = Array.from(jtiBytes).map(b => b.toString(16).padStart(2, "0")).join("");
  const audience = await installationId(secret, installation);
  const fullPayload: JWTPayload = {
    ...payload,
    iss: audience,
    aud: audience,
    iat: now,
    exp: now + expiresInSeconds,
    jti,
  };

  const headerB64 = base64UrlEncode(encoder.encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(encoder.encode(JSON.stringify(fullPayload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await importKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput));

  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function verifyJWT(
  token: string,
  secret: string,
  installation?: string,
): Promise<JWTPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  try {
    const key = await importKey(secret);
    const signingInput = `${headerB64}.${payloadB64}`;
    const signature = base64UrlDecode(signatureB64);

    const valid = await crypto.subtle.verify("HMAC", key, signature, encoder.encode(signingInput));
    if (!valid) return null;

    const payload: JWTPayload = JSON.parse(decoder.decode(base64UrlDecode(payloadB64)));
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.exp <= now) {
      return null;
    }
    const expectedInstallation = await installationId(secret, installation);
    if (payload.iss !== expectedInstallation || payload.aud !== expectedInstallation) return null;

    return payload;
  } catch {
    return null;
  }
}

let _cachedSecret: string | null = null;

export async function getJwtSecret(): Promise<string> {
  if (_cachedSecret) return _cachedSecret;

  // 1. Check env var
  if (process.env.EZCORP_JWT_SECRET) {
    _cachedSecret = process.env.EZCORP_JWT_SECRET;
    return _cachedSecret;
  }

  // 2. Check settings store.
  // sec-C1b: instance:jwtSecret is encrypted at rest via providers/encryption.
  // Legacy deployments may still have a plaintext value; on decrypt failure we
  // treat it as legacy plaintext, lazily re-save it encrypted, and return it.
  const stored = await getSetting("instance:jwtSecret") as string | undefined;
  if (stored) {
    try {
      _cachedSecret = decrypt(stored);
      return _cachedSecret;
    } catch {
      await upsertSetting("instance:jwtSecret", encrypt(stored));
      _cachedSecret = stored;
      return _cachedSecret;
    }
  }

  // 3. Auto-generate and persist (encrypted at rest — sec-C1b).
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const secret = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
  await upsertSetting("instance:jwtSecret", encrypt(secret));
  _cachedSecret = secret;
  return secret;
}

/** Reset cached secret (for testing) */
export function _resetSecretCache(): void {
  _cachedSecret = null;
}
