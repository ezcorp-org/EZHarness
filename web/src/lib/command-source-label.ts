/**
 * Render a `CommandSource` string into a short, user-facing label that
 * shows both **scope** (project vs global) and **origin folder**.
 *
 * Examples:
 *   "project:claude-commands" → "Project · .claude/commands"
 *   "user:codex-prompts"      → "Global · ~/.codex/prompts"
 *   "user:db"                 → "Global · Saved"
 *
 * Keeping the mapping in its own pure module makes it trivial to test
 * and reuse from any component that renders command results.
 */

const FOLDER_LABELS: Record<string, string> = {
	"claude-commands": ".claude/commands",
	"claude-agents": ".claude/agents",
	"codex-prompts": ".codex/prompts",
	agents: "agents",
	db: "Saved",
};

export interface CommandSourceLabel {
	/** "Project" or "Global". */
	scope: string;
	/** Folder slug, e.g. ".claude/commands", "~/.codex/prompts", "Saved". */
	folder: string;
	/** Pre-formatted display string. */
	display: string;
}

export function commandSourceLabel(source: string | undefined): CommandSourceLabel | null {
	if (!source) return null;
	const [scopeKey, ...rest] = source.split(":");
	const folderKey = rest.join(":");
	if (!scopeKey || !folderKey) return null;

	const scope = scopeKey === "project" ? "Project" : scopeKey === "user" ? "Global" : scopeKey;
	const base = FOLDER_LABELS[folderKey] ?? folderKey;
	// Global folder paths get a `~/` prefix so it's obvious they come
	// from the user's home directory, not the project tree.
	const folder =
		scopeKey === "user" && base !== "Saved" ? `~/${base}` : base;

	return { scope, folder, display: `${scope} · ${folder}` };
}
