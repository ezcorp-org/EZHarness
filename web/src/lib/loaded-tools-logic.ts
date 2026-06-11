/**
 * Pure logic for the header's loaded-tools badge + popover.
 *
 * `/api/tools` returns a flat list; the popover renders it grouped by
 * extension with a type badge per group and token-estimate sums. The
 * grouping/derivation lives here (not in the components) so ChatHeader
 * can derive its own view state from the single `loadedTools` prop and
 * the page never re-derives thread internals.
 */

export interface LoadedTool {
	name: string;
	description: string;
	extension: string;
	extensionType?: string;
	/** The owning extension's manifest description (or built-in category
	 *  description) — shown by the header popover's group-hover card. */
	extensionDescription?: string;
	tokenEstimate?: number;
}

/** Group tools by their owning extension, preserving API order. */
export function groupToolsByExtension(
	tools: readonly LoadedTool[],
): Map<string, LoadedTool[]> {
	const map = new Map<string, LoadedTool[]>();
	for (const t of tools) {
		const arr = map.get(t.extension);
		if (arr) arr.push(t);
		else map.set(t.extension, [t]);
	}
	return map;
}

/** extension name → type ("extension" when the API omits it). */
export function buildExtensionTypeMap(
	tools: readonly LoadedTool[],
): Map<string, string> {
	return new Map(tools.map((t) => [t.extension, t.extensionType ?? "extension"]));
}

/** Sum of token estimates; tools without an estimate count as 0. */
export function sumTokenEstimates(tools: readonly LoadedTool[]): number {
	return tools.reduce((sum, t) => sum + (t.tokenEstimate ?? 0), 0);
}
