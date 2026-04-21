import { test, expect, describe } from "bun:test";

/**
 * Tests for the waterfall timing visualization logic.
 *
 * Following the streaming-store.test.ts pattern: replicate bar computation
 * as pure functions. These tests define the behavioral contract that the
 * waterfall component's logic must satisfy in Plan 02.
 */

// --- Interfaces matching planned waterfall module ---

interface ToolCallState {
	toolName: string;
	status: "running" | "complete" | "error";
	startedAt: number;
	duration?: number;
	extensionId?: string;
	input?: unknown;
	output?: unknown;
	error?: string;
}

interface WaterfallBar {
	type: "llm" | "tool";
	label: string;
	startOffset: number;
	width: number;
	duration: number;
	status: "running" | "complete" | "error";
}

// --- Replicated logic ---

function computeBars(
	toolCalls: ToolCallState[],
	timelineStart: number,
	now: number,
): WaterfallBar[] {
	const totalDuration = now - timelineStart;
	if (totalDuration <= 0) return [];

	const bars: WaterfallBar[] = [];

	// Sort by startedAt for gap detection
	const sorted = [...toolCalls].sort((a, b) => a.startedAt - b.startedAt);

	for (let i = 0; i < sorted.length; i++) {
		const tc = sorted[i];
		const prevEnd =
			i === 0
				? timelineStart
				: sorted[i - 1].startedAt + (sorted[i - 1].duration ?? now - sorted[i - 1].startedAt);

		// Insert LLM "thinking" bar in gaps > 100ms
		const gap = tc.startedAt - prevEnd;
		if (gap > 100) {
			bars.push({
				type: "llm",
				label: "Thinking",
				startOffset: ((prevEnd - timelineStart) / totalDuration) * 100,
				width: (gap / totalDuration) * 100,
				duration: gap,
				status: "complete",
			});
		}

		const duration = tc.duration ?? now - tc.startedAt;
		bars.push({
			type: "tool",
			label: tc.toolName,
			startOffset: ((tc.startedAt - timelineStart) / totalDuration) * 100,
			width: Math.max((duration / totalDuration) * 100, 0.5), // min 0.5% width
			duration,
			status: tc.status,
		});
	}

	return bars;
}

function formatMs(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms >= 10000) return `${Math.round(ms / 1000)}s`;
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
	return `${n}`;
}

// --- Tests ---

describe("computeBars", () => {
	test("computes correct startOffset and width for single tool call", () => {
		const start = 1000;
		const now = 3000; // total 2000ms
		const calls: ToolCallState[] = [
			{ toolName: "search", status: "complete", startedAt: 1000, duration: 1000 },
		];

		const bars = computeBars(calls, start, now);
		const toolBar = bars.find((b) => b.type === "tool");

		expect(toolBar).toBeDefined();
		expect(toolBar!.startOffset).toBe(0); // starts at timeline start
		expect(toolBar!.width).toBe(50); // 1000/2000 = 50%
		expect(toolBar!.duration).toBe(1000);
	});

	test("handles multiple sequential tool calls", () => {
		const start = 0;
		const now = 4000;
		const calls: ToolCallState[] = [
			{ toolName: "tool-a", status: "complete", startedAt: 0, duration: 1000 },
			{ toolName: "tool-b", status: "complete", startedAt: 1000, duration: 1000 },
		];

		const bars = computeBars(calls, start, now);
		const toolBars = bars.filter((b) => b.type === "tool");

		expect(toolBars).toHaveLength(2);
		expect(toolBars[0].startOffset).toBe(0);
		expect(toolBars[0].width).toBe(25); // 1000/4000
		expect(toolBars[1].startOffset).toBe(25); // 1000/4000
		expect(toolBars[1].width).toBe(25);
	});

	test("inserts LLM thinking bars in gaps", () => {
		const start = 0;
		const now = 3000;
		const calls: ToolCallState[] = [
			{ toolName: "tool-a", status: "complete", startedAt: 0, duration: 1000 },
			// 500ms gap (tool-a ends at 1000, tool-b starts at 1500)
			{ toolName: "tool-b", status: "complete", startedAt: 1500, duration: 500 },
		];

		const bars = computeBars(calls, start, now);
		const llmBars = bars.filter((b) => b.type === "llm");

		expect(llmBars).toHaveLength(1);
		expect(llmBars[0].label).toBe("Thinking");
		expect(llmBars[0].duration).toBe(500);
		// LLM bar starts at 1000ms = 33.33%
		expect(llmBars[0].startOffset).toBeCloseTo(33.33, 0);
	});

	test("handles running tool call (no duration)", () => {
		const start = 0;
		const now = 2000;
		const calls: ToolCallState[] = [
			{ toolName: "search", status: "running", startedAt: 1000 },
		];

		const bars = computeBars(calls, start, now);
		const toolBar = bars.find((b) => b.type === "tool");

		expect(toolBar).toBeDefined();
		expect(toolBar!.status).toBe("running");
		// duration should be now - startedAt = 1000
		expect(toolBar!.duration).toBe(1000);
		expect(toolBar!.width).toBe(50); // 1000/2000
	});

	test("handles zero-duration edge case with minimal width", () => {
		const start = 0;
		const now = 1000;
		const calls: ToolCallState[] = [
			{ toolName: "fast-tool", status: "complete", startedAt: 500, duration: 0 },
		];

		const bars = computeBars(calls, start, now);
		const toolBar = bars.find((b) => b.type === "tool");

		expect(toolBar).toBeDefined();
		// Should have minimum width (0.5%)
		expect(toolBar!.width).toBeGreaterThanOrEqual(0.5);
	});

	test("returns empty array when totalDuration is zero", () => {
		const bars = computeBars([], 1000, 1000);
		expect(bars).toEqual([]);
	});

	test("does not insert LLM bar for small gaps (<= 100ms)", () => {
		const start = 0;
		const now = 2000;
		const calls: ToolCallState[] = [
			{ toolName: "tool-a", status: "complete", startedAt: 0, duration: 1000 },
			// Only 50ms gap
			{ toolName: "tool-b", status: "complete", startedAt: 1050, duration: 500 },
		];

		const bars = computeBars(calls, start, now);
		const llmBars = bars.filter((b) => b.type === "llm");
		expect(llmBars).toHaveLength(0);
	});

	test("overlapping / concurrent tool calls (same startedAt)", () => {
		const start = 0;
		const now = 2000;
		const calls: ToolCallState[] = [
			{ toolName: "tool-a", status: "complete", startedAt: 0, duration: 1500 },
			{ toolName: "tool-b", status: "complete", startedAt: 0, duration: 1000 },
		];

		const bars = computeBars(calls, start, now);
		const toolBars = bars.filter((b) => b.type === "tool");
		expect(toolBars).toHaveLength(2);
		// Both should start at offset 0
		expect(toolBars[0].startOffset).toBe(0);
		expect(toolBars[1].startOffset).toBe(0);
	});

	test("all tool calls at same timestamp", () => {
		const start = 1000;
		const now = 2000;
		const calls: ToolCallState[] = [
			{ toolName: "a", status: "complete", startedAt: 1000, duration: 500 },
			{ toolName: "b", status: "complete", startedAt: 1000, duration: 500 },
			{ toolName: "c", status: "complete", startedAt: 1000, duration: 500 },
		];

		const bars = computeBars(calls, start, now);
		const toolBars = bars.filter((b) => b.type === "tool");
		expect(toolBars).toHaveLength(3);
		// No LLM thinking bars since there are no gaps
		expect(bars.filter((b) => b.type === "llm")).toHaveLength(0);
		// All start at same offset
		for (const bar of toolBars) {
			expect(bar.startOffset).toBe(0);
		}
	});

	test("error status bars preserve error status", () => {
		const start = 0;
		const now = 2000;
		const calls: ToolCallState[] = [
			{ toolName: "failing-tool", status: "error", startedAt: 0, duration: 500, error: "timeout" },
		];

		const bars = computeBars(calls, start, now);
		const toolBar = bars.find((b) => b.type === "tool");

		expect(toolBar).toBeDefined();
		expect(toolBar!.status).toBe("error");
		expect(toolBar!.label).toBe("failing-tool");
	});

	test("mix of error, complete, and running statuses", () => {
		const start = 0;
		const now = 3000;
		const calls: ToolCallState[] = [
			{ toolName: "done", status: "complete", startedAt: 0, duration: 1000 },
			{ toolName: "broken", status: "error", startedAt: 1000, duration: 500 },
			{ toolName: "active", status: "running", startedAt: 1500 },
		];

		const bars = computeBars(calls, start, now);
		const toolBars = bars.filter((b) => b.type === "tool");
		expect(toolBars).toHaveLength(3);
		expect(toolBars[0].status).toBe("complete");
		expect(toolBars[1].status).toBe("error");
		expect(toolBars[2].status).toBe("running");
	});

	test("unsorted input is sorted by startedAt", () => {
		const start = 0;
		const now = 3000;
		const calls: ToolCallState[] = [
			{ toolName: "second", status: "complete", startedAt: 1000, duration: 500 },
			{ toolName: "first", status: "complete", startedAt: 0, duration: 500 },
		];

		const bars = computeBars(calls, start, now);
		const toolBars = bars.filter((b) => b.type === "tool");
		expect(toolBars[0].label).toBe("first");
		expect(toolBars[1].label).toBe("second");
	});

	test("negative totalDuration returns empty", () => {
		// now < timelineStart
		const bars = computeBars([], 2000, 1000);
		expect(bars).toEqual([]);
	});
});

// --- Replicated computeBarsFromEvents logic ---

interface ObsEvent {
	id: string;
	eventType: string;
	data: Record<string, unknown>;
	durationMs: number | null;
	createdAt: string;
}

function computeBarsFromEvents(evts: ObsEvent[]): WaterfallBar[] {
	if (evts.length === 0) return [];

	const toolEvts = evts.filter(
		(e) => e.eventType === "tool_call" || e.eventType === "tool_error",
	);
	if (toolEvts.length === 0) return [];

	const sorted = [...toolEvts].sort(
		(a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
	);
	const timelineStart = new Date(sorted[0]!.createdAt).getTime();
	const timelineEnd = sorted.reduce((max, ev) => {
		const t = new Date(ev.createdAt).getTime() + (ev.durationMs ?? 0);
		return t > max ? t : max;
	}, timelineStart);
	const totalDuration = timelineEnd - timelineStart;
	if (totalDuration <= 0) return [];

	const bars: WaterfallBar[] = [];

	for (let i = 0; i < sorted.length; i++) {
		const ev = sorted[i]!;
		const d = ev.data as Record<string, unknown>;
		const evStart = new Date(ev.createdAt).getTime();
		const evDuration = ev.durationMs ?? 0;

		const prevEnd = i === 0
			? timelineStart
			: new Date(sorted[i - 1]!.createdAt).getTime() + (sorted[i - 1]!.durationMs ?? 0);

		const gap = evStart - prevEnd;
		if (gap > 100) {
			bars.push({
				type: "llm",
				label: "Thinking",
				startOffset: ((prevEnd - timelineStart) / totalDuration) * 100,
				width: (gap / totalDuration) * 100,
				duration: gap,
				status: "complete",
			});
		}

		bars.push({
			type: "tool",
			label: (d.toolName as string) ?? "unknown",
			startOffset: ((evStart - timelineStart) / totalDuration) * 100,
			width: Math.max((evDuration / totalDuration) * 100, 0.5),
			duration: evDuration,
			status: ev.eventType === "tool_error" ? "error" : "complete",
		});
	}

	return bars;
}

describe("computeBarsFromEvents", () => {
	test("produces tool bars from tool_call events", () => {
		const events: ObsEvent[] = [
			{
				id: "1", eventType: "tool_call",
				data: { toolName: "search" },
				durationMs: 500,
				createdAt: "2026-01-01T00:00:00.000Z",
			},
			{
				id: "2", eventType: "tool_call",
				data: { toolName: "read" },
				durationMs: 300,
				createdAt: "2026-01-01T00:00:01.000Z",
			},
		];

		const bars = computeBarsFromEvents(events);
		const toolBars = bars.filter((b) => b.type === "tool");
		expect(toolBars).toHaveLength(2);
		expect(toolBars[0].label).toBe("search");
		expect(toolBars[1].label).toBe("read");
	});

	test("tool_error events produce error status bars", () => {
		const events: ObsEvent[] = [
			{
				id: "1", eventType: "tool_call",
				data: { toolName: "search" },
				durationMs: 500,
				createdAt: "2026-01-01T00:00:00.000Z",
			},
			{
				id: "2", eventType: "tool_error",
				data: { toolName: "broken", error: "timeout" },
				durationMs: 200,
				createdAt: "2026-01-01T00:00:01.000Z",
			},
		];

		const bars = computeBarsFromEvents(events);
		const errorBars = bars.filter((b) => b.status === "error");
		expect(errorBars).toHaveLength(1);
		expect(errorBars[0].label).toBe("broken");
	});

	test("filters out non-tool events", () => {
		const events: ObsEvent[] = [
			{
				id: "1", eventType: "llm_call",
				data: {},
				durationMs: 1000,
				createdAt: "2026-01-01T00:00:00.000Z",
			},
		];

		const bars = computeBarsFromEvents(events);
		expect(bars).toEqual([]);
	});

	test("inserts LLM thinking bar in gaps > 100ms", () => {
		const events: ObsEvent[] = [
			{
				id: "1", eventType: "tool_call",
				data: { toolName: "a" },
				durationMs: 200,
				createdAt: "2026-01-01T00:00:00.000Z",
			},
			{
				id: "2", eventType: "tool_call",
				data: { toolName: "b" },
				durationMs: 200,
				// 500ms after event 1 ends (200ms after start + 200ms duration = 200ms, event 2 at 700ms => gap = 500ms)
				createdAt: "2026-01-01T00:00:00.700Z",
			},
		];

		const bars = computeBarsFromEvents(events);
		const llmBars = bars.filter((b) => b.type === "llm");
		expect(llmBars).toHaveLength(1);
		expect(llmBars[0].label).toBe("Thinking");
		expect(llmBars[0].duration).toBe(500);
	});

	test("empty events array returns empty bars", () => {
		expect(computeBarsFromEvents([])).toEqual([]);
	});

	test("single event with null durationMs uses 0", () => {
		const events: ObsEvent[] = [
			{
				id: "1", eventType: "tool_call",
				data: { toolName: "quick" },
				durationMs: null,
				createdAt: "2026-01-01T00:00:00.000Z",
			},
		];

		// Single event with 0 duration => totalDuration = 0 => empty
		const bars = computeBarsFromEvents(events);
		expect(bars).toEqual([]);
	});

	test("events with same createdAt and positive duration", () => {
		const events: ObsEvent[] = [
			{
				id: "1", eventType: "tool_call",
				data: { toolName: "a" },
				durationMs: 500,
				createdAt: "2026-01-01T00:00:00.000Z",
			},
			{
				id: "2", eventType: "tool_call",
				data: { toolName: "b" },
				durationMs: 500,
				createdAt: "2026-01-01T00:00:00.000Z",
			},
		];

		const bars = computeBarsFromEvents(events);
		const toolBars = bars.filter((b) => b.type === "tool");
		expect(toolBars).toHaveLength(2);
		// Both start at 0
		expect(toolBars[0].startOffset).toBe(0);
		expect(toolBars[1].startOffset).toBe(0);
	});
});

describe("formatMs", () => {
	test("formats < 1000 as ms", () => {
		expect(formatMs(123)).toBe("123ms");
	});

	test("formats >= 1000 as seconds with decimal", () => {
		expect(formatMs(1500)).toBe("1.5s");
	});

	test("formats >= 10000 as seconds without decimal", () => {
		expect(formatMs(12000)).toBe("12s");
	});

	test("formats 0 as 0ms", () => {
		expect(formatMs(0)).toBe("0ms");
	});

	test("formats 999 as ms", () => {
		expect(formatMs(999)).toBe("999ms");
	});

	test("formats exactly 1000 as 1.0s", () => {
		expect(formatMs(1000)).toBe("1.0s");
	});
});

describe("formatTokens", () => {
	test("formats < 1000 as raw number", () => {
		expect(formatTokens(500)).toBe("500");
	});

	test("formats >= 1000 as K", () => {
		expect(formatTokens(1500)).toBe("1.5K");
	});

	test("formats >= 1000000 as M", () => {
		expect(formatTokens(1500000)).toBe("1.5M");
	});

	test("formats exactly 1000 as 1.0K", () => {
		expect(formatTokens(1000)).toBe("1.0K");
	});

	test("formats 0 as 0", () => {
		expect(formatTokens(0)).toBe("0");
	});
});
