import { goto } from "$app/navigation";
import { toggleTheme } from "./theme.js";

export interface Command {
	id: string;
	label: string;
	group: "Navigate" | "Actions" | "Search";
	icon?: string;
	shortcut?: string;
	context?: string[];
	action: () => void;
	children?: Command[];
}

// --- Command definitions (factory) ---

export function buildCommands(activeProjectId: string): Command[] {
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
			action: () => goto("/settings"),
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
			action: () => goto("/settings"),
		},
	];

	const searchCommands: Command[] = [
		{
			id: "search-conversations",
			label: "Search conversations...",
			group: "Search",
			action: () => {
				/* opens nested search sub-view */
			},
		},
	];

	return [
		...navigation,
		...chatContext,
		...extensionContext,
		...settingsCommands,
		...searchCommands,
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
