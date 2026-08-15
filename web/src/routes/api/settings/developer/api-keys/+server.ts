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
import { canMintRole, scopesOverCeiling } from "$server/auth/api-key";
import {
  policyOverCeiling,
  resolveRouteBundle,
  routeBundleNames,
  validateToolPolicy,
  type ToolPolicy,
} from "$server/auth/tool-policy";
import { getVisibleMode } from "$server/db/queries/modes";
import { apiRegistry } from "$server/api-registry";
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
      // `role` is optional on-disk (legacy rows) → surface the member default.
      return { keyId, name: entry.name, scopes: entry.scopes, role: entry.role ?? "member", createdAt: entry.createdAt };
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

  const { name, scopes, role } = result.data;

  // Expand `routeBundle` into the concrete route list BEFORE any ceiling or
  // validity check, so both run against the routes that will actually be
  // stored. The bundle NAME is never persisted: a stored name would silently
  // change meaning the day the bundle is edited, and a key's reach must be
  // whatever it was reviewed as at mint time.
  let requestedPolicy: ToolPolicy | undefined;
  if (result.data.toolPolicy) {
    const { routeBundle, ...rest } = result.data.toolPolicy;
    if (routeBundle !== undefined) {
      if (rest.routeAllowlist !== undefined) {
        return errorJson(400, "Specify routeBundle or routeAllowlist, not both");
      }
      const resolved = resolveRouteBundle(routeBundle);
      if (!resolved) {
        return errorJson(
          400,
          `Unknown routeBundle "${routeBundle}". Known bundles: ${routeBundleNames().join(", ")}`,
        );
      }
      rest.routeAllowlist = [...resolved];
    }
    requestedPolicy = rest;
  }

  // Scope ceiling: a key must never carry authority its OWNER lacks. A
  // non-admin self-minting an `admin`-scoped key would be a privilege
  // escalation (the zod schema permits "admin", and requireScope("admin")
  // is allow-all for cookie sessions). See FINDING B. Enforced identically
  // in the CLI via the shared scopesOverCeiling().
  const over = scopesOverCeiling(user.role, scopes);
  if (over.length > 0) {
    return errorJson(403, `Cannot mint scope(s) you lack: ${over.join(", ")}`);
  }

  // Role anti-escalation: minting an admin-ROLE key requires the ACTOR to
  // already be an admin. Without this, a member-role key that merely holds
  // the `admin` SCOPE (enough to reach this route) could mint itself an
  // admin-role key and cross the role wall — a privilege-escalation hole.
  // `user.role` is the cookie session's real role, or (for a bearer caller)
  // the calling key's own stored role.
  if (!canMintRole(user.role, role)) {
    return errorJson(403, `Cannot mint a key with role "${role}": requires admin role`);
  }

  // Policy ceiling, on the same axis as the two checks above and in the same
  // order: what the ACTOR may hand out, before what is intrinsically valid.
  // For every field the acting key's own policy constrains, an ABSENT field
  // in the request is WIDENING — so a policied actor can mint only an
  // equal-or-narrower key, and can never mint an unpolicied one. The common
  // case is an unpolicied admin (this route is `admin`-scoped), for whom
  // `policyOverCeiling` returns [] and nothing changes.
  const policyOver = policyOverCeiling(locals.apiKeyToolPolicy, requestedPolicy);
  if (policyOver.length > 0) {
    return errorJson(
      403,
      `Cannot mint a key that widens your own policy: ${policyOver.join(", ")}`,
    );
  }

  // Intrinsic validity LAST: every route resolves against the registry (so a
  // typo is a 400 rather than a route that silently denies forever), the
  // locked mode is one the OWNER can see, the caller-tool names are spellable.
  const policyErrors = await validateToolPolicy(requestedPolicy, {
    getMode: (id, ownerId) => getVisibleMode(id, ownerId),
    ownerId: user.id,
    registry: apiRegistry,
  });
  if (policyErrors) {
    return errorJson(400, "Invalid toolPolicy", { details: policyErrors });
  }

  const { raw, keyId } = await mintApiKeyForUser(
    user.id,
    scopes,
    name,
    role,
    requestedPolicy,
  );

  return json(
    { key: raw, keyId, name, scopes, role, ...(requestedPolicy ? { toolPolicy: requestedPolicy } : {}) },
    { status: 201 },
  );
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
