/**
 * API Key CRUD endpoints for developer settings.
 *
 * GET:    List user's API keys (name, scopes, createdAt, keyId -- NOT the hash or raw key)
 * POST:   Generate new API key with name + scopes. Returns raw key once.
 * DELETE:  Revoke API key by keyId.
 */

import { json } from "@sveltejs/kit";
import { requireAuth } from "$server/auth/middleware";
import { getAllSettings, deleteSetting } from "$server/db/queries/settings";
import {
  requireScope,
  apiKeySettingsKey,
  apiKeySettingsPrefix,
  type ApiKeyEntry,
} from "$lib/server/security/api-keys";
import { mintApiKeyForUser } from "$server/auth/mint-api-key";
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
  const deleted = await deleteSetting(apiKeySettingsKey(user.id, keyId));
  if (!deleted) return errorJson(404, "Key not found");
  return new Response(null, { status: 204 });
};
