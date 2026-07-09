/**
 * Pure selection/display logic for the chat model picker
 * (`components/ModelSelector.svelte`) — extracted so the component, the
 * send-message wire path, and the unit tests share ONE implementation
 * (previously the test file carried a hand-copied clone of this logic).
 *
 * Also home of the "Auto (smart routing)" selection semantics:
 *
 * - Auto is represented client-side as the sentinel selection
 *   `{ provider: "auto", model: "auto" }` (`AUTO_SELECTION`). It is a real,
 *   non-null selection — the composer stays enabled — but it must NEVER be
 *   persisted (not to the conversation row, not to localStorage) and never
 *   sent as a literal "auto" string.
 * - On the wire, Auto is the EXPLICIT `model: null, provider: null` JSON
 *   sentinel (distinguishable from an absent field, which keeps the legacy
 *   conv.model fallback). The server routes the turn and then pins the
 *   SERVED model onto the conversation (route-once-per-conversation).
 * - The client mirrors that route-once discipline: after the first routed
 *   turn reconciles, `resolveWireModel` re-sends the SERVED identity (read
 *   from the last auto-routed assistant message) instead of `null`, so Auto
 *   never re-routes mid-conversation.
 */

export interface ModelSelection {
	provider: string;
	model: string;
}

export interface ModelOptionLike {
	provider: string;
	model: string;
	tier: string;
	costTier: string;
	reasoning?: boolean;
	displayName?: string;
	available: boolean;
	contextWindow?: number;
}

/** Message shape `autoServedFromMessages` needs — a structural subset of
 *  `$lib/api.js`'s `Message` so pure tests don't need the full row. */
export interface ServedMessageLike {
	role: string;
	provider?: string | null;
	model?: string | null;
	usage?: { requestedModel?: string | null } | null;
}

export const AUTO_PROVIDER = "auto";
export const AUTO_MODEL = "auto";
export const AUTO_SELECTION: ModelSelection = { provider: AUTO_PROVIDER, model: AUTO_MODEL };
export const AUTO_LABEL = "Auto (smart routing)";

export const TIER_ORDER = ["powerful", "balanced", "fast"] as const;

export const TIER_LABELS: Record<string, string> = {
	fast: "Fast",
	balanced: "Balanced",
	powerful: "Powerful",
};

export const COST_LABELS: Record<string, string> = {
	low: "$",
	medium: "$$",
	high: "$$$",
};

/** True when the selection is the Auto (smart routing) sentinel. */
export function isAutoSelection(selected: ModelSelection | null): boolean {
	return selected !== null && selected.provider === AUTO_PROVIDER && selected.model === AUTO_MODEL;
}

export function filterAvailable<T extends ModelOptionLike>(models: T[]): T[] {
	return models.filter((m) => m.available);
}

/**
 * Group models by their non-numeric prefix (e.g. "claude-opus" for
 * "claude-opus-4-6"), preserve first-seen family order, and within each
 * family put newer versions (higher numbers) first.
 */
export function sortNewestFirst<T extends ModelOptionLike>(list: T[]): T[] {
	const familyOrder: string[] = [];
	const byFamily = new Map<string, T[]>();
	for (const m of list) {
		const leading = m.model.match(/^[^\d]+/)?.[0] ?? m.model;
		const key = leading.replace(/[-_.\s]+$/, "").toLowerCase();
		if (!byFamily.has(key)) {
			byFamily.set(key, []);
			familyOrder.push(key);
		}
		byFamily.get(key)!.push(m);
	}
	for (const arr of byFamily.values()) {
		arr.sort((a, b) => b.model.localeCompare(a.model, undefined, { numeric: true }));
	}
	return familyOrder.flatMap((k) => byFamily.get(k)!);
}

export function groupModels<T extends ModelOptionLike>(
	models: T[],
): { tier: string; label: string; models: T[] }[] {
	const groups: { tier: string; label: string; models: T[] }[] = [];
	for (const tier of TIER_ORDER) {
		const tierModels = models.filter((m) => m.tier === tier);
		if (tierModels.length > 0) {
			groups.push({ tier, label: TIER_LABELS[tier] ?? tier, models: sortNewestFirst(tierModels) });
		}
	}
	const knownTiers = new Set<string>(TIER_ORDER);
	const otherModels = models.filter((m) => !knownTiers.has(m.tier));
	if (otherModels.length > 0) {
		groups.push({ tier: "other", label: "Other", models: sortNewestFirst(otherModels) });
	}
	return groups;
}

function truncateLabel(name: string): string {
	return name.length > 24 ? name.slice(0, 24) + "..." : name;
}

/**
 * Picker-button label. Auto renders its own label — and once a routed turn
 * has been served in-session, "Auto → <served model>" so the user sees what
 * the router picked without leaving Auto mode.
 */
export function displayLabel(
	selected: ModelSelection | null,
	models: ModelOptionLike[],
	autoServed: ModelSelection | null = null,
): string {
	if (!selected) return "Select model";
	if (isAutoSelection(selected)) {
		if (!autoServed) return AUTO_LABEL;
		const served = models.find(
			(m) => m.provider === autoServed.provider && m.model === autoServed.model,
		);
		return truncateLabel(`Auto → ${served?.displayName ?? autoServed.model}`);
	}
	const m = models.find((m) => m.provider === selected.provider && m.model === selected.model);
	return truncateLabel(m?.displayName ?? selected.model);
}

/**
 * Whether the picker should fire its `onautoselect` default (persisting
 * `models[0]` as the working selection). Any existing selection — INCLUDING
 * the Auto sentinel — suppresses it; that suppression is what stops the
 * legacy "auto-persist models[0]" behavior from clobbering a deliberate
 * Auto choice.
 */
export function shouldAutoSelectDefault(
	selected: ModelSelection | null,
	models: ModelOptionLike[],
): boolean {
	return selected === null && models.length > 0;
}

/** Whether the dedicated Auto row is visible for the current search text. */
export function autoRowVisible(allowAuto: boolean, search: string): boolean {
	if (!allowAuto) return false;
	const q = search.trim().toLowerCase();
	return q === "" || AUTO_LABEL.toLowerCase().includes(q);
}

/**
 * The served identity of the conversation's last REAL assistant turn, but
 * only when that turn was itself auto-routed (`usage.requestedModel === null`
 * — the provenance the runtime persists for routed turns). Streaming
 * placeholders / optimistic rows (no `usage`) are skipped; a pinned last
 * turn (non-null `requestedModel`) or a legacy row (no provenance keys)
 * yields null so a deliberate Auto pick re-routes exactly once.
 */
export function autoServedFromMessages(
	messages: readonly ServedMessageLike[],
): ModelSelection | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role !== "assistant" || m.usage == null) continue;
		if (m.usage.requestedModel === null && m.provider && m.model) {
			return { provider: m.provider, model: m.model };
		}
		return null;
	}
	return null;
}

/**
 * Resolve what goes on the wire for a send:
 * - no selection      → both `undefined` (field absent — legacy server fallback)
 * - concrete model    → the pinned pair
 * - Auto, first turn  → both `null` (explicit Auto sentinel → server routes)
 * - Auto, routed turn → the SERVED pair from the last auto-routed assistant
 *                       message (client half of route-once: never re-route)
 */
export function resolveWireModel(
	selected: ModelSelection | null,
	messages: readonly ServedMessageLike[],
): { provider: string | null | undefined; model: string | null | undefined } {
	if (!selected) return { provider: undefined, model: undefined };
	if (!isAutoSelection(selected)) return { provider: selected.provider, model: selected.model };
	return autoServedFromMessages(messages) ?? { provider: null, model: null };
}
