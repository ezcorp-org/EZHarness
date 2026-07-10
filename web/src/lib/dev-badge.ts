/**
 * Pure reader for the dev-mode git badge.
 *
 * The server (hooks.server.ts) stamps `data-dev-indicator="1"` plus
 * `data-dev-branch` / `data-dev-commit` on `<html>` in dev mode. This reads
 * them back off a DOMStringMap (`document.documentElement.dataset`) into a
 * total shape so the DevBadge component never has to branch on missing values.
 */

export interface DevBadgeInfo {
	branch: string;
	commit: string;
}

/**
 * Returns the branch + commit to render, or null when the badge should be
 * hidden: not in dev mode, or in dev mode but with no branch/commit at all.
 * Trimmed values fall back to `"HEAD"` / `"unknown"` so rendering is total.
 */
export function readDevBadge(dataset: DOMStringMap): DevBadgeInfo | null {
	if (dataset.devIndicator !== "1") return null;

	const branch = (dataset.devBranch ?? "").trim();
	const commit = (dataset.devCommit ?? "").trim();
	if (!branch && !commit) return null;

	return {
		branch: branch || "HEAD",
		commit: commit || "unknown",
	};
}
