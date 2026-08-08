import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getCredential } from "$server/providers/credentials";
import { findModelForProviderInTier, resolveModelObject } from "$server/providers/registry";
import { getConfiguredTierLadder, getRoutableOverlayModels } from "$server/providers/router";
import { complete } from "@earendil-works/pi-ai/compat";
import { requireAdmin, requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import { LLM_PROVIDER_IDS, providerListMessage } from "$server/runtime/routing/llm-providers";

// Derived from the one provider table — see web/src/routes/api/providers/+server.ts.
const VALID_PROVIDERS = new Set<string>(LLM_PROVIDER_IDS);

export const POST: RequestHandler = async ({ params, locals }) => {
	// Live provider-credential test hits instance secrets — admin-only, on
	// BOTH axes. requireScope("admin") alone would allow any cookie session
	// (allow-all for non-API-key principals); requireAdmin gates on role so
	// non-admin members get 403. See FINDING A.
	//
	// F6: the "BOTH axes" above was, until now, only half true — the scope
	// call was missing, so an admin-role key minted `--scopes read` could spend
	// the instance's BYOK provider credential on a live completion. The
	// `requireAdmin` + `requireScope("admin")` pairing matches the sibling
	// `POST/DELETE /api/providers`. `requireAuth` is gone: it THREW its 401
	// (SvelteKit renders a thrown Response as a 500) and `requireAdmin` already
	// refuses a request with no `locals.user`, returning its denial.
	const adminErr = requireAdmin(locals);
	if (adminErr) return adminErr;
	const scopeErr = requireScope(locals, "admin");
	if (scopeErr) return scopeErr;

	const { provider } = params;
	if (!provider || !VALID_PROVIDERS.has(provider)) {
		return errorJson(400, `Invalid provider. Must be one of: ${providerListMessage()}`);
	}

	try {
		const cred = await getCredential(provider);

		// Resolve the probe model exactly the way ROUTING would, ladder and
		// overlay included. Asking the bare pi-ai catalog reported "No models
		// available for kilo" for a provider that has ~350 of them — Kilo is not
		// a pi-ai provider, so its models (like Ollama's) reach routing only
		// through the overlay. A connection test that consults a narrower list
		// than the router does can fail a provider that works.
		const [ladder, overlay] = await Promise.all([
			getConfiguredTierLadder(),
			getRoutableOverlayModels(),
		]);
		const model = findModelForProviderInTier(provider, "fast", ladder, overlay);
		if (!model) {
			return json({ success: false, error: `No models available for ${provider}` });
		}

		const piModel = resolveModelObject(provider, model.id, model.baseUrl);

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
