import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireAuth } from "$server/auth/middleware";
import { getCredential } from "$server/providers/credentials";
import { findModelForProviderInTier, resolveModelObject } from "$server/providers/registry";
import { complete } from "@mariozechner/pi-ai";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";

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
		const cred = await getCredential(provider);

		const model = findModelForProviderInTier(provider, "fast");
		if (!model) {
			return json({ success: false, error: `No models available for ${provider}` });
		}

		const piModel = resolveModelObject(provider, model.id);

		await complete(piModel, {
			messages: [{ role: "user", content: "Say ok", timestamp: Date.now() }],
		}, {
			apiKey: cred.token,
			maxTokens: 1,
			signal: AbortSignal.timeout(15_000),
		});

		return json({ success: true });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return json({ success: false, error: message });
	}
};
