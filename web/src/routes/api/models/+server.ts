import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getModelRegistry, getOAuthModelIds, type ModelEntry } from "$server/providers/registry";
import { getCredential } from "$server/providers/credentials";
import { getSetting } from "$server/db/queries/settings";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";

const ENV_KEYS: Record<string, string> = {
	anthropic: "ANTHROPIC_API_KEY",
	openai: "OPENAI_API_KEY",
	google: "GOOGLE_API_KEY",
};

function mapModel(m: ModelEntry, available: boolean) {
	return {
		provider: m.provider,
		model: m.id,
		tier: m.tier,
		contextWindow: m.contextWindow,
		vision: m.vision,
		reasoning: m.reasoning,
		costTier: m.costTier,
		displayName: m.displayName,
		available,
	};
}

export const GET: RequestHandler = async ({ locals }) => {
	const scopeErr = requireScope(locals, "read");
	if (scopeErr) return scopeErr;
	requireAuth(locals);

	const allModels = await getModelRegistry();
	const result: ReturnType<typeof mapModel>[] = [];

	// Determine availability and credential type per unique provider
	const providers = [...new Set(allModels.map((m) => m.provider))];
	const availability = new Map<string, boolean>();
	const credTypes = new Map<string, string>();

	for (const provider of providers) {
		const hasEnv = !!(ENV_KEYS[provider] && process.env[ENV_KEYS[provider]]);
		const hasByok = !!(await getSetting(`provider:apiKey:${provider}`));
		const hasOauth = !!(await getSetting(`provider:oauth:${provider}`));
		let available = hasEnv || hasByok || hasOauth;

		if (available) {
			try {
				const cred = await getCredential(provider);
				credTypes.set(provider, cred.type);
			} catch {
				available = false;
			}
		}

		availability.set(provider, available);
	}

	// When providers use OAuth, only show models supported by their OAuth-compatible variant
	// (e.g. google → google-gemini-cli, openai → openai-codex)
	const oauthFilters = new Map<string, Set<string>>();
	for (const [provider, credType] of credTypes) {
		if (credType === "oauth") {
			const ids = getOAuthModelIds(provider);
			if (ids) oauthFilters.set(provider, ids);
		}
	}

	for (const m of allModels) {
		const allowedIds = oauthFilters.get(m.provider);
		if (allowedIds && !allowedIds.has(m.id)) continue;
		const isLocal = !!m.baseUrl;
		result.push(mapModel(m, isLocal || (availability.get(m.provider) ?? false)));
	}

	return json(result);
};
