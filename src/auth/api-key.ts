/**
 * Pure, dependency-free primitives for EZCorp user API keys (`ezk_*`).
 *
 * This lives in `src/` (backend, node:crypto only — no web `$server`/`$lib`
 * aliases) so BOTH the SvelteKit server (`web/.../security/api-keys.ts`,
 * which re-exports these) AND the backend CLI (`src/cli.ts key:mint`) share
 * ONE definition of how a key is generated, hashed, and where its settings
 * row lives. Verification (`verifyApiKey`) and request gating
 * (`requireScope`) stay web-side — they need the settings store and
 * `locals`.
 */
import crypto from "node:crypto";

export type ApiKeyScope = "read" | "chat" | "extensions" | "admin";

/** Canonical scope list — the source of truth for CLI/route validation. */
export const API_KEY_SCOPES: readonly ApiKeyScope[] = ["read", "chat", "extensions", "admin"];

export function isApiKeyScope(value: string): value is ApiKeyScope {
  return (API_KEY_SCOPES as readonly string[]).includes(value);
}

export interface GeneratedKey {
  raw: string;
  hash: string;
  keyId: string;
}

/** Shape of the value stored at the `apikey:<userId>:<keyId>` settings row. */
export interface ApiKeyEntry {
  hash: string;
  userId: string;
  scopes: ApiKeyScope[];
  name: string;
  createdAt: number;
}

/** Settings-store key for a user's API key. Single source of truth so the
 *  GET/POST/DELETE routes and the CLI never drift on the prefix format. */
export function apiKeySettingsKey(userId: string, keyId: string): string {
  return `apikey:${userId}:${keyId}`;
}

/** Prefix used to enumerate a user's keys (e.g. in the list endpoint). */
export function apiKeySettingsPrefix(userId: string): string {
  return `apikey:${userId}:`;
}

export function generateApiKey(): GeneratedKey {
  const raw = "ezk_" + crypto.randomBytes(32).toString("base64url");
  return { raw, hash: hashApiKey(raw), keyId: crypto.randomUUID() };
}

export function hashApiKey(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}
