/**
 * Unit suite for the graph canvas's pure presentation + navigation rules.
 *
 * The duration contract gets the most attention: an ABSENT `durationMs`
 * must render an em dash and must never be reported as "0ms", because
 * built-in tools persist a hardcoded 0 that is indistinguishable from a
 * genuinely instant call.
 */
import { describe, expect, test } from "bun:test";
import type { GraphNode } from "$server/runtime/chat-graph/types";
import {
	clampZoom,
	DURATION_UNKNOWN,
	edgeDashArray,
	EDGE_LABEL,
	formatNodeDuration,
	isActivationKey,
	KIND_LABEL,
	LABEL_FADE_PX,
	labelFadeStart,
	KIND_ICON,
	formatTokenLine,
	formatTokens,
	legendSections,
	nodeDetailCard,
	moveFocus,
	type NavNode,
	nodeAction,
	nodeAriaLabel,
	nodeTitle,
	STATUS_LABEL,
	wheelZoomFactor,
	ZOOM_MAX,
	ZOOM_MIN,
	ZOOM_STEP,
	zoomBy,
} from "./canvas-view";

function node(over: Partial<GraphNode> = {}): GraphNode {
	return {
		id: "n1",
		kind: "prompt",
		label: "Add a login page",
		status: "success",
		createdAt: "2026-07-26T10:00:00.000Z",
		...over,
	};
}

describe("formatNodeDuration", () => {
	test("absent duration renders an em dash, never 0ms", () => {
		expect(formatNodeDuration(undefined)).toBe(DURATION_UNKNOWN);
		expect(formatNodeDuration(undefined)).not.toContain("0");
	});

	test("zero is unknown too — built-in tools hardcode it, so it is never a fact", () => {
		// This used to assert "0ms" on the reading that only an ABSENT field
		// means unknown. It was changed deliberately: `tool_calls.duration_ms`
		// is a hardcoded 0 for every built-in tool, so a 0 that does reach the
		// renderer is indistinguishable from a genuinely instant call and
		// "0ms" would be a fabricated measurement. `resolveDurationMs` already
		// held this line for the builder; two modules in one feature must not
		// disagree about whether 0 is a fact.
		expect(formatNodeDuration(0)).toBe(DURATION_UNKNOWN);
	});

	test("sub-second durations keep millisecond precision", () => {
		expect(formatNodeDuration(1)).toBe("1ms");
		expect(formatNodeDuration(120)).toBe("120ms");
		expect(formatNodeDuration(999)).toBe("999ms");
	});

	test("fractional milliseconds round", () => {
		expect(formatNodeDuration(120.6)).toBe("121ms");
	});

	test("one second and up delegates to the shared compact formatter", () => {
		expect(formatNodeDuration(1000)).toBe("1s");
		expect(formatNodeDuration(45_000)).toBe("45s");
		expect(formatNodeDuration(133_000)).toBe("2m 13s");
	});

	test("corrupt values read as unknown, not as a fast call", () => {
		expect(formatNodeDuration(-5)).toBe(DURATION_UNKNOWN);
		expect(formatNodeDuration(Number.NaN)).toBe(DURATION_UNKNOWN);
		expect(formatNodeDuration(Number.POSITIVE_INFINITY)).toBe(DURATION_UNKNOWN);
	});
});

describe("labels", () => {
	test("every node kind has a human label", () => {
		expect(Object.keys(KIND_LABEL).sort()).toEqual([
			"assistant",
			"error",
			"prompt",
			"subagent",
			"thinking",
			"tool",
		]);
	});

	test("every status has a human label", () => {
		expect(Object.keys(STATUS_LABEL).sort()).toEqual(["error", "interrupted", "running", "success"]);
	});

	test("nodeTitle prefers the untruncated fullLabel", () => {
		expect(nodeTitle(node({ label: "Add a lo…", fullLabel: "Add a login page please" }))).toBe(
			"Add a login page please",
		);
	});

	test("nodeTitle falls back to label when nothing was truncated", () => {
		expect(nodeTitle(node({ label: "short" }))).toBe("short");
	});
});

describe("nodeAction", () => {
	test("a leaf node only shows details", () => {
		expect(nodeAction(node({ kind: "tool" }))).toBe("Shows details.");
	});

	test("a drillable prompt announces the drill-in", () => {
		expect(nodeAction(node({ drillable: true }))).toBe("Opens this turn's trace.");
	});

	test("a drillable subagent announces the sub-graph", () => {
		expect(nodeAction(node({ kind: "subagent", drillable: true }))).toBe("Opens this sub-agent's graph.");
	});
});

describe("labelFadeStart", () => {
	test("the fade occupies the last LABEL_FADE_PX of the text area", () => {
		// 146 is the real text width for the default 168px node box.
		expect(labelFadeStart(146)).toBeCloseTo((146 - LABEL_FADE_PX) / 146, 10);
		expect(labelFadeStart(146) * 146).toBeCloseTo(146 - LABEL_FADE_PX, 10);
	});

	test("a text area no wider than the fade fades from its very start", () => {
		// A negative stop offset is invalid SVG, so the degenerate case clamps.
		expect(labelFadeStart(LABEL_FADE_PX)).toBe(0);
		expect(labelFadeStart(4)).toBe(0);
		expect(labelFadeStart(0)).toBe(0);
	});

	test("every offset it returns is a valid SVG stop", () => {
		for (const w of [0, 1, LABEL_FADE_PX, 25, 100, 146, 1000]) {
			const stop = labelFadeStart(w);
			expect(stop).toBeGreaterThanOrEqual(0);
			expect(stop).toBeLessThan(1);
		}
	});
});

describe("nodeAriaLabel", () => {
	test("names the kind, the full label, the status and the action", () => {
		const label = nodeAriaLabel(node({ kind: "prompt", drillable: true, label: "Add a…", fullLabel: "Add a login" }));
		expect(label).toBe("Prompt: Add a login, succeeded. Opens this turn's trace.");
	});

	test("includes the duration when it is known", () => {
		expect(nodeAriaLabel(node({ kind: "tool", status: "error", durationMs: 1500 }))).toBe(
			"Tool: Add a login page, failed, 1s. Shows details.",
		);
	});

	test("omits the duration entirely when unknown — no em dash in speech", () => {
		const label = nodeAriaLabel(node({ kind: "tool" }));
		expect(label).not.toContain(DURATION_UNKNOWN);
		expect(label).toBe("Tool: Add a login page, succeeded. Shows details.");
	});

	test("a corrupt duration is unknown in speech too, not a spoken dash", () => {
		// These render as an em dash on the node box. Reading "em dash" out is
		// worse than saying nothing, so the aria label drops them.
		for (const durationMs of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(nodeAriaLabel(node({ kind: "tool", durationMs }))).toBe(
				"Tool: Add a login page, succeeded. Shows details.",
			);
		}
	});

	test("speaks the rewound-away state, which is otherwise colour-only", () => {
		expect(nodeAriaLabel(node({ excluded: true }))).toContain("rewound away");
	});

	test("does not claim rewound-away for a live node", () => {
		expect(nodeAriaLabel(node({ excluded: false }))).not.toContain("rewound");
	});
});

describe("edgeDashArray", () => {
	test("spawn edges are dashed — they leave the conversation", () => {
		expect(edgeDashArray("spawn")).toBe("6 4");
	});

	test("sequence and branch edges are solid", () => {
		expect(edgeDashArray("sequence")).toBe("none");
		expect(edgeDashArray("branch")).toBe("none");
	});
});

describe("isActivationKey", () => {
	test("Enter and Space activate, like a native button", () => {
		expect(isActivationKey("Enter")).toBe(true);
		expect(isActivationKey(" ")).toBe(true);
	});

	test("other keys do not", () => {
		expect(isActivationKey("a")).toBe(false);
		expect(isActivationKey("Escape")).toBe(false);
	});
});

describe("moveFocus", () => {
	// rank 0: a
	// rank 1: b (x 0), c (x 200)
	// rank 2: d (x 100)
	const nodes: NavNode[] = [
		{ id: "a", x: 100, width: 168, rank: 0 },
		{ id: "b", x: 0, width: 168, rank: 1 },
		{ id: "c", x: 200, width: 168, rank: 1 },
		{ id: "d", x: 100, width: 168, rank: 2 },
	];

	test("an empty graph has nowhere to go", () => {
		expect(moveFocus([], null, "ArrowDown")).toBeNull();
	});

	test("a non-navigation key is left alone", () => {
		expect(moveFocus(nodes, "a", "x")).toBeNull();
		expect(moveFocus(nodes, "a", "Enter")).toBeNull();
	});

	test("Home and End jump to the ends of layout order", () => {
		expect(moveFocus(nodes, "c", "Home")).toBe("a");
		expect(moveFocus(nodes, "a", "End")).toBe("d");
	});

	test("Home works with nothing focused yet", () => {
		expect(moveFocus(nodes, null, "Home")).toBe("a");
	});

	test("no current node focuses the first one", () => {
		expect(moveFocus(nodes, null, "ArrowDown")).toBe("a");
	});

	test("an unknown current node focuses the first one", () => {
		expect(moveFocus(nodes, "ghost", "ArrowRight")).toBe("a");
	});

	test("left/right step within the row", () => {
		expect(moveFocus(nodes, "b", "ArrowRight")).toBe("c");
		expect(moveFocus(nodes, "c", "ArrowLeft")).toBe("b");
	});

	test("left/right clamp at the row ends instead of wrapping", () => {
		expect(moveFocus(nodes, "c", "ArrowRight")).toBe("c");
		expect(moveFocus(nodes, "b", "ArrowLeft")).toBe("b");
	});

	test("down lands on the nearest node by centre in the next row", () => {
		// a's centre is 184; b's is 84, c's is 284 — equidistant, so the first
		// (leftmost, since strict < keeps the earlier one) wins.
		expect(moveFocus(nodes, "a", "ArrowDown")).toBe("b");
		expect(moveFocus(nodes, "c", "ArrowDown")).toBe("d");
	});

	test("up lands on the nearest node by centre in the previous row", () => {
		expect(moveFocus(nodes, "d", "ArrowUp")).toBe("b");
		expect(moveFocus(nodes, "b", "ArrowUp")).toBe("a");
	});

	test("up/down clamp at the top and bottom rows", () => {
		expect(moveFocus(nodes, "a", "ArrowUp")).toBe("a");
		expect(moveFocus(nodes, "d", "ArrowDown")).toBe("d");
	});

	test("picks the strictly nearer of two candidates", () => {
		const offset: NavNode[] = [
			{ id: "top", x: 0, width: 100, rank: 0 },
			{ id: "far", x: 500, width: 100, rank: 1 },
			{ id: "near", x: 20, width: 100, rank: 1 },
		];
		expect(moveFocus(offset, "top", "ArrowDown")).toBe("near");
	});

	test("a single-node graph clamps in every direction", () => {
		const one: NavNode[] = [{ id: "only", x: 0, width: 10, rank: 0 }];
		for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
			expect(moveFocus(one, "only", key)).toBe("only");
		}
	});
});

describe("zoom", () => {
	test("clamps to the readable range", () => {
		expect(clampZoom(0.01)).toBe(ZOOM_MIN);
		expect(clampZoom(99)).toBe(ZOOM_MAX);
		expect(clampZoom(1)).toBe(1);
	});

	test("zoomBy multiplies then clamps", () => {
		expect(zoomBy(1, ZOOM_STEP)).toBeCloseTo(1.2, 10);
		expect(zoomBy(ZOOM_MAX, ZOOM_STEP)).toBe(ZOOM_MAX);
		expect(zoomBy(ZOOM_MIN, 1 / ZOOM_STEP)).toBe(ZOOM_MIN);
	});

	test("wheel up zooms in, wheel down zooms out", () => {
		expect(wheelZoomFactor(-120)).toBe(ZOOM_STEP);
		expect(wheelZoomFactor(120)).toBe(1 / ZOOM_STEP);
		expect(wheelZoomFactor(0)).toBe(1 / ZOOM_STEP);
	});
});

describe("legendSections", () => {
	test("covers every node kind the canvas can draw", () => {
		const node = legendSections().find((s) => s.title === "Node");
		expect(node?.sample).toBe("bar");
		expect(node?.items.map((i) => i.id).sort()).toEqual(
			Object.keys(KIND_LABEL).sort(),
		);
	});

	test("covers every status the canvas can draw", () => {
		const status = legendSections().find((s) => s.title === "Status");
		expect(status?.sample).toBe("dot");
		expect(status?.items.map((i) => i.id).sort()).toEqual(
			Object.keys(STATUS_LABEL).sort(),
		);
	});

	test("covers every edge kind, plus the rewound-away node state", () => {
		const link = legendSections().find((s) => s.title === "Link");
		expect(link?.sample).toBe("line");
		const ids = link?.items.map((i) => i.id) ?? [];
		for (const kind of Object.keys(EDGE_LABEL)) expect(ids).toContain(kind);
		// Not an edge kind — a node state that reads as a line style.
		expect(ids).toContain("excluded");
	});

	test("labels come from the shared maps, so the key cannot drift from the graph", () => {
		const sections = legendSections();
		const node = sections.find((s) => s.title === "Node");
		expect(node?.items.find((i) => i.id === "subagent")?.label).toBe(KIND_LABEL.subagent);
		const status = sections.find((s) => s.title === "Status");
		expect(status?.items.find((i) => i.id === "running")?.label).toBe(STATUS_LABEL.running);
		const link = sections.find((s) => s.title === "Link");
		expect(link?.items.find((i) => i.id === "spawn")?.label).toBe(EDGE_LABEL.spawn);
	});

	test("every item has a non-empty label and a unique id within its section", () => {
		for (const section of legendSections()) {
			expect(section.items.length).toBeGreaterThan(0);
			for (const item of section.items) expect(item.label.length).toBeGreaterThan(0);
			expect(new Set(section.items.map((i) => i.id)).size).toBe(section.items.length);
		}
	});

	test("is pure — repeated calls deep-equal", () => {
		expect(legendSections()).toEqual(legendSections());
	});
});

describe("nodeDetailCard", () => {
	test("the glance splits kind from meta so the kind can be colour-coded", () => {
		const card = nodeDetailCard(node({ kind: "tool", status: "success", durationMs: 840 }));
		expect(card.kind).toBe("tool");
		expect(card.kindLabel).toBe("Tool");
		expect(card.meta).toBe("succeeded · 840ms");
	});

	test("every kind reports itself, so the heading colour can never be wrong", () => {
		for (const kind of Object.keys(KIND_LABEL) as (keyof typeof KIND_LABEL)[]) {
			const card = nodeDetailCard(node({ kind }));
			expect(card.kind).toBe(kind);
			expect(card.kindLabel).toBe(KIND_LABEL[kind]);
		}
	});

	test("meta omits an unknown duration rather than showing a dash", () => {
		const card = nodeDetailCard(node({ kind: "prompt", status: "success" }));
		expect(card.meta).toBe("succeeded");
		expect(card.meta).not.toContain(DURATION_UNKNOWN);
	});

	test("a tool names its owner, translating the builtin sentinel", () => {
		const builtin = nodeDetailCard(node({ kind: "tool", extensionId: "builtin" }));
		expect(builtin.rows).toContainEqual({ term: "Provided by", value: "Built-in" });
		const ext = nodeDetailCard(node({ kind: "tool", extensionId: "web-search" }));
		expect(ext.rows).toContainEqual({ term: "Provided by", value: "web-search" });
	});

	test("a sub-agent surfaces the chat it opens", () => {
		const card = nodeDetailCard(
			node({ kind: "subagent", subConversationId: "sub-42", drillable: true }),
		);
		expect(card.rows).toContainEqual({ term: "Sub-chat", value: "sub-42" });
		expect(card.hint).toBeTruthy();
	});

	test("the Started row carries the RAW iso — formatting is the component's job", () => {
		const iso = "2026-07-26T10:00:03.000Z";
		const card = nodeDetailCard(node({ createdAt: iso }));
		expect(card.rows).toContainEqual({ term: "Started", value: iso });
	});

	test("an unknown duration still gets a row, showing the em dash", () => {
		const card = nodeDetailCard(node({ kind: "prompt" }));
		expect(card.rows).toContainEqual({ term: "Duration", value: DURATION_UNKNOWN });
	});

	test("a turn's duration is labelled 'Took' — it is an elapsed span, not a tool time", () => {
		const card = nodeDetailCard(
			node({ durationMs: 5000, stats: { replies: 2, toolCalls: 3, subAgents: 1, thinking: 1 } }),
		);
		expect(card.rows).toContainEqual({ term: "Took", value: "5s" });
		expect(card.rows.find((r) => r.term === "Duration")).toBeUndefined();
	});

	test("a turn breaks down what it contains", () => {
		const card = nodeDetailCard(
			node({ stats: { replies: 2, toolCalls: 3, subAgents: 1, thinking: 4 } }),
		);
		expect(card.rows).toContainEqual({ term: "Replies", value: "2" });
		expect(card.rows).toContainEqual({ term: "Tool calls", value: "3" });
		expect(card.rows).toContainEqual({ term: "Sub-agents", value: "1" });
		expect(card.rows).toContainEqual({ term: "Thinking steps", value: "4" });
	});

	test("zero counts are dropped, so a simple turn reads as a shorter card", () => {
		const card = nodeDetailCard(
			node({ stats: { replies: 1, toolCalls: 0, subAgents: 0, thinking: 0 } }),
		);
		expect(card.rows).toContainEqual({ term: "Replies", value: "1" });
		for (const term of ["Tool calls", "Sub-agents", "Thinking steps"]) {
			expect(card.rows.find((r) => r.term === term)).toBeUndefined();
		}
	});

	test("replies is shown even at zero — a turn that produced nothing is news", () => {
		const card = nodeDetailCard(
			node({ stats: { replies: 0, toolCalls: 0, subAgents: 0, thinking: 0 } }),
		);
		expect(card.rows).toContainEqual({ term: "Replies", value: "0" });
	});

	test("a node with no stats gets no breakdown rows at all", () => {
		const card = nodeDetailCard(node({ kind: "tool" }));
		for (const term of ["Replies", "Tool calls", "Sub-agents", "Thinking steps"]) {
			expect(card.rows.find((r) => r.term === term)).toBeUndefined();
		}
	});

	test("a rewound-away node says so in words, not only in colour", () => {
		const card = nodeDetailCard(node({ excluded: true }));
		expect(card.rows.find((r) => r.term === "Branch")?.value).toContain("Rewound away");
		expect(nodeDetailCard(node({})).rows.find((r) => r.term === "Branch")).toBeUndefined();
	});

	test("prose kinds get a body; name-like kinds do not repeat their title", () => {
		for (const kind of ["prompt", "assistant", "thinking", "error"] as const) {
			expect(nodeDetailCard(node({ kind, label: "x", fullLabel: "the whole thing" })).body).toBe(
				"the whole thing",
			);
		}
		for (const kind of ["tool", "subagent"] as const) {
			expect(nodeDetailCard(node({ kind, label: "read_file" })).body).toBeUndefined();
		}
	});

	test("no body when nothing was truncated — the title already shows it all", () => {
		// Rendering the identical string as both title and body reads as a
		// duplication bug; the body exists only to reveal what truncation hid.
		expect(nodeDetailCard(node({ kind: "prompt", label: "short" })).body).toBeUndefined();
		expect(
			nodeDetailCard(node({ kind: "prompt", label: "short", fullLabel: "short" })).body,
		).toBeUndefined();
	});

	test("hint appears only for drillable nodes", () => {
		expect(nodeDetailCard(node({ drillable: true })).hint).toBeTruthy();
		expect(nodeDetailCard(node({ drillable: false })).hint).toBeUndefined();
		expect(nodeDetailCard(node({})).hint).toBeUndefined();
	});

	test("title is the truncated label, so the card header matches the node box", () => {
		expect(nodeDetailCard(node({ label: "trunc…", fullLabel: "truncated all the way" })).title).toBe(
			"trunc…",
		);
	});
});

describe("KIND_ICON", () => {
	test("every kind the canvas can draw has an icon", () => {
		expect(Object.keys(KIND_ICON).sort()).toEqual(Object.keys(KIND_LABEL).sort());
	});

	test("each is a non-empty SVG path starting with a move command", () => {
		for (const [kind, d] of Object.entries(KIND_ICON)) {
			expect(d.length, kind).toBeGreaterThan(0);
			expect(d.startsWith("M"), kind).toBe(true);
		}
	});

	test("no two kinds share a drawing", () => {
		expect(new Set(Object.values(KIND_ICON)).size).toBe(Object.keys(KIND_ICON).length);
	});
});

describe("formatTokens", () => {
	test("counts below 1k are exact", () => {
		expect(formatTokens(0)).toBe("0");
		expect(formatTokens(980)).toBe("980");
		expect(formatTokens(999)).toBe("999");
	});

	test("one decimal below 10k", () => {
		expect(formatTokens(1000)).toBe("1.0k");
		expect(formatTokens(1234)).toBe("1.2k");
		expect(formatTokens(9949)).toBe("9.9k");
	});

	test("no decimal at 10k and above — it is noise at that size", () => {
		expect(formatTokens(10_000)).toBe("10k");
		expect(formatTokens(12_345)).toBe("12k");
		expect(formatTokens(1_200_000)).toBe("1200k");
	});
});

describe("formatTokenLine", () => {
	const stats = { replies: 1, toolCalls: 0, subAgents: 0, thinking: 0 };

	test("reads in / out / total on one line", () => {
		expect(formatTokenLine({ ...stats, inputTokens: 1234, outputTokens: 450 })).toBe(
			"1.2k in · 450 out · 1.7k total",
		);
	});

	test("a turn that recorded no usage gets no line — unmeasured is not free", () => {
		expect(formatTokenLine(stats)).toBeUndefined();
		expect(formatTokenLine(undefined)).toBeUndefined();
	});

	test("one side recorded is enough; the other counts as zero", () => {
		expect(formatTokenLine({ ...stats, inputTokens: 500 })).toBe("500 in · 0 out · 500 total");
		expect(formatTokenLine({ ...stats, outputTokens: 20 })).toBe("0 in · 20 out · 20 total");
	});

	test("a genuine zero still reports, since it WAS measured", () => {
		expect(formatTokenLine({ ...stats, inputTokens: 0, outputTokens: 0 })).toBe(
			"0 in · 0 out · 0 total",
		);
	});
});

describe("nodeDetailCard tokens", () => {
	test("a turn with usage gets the one-liner", () => {
		const card = nodeDetailCard(
			node({
				stats: { replies: 1, toolCalls: 0, subAgents: 0, thinking: 0, inputTokens: 1200, outputTokens: 300 },
			}),
		);
		expect(card.rows).toContainEqual({ term: "Tokens", value: "1.2k in · 300 out · 1.5k total" });
	});

	test("a turn without usage gets no Tokens row at all", () => {
		const card = nodeDetailCard(
			node({ stats: { replies: 1, toolCalls: 0, subAgents: 0, thinking: 0 } }),
		);
		expect(card.rows.find((r) => r.term === "Tokens")).toBeUndefined();
	});
});
