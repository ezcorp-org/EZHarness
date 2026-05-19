import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import { fetchProviderModels } from "$server/providers/model-discovery";
import { getCredential, type ProviderCredential } from "$server/providers/credentials";
import { upsertSetting } from "$server/db/queries/settings";
import { logger } from "$server/logger";

const log = logger.child("api.refresh-models");

const VALID_PROVIDERS = new Set(["anthropic", "openai", "google"]);

export const POST: RequestHandler = async ({ params, locals }) => {
	const scopeErr = requireScope(locals, "admin");
	if (scopeErr) return scopeErr;
	requireAuth(locals);

	const { provider } = params;
	if (!provider || !VALID_PROVIDERS.has(provider)) {
		return errorJson(400, "Invalid provider. Must be one of: anthropic, openai, google");
	}

	try {
		// Best-effort credential: lets us hit the provider's own /v1/models
		// (authoritative + key-scoped). Missing creds → catalog fallback.
		let credential: ProviderCredential | undefined;
		try {
			credential = await getCredential(provider);
		} catch {
			credential = undefined;
		}

		const models = await fetchProviderModels(provider, credential);
		await upsertSetting(`provider:discoveredModels:${provider}`, models);
		return json({
			success: true,
			count: models.length,
			ids: models.map((m) => m.id),
			fetchedAt: new Date().toISOString(),
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log.error("provider model fetch failed", { provider, error: message });
		return json({ success: false, error: message });
	}
};
