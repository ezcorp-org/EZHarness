import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import {
	getModelSupport,
	peekModelSupport,
	invalidateModelSupport,
	resolveLocalModel,
} from "$server/contexts/model-support";

/**
 * GET /api/contexts/model-support — the resource-aware support status of the
 * effective default-local model, for the Settings → Topic Contexts status line.
 *
 * The endpoint + model come from the SERVER's suggest config (never a
 * caller-supplied URL), so there is no SSRF surface — read scope + auth is
 * enough (mirrors the other read-scoped contexts routes).
 *
 * Normal load PEEKS the cache (instant; `probed:false` when boot warmup hasn't
 * landed yet). `?recheck=1` invalidates + runs a fresh probe (the "re-check"
 * button — it may block for the cold-load budget, which is expected on a
 * deliberate user action).
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	const scopeErr = requireScope(locals, "read");
	if (scopeErr) return scopeErr;
	requireAuth(locals);

	const local = await resolveLocalModel();
	if (!local.baseUrl) {
		return json({
			localModel: local.model,
			configured: false,
			probed: false,
			supported: false,
			reason: "endpoint-down",
		});
	}

	if (url.searchParams.get("recheck") === "1") {
		invalidateModelSupport();
		const support = await getModelSupport(local.baseUrl, local.model);
		return json({
			localModel: local.model,
			configured: true,
			probed: true,
			supported: support.supported,
			reason: support.reason ?? null,
		});
	}

	const cached = peekModelSupport(local.baseUrl, local.model);
	return json({
		localModel: local.model,
		configured: true,
		probed: cached !== null,
		supported: cached?.supported ?? false,
		reason: cached?.reason ?? null,
	});
};
