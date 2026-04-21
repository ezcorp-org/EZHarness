/**
 * Side-panel state persistence.
 *
 * Lightweight helpers to save/restore which side panels are open, what they
 * are bound to, and their internal state (expanded tool calls, scroll
 * positions). Mirrors the `last-model.ts` pattern: SSR-safe, fail-soft —
 * any storage failure (missing/corrupt JSON, disabled storage) returns null
 * and callers fall back to defaults.
 *
 * All keys are namespaced `ezcorp-panel-*`.
 */

const KEY_TEAM = "ezcorp-panel-team";
const KEY_CHAT = (convId: string) => `ezcorp-panel-chat:${convId}`;
const KEY_SCROLL = (key: string) => `ezcorp-panel-scroll:${key}`;
const KEY_EXPANDED_TOOLS = (convId: string) => `ezcorp-panel-team-expanded:${convId}`;
const KEY_EXT = (convId: string, extId: string) => `ezcorp-panel-ext:${convId}:${extId}`;

function getStorage(): Storage | null {
	if (typeof localStorage === "undefined") return null;
	return localStorage;
}

function readJson<T>(key: string): T | null {
	const s = getStorage();
	if (!s) return null;
	const raw = s.getItem(key);
	if (!raw) return null;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

function writeJson(key: string, value: unknown): void {
	const s = getStorage();
	if (!s) return;
	try {
		s.setItem(key, JSON.stringify(value));
	} catch {
		/* quota / disabled — ignore */
	}
}

// ── Team panel (global) ──

export interface TeamPanelDrillDown {
	subConversationId: string;
	agentName: string;
	turnIndex?: number;
}

export interface TeamPanelState {
	open: boolean;
	agentConfigId: string | null;
	teamName: string | null;
	conversationId: string | null;
	drillDownAgent: TeamPanelDrillDown | null;
}

export function readTeamPanel(): TeamPanelState | null {
	const raw = readJson<unknown>(KEY_TEAM);
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	if (typeof o.open !== "boolean") return null;
	const drill = o.drillDownAgent;
	let drillDownAgent: TeamPanelDrillDown | null = null;
	if (drill && typeof drill === "object") {
		const d = drill as Record<string, unknown>;
		if (typeof d.subConversationId === "string" && typeof d.agentName === "string") {
			drillDownAgent = {
				subConversationId: d.subConversationId,
				agentName: d.agentName,
				turnIndex: typeof d.turnIndex === "number" ? d.turnIndex : undefined,
			};
		}
	}
	return {
		open: o.open,
		agentConfigId: typeof o.agentConfigId === "string" ? o.agentConfigId : null,
		teamName: typeof o.teamName === "string" ? o.teamName : null,
		conversationId: typeof o.conversationId === "string" ? o.conversationId : null,
		drillDownAgent,
	};
}

export function writeTeamPanel(state: TeamPanelState): void {
	writeJson(KEY_TEAM, state);
}

// ── Chat-page panels (per conversation) ──

export interface ChatPanelState {
	obsOpen: boolean;
	diffPanelOpen: boolean;
	taskLogsOpen: boolean;
	taskLogsTaskId: string | null;
	toolsOpen: boolean;
	settingsOpen: boolean;
	selectedAgentSubConvId: string | null;
}

const CHAT_DEFAULTS: ChatPanelState = {
	obsOpen: false,
	diffPanelOpen: false,
	taskLogsOpen: false,
	taskLogsTaskId: null,
	toolsOpen: false,
	settingsOpen: false,
	selectedAgentSubConvId: null,
};

export function readChatPanels(convId: string): ChatPanelState | null {
	const raw = readJson<unknown>(KEY_CHAT(convId));
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	return {
		obsOpen: typeof o.obsOpen === "boolean" ? o.obsOpen : CHAT_DEFAULTS.obsOpen,
		diffPanelOpen: typeof o.diffPanelOpen === "boolean" ? o.diffPanelOpen : CHAT_DEFAULTS.diffPanelOpen,
		taskLogsOpen: typeof o.taskLogsOpen === "boolean" ? o.taskLogsOpen : CHAT_DEFAULTS.taskLogsOpen,
		taskLogsTaskId: typeof o.taskLogsTaskId === "string" ? o.taskLogsTaskId : CHAT_DEFAULTS.taskLogsTaskId,
		toolsOpen: typeof o.toolsOpen === "boolean" ? o.toolsOpen : CHAT_DEFAULTS.toolsOpen,
		settingsOpen: typeof o.settingsOpen === "boolean" ? o.settingsOpen : CHAT_DEFAULTS.settingsOpen,
		selectedAgentSubConvId: typeof o.selectedAgentSubConvId === "string" ? o.selectedAgentSubConvId : CHAT_DEFAULTS.selectedAgentSubConvId,
	};
}

export function writeChatPanels(convId: string, state: ChatPanelState): void {
	writeJson(KEY_CHAT(convId), state);
}

// ── Scroll position (generic key — caller decides scoping) ──

export interface PanelScroll {
	timeline?: number;
	drill?: number;
}

export function readScroll(key: string): PanelScroll | null {
	const raw = readJson<unknown>(KEY_SCROLL(key));
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	const out: PanelScroll = {};
	if (typeof o.timeline === "number") out.timeline = o.timeline;
	if (typeof o.drill === "number") out.drill = o.drill;
	return out;
}

export function writeScroll(key: string, scroll: PanelScroll): void {
	writeJson(KEY_SCROLL(key), scroll);
}

// ── Expanded tool calls (TeamChatPanel) ──

export function readExpandedTools(convId: string): string[] {
	const raw = readJson<unknown>(KEY_EXPANDED_TOOLS(convId));
	if (!Array.isArray(raw)) return [];
	return raw.filter((x): x is string => typeof x === "string");
}

export function writeExpandedTools(convId: string, ids: string[]): void {
	writeJson(KEY_EXPANDED_TOOLS(convId), ids);
}

// ── Extension panel state (per conversation, per extension) ──

export interface ExtPanelState {
	expanded: boolean;
}

export function readExtPanel(convId: string, extId: string): ExtPanelState | null {
	const raw = readJson<unknown>(KEY_EXT(convId, extId));
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	if (typeof o.expanded !== "boolean") return null;
	return { expanded: o.expanded };
}

export function writeExtPanel(convId: string, extId: string, state: ExtPanelState): void {
	writeJson(KEY_EXT(convId, extId), state);
}
