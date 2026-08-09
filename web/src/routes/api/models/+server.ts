import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getModelRegistry, getOAuthModelIds, type ModelEntry } from "$server/providers/registry";
import { getSetting } from "$server/db/queries/settings";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { resolveProviderAvailability } from "$lib/server/provider-availability";
import { computeInputBudget } from "$server/runtime/stream-chat/context-compaction";

function mapModel(m: ModelEntry, available: boolean) {
	return {
		provider: m.provider,
		model: m.id,
		tier: m.tier,
		contextWindow: m.contextWindow,
		// The number the runtime ACTUALLY enforces: contextWindow minus the
		// response reserve minus the safety margin. Computed here, server-side,
		// from the one gated implementation — the client must never re-derive it,
		// or the gauge and the trim point drift apart again the first time the
		// compaction constants change.
		inputBudget: computeInputBudget({
			maxTokens: m.maxTokens ?? 0,
			contextWindow: m.contextWindow,
		}),
		estimated: m.estimated === true,
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

	// Determine availability and credential type per unique provider. Shared with
	// /api/models/capabilities so the picker and the Auto capability
	// intersection can never disagree about what this deployment can call.
	const { available: availability, credentialTypes: credTypes } =
		await resolveProviderAvailability(allModels.map((m) => m.provider));

	// When providers use OAuth, only show models supported by their OAuth-compatible variant
	// (e.g. google → google-gemini-cli, openai → openai-codex) — plus any models the user
	// explicitly pulled in via the "Refresh models" button (stored under provider:discoveredModels:*).
	const oauthFilters = new Map<string, Set<string>>();
	for (const [provider, credType] of credTypes) {
		if (credType === "oauth") {
			const ids = getOAuthModelIds(provider);
			if (!ids) continue;
			const discovered = (await getSetting(`provider:discoveredModels:${provider}`)) as Array<{ id: string }> | undefined;
			if (Array.isArray(discovered)) {
				for (const m of discovered) ids.add(m.id);
			}
			oauthFilters.set(provider, ids);
		}
	}

	for (const m of allModels) {
		const allowedIds = oauthFilters.get(m.provider);
		if (allowedIds && !allowedIds.has(m.id)) continue;
		const isLocal = !!m.baseUrl;
		result.push(mapModel(m, isLocal || availability.has(m.provider)));
	}

	return json(result);
};
