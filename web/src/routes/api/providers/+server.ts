import { json } from "@sveltejs/kit";
import { z } from "zod";
import type { RequestHandler } from "./$types";
import { encrypt, decrypt } from "$server/providers/encryption";
import { getSetting, upsertSetting, deleteSetting } from "$server/db/queries/settings";
import { requireAuth } from "$server/auth/middleware";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { requireAdmin, requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import {
	isKnownLlmProvider,
	LLM_PROVIDER_IDS,
	OAUTH_SUPPORTED_PROVIDERS,
	PROVIDER_ENV_KEYS,
	providerListMessage,
} from "$server/runtime/routing/llm-providers";

// The one provider table (`src/runtime/routing/llm-providers.ts`). Before it,
// this route, the two per-provider routes, provider-availability and the
// backend router each carried their own copy of the same list — and a provider
// added to some but not all of them is a provider you can save a key for but
// cannot route to.
const PROVIDERS = LLM_PROVIDER_IDS;
type Provider = string;

// Boundary validation. POST upserts an encrypted API key; DELETE removes
// it. Both bodies share the `provider` discriminant — POST also requires
// `apiKey`. The 400 messages are preserved verbatim so the existing test
// contract on those exact strings still holds.
const postBodySchema = z.object({
  provider: z.string().optional(),
  apiKey: z.string().optional(),
}).strict();

const deleteBodySchema = z.object({
  provider: z.string().optional(),
}).strict();

const ENV_KEYS: Record<Provider, string> = { ...PROVIDER_ENV_KEYS };

// OAuth is supported for openai and google only (anthropic, openrouter and
// kilo are BYOK-only) — derived, not restated.
const OAUTH_SUPPORTED = new Set<string>(OAUTH_SUPPORTED_PROVIDERS);

function settingKey(provider: Provider): string {
	return `provider:apiKey:${provider}`;
}

function isValidProvider(p: string): p is Provider {
	return isKnownLlmProvider(p);
}

const INVALID_PROVIDER_MESSAGE = `Invalid provider. Must be one of: ${providerListMessage()}`;

export const GET: RequestHandler = async ({ locals }) => {
	const scopeErr = requireScope(locals, "read");
	if (scopeErr) return scopeErr;
	requireAuth(locals);
	const statuses = await Promise.all(
		PROVIDERS.map(async (provider) => {
			const hasEnv = !!process.env[ENV_KEYS[provider]];
			const stored = await getSetting(settingKey(provider));
			const hasByok = !!stored;

			// OAuth status
			const oauthSupported = OAUTH_SUPPORTED.has(provider);
			let oauthConnected = false;
			let oauthExpired = false;
			let expiresAt: string | null = null;

			if (oauthSupported) {
				const oauthToken = await getSetting(`provider:oauth:${provider}`);
				if (oauthToken && typeof oauthToken === "string") {
					oauthConnected = true;
					try {
						const tokenData = JSON.parse(decrypt(oauthToken)) as { expires: number };
						expiresAt = new Date(tokenData.expires).toISOString();
						if (tokenData.expires < Date.now()) {
							oauthExpired = true;
						}
					} catch {
						// Decrypt failed -- report as disconnected
						oauthConnected = false;
					}
				}
			}

			return {
				provider,
				hasKey: hasEnv || hasByok,
				source: hasByok ? "byok" : hasEnv ? "env" : "none",
				oauthConnected,
				oauthExpired,
				oauthSupported,
				expiresAt,
			};
		})
	);

	return json(statuses);
};

export const POST: RequestHandler = async ({ request, locals }) => {
	// sec-C5: admin role required. Pre-fix this route was only gated by
	// requireScope(locals, "admin") which is a no-op for cookie auth, so any
	// authenticated member could overwrite the organization's LLM API key —
	// redirecting billing to an attacker-controlled key.
	//
	// F2: BOTH authorization axes, as the explicit `requireAdmin` +
	// `requireScope("admin")` pairing that route-contract.test.ts sanctions.
	//
	// sec-C5 closed the cookie hole but opened a key one: role alone proves the
	// PRINCIPAL is an admin and ignores what the key was SCOPED for, so a key
	// minted `--scopes read --role admin` still reached this write — which sets
	// the organization's LLM API key. The scope check closes that, and
	// deliberately narrows this route's former "no API-key scope gate"
	// contract. A cookie session carries no `apiKeyScopes`, so `requireScope`
	// is a no-op for it and browser admins are unaffected.
	//
	// Both helpers RETURN their denial (#84) — a thrown Response is what
	// SvelteKit renders as a 500. Role is checked FIRST so an unauthenticated
	// or non-admin caller gets #84's uniform 403 "Admin role required" rather
	// than leaking that scope was also missing.
	const adminErr = requireAdmin(locals);
	if (adminErr) return adminErr;
	const scopeErr = requireScope(locals, "admin");
	if (scopeErr) return scopeErr;
	const admin = locals.user!;
	const parsed = postBodySchema.safeParse(await request.json().catch(() => ({})));
	if (!parsed.success) {
		return errorJson(400, INVALID_PROVIDER_MESSAGE);
	}
	const { provider, apiKey } = parsed.data;

	if (!provider || !isValidProvider(provider)) {
		return errorJson(400, INVALID_PROVIDER_MESSAGE);
	}
	if (!apiKey || typeof apiKey !== "string" || apiKey.trim().length === 0) {
		return errorJson(400, "API key is required");
	}

	const encrypted = encrypt(apiKey.trim());
	await upsertSetting(settingKey(provider), encrypted);

	// Best-effort audit log — do not fail the request on logging errors.
	try {
		await insertAuditEntry(admin.id, "provider:key_upsert", provider, {});
	} catch { /* swallow */ }

	return json({ success: true });
};

export const DELETE: RequestHandler = async ({ request, locals }) => {
	// sec-C5: admin role required. Pre-fix, any authenticated member could
	// delete the organization's LLM API key — DoS for every other user.
	// F2: role AND admin scope, both returning their denial — see POST above.
	const adminErr = requireAdmin(locals);
	if (adminErr) return adminErr;
	const scopeErr = requireScope(locals, "admin");
	if (scopeErr) return scopeErr;
	const admin = locals.user!;
	const parsed = deleteBodySchema.safeParse(await request.json().catch(() => ({})));
	if (!parsed.success) {
		return errorJson(400, INVALID_PROVIDER_MESSAGE);
	}
	const { provider } = parsed.data;

	if (!provider || !isValidProvider(provider)) {
		return errorJson(400, INVALID_PROVIDER_MESSAGE);
	}

	await deleteSetting(settingKey(provider));

	// Best-effort audit log — do not fail the request on logging errors.
	try {
		await insertAuditEntry(admin.id, "provider:key_delete", provider, {});
	} catch { /* swallow */ }

	return json({ success: true });
};
