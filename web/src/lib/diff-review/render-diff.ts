/**
 * Single diff2html entry point.
 *
 * `DiffCard`, `DiffSummaryPanel` and the review file cards all had their own
 * copy of the same parse → html → try/catch dance. One helper keeps the
 * fallback behaviour identical everywhere and gives the render path a unit
 * test that doesn't need a DOM.
 */

import * as Diff2Html from "diff2html";
import type { DiffViewMode } from "../diff-view-mode";

/** Escape a raw diff for the `<pre>` fallback so it can't inject markup. */
function escapeHtml(value: unknown): string {
	return String(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/**
 * Render a unified diff to diff2html markup in the requested view mode.
 *
 * diff2html throws on malformed input (truncated streaming hunks, mangled
 * headers); rather than blanking the card we fall back to the escaped raw
 * text, which is still readable. `drawFileList` is off — the panel draws its
 * own GitHub-style file tree.
 */
export function renderDiffHtml(diffText: string, mode: DiffViewMode): string {
	try {
		const parsed = Diff2Html.parse(diffText);
		return Diff2Html.html(parsed, { outputFormat: mode, drawFileList: false });
	} catch {
		return `<pre>${escapeHtml(diffText)}</pre>`;
	}
}
