import { test, expect, describe } from "bun:test";
import {
	computePct,
	computeTone,
	fmtTokens,
	tooltipText,
	pickLastTurnInputTokens,
	pickLastTurnUsage,
	estimateToolCallTokens,
	computeBreakdown,
	computeToolBreakdown,
	groupToolBreakdown,
	splitNamespacedToolName,
	summarizeToolInput,
	type MessageLike,
	type ToolBreakdownEntry,
} from "$lib/context-usage-logic";

// ── computePct ──────────────────────────────────────────────────────────────

describe("computePct", () => {
	test("returns null when usedTokens is null", () => {
		expect(computePct(null, 200_000)).toBeNull();
	});

	test("returns null when usedTokens is undefined", () => {
		expect(computePct(undefined, 200_000)).toBeNull();
	});

	test("returns null when contextWindow is null", () => {
		expect(computePct(1_000, null)).toBeNull();
	});

	test("returns null when contextWindow is zero", () => {
		expect(computePct(1_000, 0)).toBeNull();
	});

	test("returns null when contextWindow is negative", () => {
		expect(computePct(1_000, -5)).toBeNull();
	});

	test("returns null when inputs are non-finite", () => {
		expect(computePct(Number.NaN, 1_000)).toBeNull();
		expect(computePct(1_000, Number.POSITIVE_INFINITY)).toBeNull();
	});

	test("computes percentage correctly", () => {
		expect(computePct(50_000, 200_000)).toBe(25);
	});

	test("clamps above 100%", () => {
		expect(computePct(500_000, 200_000)).toBe(100);
	});

	test("clamps below 0%", () => {
		expect(computePct(-10, 200_000)).toBe(0);
	});

	test("supports fractional percentages", () => {
		expect(computePct(1, 3)).toBeCloseTo(33.333, 2);
	});
});

// ── computeTone ─────────────────────────────────────────────────────────────

describe("computeTone", () => {
	test("null → muted", () => {
		expect(computeTone(null)).toBe("muted");
	});

	test("0% → muted", () => {
		expect(computeTone(0)).toBe("muted");
	});

	test("just under warn threshold → muted", () => {
		expect(computeTone(69.9)).toBe("muted");
	});

	test("at warn threshold → warn", () => {
		expect(computeTone(70)).toBe("warn");
	});

	test("between warn and danger → warn", () => {
		expect(computeTone(85)).toBe("warn");
	});

	test("just under danger threshold → warn", () => {
		expect(computeTone(89.9)).toBe("warn");
	});

	test("at danger threshold → danger", () => {
		expect(computeTone(90)).toBe("danger");
	});

	test("100% → danger", () => {
		expect(computeTone(100)).toBe("danger");
	});
});

// ── fmtTokens ───────────────────────────────────────────────────────────────

describe("fmtTokens", () => {
	test("small numbers are integers", () => {
		expect(fmtTokens(0)).toBe("0");
		expect(fmtTokens(42)).toBe("42");
		expect(fmtTokens(999)).toBe("999");
	});

	test("thousands show one decimal below 10k", () => {
		expect(fmtTokens(1_000)).toBe("1.0k");
		expect(fmtTokens(1_234)).toBe("1.2k");
		expect(fmtTokens(9_876)).toBe("9.9k");
	});

	test("tens of thousands show no decimal", () => {
		expect(fmtTokens(10_000)).toBe("10k");
		expect(fmtTokens(12_345)).toBe("12k");
		expect(fmtTokens(200_000)).toBe("200k");
	});

	test("millions show one decimal", () => {
		expect(fmtTokens(1_000_000)).toBe("1.0M");
		expect(fmtTokens(1_234_567)).toBe("1.2M");
	});

	test("non-finite input falls back to 0", () => {
		expect(fmtTokens(Number.NaN)).toBe("0");
	});
});

// ── tooltipText ─────────────────────────────────────────────────────────────

describe("tooltipText", () => {
	test("returns placeholder when tokens are unknown", () => {
		expect(tooltipText(null, 200_000)).toBe("Context usage — appears after the first assistant response");
		expect(tooltipText(1_000, null)).toBe("Context usage — appears after the first assistant response");
	});

	test("formats used / window / percent", () => {
		expect(tooltipText(50_000, 200_000)).toBe("50k / 200k tokens used (25%)");
	});

	test("rounds percentage to nearest whole", () => {
		// 1/3 → 33.33…%
		expect(tooltipText(1_000, 3_000)).toBe("1.0k / 3.0k tokens used (33%)");
	});
});

// ── pickLastTurnInputTokens ─────────────────────────────────────────────────

describe("pickLastTurnInputTokens", () => {
	test("empty → null", () => {
		expect(pickLastTurnInputTokens([])).toBeNull();
	});

	test("user-only messages → null", () => {
		const msgs: MessageLike[] = [
			{ role: "user", usage: null },
			{ role: "user", usage: { inputTokens: 42 } },
		];
		expect(pickLastTurnInputTokens(msgs)).toBeNull();
	});

	test("system messages are ignored", () => {
		const msgs: MessageLike[] = [{ role: "system", usage: { inputTokens: 99 } }];
		expect(pickLastTurnInputTokens(msgs)).toBeNull();
	});

	test("returns inputTokens from the latest assistant message", () => {
		const msgs: MessageLike[] = [
			{ role: "user" },
			{ role: "assistant", usage: { inputTokens: 1_000 } },
			{ role: "user" },
			{ role: "assistant", usage: { inputTokens: 3_500 } },
		];
		expect(pickLastTurnInputTokens(msgs)).toBe(3_500);
	});

	test("skips assistant messages with missing usage", () => {
		const msgs: MessageLike[] = [
			{ role: "assistant", usage: { inputTokens: 1_000 } },
			{ role: "assistant", usage: null },
		];
		expect(pickLastTurnInputTokens(msgs)).toBe(1_000);
	});

	test("skips assistant messages with zero inputTokens (streaming placeholder)", () => {
		const msgs: MessageLike[] = [
			{ role: "assistant", usage: { inputTokens: 2_000 } },
			{ role: "user" },
			{ role: "assistant", usage: { inputTokens: 0 } },
		];
		expect(pickLastTurnInputTokens(msgs)).toBe(2_000);
	});

	test("skips non-numeric inputTokens", () => {
		const msgs: MessageLike[] = [
			{ role: "assistant", usage: { inputTokens: 5_000 } },
			{ role: "assistant", usage: { inputTokens: null as unknown as number } },
		];
		expect(pickLastTurnInputTokens(msgs)).toBe(5_000);
	});

	test("handles undefined usage entirely", () => {
		const msgs: MessageLike[] = [
			{ role: "assistant" },
			{ role: "assistant", usage: { inputTokens: 7_000 } },
		];
		expect(pickLastTurnInputTokens(msgs)).toBe(7_000);
	});

	test("all-null usage on all assistant messages → null", () => {
		const msgs: MessageLike[] = [
			{ role: "assistant", usage: null },
			{ role: "assistant", usage: { inputTokens: undefined } },
		];
		expect(pickLastTurnInputTokens(msgs)).toBeNull();
	});
});

// ── pickLastTurnUsage ───────────────────────────────────────────────────────

describe("pickLastTurnUsage", () => {
	test("returns input + output from latest assistant message", () => {
		const msgs: MessageLike[] = [
			{ role: "assistant", usage: { inputTokens: 100, outputTokens: 20 } },
			{ role: "user" },
			{ role: "assistant", usage: { inputTokens: 500, outputTokens: 75 } },
		];
		expect(pickLastTurnUsage(msgs)).toEqual({ inputTokens: 500, outputTokens: 75 });
	});

	test("treats missing/zero outputTokens as 0", () => {
		const msgs: MessageLike[] = [
			{ role: "assistant", usage: { inputTokens: 1_000 } },
		];
		expect(pickLastTurnUsage(msgs)).toEqual({ inputTokens: 1_000, outputTokens: 0 });
	});

	test("returns null when no assistant message has positive inputTokens", () => {
		expect(pickLastTurnUsage([{ role: "assistant", usage: { inputTokens: 0, outputTokens: 5 } }])).toBeNull();
	});
});

// ── estimateToolCallTokens ──────────────────────────────────────────────────

describe("estimateToolCallTokens", () => {
	test("empty list → 0", () => {
		expect(estimateToolCallTokens([])).toBe(0);
	});

	test("sums approximate tokens from string output (4 chars per token)", () => {
		// 8 chars / 4 = 2 tokens
		expect(estimateToolCallTokens([{ output: "abcdefgh" }])).toBe(2);
	});

	test("includes input payloads", () => {
		// JSON.stringify({a:1}) = "{\"a\":1}" = 7 chars → ceil(7/4) = 2
		expect(estimateToolCallTokens([{ input: { a: 1 } }])).toBe(2);
	});

	test("ignores null/undefined fields", () => {
		expect(estimateToolCallTokens([{ input: undefined, output: undefined }])).toBe(0);
	});

	test("handles non-serializable input gracefully", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => estimateToolCallTokens([{ input: cyclic }])).not.toThrow();
	});
});

// ── computeBreakdown ────────────────────────────────────────────────────────

describe("computeBreakdown", () => {
	test("returns null when input is missing or non-positive", () => {
		expect(computeBreakdown(null, 50, 10)).toBeNull();
		expect(computeBreakdown(0, 50, 10)).toBeNull();
		expect(computeBreakdown(Number.NaN, 50, 10)).toBeNull();
	});

	test("computes input/output/tool percentages on a clean turn", () => {
		const bd = computeBreakdown(800, 200, 100)!;
		expect(bd.inputTokens).toBe(800);
		expect(bd.outputTokens).toBe(200);
		expect(bd.toolTokens).toBe(100);
		expect(bd.totalTokens).toBe(1_000);
		expect(bd.pctInput).toBe(80);
		expect(bd.pctOutput).toBe(20);
		expect(bd.pctTools).toBe(10);
	});

	test("clamps tool tokens to inputTokens (tool data lives inside input)", () => {
		const bd = computeBreakdown(100, 50, 9_999)!;
		expect(bd.toolTokens).toBe(100);
	});

	test("treats missing output as 0", () => {
		const bd = computeBreakdown(1_000, null, 0)!;
		expect(bd.outputTokens).toBe(0);
		expect(bd.totalTokens).toBe(1_000);
		expect(bd.pctInput).toBe(100);
	});
});

// ── computeToolBreakdown ────────────────────────────────────────────────────

describe("computeToolBreakdown", () => {
	test("empty list → empty array", () => {
		expect(computeToolBreakdown([], 1_000)).toEqual([]);
	});

	test("parses extension namespace + function name from `ext__fn` tool names", () => {
		// "abcdefgh" = 8 chars → 2 tokens; called twice → 4 tokens, 2 calls
		const out = computeToolBreakdown(
			[
				{ toolName: "filesystem__read_file", output: "abcdefgh" },
				{ toolName: "filesystem__read_file", output: "abcdefgh" },
			],
			1_000,
		);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			extensionName: "filesystem",
			toolName: "read_file",
			callCount: 2,
			tokens: 4,
		});
		expect(out[0]?.pct).toBeCloseTo(0.4, 5);
	});

	test("built-in tools (no `__` namespace) leave the extension pill empty", () => {
		const out = computeToolBreakdown(
			[{ toolName: "Bash", output: "abcdefgh" }],
			1_000,
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.extensionName).toBe("");
		expect(out[0]?.toolName).toBe("Bash");
	});

	test("does NOT collapse same function name across different extensions", () => {
		// Two different extensions both expose a "read_file" tool — they should
		// stay separate in the breakdown.
		const out = computeToolBreakdown(
			[
				{ toolName: "filesystem__read_file", output: "abcdefgh" },
				{ toolName: "http__read_file", output: "abcdefgh" },
			],
			1_000,
		);
		expect(out).toHaveLength(2);
		const exts = out.map((t) => t.extensionName).sort();
		expect(exts).toEqual(["filesystem", "http"]);
	});

	test("ignores the inline-tool-store extensionName field (it's an opaque id, not a label)", () => {
		// The inline-tool-store sets `extensionName` to the extensionId (or
		// "builtin"), so we must derive the visible namespace strictly from
		// the namespaced toolName itself.
		const out = computeToolBreakdown(
			[{ extensionName: "ext_abc123_uuid", toolName: "filesystem__read_file", output: "abcdefgh" }],
			1_000,
		);
		expect(out[0]?.extensionName).toBe("filesystem");
		expect(out[0]?.toolName).toBe("read_file");
	});

	test("splits on the FIRST `__` so suffixed names keep their tail", () => {
		const out = computeToolBreakdown(
			[{ toolName: "ext__sub__action", output: "abcdefgh" }],
			1_000,
		);
		expect(out[0]?.extensionName).toBe("ext");
		expect(out[0]?.toolName).toBe("sub__action");
	});

	test("sorts tools by tokens descending", () => {
		const out = computeToolBreakdown(
			[
				{ toolName: "x__Small", output: "ab" }, // 1 token
				{ toolName: "x__Big", output: "a".repeat(100) }, // 25 tokens
				{ toolName: "x__Medium", output: "a".repeat(20) }, // 5 tokens
			],
			1_000,
		);
		expect(out.map((t) => t.toolName)).toEqual(["Big", "Medium", "Small"]);
	});

	test("uses 'unknown' when toolName is missing or empty", () => {
		const out = computeToolBreakdown(
			[
				{ output: "abcdefgh" },
				{ toolName: "", output: "abcdefgh" },
			],
			1_000,
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.toolName).toBe("unknown");
		expect(out[0]?.extensionName).toBe("");
		expect(out[0]?.callCount).toBe(2);
	});

	test("drops tools that contribute zero tokens", () => {
		expect(computeToolBreakdown([{ toolName: "Noop" }], 1_000)).toEqual([]);
	});

	test("pct is 0 when totalTokens is non-positive", () => {
		const out = computeToolBreakdown([{ toolName: "Read", output: "abcdefgh" }], 0);
		expect(out[0]?.pct).toBe(0);
	});

	test("carries each call's source `id` through as `callId` so the popover can scroll to it", () => {
		// The chat page renders each tool card with `id="tool-call-${id}"`.
		// The popover needs that same id on every per-call row so a click can
		// land on the matching anchor. If this regresses, the "jump to call"
		// affordance silently breaks (button no-ops, no error).
		const out = computeToolBreakdown(
			[
				{ id: "call-A", toolName: "fs__Read", input: { path: "/a" }, output: "x".repeat(40) },
				{ id: "call-B", toolName: "fs__Read", input: { path: "/b" }, output: "x".repeat(20) },
				{ /* no id */ toolName: "fs__Read", input: { path: "/c" }, output: "x".repeat(10) },
			],
			1_000,
		);
		expect(out).toHaveLength(1);
		const ids = out[0]!.calls.map((c) => c.callId);
		// Sorted by tokens desc — A (40), B (20), C (10).
		expect(ids).toEqual(["call-A", "call-B", undefined]);
	});

	test("captures per-call breakdown sorted by tokens desc, with input previews", () => {
		const out = computeToolBreakdown(
			[
				{ toolName: "fs__Read", input: { path: "/a" }, output: "x".repeat(40) }, // big call
				{ toolName: "fs__Read", input: { path: "/tiny" }, output: "x" }, // small
				{ toolName: "fs__Read", input: { path: "/medium" }, output: "x".repeat(20) }, // mid
			],
			1_000,
		);
		expect(out).toHaveLength(1);
		const entry = out[0]!;
		expect(entry.callCount).toBe(3);
		expect(entry.calls).toHaveLength(3);
		// Sorted by tokens desc.
		expect(entry.calls.map((c) => c.tokens)).toEqual([
			...entry.calls.map((c) => c.tokens),
		].sort((a, b) => b - a));
		// Each call has a preview drawn from the input's first string value.
		expect(entry.calls[0]?.preview).toBe("/a");
		// And per-call pct relative to totalTokens.
		expect(entry.calls[0]?.pct).toBeCloseTo((entry.calls[0]!.tokens / 1_000) * 100, 5);
	});
});

// ── groupToolBreakdown ─────────────────────────────────────────────────────

describe("groupToolBreakdown", () => {
	function fn(
		extensionName: string,
		toolName: string,
		tokens: number,
		callCount = 1,
	): ToolBreakdownEntry {
		return {
			extensionName,
			toolName,
			callCount,
			tokens,
			pct: tokens / 10, // arbitrary, just so we can test pct summation
			calls: Array.from({ length: callCount }, (_, i) => ({
				tokens: Math.floor(tokens / callCount),
				pct: tokens / 10 / callCount,
				preview: `${toolName}-call${i}`,
			})),
		};
	}

	test("empty input → empty array", () => {
		expect(groupToolBreakdown([])).toEqual([]);
	});

	test("collapses multiple functions of one extension into a single group", () => {
		const out = groupToolBreakdown([
			fn("playwright", "browser_click", 100, 2),
			fn("playwright", "browser_navigate", 60, 1),
			fn("playwright", "browser_snapshot", 40, 3),
		]);
		expect(out).toHaveLength(1);
		const g = out[0]!;
		expect(g.extensionName).toBe("playwright");
		expect(g.displayName).toBe("playwright");
		expect(g.isBuiltin).toBe(false);
		expect(g.functions).toHaveLength(3);
		expect(g.tokens).toBe(200);
		expect(g.callCount).toBe(6);
		expect(g.pct).toBeCloseTo(20, 5); // sum of per-fn pcts
	});

	test("each built-in tool becomes its OWN top-level group (does not collapse together)", () => {
		// Critical: empty extensionName must NOT collapse Bash + Read + Edit
		// into one group. Each built-in is its own row at the top level.
		const out = groupToolBreakdown([
			fn("", "Bash", 80, 2),
			fn("", "Read", 50, 1),
			fn("", "Edit", 30, 4),
		]);
		expect(out).toHaveLength(3);
		const byName = new Map(out.map((g) => [g.displayName, g]));
		expect(byName.get("Bash")?.isBuiltin).toBe(true);
		expect(byName.get("Read")?.isBuiltin).toBe(true);
		expect(byName.get("Edit")?.isBuiltin).toBe(true);
		// Each built-in group has exactly one function (itself).
		for (const g of out) {
			expect(g.functions).toHaveLength(1);
			expect(g.extensionName).toBe("");
			expect(g.functions[0]?.toolName).toBe(g.displayName);
		}
	});

	test("mixed extension + built-in tools coexist at the top level", () => {
		const out = groupToolBreakdown([
			fn("playwright", "browser_click", 100),
			fn("playwright", "browser_navigate", 60),
			fn("", "Bash", 80),
			fn("stackflow", "add_task", 40),
			fn("", "Read", 30),
		]);
		// Expect 4 groups: playwright, stackflow, Bash, Read.
		expect(out).toHaveLength(4);
		const byKey = new Map(out.map((g) => [g.key, g]));
		expect(byKey.get("ext::playwright")?.tokens).toBe(160);
		expect(byKey.get("ext::stackflow")?.tokens).toBe(40);
		expect(byKey.get("builtin::Bash")?.tokens).toBe(80);
		expect(byKey.get("builtin::Read")?.tokens).toBe(30);
	});

	test("sorts groups by tokens desc, then by displayName asc as a tiebreak", () => {
		const out = groupToolBreakdown([
			fn("zeta", "x", 50),
			fn("alpha", "x", 100),
			fn("beta", "x", 50), // tied with zeta
		]);
		expect(out.map((g) => g.displayName)).toEqual(["alpha", "beta", "zeta"]);
	});

	test("functions inside a group are sorted by tokens desc", () => {
		const out = groupToolBreakdown([
			fn("playwright", "browser_navigate", 30),
			fn("playwright", "browser_snapshot", 90),
			fn("playwright", "browser_click", 60),
		]);
		expect(out[0]?.functions.map((f) => f.toolName)).toEqual([
			"browser_snapshot",
			"browser_click",
			"browser_navigate",
		]);
	});

	test("group keys are stable and namespace-distinct (`ext::` vs `builtin::`)", () => {
		// Edge case: a built-in tool happens to share a name with an extension.
		// They must NOT collide.
		const out = groupToolBreakdown([
			fn("", "Read", 50),
			fn("Read", "list", 30), // pretend an extension named "Read" with a `list` fn
		]);
		expect(out).toHaveLength(2);
		const keys = out.map((g) => g.key).sort();
		expect(keys).toEqual(["builtin::Read", "ext::Read"]);
	});

	test("preserves per-function calls verbatim (no rebucketing of call previews)", () => {
		const input = fn("playwright", "browser_click", 60, 3);
		const out = groupToolBreakdown([input]);
		expect(out[0]?.functions[0]?.calls.map((c) => c.preview)).toEqual([
			"browser_click-call0",
			"browser_click-call1",
			"browser_click-call2",
		]);
	});
});

// ── splitNamespacedToolName ────────────────────────────────────────────────

describe("splitNamespacedToolName", () => {
	test("empty input → empty parts", () => {
		expect(splitNamespacedToolName("")).toEqual({ namespace: "", functionName: "" });
	});

	test("no `__` → built-in (no namespace)", () => {
		expect(splitNamespacedToolName("Bash")).toEqual({ namespace: "", functionName: "Bash" });
	});

	test("standard `ext__fn` splits cleanly", () => {
		expect(splitNamespacedToolName("filesystem__read_file")).toEqual({
			namespace: "filesystem",
			functionName: "read_file",
		});
	});

	test("splits on the FIRST `__`, preserving suffix occurrences", () => {
		expect(splitNamespacedToolName("ext__sub__action")).toEqual({
			namespace: "ext",
			functionName: "sub__action",
		});
	});

	test("leading `__` is treated as no namespace", () => {
		// idx === 0 means there's no real prefix, just a malformed name.
		expect(splitNamespacedToolName("__weird")).toEqual({ namespace: "", functionName: "__weird" });
	});

	test("single underscores do NOT split", () => {
		expect(splitNamespacedToolName("read_file")).toEqual({ namespace: "", functionName: "read_file" });
	});
});

// ── summarizeToolInput ─────────────────────────────────────────────────────

describe("summarizeToolInput", () => {
	test("null/undefined → empty string", () => {
		expect(summarizeToolInput(null)).toBe("");
		expect(summarizeToolInput(undefined)).toBe("");
	});

	test("string input is truncated to 60 chars", () => {
		const long = "a".repeat(100);
		expect(summarizeToolInput(long).length).toBe(60);
	});

	test("object input prefers first non-empty string field", () => {
		expect(summarizeToolInput({ path: "/foo", lineCount: 3 })).toBe("/foo");
	});

	test("object input falls back to first numeric/boolean field when no strings", () => {
		expect(summarizeToolInput({ count: 42 })).toBe("42");
		expect(summarizeToolInput({ flag: true })).toBe("true");
	});

	test("object with no scalar fields falls back to JSON snippet", () => {
		expect(summarizeToolInput({ nested: { x: 1 } })).toBe('{"nested":{"x":1}}');
	});

	test("non-serializable input returns empty string", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(summarizeToolInput(cyclic)).toBe("");
	});
});
