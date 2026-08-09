/**
 * Admin-only Settings → Search BACKEND config (shared-search Phase 2).
 *
 * Reuses the EXISTING encrypted + deny-listed `provider:apiKey:*` secret
 * store (same as the LLM providers route) for BYOK search keys — NO new
 * secret store. The SearXNG base URL is a non-secret instance setting
 * (`global:search:searxngUrl`).
 *
 *   GET    → presence-only status (hasKey per BYOK provider + searxngUrl).
 *            Keys are NEVER returned (encrypted at rest + deny-listed from
 *            the generic settings API).
 *   POST   → upsert a BYOK key (encrypted) or the SearXNG URL.
 *   DELETE → remove a BYOK key.
 *
 * All three require admin on BOTH authorization axes — `requireAdmin(locals)`
 * for the ROLE, then `requireScope(locals, "admin")` for the API-key SCOPE.
 * A member could otherwise redirect search egress or exfiltrate billing, and
 * (F2) a key minted `--scopes read --role admin` could reach these writes on
 * a role-only gate. Cookie sessions carry no `apiKeyScopes`, so the scope
 * check is a no-op for them and they pass on role alone.
 *
 * Both helpers RETURN their denial (#84) — a thrown Response is what SvelteKit
 * renders as a 500. Role first, so an unauthenticated or non-admin caller gets
 * #84's uniform 403 "Admin role required". The added scope axis deliberately
 * narrows this route's former "no API-key scope gate" contract.
 */
import { json } from "@sveltejs/kit";
import { z } from "zod";
import { encrypt } from "$server/providers/encryption";
import { getSetting, upsertSetting, deleteSetting } from "$server/db/queries/settings";
import { requireAdmin, requireScope } from "$lib/server/security/api-keys";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

// The BYOK search providers (mirror SEARCH_BYOK_PROVIDERS in
// $lib/settings-search-config + resolveProviders in src/search/providers).
const BYOK_PROVIDERS = ["tavily", "brave", "exa", "serpapi", "jina"] as const;
type ByokProvider = (typeof BYOK_PROVIDERS)[number];

const SEARXNG_URL_KEY = "global:search:searxngUrl";

function isByokProvider(p: string): p is ByokProvider {
  return (BYOK_PROVIDERS as readonly string[]).includes(p);
}

function apiKeySetting(provider: ByokProvider): string {
  return `provider:apiKey:${provider}`;
}

// POST upserts either a BYOK `{ provider, apiKey }` or the SearXNG URL
// `{ searxngUrl }`. The discriminant is which field is present.
const postBodySchema = z
  .object({
    provider: z.string().optional(),
    apiKey: z.string().optional(),
    searxngUrl: z.string().optional(),
  })
  .strict();

const deleteBodySchema = z.object({ provider: z.string().optional() }).strict();

export const GET: RequestHandler = async ({ locals }) => {
  const adminErr = requireAdmin(locals);
  if (adminErr) return adminErr;
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  const providers = await Promise.all(
    BYOK_PROVIDERS.map(async (provider) => ({
      provider,
      // Presence only — the key itself is encrypted + deny-listed and
      // must never leave the server.
      hasKey: !!(await getSetting(apiKeySetting(provider))),
    })),
  );
  const searxngUrl = await getSetting(SEARXNG_URL_KEY);
  return json({
    providers,
    searxngUrl: typeof searxngUrl === "string" ? searxngUrl : "",
  });
};

export const POST: RequestHandler = async ({ request, locals }) => {
  const adminErr = requireAdmin(locals);
  if (adminErr) return adminErr;
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  const admin = locals.user!;
  const parsed = postBodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return errorJson(400, "Invalid request body");
  }
  const { provider, apiKey, searxngUrl } = parsed.data;

  // SearXNG URL branch (non-secret instance setting).
  if (searxngUrl !== undefined) {
    const trimmed = searxngUrl.trim();
    // Reject anything that isn't an http(s) URL — the SSRF guard
    // allowlists this host, so a bad value would only break search,
    // but validate up front for a clean error.
    if (trimmed !== "") {
      let ok = false;
      try {
        const u = new URL(trimmed);
        ok = u.protocol === "http:" || u.protocol === "https:";
      } catch {
        ok = false;
      }
      if (!ok) return errorJson(400, "SearXNG URL must be an http(s) URL");
    }
    await upsertSetting(SEARXNG_URL_KEY, trimmed);
    try {
      await insertAuditEntry(admin.id, "search:backend_upsert", "searxngUrl", {});
    } catch {
      /* swallow */
    }
    return json({ success: true });
  }

  // BYOK key branch (encrypted, reuses the provider:apiKey:* store).
  if (!provider || !isByokProvider(provider)) {
    return errorJson(400, `Invalid provider. Must be one of: ${BYOK_PROVIDERS.join(", ")}`);
  }
  if (!apiKey || typeof apiKey !== "string" || apiKey.trim().length === 0) {
    return errorJson(400, "API key is required");
  }
  await upsertSetting(apiKeySetting(provider), encrypt(apiKey.trim()));
  try {
    await insertAuditEntry(admin.id, "search:backend_upsert", provider, {});
  } catch {
    /* swallow */
  }
  return json({ success: true });
};

export const DELETE: RequestHandler = async ({ request, locals }) => {
  const adminErr = requireAdmin(locals);
  if (adminErr) return adminErr;
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  const admin = locals.user!;
  const parsed = deleteBodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return errorJson(400, "Invalid request body");
  }
  const { provider } = parsed.data;
  if (!provider || !isByokProvider(provider)) {
    return errorJson(400, `Invalid provider. Must be one of: ${BYOK_PROVIDERS.join(", ")}`);
  }
  await deleteSetting(apiKeySetting(provider));
  try {
    await insertAuditEntry(admin.id, "search:backend_delete", provider, {});
  } catch {
    /* swallow */
  }
  return json({ success: true });
};
