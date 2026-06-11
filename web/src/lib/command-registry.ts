import { goto } from "$app/navigation";
import { toggleTheme } from "./theme.js";
import { openEzPanel } from "./ez/panel-store.svelte.js";
import type { Project } from "./api.js";

export interface Command {
	id: string;
	label: string;
	group: "Navigate" | "Actions" | "Search" | "Ez" | "Project";
	// Optional leading glyph. When set it is rendered verbatim as text in place
	// of the group SVG — see CommandPalette's `commandRow` snippet. Left unset
	// for normal commands (they fall back to the per-group icon).
	icon?: string;
	// Optional project-style avatar (logo image, else a colored letter from the
	// name) shown in the icon slot — mirrors the sidebar's project rail. Used by
	// the per-project rows under the Projects sub-menu. Takes precedence over the
	// group icon. `src` is an image URL or null.
	avatar?: { name: string; src: string | null };
	shortcut?: string;
	context?: string[];
	action: () => void;
	children?: Command[];
}

// No-op action for commands that exist only to open a sub-menu (their
// `children` drive navigation; the action never runs). Shared so we don't
// sprinkle empty closures across the Projects tree.
const openSubmenu = () => {};

/**
 * The per-project destination commands shown when a project is chosen from the
 * Projects sub-menu. Mirrors the in-context navigation commands but is always
 * scoped to an explicit `projectId` (independent of the active project). Offers
 * the chat and settings routes — see `web/src/routes/(app)/project/[id]/`.
 */
export function buildProjectActions(projectId: string): Command[] {
	const base = `/project/${projectId}`;
	return [
		{
			id: `project-${projectId}-chat`,
			label: "Go to Chat",
			group: "Navigate",
			action: () => goto(`${base}/chat`),
		},
		{
			id: `project-${projectId}-settings`,
			label: "Go to Settings",
			group: "Navigate",
			action: () => goto(`${base}/settings`),
		},
	];
}

/**
 * Phase 48 Wave 3 — `ez:` query prefix.
 *
 * Typing `ez: hello` in the palette is shorthand for "open Ez and
 * pre-fill the composer with 'hello'". The CommandPalette checks this
 * regex on every keystroke and intercepts Enter when it matches.
 */
export const EZ_PREFIX_REGEX = /^ez:\s*(.*)$/i;

/**
 * Returns the prefilled prompt if the query is the `ez: ...` shape,
 * otherwise null. Pure helper so the palette stays declarative.
 */
export function tryParseEzPrefix(query: string): string | null {
	const m = EZ_PREFIX_REGEX.exec(query);
	return m ? m[1] ?? "" : null;
}

// --- Command definitions (factory) ---

export function buildCommands(
	activeProjectId: string,
	projects: Project[] = [],
): Command[] {
	const isProject = activeProjectId && activeProjectId !== "global";
	const projectBase = isProject ? `/project/${activeProjectId}` : "";

	const navigation: Command[] = [
		{
			id: "go-dashboard",
			label: isProject ? "Go to Overview" : "Go to Home",
			group: "Navigate",
			shortcut: undefined,
			action: () => goto(isProject ? projectBase : "/"),
		},
		...(isProject
			? [
					{
						id: "go-chat",
						label: "Go to Chat",
						group: "Navigate" as const,
						action: () => goto(`${projectBase}/chat`),
					},
				]
			: []),
		{
			id: "go-memories",
			label: "Go to Memories",
			group: "Navigate",
			action: () => goto("/memories"),
		},
		{
			id: "go-agents",
			label: "Go to Agents",
			group: "Navigate",
			action: () => goto("/agents"),
		},
		{
			id: "go-extensions",
			label: "Go to Extensions",
			group: "Navigate",
			action: () => goto("/extensions"),
		},
		{
			id: "go-marketplace",
			label: "Go to Marketplace",
			group: "Navigate",
			action: () => goto("/marketplace"),
		},
		{
			id: "go-observability",
			label: "Go to Analytics",
			group: "Navigate",
			action: () => goto("/observability"),
		},
		{
			id: "go-settings",
			label: "Go to Settings",
			group: "Navigate",
			action: () => goto("/settings/models"),
		},
	];

	const chatContext: Command[] = [
		{
			id: "export-conversation",
			label: "Export Conversation",
			group: "Actions",
			context: ["/chat/"],
			action: () => {
				/* handled by palette - triggers export flow */
			},
		},
		{
			id: "switch-model",
			label: "Switch Model",
			group: "Actions",
			context: ["/chat/"],
			children: [],
			action: () => {
				/* opens nested model list */
			},
		},
		{
			id: "branch-from-here",
			label: "Branch from Here",
			group: "Actions",
			context: ["/chat/"],
			action: () => {
				/* handled by chat page */
			},
		},
	];

	const extensionContext: Command[] = [
		{
			id: "install-extension",
			label: "Install Extension",
			group: "Actions",
			context: ["/extensions"],
			action: () => goto("/marketplace"),
		},
	];

	const settingsCommands: Command[] = [
		{
			id: "toggle-theme",
			label: "Toggle Theme",
			group: "Actions",
			action: () => toggleTheme(),
		},
		{
			id: "manage-providers",
			label: "Manage Providers",
			group: "Actions",
			action: () => goto("/settings/models"),
		},
	];

	const ezCommands: Command[] = [
		{
			id: "ask-ez",
			label: "Ask Ez",
			group: "Ez",
			shortcut: undefined,
			action: () => openEzPanel(),
		},
	];

	// "Projects" — a two-level drill-down: Projects → a project → that
	// project's actions (Overview / Chat / Settings). Only present when the
	// user has projects. Each project carries its own icon (emoji when set,
	// else the folder fallback rendered by the palette's `Project` group icon).
	const projectsCommands: Command[] =
		projects.length > 0
			? [
					{
						id: "projects",
						label: "Projects",
						group: "Project",
						action: openSubmenu,
						children: projects.map((p) => ({
							id: `project-${p.id}`,
							label: p.name,
							group: "Project" as const,
							// Show the project's logo (or a colored-letter fallback),
							// matching the sidebar — not a generic folder icon.
							avatar: { name: p.name, src: p.icon },
							action: openSubmenu,
							children: buildProjectActions(p.id),
						})),
					},
				]
			: [];

	return [
		...navigation,
		...projectsCommands,
		...chatContext,
		...extensionContext,
		...settingsCommands,
		...ezCommands,
	];
}

// --- Filtering ---

/** Filter commands by current route context. Commands without context are always shown. */
export function resolveCommands(
	commands: Command[],
	pathname: string,
): Command[] {
	return commands.filter((cmd) => {
		if (!cmd.context || cmd.context.length === 0) return true;
		return cmd.context.some((pattern) => pathname.includes(pattern));
	});
}

/** Fuzzy match commands by label substring, prioritizing startsWith over contains. */
export function fuzzyMatch(query: string, commands: Command[]): Command[] {
	const lower = query.toLowerCase();
	return commands
		.filter((cmd) => cmd.label.toLowerCase().includes(lower))
		.sort((a, b) => {
			const aStarts = a.label.toLowerCase().startsWith(lower) ? 0 : 1;
			const bStarts = b.label.toLowerCase().startsWith(lower) ? 0 : 1;
			return aStarts - bStarts;
		});
}

// --- Recent commands (localStorage) ---

const RECENT_KEY = "pi-recent-commands";
const MAX_RECENT = 5;

export function getRecentCommands(): string[] {
	try {
		const raw = localStorage.getItem(RECENT_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

export function addRecentCommand(id: string): void {
	const recent = getRecentCommands().filter((r) => r !== id);
	recent.unshift(id);
	if (recent.length > MAX_RECENT) recent.length = MAX_RECENT;
	localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
}
