// Pure logic for the chat "context % used" indicator. Kept in a plain
// module so unit tests can exercise every branch without mounting Svelte.

export type Tone = "muted" | "warn" | "danger";

export interface MessageLike {
	role: string;
	usage?: { inputTokens?: number | null; outputTokens?: number | null } | null;
}

export interface ToolCallLike {
	id?: string;
	extensionName?: string;
	toolName?: string;
	input?: unknown;
	output?: unknown;
}

export interface ToolCallBreakdownItem {
	/**
	 * Stable id of the source tool call (carried through from
	 * `ToolCallLike.id`). Lets the popover scroll the chat to the
	 * matching `id="tool-call-${callId}"` anchor when clicked. May be
	 * undefined if the upstream call had no id (e.g., legacy / partial data).
	 */
	callId?: string;
	tokens: number;
	pct: number;
	preview: string;
}

export interface ToolBreakdownEntry {
	extensionName: string;
	toolName: string;
	callCount: number;
	tokens: number;
	pct: number;
	calls: ToolCallBreakdownItem[];
}

/**
 * Top-level "tool" row in the popover. Extension/MCP tools collapse all
 * of their functions under one group keyed by `extensionName`; built-in
 * tools (no `__` namespace) become their own one-function group, which
 * the UI renders without an intermediate function row.
 */
export interface ToolGroupEntry {
	/** "" for built-ins, otherwise the extension/MCP namespace. */
	extensionName: string;
	/** Display label: extension name for groups, function name for built-ins. */
	displayName: string;
	/** Stable key for keyed-each + expand state. */
	key: string;
	/** True when this group is a single built-in tool with no extension. */
	isBuiltin: boolean;
	tokens: number;
	pct: number;
	callCount: number;
	functions: ToolBreakdownEntry[];
}

export interface ContextBreakdown {
	inputTokens: number;
	outputTokens: number;
	toolTokens: number;
	totalTokens: number;
	pctInput: number;
	pctOutput: number;
	pctTools: number;
}

/**
 * Percentage of the model's context window used by the last turn.
 * Returns null when either input is missing/invalid. Clamped to [0, 100].
 */
export function computePct(usedTokens: number | null | undefined, contextWindow: number | null | undefined): number | null {
	if (usedTokens == null || !Number.isFinite(usedTokens)) return null;
	if (contextWindow == null || !Number.isFinite(contextWindow) || contextWindow <= 0) return null;
	const raw = (usedTokens / contextWindow) * 100;
	if (raw < 0) return 0;
	if (raw > 100) return 100;
	return raw;
}

/**
 * Visual tone bucket. Thresholds are inclusive at the lower bound
 * (70 → warn, 90 → danger) so the indicator flips *at* the boundary.
 */
export function computeTone(pct: number | null): Tone {
	if (pct == null) return "muted";
	if (pct >= 90) return "danger";
	if (pct >= 70) return "warn";
	return "muted";
}

/**
 * Compact human token count: 1_234 → "1.2k", 12_345 → "12k",
 * 1_234_567 → "1.2M". Preserves one decimal for readability in low ranges.
 */
export function fmtTokens(n: number): string {
	if (!Number.isFinite(n)) return "0";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${Math.round(n)}`;
}

/**
 * Tooltip text — single source of truth so the component and any future
 * status bar stay consistent.
 */
export function tooltipText(usedTokens: number | null | undefined, contextWindow: number | null | undefined): string {
	const pct = computePct(usedTokens, contextWindow);
	if (pct == null) {
		return "Context usage — appears after the first assistant response";
	}
	return `${fmtTokens(usedTokens as number)} / ${fmtTokens(contextWindow as number)} tokens used (${Math.round(pct)}%)`;
}

/**
 * Pick the `inputTokens` reported by the most recent assistant message that
 * actually has a usage number. Represents "what fit in the prompt last turn".
 * Returns null until the first assistant reply with a positive token count.
 */
export function pickLastTurnInputTokens(messages: readonly MessageLike[]): number | null {
	const usage = pickLastTurnUsage(messages);
	return usage ? usage.inputTokens : null;
}

/**
 * Pick the full `usage` (input + output) from the most recent assistant
 * message with a positive `inputTokens`. Returns null otherwise.
 */
export function pickLastTurnUsage(
	messages: readonly MessageLike[],
): { inputTokens: number; outputTokens: number } | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (!m || m.role !== "assistant") continue;
		const inp = m.usage?.inputTokens;
		if (typeof inp !== "number" || !Number.isFinite(inp) || inp <= 0) continue;
		const out = m.usage?.outputTokens;
		const outNum = typeof out === "number" && Number.isFinite(out) && out > 0 ? out : 0;
		return { inputTokens: inp, outputTokens: outNum };
	}
	return null;
}

/**
 * Rough token estimate from string/JSON content. Uses the well-known
 * ~4-chars-per-token heuristic; good enough for showing the "tool calls"
 * share of the context. Never throws.
 */
function estimateTokensFromValue(value: unknown): number {
	if (value == null) return 0;
	if (typeof value === "string") return Math.ceil(value.length / 4);
	try {
		return Math.ceil(JSON.stringify(value).length / 4);
	} catch {
		return 0;
	}
}

/**
 * Estimate the share of the context window consumed by tool call inputs +
 * outputs. Tool call payloads are part of the conversation history sent
 * back on every turn, so they are a subset of `inputTokens`.
 */
export function estimateToolCallTokens(toolCalls: readonly ToolCallLike[]): number {
	let total = 0;
	for (const tc of toolCalls) {
		total += estimateTokensFromValue(tc.input);
		total += estimateTokensFromValue(tc.output);
	}
	return total;
}

/**
 * Build a short, human-readable preview of a tool call's input — used as
 * the label for individual calls in the expanded per-tool dropdown. Picks
 * the first non-empty string value out of an object input (so things like
 * `{ path: "/foo" }` render as "/foo"), falling back to truncated JSON.
 */
const PREVIEW_MAX = 60;
export function summarizeToolInput(input: unknown): string {
	if (input == null) return "";
	if (typeof input === "string") return input.slice(0, PREVIEW_MAX);
	if (typeof input !== "object") return String(input).slice(0, PREVIEW_MAX);
	const obj = input as Record<string, unknown>;
	for (const v of Object.values(obj)) {
		if (typeof v === "string" && v.length > 0) return v.slice(0, PREVIEW_MAX);
	}
	for (const v of Object.values(obj)) {
		if (typeof v === "number" || typeof v === "boolean") return String(v).slice(0, PREVIEW_MAX);
	}
	try {
		return JSON.stringify(input).slice(0, PREVIEW_MAX);
	} catch {
		return "";
	}
}

/**
 * Split a tool's globally-unique name into `{ namespace, functionName }`.
 * Extension tools are namespaced as `${manifest.name}__${tool.name}` by
 * `src/extensions/registry.ts` (delimiter is `__`, NOT `.`, because
 * Anthropic rejects dots in tool names). Built-in tools have no
 * namespace, so they fall through with an empty `namespace`.
 *
 * Splits on the FIRST `__` so tool names that themselves contain `__`
 * (e.g. `ext__sub__action`) keep the suffix on the function side.
 */
export function splitNamespacedToolName(fullName: string): {
	namespace: string;
	functionName: string;
} {
	if (!fullName) return { namespace: "", functionName: "" };
	const idx = fullName.indexOf("__");
	if (idx <= 0) return { namespace: "", functionName: fullName };
	return {
		namespace: fullName.slice(0, idx),
		functionName: fullName.slice(idx + 2),
	};
}

/**
 * Per-tool token breakdown — groups calls by their globally-unique tool
 * name, sums estimated tokens, and computes each tool's share of
 * `totalTokens`. The display `extensionName` and `toolName` are parsed
 * out of the namespaced name (`${manifest.name}__${tool.name}`) rather
 * than read from the inline-tool-store's `extensionName` field, which
 * actually carries an opaque extensionId / "builtin" sentinel.
 *
 * Each entry also carries a `calls` array with per-invocation tokens and
 * a short input preview so callers can render a click-to-expand
 * dropdown. Sorted by tokens desc; tools that contribute zero tokens
 * are dropped. `pct` is 0 when `totalTokens` is non-positive.
 */
export function computeToolBreakdown(
	toolCalls: readonly ToolCallLike[],
	totalTokens: number,
): ToolBreakdownEntry[] {
	const denom = Number.isFinite(totalTokens) && totalTokens > 0 ? totalTokens : 0;
	const map = new Map<
		string,
		{ extensionName: string; toolName: string; tokens: number; calls: ToolCallBreakdownItem[] }
	>();
	for (const tc of toolCalls) {
		const tokens = estimateTokensFromValue(tc.input) + estimateTokensFromValue(tc.output);
		if (tokens === 0) continue;
		const fullName = tc.toolName && tc.toolName.length > 0 ? tc.toolName : "unknown";
		const { namespace, functionName } = splitNamespacedToolName(fullName);
		const ext = namespace;
		const name = functionName || fullName;
		const key = fullName; // already globally unique post-namespacing
		const entry = map.get(key) ?? { extensionName: ext, toolName: name, tokens: 0, calls: [] };
		entry.tokens += tokens;
		entry.calls.push({
			callId: tc.id,
			tokens,
			pct: denom > 0 ? (tokens / denom) * 100 : 0,
			preview: summarizeToolInput(tc.input),
		});
		map.set(key, entry);
	}
	const entries: ToolBreakdownEntry[] = [];
	for (const { extensionName, toolName, tokens, calls } of map.values()) {
		// Sort individual calls by tokens desc so heaviest invocations show first.
		calls.sort((a, b) => b.tokens - a.tokens);
		entries.push({
			extensionName,
			toolName,
			callCount: calls.length,
			tokens,
			pct: denom > 0 ? (tokens / denom) * 100 : 0,
			calls,
		});
	}
	entries.sort(
		(a, b) =>
			b.tokens - a.tokens ||
			a.extensionName.localeCompare(b.extensionName) ||
			a.toolName.localeCompare(b.toolName),
	);
	return entries;
}

/**
 * Roll the per-function breakdown up to one row per tool/extension.
 *
 * Grouping rule:
 *  - Extension tools (`extensionName !== ""`) collapse under one row
 *    keyed by `extensionName`. Their functions become the second level.
 *  - Built-in tools (`extensionName === ""`) get their OWN top-level row
 *    keyed by `toolName`. There's only one function per built-in, so the
 *    UI skips the function level and jumps straight to the call list.
 *
 * Output is sorted by tokens desc; functions inside each group are also
 * sorted by tokens desc (already true coming from `computeToolBreakdown`,
 * preserved on the way through).
 */
export function groupToolBreakdown(
	entries: readonly ToolBreakdownEntry[],
): ToolGroupEntry[] {
	const map = new Map<string, ToolGroupEntry>();
	for (const fn of entries) {
		const isBuiltin = !fn.extensionName;
		const key = isBuiltin ? `builtin::${fn.toolName}` : `ext::${fn.extensionName}`;
		const displayName = isBuiltin ? fn.toolName : fn.extensionName;
		let group = map.get(key);
		if (!group) {
			group = {
				extensionName: fn.extensionName,
				displayName,
				key,
				isBuiltin,
				tokens: 0,
				pct: 0,
				callCount: 0,
				functions: [],
			};
			map.set(key, group);
		}
		group.functions.push(fn);
		group.tokens += fn.tokens;
		group.pct += fn.pct;
		group.callCount += fn.callCount;
	}
	const out = Array.from(map.values());
	for (const g of out) g.functions.sort((a, b) => b.tokens - a.tokens);
	out.sort(
		(a, b) =>
			b.tokens - a.tokens ||
			a.displayName.localeCompare(b.displayName),
	);
	return out;
}

/**
 * Build the popover breakdown: input vs output share of the last assistant
 * turn, plus an estimated tool-call slice. Returns null when we don't yet
 * have a turn with usage to report.
 */
export function computeBreakdown(
	inputTokens: number | null | undefined,
	outputTokens: number | null | undefined,
	toolTokens: number,
): ContextBreakdown | null {
	if (inputTokens == null || !Number.isFinite(inputTokens) || inputTokens <= 0) return null;
	const inp = inputTokens;
	const out = typeof outputTokens === "number" && Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : 0;
	const tools = Number.isFinite(toolTokens) && toolTokens > 0 ? Math.min(toolTokens, inp) : 0;
	const total = inp + out;
	return {
		inputTokens: inp,
		outputTokens: out,
		toolTokens: tools,
		totalTokens: total,
		pctInput: (inp / total) * 100,
		pctOutput: (out / total) * 100,
		pctTools: (tools / total) * 100,
	};
}
