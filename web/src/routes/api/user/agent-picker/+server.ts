/**
 * Phase 57 UX-03 — agent-picker saved-searches + pinned-agents prefs.
 *
 * Storage uses the existing settings KV (`src/db/queries/settings.ts`) under
 * verbatim namespaced keys per CONTEXT.md locked decisions:
 *   user:<id>:agentPicker:savedSearches
 *   user:<id>:agentPicker:pinned
 *
 * No new DB table, no Drizzle migration — the settings table is JSONB and
 * tolerates the per-user shape.
 *
 * Orphan trim is ON READ only (no background sweep). Pinned agent IDs that
 * no longer resolve in `listAgentConfigs()` get filtered out and the list is
 * re-persisted ONLY when the trim shortened it (no write-amplification when
 * the list is already clean — Wave 0 test 5 locks this).
 *
 * Saved searches reference free-text queries, not agents, so no orphan trim
 * applies on that side.
 */
import { json } from "@sveltejs/kit";
import { requireAuth } from "$server/auth/middleware";
import { getSetting, upsertSetting } from "$server/db/queries/settings";
import { listAgentConfigs } from "$server/db/queries/agent-configs";
import type { RequestHandler } from "./$types";

interface SavedSearch {
	query: string;
	createdAt: number;
}

interface AgentPickerPrefs {
	savedSearches: SavedSearch[];
	pinned: string[];
}

function savedKey(userId: string): string {
	return `user:${userId}:agentPicker:savedSearches`;
}

function pinnedKey(userId: string): string {
	return `user:${userId}:agentPicker:pinned`;
}

export const GET: RequestHandler = async ({ locals }) => {
	const user = requireAuth(locals);
	const [savedRaw, pinnedRaw, agents] = await Promise.all([
		getSetting(savedKey(user.id)),
		getSetting(pinnedKey(user.id)),
		listAgentConfigs(),
	]);

	const liveIds = new Set((agents as Array<{ id: string }>).map((a) => a.id));

	const savedSearches: SavedSearch[] = Array.isArray(savedRaw)
		? (savedRaw as SavedSearch[])
		: [];

	const pinnedRawArr: string[] = Array.isArray(pinnedRaw)
		? (pinnedRaw as string[])
		: [];
	const pinned = pinnedRawArr.filter((id) => liveIds.has(id));

	// No write-amplification: only re-persist if a trim actually occurred.
	if (pinned.length !== pinnedRawArr.length) {
		await upsertSetting(pinnedKey(user.id), pinned);
	}

	const body: AgentPickerPrefs = { savedSearches, pinned };
	return json(body);
};

export const PUT: RequestHandler = async ({ request, locals }) => {
	const user = requireAuth(locals);
	const body = (await request.json()) as Partial<AgentPickerPrefs>;

	if (body.savedSearches !== undefined) {
		await upsertSetting(savedKey(user.id), body.savedSearches);
	}
	if (body.pinned !== undefined) {
		await upsertSetting(pinnedKey(user.id), body.pinned);
	}

	return json({ ok: true });
};
