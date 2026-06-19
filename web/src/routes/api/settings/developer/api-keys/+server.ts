/**
 * API Key CRUD endpoints for developer settings.
 *
 * GET:    List user's API keys (name, scopes, createdAt, keyId -- NOT the hash or raw key)
 * POST:   Generate new API key with name + scopes. Returns raw key once.
 * DELETE:  Revoke API key by keyId.
 */

import { json } from "@sveltejs/kit";
import { requireAuth } from "$server/auth/middleware";
import { getAllSettings } from "$server/db/queries/settings";
import {
  requireScope,
  apiKeySettingsPrefix,
  type ApiKeyEntry,
} from "$lib/server/security/api-keys";
import { scopesOverCeiling } from "$server/auth/api-key";
import { mintApiKeyForUser, deleteApiKeyForUser } from "$server/auth/mint-api-key";
import { validationError } from "$lib/server/security/validation";
import { createApiKeySchema, deleteApiKeySchema } from "../schema";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const all = await getAllSettings();
  const prefix = apiKeySettingsPrefix(user.id);
  const keys = Object.entries(all)
    .filter(([k]) => k.startsWith(prefix))
    .map(([k, v]) => {
      const entry = v as ApiKeyEntry;
      const keyId = k.slice(prefix.length);
      return { keyId, name: entry.name, scopes: entry.scopes, createdAt: entry.createdAt };
    });
  return json({ keys });
};

export const POST: RequestHandler = async ({ request, locals }) => {
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const body = await request.json();
  const result = createApiKeySchema.safeParse(body);
  if (!result.success) return validationError(result.error);

  const { name, scopes } = result.data;

  // Scope ceiling: a key must never carry authority its OWNER lacks. A
  // non-admin self-minting an `admin`-scoped key would be a privilege
  // escalation (the zod schema permits "admin", and requireScope("admin")
  // is allow-all for cookie sessions). See FINDING B. Enforced identically
  // in the CLI via the shared scopesOverCeiling().
  const over = scopesOverCeiling(user.role, scopes);
  if (over.length > 0) {
    return errorJson(403, `Cannot mint scope(s) you lack: ${over.join(", ")}`);
  }

  const { raw, keyId } = await mintApiKeyForUser(user.id, scopes, name);

  return json({ key: raw, keyId, name, scopes }, { status: 201 });
};

export const DELETE: RequestHandler = async ({ request, locals }) => {
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const body = await request.json();
  const result = deleteApiKeySchema.safeParse(body);
  if (!result.success) return validationError(result.error);

  const { keyId } = result.data;
  // Drops BOTH the canonical per-user row and its hash-index pointer so the
  // revoked key can't authenticate via the fast path (see verifyApiKey).
  const deleted = await deleteApiKeyForUser(user.id, keyId);
  if (!deleted) return errorJson(404, "Key not found");
  return new Response(null, { status: 204 });
};
