/**
 * Timeline normalization — the ONE place a tool invocation is turned into a
 * comparable, source-agnostic record (pure logic, no DOM, no `Date.now()`).
 *
 * Two sources describe the same thing and every consumer used to re-derive the
 * mapping itself:
 *
 *   1. `ToolCallState[]`      — the live streaming store (`$lib/stores.svelte`),
 *                               what `WaterfallTimeline` renders mid-run.
 *   2. `observability_events` — persisted `tool_call` / `tool_error` rows,
 *                               what `WaterfallTimeline` renders after reload.
 *
 * Both collapse to `TimelineEntry`, so the waterfall geometry
 * (`buildWaterfallBars`) reads one vocabulary instead of two hand-rolled
 * copies.
 *
 * The chat-graph level-2 builder (`src/runtime/chat-graph/build-turn-dag.ts`)
 * shares the two RULES below — `resolveDurationMs` and `TOOL_EVENT_TYPES` —
 * but deliberately NOT `TimelineEntry`. A third normalizer for `tool_calls`
 * rows existed briefly and was removed: it lost `messageId` (which the builder
 * needs to group calls under their assistant message), collapsed
 * `ToolCallSummary.status` — a real three-value rule including `interrupted`
 * (`src/db/queries/conversations.ts`) — into the two-value complete/error
 * split, and sorted on `startMs` alone, dropping the `id` tie-break the
 * builder's positional observability zip depends on. Sharing the rules is the
 * win; sharing the row shape was a loss.
 *
 * This module lives under `web/src/lib/` but is imported by BOTH the browser
 * (via `$lib`) and the Bun backend (via a relative path) — the same
 * arrangement as `mention-logic.ts` (`src/runtime/mention-wiring.ts`) and
 * `briefing-cron.ts` (`src/runtime/briefing/chat-tools.ts`). It must therefore
 * stay dependency-free: no `$app/*`, no `$server/*`, no runes, no I/O.
 *
 * ===== The duration-honesty rule (read before touching `durationMs`) =====
 *
 * Built-in tools emit `duration: 0` unconditionally
 * (`src/runtime/stream-chat/subscribe-bridge.ts`), and that literal 0 reaches
 * every one of the three sources above:
 *   - `ToolCallState.duration` — set from the `tool:complete` event payload;
 *   - `observability_events.durationMs` — the collector copies the same field
 *     (`src/observability/collector.ts`), so obs rows are NOT a trustworthy
 *     duration source for built-in tools either, only for extension tools;
 *   - `tool_calls.duration_ms` — hardcoded 0 at the insert site.
 *
 * So a 0 is indistinguishable from a genuinely instant call, and
 * `resolveDurationMs` reports it as UNKNOWN (`undefined`). Consumers that
 * display a duration must render an em dash for unknown, never "0ms".
 *
 * `TimelineEntry` therefore carries TWO numbers, and they are not the same
 * thing:
 *
 *   `durationMs` — the TRUTH. Absent when unknown. What the chat graph reads.
 *   `spanMs`     — the GEOMETRY. Always a number, only ever used to lay bars
 *                  out on a shared time axis. Equals `durationMs` when known;
 *                  when unknown it falls back to whatever the source can
 *                  offer — elapsed-since-start for a live call, 0 for a
 *                  persisted row with nothing better.
 *
 * Keeping them separate is what lets the waterfall keep drawing its existing
 * (0-width, "0ms"-labelled) bars while the graph tells the truth. Do not
 * collapse them back into one field.
 */

/** Lifecycle of one tool invocation. Mirrors `ToolCallState["status"]`. */
export type TimelineStatus = "running" | "complete" | "error";

/**
 * One tool invocation, normalized away from whichever source produced it.
 * Ordered by `startMs` ascending — see `sortByStart` for the tie-break rule.
 */
export interface TimelineEntry {
	/** Source row id when the source has one (`tool_calls.id`, obs event id). */
	id?: string;
	/** Tool name; `"unknown"` when the source row carries none. */
	toolName: string;
	/** Owning extension, or `"builtin"` / absent for host tools. */
	extensionId?: string;
	status: TimelineStatus;
	/** Start of the call, epoch milliseconds. The ordering axis. */
	startMs: number;
	/**
	 * Confirmed wall-clock duration in ms. **Absent means UNKNOWN** — render an
	 * em dash, never "0ms". See the duration-honesty rule in the file header.
	 */
	durationMs?: number;
	/**
	 * Layout-only span in ms, always present. Equals `durationMs` when known;
	 * otherwise the source's best fallback (elapsed for a live call, 0 for a
	 * persisted row). NEVER show this to a user as a measured duration.
	 */
	spanMs: number;
	input?: unknown;
	output?: unknown;
	error?: string;
}

/** A live `tool:complete`-fed store entry. Structural subset of `ToolCallState`. */
export interface ToolCallLike {
	id?: string;
	toolName: string;
	status: TimelineStatus;
	startedAt: number;
	duration?: number;
	extensionId?: string;
	input?: unknown;
	output?: unknown;
	error?: string;
}

/** A persisted `observability_events` row of type `tool_call` / `tool_error`. */
export interface ObsEventLike {
	id: string;
	eventType: string;
	data: Record<string, unknown>;
	durationMs: number | null;
	createdAt: string;
}

/**
 * Obs event types that describe a tool invocation.
 *
 * Exported because the chat-graph level-2 builder filters the same rows for
 * its duration zip — one list, so the two surfaces cannot drift on what counts
 * as a tool event.
 */
export const TOOL_EVENT_TYPES: ReadonlySet<string> = new Set(["tool_call", "tool_error"]);

/**
 * A gap larger than this between one call ending and the next starting is
 * attributed to the model thinking, and gets its own synthesized bar. Below
 * it the gap is scheduling noise and is left as empty track.
 */
export const THINKING_GAP_MS = 100;

/**
 * The single home of the duration-honesty rule: 0, null and undefined are all
 * "unknown". Everything else is a real measurement.
 *
 * Negative values are also rejected — a clock skew between the emitting
 * process and the row's timestamp can produce one, and a negative duration is
 * never a fact worth rendering.
 *
 * Shared with the chat-graph level-2 builder, which used to carry its own
 * looser copy (`ms ? ms : undefined`) that let a negative and an Infinity
 * through as facts.
 */
export function resolveDurationMs(raw: number | null | undefined): number | undefined {
	if (raw === null || raw === undefined) return undefined;
	if (!Number.isFinite(raw) || raw <= 0) return undefined;
	return raw;
}

/**
 * Stable ascending sort on `startMs`. Ties keep their INPUT order — callers
 * that need a deterministic secondary key (the chat-graph builder orders by
 * `createdAt` then `id`) pre-sort their rows and rely on that stability.
 * `Array.prototype.sort` has been required to be stable since ES2019.
 */
function sortByStart<T extends { startMs: number }>(entries: T[]): T[] {
	return [...entries].sort((a, b) => a.startMs - b.startMs);
}

/**
 * Live streaming source → entries.
 *
 * `now` is injected rather than read from `Date.now()` so this stays pure and
 * testable; the caller re-invokes with a fresh clock to animate running bars.
 *
 * An absent `duration` means the call has not reported one yet, so the layout
 * span runs to `now` (an open-ended bar). That is a live estimate, not a
 * measurement, so `durationMs` stays absent for it.
 */
export function normalizeToolCalls(calls: ToolCallLike[], now: number): TimelineEntry[] {
	return sortByStart(
		calls.map((tc) => {
			const durationMs = resolveDurationMs(tc.duration);
			return {
				...(tc.id === undefined ? {} : { id: tc.id }),
				toolName: tc.toolName,
				extensionId: tc.extensionId,
				status: tc.status,
				startMs: tc.startedAt,
				...(durationMs === undefined ? {} : { durationMs }),
				// Preserves the waterfall's long-standing geometry: a call with no
				// reported duration is drawn open-ended, running to `now`.
				spanMs: tc.duration ?? now - tc.startedAt,
				input: tc.input,
				output: tc.output,
				error: tc.error,
			};
		}),
	);
}

/**
 * Persisted observability source → entries. Non-tool event types are dropped.
 *
 * A null `durationMs` (and, per the honesty rule, a 0) leaves the entry's
 * duration unknown; the layout span falls back to 0 because a persisted row
 * offers nothing better than "instantaneous" for drawing purposes.
 */
export function normalizeObsEvents(events: ObsEventLike[]): TimelineEntry[] {
	const entries: TimelineEntry[] = [];
	for (const ev of events) {
		if (!TOOL_EVENT_TYPES.has(ev.eventType)) continue;
		const d = ev.data;
		const durationMs = resolveDurationMs(ev.durationMs);
		entries.push({
			id: ev.id,
			toolName: (d.toolName as string) ?? "unknown",
			extensionId: d.extensionId as string | undefined,
			status: ev.eventType === "tool_error" ? "error" : "complete",
			startMs: new Date(ev.createdAt).getTime(),
			...(durationMs === undefined ? {} : { durationMs }),
			spanMs: ev.durationMs ?? 0,
			input: d.input,
			// The collector writes the payload under `output`; older rows used
			// `result`. Both shapes are still in the table.
			output: d.output ?? d.result,
			error: d.error as string | undefined,
		});
	}
	return sortByStart(entries);
}

/** One row of the waterfall chart. Percentages are relative to the whole run. */
export interface WaterfallBar {
	type: "llm" | "tool";
	label: string;
	extensionId?: string;
	/** Left edge, percent of the total timeline width. */
	startOffset: number;
	/** Bar width, percent of the total timeline width. */
	width: number;
	/**
	 * Milliseconds shown in the duration column. Derived from `spanMs`, so it
	 * is display geometry, NOT a trustworthy measurement — a built-in tool
	 * shows 0 here. Consumers needing the truth read `TimelineEntry.durationMs`.
	 */
	duration: number;
	status: TimelineStatus;
	tokens?: { input: number; output: number };
	input?: unknown;
	output?: unknown;
	error?: string;
}

/**
 * Entries → waterfall bars on a shared 0-100% time axis, with a synthesized
 * "Thinking" bar for every inter-call gap over `THINKING_GAP_MS`.
 *
 * Returns `[]` when there is nothing to draw or when every call collapses onto
 * a single instant (a zero-width axis has no meaningful percentages).
 *
 * Tool bars get a `0.5%` minimum width so a sub-millisecond call is still
 * clickable; thinking bars do not, because they are never narrow enough to
 * need it (they are over `THINKING_GAP_MS` by construction).
 */
export function buildWaterfallBars(entries: TimelineEntry[]): WaterfallBar[] {
	if (entries.length === 0) return [];

	const timelineStart = entries[0]!.startMs;
	const timelineEnd = entries.reduce(
		(max, e) => Math.max(max, e.startMs + e.spanMs),
		timelineStart,
	);
	const totalDuration = timelineEnd - timelineStart;
	if (totalDuration <= 0) return [];

	const pct = (ms: number) => (ms / totalDuration) * 100;
	const bars: WaterfallBar[] = [];

	for (let i = 0; i < entries.length; i++) {
		const e = entries[i]!;
		const prev = entries[i - 1];
		const prevEnd = prev ? prev.startMs + prev.spanMs : timelineStart;

		const gap = e.startMs - prevEnd;
		if (gap > THINKING_GAP_MS) {
			bars.push({
				type: "llm",
				label: "Thinking",
				startOffset: pct(prevEnd - timelineStart),
				width: pct(gap),
				duration: gap,
				status: "complete",
			});
		}

		bars.push({
			type: "tool",
			label: e.toolName,
			extensionId: e.extensionId,
			startOffset: pct(e.startMs - timelineStart),
			width: Math.max(pct(e.spanMs), 0.5),
			duration: e.spanMs,
			status: e.status,
			input: e.input,
			output: e.output,
			error: e.error,
		});
	}

	return bars;
}
