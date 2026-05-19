export type ModelCommand =
	| { type: "list" }
	| { type: "switch"; provider?: string; model: string };

/**
 * Parse `/model [provider/name]` commands from chat input.
 * Returns a ModelCommand if valid, null otherwise.
 */
export function isModelCommand(content: string): ModelCommand | null {
	const trimmed = content.trim();
	const match = trimmed.match(/^\/model(\s+.*)?$/i);
	if (!match) return null;

	const arg = match[1]?.trim();
	if (!arg) return { type: "list" };

	const slashIdx = arg.indexOf("/");
	if (slashIdx !== -1) {
		return {
			type: "switch",
			provider: arg.slice(0, slashIdx).toLowerCase(),
			model: arg.slice(slashIdx + 1),
		};
	}

	return { type: "switch", model: arg };
}
