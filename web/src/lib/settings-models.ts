/**
 * Custom-model list partitioning for the merged /settings/models page.
 *
 * Locked decision 6 (tasks/settings-ux-overhaul.md): no model id may
 * appear twice on the page. Resolution: FILTER — entries with
 * `provider === "ollama"` render exclusively inside the Ollama provider
 * card ("Active models"); the Custom Models registry renders the rest.
 * Both lists derive from this single pure function so the dedupe
 * invariant can't drift between the two sections.
 */

export interface CustomModelEntry {
	modelId: string;
	provider: string;
	tier: string;
	baseUrl?: string;
}

export interface PartitionedCustomModels<T extends CustomModelEntry = CustomModelEntry> {
	/** Rendered in the Ollama provider card only. */
	ollama: T[];
	/** Rendered in the Custom Models registry list only. */
	registry: T[];
}

export function partitionCustomModels<T extends CustomModelEntry>(
	models: T[],
): PartitionedCustomModels<T> {
	const ollama: T[] = [];
	const registry: T[] = [];
	for (const m of models) {
		(m.provider === "ollama" ? ollama : registry).push(m);
	}
	return { ollama, registry };
}

/**
 * Id-only duplicate check shared by every add path (Ollama provider
 * card AND the Custom Models registry). Deliberately ignores the
 * provider: locked decision 6 says no model id may appear twice on the
 * page, so "llama3 via openai" blocks adding "llama3 via ollama" too.
 */
export function hasModelId(models: CustomModelEntry[], modelId: string): boolean {
	return models.some((m) => m.modelId === modelId);
}

/**
 * Canonical provider preference order. The /settings/models load path
 * self-heals a stored order by appending any of these providers it is
 * missing, so a provider added to the platform after an admin last reordered
 * (e.g. openrouter) still surfaces in the UI and in backend routing. Mirrors
 * the backend router's getPreferenceOrder merge (separate build, so the pure
 * logic is duplicated with tests on both sides).
 */
export const DEFAULT_PREFERENCE_ORDER = ["anthropic", "openai", "google", "openrouter"];

/**
 * Merge a stored preference order with the known defaults: keep the stored
 * order verbatim, then append any default providers missing from it.
 */
export function mergePreferenceOrder(
	stored: string[],
	defaults: readonly string[] = DEFAULT_PREFERENCE_ORDER,
): string[] {
	return [...stored, ...defaults.filter((p) => !stored.includes(p))];
}
