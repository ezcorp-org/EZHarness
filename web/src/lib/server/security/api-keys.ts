import crypto from "node:crypto";
import { getAllSettings } from "$server/db/queries/settings";

export type ApiKeyScope = "read" | "chat" | "extensions" | "admin";

interface GeneratedKey {
  raw: string;
  hash: string;
  keyId: string;
}

interface VerifiedKey {
  userId: string;
  scopes: ApiKeyScope[];
  name: string;
}

export function generateApiKey(): GeneratedKey {
  const raw = "ezk_" + crypto.randomBytes(32).toString("base64url");
  return { raw, hash: hashApiKey(raw), keyId: crypto.randomUUID() };
}

export function hashApiKey(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export async function verifyApiKey(raw: string): Promise<VerifiedKey | null> {
  const hash = hashApiKey(raw);
  const all = await getAllSettings();
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith("apikey:")) continue;
    const entry = value as { hash: string; userId: string; scopes: ApiKeyScope[]; name: string };
    if (entry.hash === hash) {
      return { userId: entry.userId, scopes: entry.scopes, name: entry.name };
    }
  }
  return null;
}

export function requireScope(
  locals: { apiKeyScopes?: ApiKeyScope[] },
  scope: ApiKeyScope,
): Response | null {
  if (!locals.apiKeyScopes) return null; // cookie auth -- allow all
  if (locals.apiKeyScopes.includes(scope)) return null;
  return Response.json({ error: "Insufficient scope", required: scope }, { status: 403 });
}
