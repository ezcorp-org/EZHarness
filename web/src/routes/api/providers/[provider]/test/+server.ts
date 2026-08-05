import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getCredential } from "$server/providers/credentials";
import { findModelForProviderInTier, resolveModelObject } from "$server/providers/registry";
import { complete } from "@earendil-works/pi-ai/compat";
import { requireAdmin, requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";

const VALID_PROVIDERS = new Set(["anthropic", "openai", "google", "openrouter"]);

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
		return errorJson(400, "Invalid provider. Must be one of: anthropic, openai, google, openrouter");
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
