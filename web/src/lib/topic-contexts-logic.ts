/**
 * Pure decision logic for Topic Contexts (WS4 chat UI). TopicPills.svelte,
 * TopicsPopover.svelte, ChatThread.svelte and ChatMessage.svelte own the
 * DOM / fetch / reactive state — this module owns every decision, mirroring
 * the mention-logic / composer-suggest-logic split so the behaviour is
 * unit-testable without a DOM.
 *
 * All shapes here track the plan's FROZEN API contract:
 *   GET  /api/conversations/[id]/topics
 *        → { topics: Topic[], stale, analyzedAt }
 *   POST /api/conversations/[id]/topics                 (same shape | 503)
 *   POST /api/conversations/[id]/topics/[topicId]/extract
 *        → { context: SavedContext }                    (| 503)
 *   GET  /api/context-types → { types: ContextType[] }
 *   GET  /api/contexts?projectId=&search=&typeId=&limit=&offset=
 */

/** One detected conversation topic (the anchor for a pill / popover row). */
export interface Topic {
	id: string;
	label: string;
	typeId: string;
	messageIds: string[];
}

/** GET/POST /topics response shape (no LLM on GET; POST re-detects). */
export interface TopicsResponse {
	topics: Topic[];
	stale: boolean;
	analyzedAt: string | null;
}

/** Library snapshot returned by the extract POST (and the library GET). */
export interface SavedContext {
	id: string;
	topicLabel: string;
	typeId: string;
	title: string;
	content: string;
	model: string;
	updatedAt: string;
}

/** A row from the DB-backed closed type enum (GET /api/context-types). */
export interface ContextType {
	id: string;
	label: string;
	description: string;
	sortOrder: number;
}

/** Per-message pill cap — overflow topics stay reachable via the header
 *  popover, so a heavily-tagged message never grows an unbounded pill row. */
export const MAX_PILLS_PER_MESSAGE = 3;

/** The library deep-link the extract result panel points at. */
export const CONTEXTS_LIBRARY_HREF = "/memories?tab=contexts";

/** Fallbacks when the server returns a 503 with an empty/absent message. */
export const DEFAULT_EXTRACT_ERROR =
	"Couldn't extract this topic — no model was available. Check the local model sidecar or set a Topic Contexts model in settings.";
export const DEFAULT_DETECT_ERROR =
	"Couldn't analyze topics — no model was available. Check the local model sidecar or set a Topic Contexts model in settings.";

/** The Analyze/Refresh button label + its semantic kind. */
export interface RefreshLabelResult {
	text: string;
	kind: "analyze" | "fresh" | "stale";
}

/**
 * Label for the popover's single detect trigger.
 *   - never analyzed (`analyzedAt === null`) → "Analyze"
 *   - analyzed + fresh                       → "Re-analyze"
 *   - analyzed + stale, with N new           → "Refresh (N new)"
 *   - analyzed + stale, unknown N            → "Refresh"
 *
 * `stale` is the server-authoritative watermark comparison; `newCount` is a
 * cosmetic hint the caller derives client-side (see `countNewMessages`).
 */
export function refreshLabel(input: {
	analyzedAt: string | null;
	stale: boolean;
	newCount?: number;
}): RefreshLabelResult {
	if (input.analyzedAt === null) return { text: "Analyze", kind: "analyze" };
	if (!input.stale) return { text: "Re-analyze", kind: "fresh" };
	const n = input.newCount ?? 0;
	if (n > 0) return { text: `Refresh (${n} new)`, kind: "stale" };
	return { text: "Refresh", kind: "stale" };
}

/**
 * Best-effort count of live messages NOT covered by any detected topic — a
 * proxy for "new since last analysis" used only for the "Refresh (N new)"
 * affordance. Uses ONLY frozen-contract data (`topics[].messageIds`) plus the
 * live message id list, so it survives a reload (the GET carries no watermark
 * count). The authoritative staleness signal is the server's `stale` flag;
 * this is a hint, and it over-counts a message that legitimately belongs to no
 * topic.
 */
export function countNewMessages(
	currentMessageIds: readonly string[],
	topics: readonly Topic[],
): number {
	const covered = new Set<string>();
	for (const topic of topics) {
		for (const id of topic.messageIds) covered.add(id);
	}
	let n = 0;
	for (const id of currentMessageIds) {
		if (!covered.has(id)) n++;
	}
	return n;
}

/**
 * Group topics by the message ids they anchor, preserving topic order and
 * capping the pills shown per message. Returns Map<messageId, Topic[]>.
 */
export function topicsByMessageId(
	topics: readonly Topic[],
	cap: number = MAX_PILLS_PER_MESSAGE,
): Map<string, Topic[]> {
	const map = new Map<string, Topic[]>();
	for (const topic of topics) {
		for (const messageId of topic.messageIds) {
			const list = map.get(messageId);
			if (list) {
				if (list.length < cap) list.push(topic);
			} else {
				map.set(messageId, [topic]);
			}
		}
	}
	return map;
}

/** Map context-type rows by id for O(1) badge lookups. */
export function contextTypeMap(
	types: readonly ContextType[],
): Map<string, ContextType> {
	return new Map(types.map((t) => [t.id, t]));
}

/** Human label for a type id, falling back to the raw id when unknown. */
export function typeBadgeLabel(
	typeId: string,
	types: Map<string, ContextType>,
): string {
	return types.get(typeId)?.label ?? typeId;
}

/** Per-type badge colour classes keyed by the DB enum slugs. */
export const TYPE_BADGE_CLASSES: Record<string, string> = {
	feature: "bg-blue-900/50 text-blue-300",
	idea: "bg-purple-900/50 text-purple-300",
	decision: "bg-emerald-900/50 text-emerald-300",
	"bug-fix": "bg-red-900/50 text-red-300",
	requirement: "bg-amber-900/50 text-amber-300",
	"how-to": "bg-cyan-900/50 text-cyan-300",
	"code-snippet": "bg-indigo-900/50 text-indigo-300",
	fact: "bg-teal-900/50 text-teal-300",
	question: "bg-pink-900/50 text-pink-300",
	plan: "bg-orange-900/50 text-orange-300",
};

/** Badge colour classes for a type id, with a neutral fallback. */
export function typeBadgeClass(typeId: string): string {
	return (
		TYPE_BADGE_CLASSES[typeId] ??
		"bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)]"
	);
}

/**
 * The library filter querystring for GET /api/contexts. Empty / whitespace
 * filters are omitted so a blank search never narrows the result set.
 */
export function buildContextsSearchParams(opts: {
	projectId?: string | null;
	search?: string;
	typeId?: string | null;
	limit?: number;
	offset?: number;
}): string {
	const params = new URLSearchParams();
	if (opts.projectId) params.set("projectId", opts.projectId);
	if (opts.search && opts.search.trim().length > 0) {
		params.set("search", opts.search.trim());
	}
	if (opts.typeId) params.set("typeId", opts.typeId);
	if (opts.limit != null) params.set("limit", String(opts.limit));
	if (opts.offset != null) params.set("offset", String(opts.offset));
	return params.toString();
}

/**
 * Parse the `contexts:model` setting (`"provider/modelId"`). The first slash
 * splits provider from model id, so a model id may itself contain slashes
 * (e.g. `openrouter/anthropic/claude-3.5`). Returns null for empty input, a
 * missing provider (leading slash), or a missing model id (trailing slash).
 */
export function parseModelSetting(
	value: string | null | undefined,
): { provider: string; modelId: string } | null {
	if (!value) return null;
	const idx = value.indexOf("/");
	if (idx <= 0 || idx >= value.length - 1) return null;
	return { provider: value.slice(0, idx), modelId: value.slice(idx + 1) };
}

// ── Extract state machine (idle → extracting → copied|copyFailed|error) ──────

/**
 * One topic-extract lifecycle. `copied` / `copyFailed` both carry the fetched
 * snapshot so the result panel can render the content preview + library link
 * either way; they differ only in whether auto-copy landed (a fresh manual
 * Copy button is offered on `copyFailed`). `error` carries a 503 message.
 */
export type ExtractState =
	| { status: "idle" }
	| { status: "extracting" }
	| { status: "copied"; context: SavedContext }
	| { status: "copyFailed"; context: SavedContext }
	| { status: "error"; message: string };

export const EXTRACT_IDLE: ExtractState = { status: "idle" };

/** Transition into the in-flight state (spinner + double-click guard). */
export function extractStarting(): ExtractState {
	return { status: "extracting" };
}

/** Resolve a successful POST: copied when auto-copy landed, else copyFailed. */
export function extractResolved(
	context: SavedContext,
	copied: boolean,
): ExtractState {
	return copied
		? { status: "copied", context }
		: { status: "copyFailed", context };
}

/** Resolve a failed POST (503 / network) into the error state. */
export function extractErrored(message: string): ExtractState {
	return { status: "error", message: message || DEFAULT_EXTRACT_ERROR };
}

/** Manual Copy button succeeded → flip copyFailed to copied; else unchanged. */
export function markCopied(state: ExtractState): ExtractState {
	return state.status === "copyFailed"
		? { status: "copied", context: state.context }
		: state;
}

/** True while the POST is in flight. */
export function isExtracting(state: ExtractState): boolean {
	return state.status === "extracting";
}

/** The fetched snapshot when a result panel should render, else null. */
export function extractResult(state: ExtractState): SavedContext | null {
	return state.status === "copied" || state.status === "copyFailed"
		? state.context
		: null;
}

/** True once auto- or manual-copy has landed (show the copied badge). */
export function isCopied(state: ExtractState): boolean {
	return state.status === "copied";
}

/** True when auto-copy failed and a manual Copy button is needed. */
export function needsManualCopy(state: ExtractState): boolean {
	return state.status === "copyFailed";
}

/** The error message when the extract failed, else null. */
export function extractError(state: ExtractState): string | null {
	return state.status === "error" ? state.message : null;
}
