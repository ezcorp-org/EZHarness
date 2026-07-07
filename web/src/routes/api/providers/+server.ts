import { json } from "@sveltejs/kit";
import { z } from "zod";
import type { RequestHandler } from "./$types";
import { encrypt, decrypt } from "$server/providers/encryption";
import { getSetting, upsertSetting, deleteSetting } from "$server/db/queries/settings";
import { requireAuth, requireRole } from "$server/auth/middleware";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";

const PROVIDERS = ["anthropic", "openai", "google", "openrouter"] as const;
type Provider = (typeof PROVIDERS)[number];

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

const ENV_KEYS: Record<Provider, string> = {
	anthropic: "ANTHROPIC_API_KEY",
	openai: "OPENAI_API_KEY",
	google: "GOOGLE_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
};

// OAuth is supported for openai and google only (anthropic is BYOK-only)
const OAUTH_SUPPORTED = new Set<string>(["openai", "google"]);

function settingKey(provider: Provider): string {
	return `provider:apiKey:${provider}`;
}

function isValidProvider(p: string): p is Provider {
	return PROVIDERS.includes(p as Provider);
}

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
	const admin = requireRole(locals, "admin");
	const parsed = postBodySchema.safeParse(await request.json().catch(() => ({})));
	if (!parsed.success) {
		return errorJson(400, "Invalid provider. Must be one of: anthropic, openai, google, openrouter");
	}
	const { provider, apiKey } = parsed.data;

	if (!provider || !isValidProvider(provider)) {
		return errorJson(400, "Invalid provider. Must be one of: anthropic, openai, google, openrouter");
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
	const admin = requireRole(locals, "admin");
	const parsed = deleteBodySchema.safeParse(await request.json().catch(() => ({})));
	if (!parsed.success) {
		return errorJson(400, "Invalid provider. Must be one of: anthropic, openai, google, openrouter");
	}
	const { provider } = parsed.data;

	if (!provider || !isValidProvider(provider)) {
		return errorJson(400, "Invalid provider. Must be one of: anthropic, openai, google, openrouter");
	}

	await deleteSetting(settingKey(provider));

	// Best-effort audit log — do not fail the request on logging errors.
	try {
		await insertAuditEntry(admin.id, "provider:key_delete", provider, {});
	} catch { /* swallow */ }

	return json({ success: true });
};
