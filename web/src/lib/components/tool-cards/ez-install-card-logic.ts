/**
 * Pure parsing for the `install_draft` tool-result card.
 *
 * The bundled `extension-author` extension's `install_draft` tool
 * declares `cardType: "ez-install"`. Its host result is
 * `{ ok, extensionId, name, openUrl }` (openUrl is the host-revalidated
 * relative deep-link `/extensions/<name>`, OMITTED when the manifest
 * name failed the host NAME_REGEX re-check — see
 * `src/extensions/author-install.ts`).
 *
 * By the time the result reaches `ToolCallState.output` the store's
 * `extractToolOutput` has already unwrapped the MCP
 * `{content:[{type:'text',text}]}` envelope to its joined text — so
 * `output` is a JSON string here (or, defensively, the raw object on a
 * non-enveloped path). Mirrors the established `extractObject` pattern
 * used by `price-chart-logic.ts` / `DesignCanvasCard.svelte` rather
 * than inventing a new unwrap.
 *
 * Returns an `EzProposeResult` so `EzToolResultCard` can render the
 * "Open extension" link, or `null` when the payload is not a usable
 * install result (router then falls back to DefaultCard).
 */

import type { EzProposeResult } from "$lib/components/ez/ez-tool-result.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function extractObject(out: unknown): Record<string, unknown> | null {
	if (out == null) return null;
	if (typeof out === "string") {
		try {
			const parsed = JSON.parse(out);
			return isRecord(parsed) ? parsed : null;
		} catch {
			return null;
		}
	}
	if (!isRecord(out)) return null;
	// Defensive: a non-enveloped path could still hand us the MCP
	// content array — unwrap the first text part like the other cards.
	if (Array.isArray(out.content)) {
		const text = (out.content as Array<{ type?: string; text?: unknown }>).find(
			(c) => c.type === "text",
		)?.text;
		if (typeof text === "string") {
			try {
				const parsed = JSON.parse(text);
				return isRecord(parsed) ? parsed : null;
			} catch {
				return null;
			}
		}
	}
	return out;
}

/**
 * Parse an `install_draft` tool output into the card's render props.
 * `openUrl` is mandatory for the card to be useful — without it the
 * card has no actionable affordance, so we return `null` and let the
 * router fall back to DefaultCard (raw JSON), exactly today's behavior.
 */
export function parseInstallCardResult(output: unknown): EzProposeResult | null {
	const obj = extractObject(output);
	if (!obj) return null;
	if (typeof obj.openUrl !== "string" || obj.openUrl.length === 0) return null;
	const name = typeof obj.name === "string" ? obj.name : undefined;
	return {
		openUrl: obj.openUrl,
		// D1: the install card's generalized label. The heading copy is
		// install-specific too so the card reads coherently.
		openUrlLabel: "Open extension",
		title: name ? `Extension "${name}" installed` : "Extension installed",
		summary: name
			? `${name} is installed and enabled. Open it in the Extensions Library.`
			: "The extension is installed and enabled. Open it in the Extensions Library.",
	};
}
