/**
 * DOM tests for ContextUsageIndicator.svelte. Runs under vitest with the
 * Svelte plugin + jsdom. The pure-logic branches are covered by
 * `context-usage-logic.test.ts`; this file asserts the actual DOM output
 * for each visual state (hidden, muted, warn, danger).
 */

import { render, cleanup, fireEvent } from "@testing-library/svelte";
import { describe, test, expect, afterEach } from "vitest";
import ContextUsageIndicator from "./ContextUsageIndicator.svelte";
import type { ContextBreakdown, ToolBreakdownEntry } from "$lib/context-usage-logic";

afterEach(() => cleanup());

describe("ContextUsageIndicator", () => {
	test("renders nothing when usedTokens is null", () => {
		const { queryByTestId } = render(ContextUsageIndicator, {
			usedTokens: null,
			contextWindow: 200_000,
		});
		expect(queryByTestId("context-usage-indicator")).toBeNull();
	});

	test("renders nothing when contextWindow is null", () => {
		const { queryByTestId } = render(ContextUsageIndicator, {
			usedTokens: 5_000,
			contextWindow: null,
		});
		expect(queryByTestId("context-usage-indicator")).toBeNull();
	});

	test("renders nothing when contextWindow is zero", () => {
		const { queryByTestId } = render(ContextUsageIndicator, {
			usedTokens: 5_000,
			contextWindow: 0,
		});
		expect(queryByTestId("context-usage-indicator")).toBeNull();
	});

	test("renders percent + bar width with muted tone under 70%", () => {
		const { getByTestId } = render(ContextUsageIndicator, {
			usedTokens: 50_000,
			contextWindow: 200_000,
		});
		const pill = getByTestId("context-usage-indicator");
		expect(pill.getAttribute("data-tone")).toBe("muted");
		expect(getByTestId("context-usage-pct").textContent).toBe("25%");
		expect(getByTestId("context-usage-bar").getAttribute("style")).toContain("width: 25");
	});

	test("applies warn tone at 70%", () => {
		const { getByTestId } = render(ContextUsageIndicator, {
			usedTokens: 140_000,
			contextWindow: 200_000,
		});
		expect(getByTestId("context-usage-indicator").getAttribute("data-tone")).toBe("warn");
		expect(getByTestId("context-usage-pct").textContent).toBe("70%");
	});

	test("applies danger tone at 90%", () => {
		const { getByTestId } = render(ContextUsageIndicator, {
			usedTokens: 180_000,
			contextWindow: 200_000,
		});
		expect(getByTestId("context-usage-indicator").getAttribute("data-tone")).toBe("danger");
		expect(getByTestId("context-usage-pct").textContent).toBe("90%");
	});

	test("clamps percent at 100% when overflow", () => {
		const { getByTestId } = render(ContextUsageIndicator, {
			usedTokens: 500_000,
			contextWindow: 200_000,
		});
		expect(getByTestId("context-usage-pct").textContent).toBe("100%");
		expect(getByTestId("context-usage-bar").getAttribute("style")).toContain("width: 100");
	});

	test("aria-label reflects the rounded percentage", () => {
		const { getByTestId } = render(ContextUsageIndicator, {
			usedTokens: 66_666,
			contextWindow: 200_000,
		});
		// 66666/200000 = 33.33% → rounded to 33
		expect(getByTestId("context-usage-indicator").getAttribute("aria-label")).toBe("Context used: 33 percent");
	});

	test("popover is hidden until the indicator is hovered", () => {
		const { queryByTestId } = render(ContextUsageIndicator, {
			usedTokens: 50_000,
			contextWindow: 200_000,
		});
		expect(queryByTestId("context-usage-popover")).toBeNull();
	});

	test("hovering reveals the popover with breakdown rows", async () => {
		const breakdown: ContextBreakdown = {
			inputTokens: 8_000,
			outputTokens: 2_000,
			toolTokens: 1_500,
			totalTokens: 10_000,
			pctInput: 80,
			pctOutput: 20,
			pctTools: 15,
		};
		const { getByTestId } = render(ContextUsageIndicator, {
			usedTokens: 8_000,
			contextWindow: 200_000,
			breakdown,
		});

		// Trigger is the parent wrapper around the indicator pill.
		const trigger = getByTestId("context-usage-indicator").parentElement!;
		await fireEvent.mouseEnter(trigger);

		expect(getByTestId("context-usage-popover")).not.toBeNull();
		expect(getByTestId("ctx-bd-input").textContent).toContain("8.0k");
		expect(getByTestId("ctx-bd-input").textContent).toContain("80.0%");
		expect(getByTestId("ctx-bd-output").textContent).toContain("2.0k");
		expect(getByTestId("ctx-bd-output").textContent).toContain("20.0%");
		expect(getByTestId("ctx-bd-total").textContent).toContain("10k");
		expect(getByTestId("ctx-bd-tools").textContent).toContain("1.5k");
		expect(getByTestId("ctx-bd-tools").textContent).toContain("15.0%");
	});

	test("renders one top-level row per extension/MCP — function pills appear only on expand", async () => {
		// Two functions of one extension must collapse into ONE top-level row
		// labeled by the extension name. The function pills only show up
		// after the user expands that row.
		const breakdown: ContextBreakdown = {
			inputTokens: 8_000,
			outputTokens: 2_000,
			toolTokens: 1_500,
			totalTokens: 10_000,
			pctInput: 80,
			pctOutput: 20,
			pctTools: 15,
		};
		const toolBreakdown: ToolBreakdownEntry[] = [
			{
				extensionName: "playwright",
				toolName: "browser_click",
				callCount: 3,
				tokens: 800,
				pct: 8,
				calls: [
					{ tokens: 400, pct: 4, preview: "btn1" },
					{ tokens: 250, pct: 2.5, preview: "btn2" },
					{ tokens: 150, pct: 1.5, preview: "btn3" },
				],
			},
			{
				extensionName: "playwright",
				toolName: "browser_navigate",
				callCount: 1,
				tokens: 200,
				pct: 2,
				calls: [{ tokens: 200, pct: 2, preview: "https://example.com" }],
			},
		];
		const { getByTestId, getAllByTestId, queryByTestId } = render(ContextUsageIndicator, {
			usedTokens: 8_000,
			contextWindow: 200_000,
			breakdown,
			toolBreakdown,
		});

		await fireEvent.mouseEnter(getByTestId("context-usage-indicator").parentElement!);

		const rows = getAllByTestId("ctx-bd-tool-row");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.getAttribute("data-tool")).toBe("playwright");
		expect(rows[0]?.getAttribute("data-ext")).toBe("playwright");
		// Top-level pill shows ONLY the extension/tool name.
		const pill = rows[0]?.querySelector('[data-testid="ctx-bd-tool-pill"]');
		expect(pill?.textContent?.trim()).toBe("playwright");
		// Sum of the two functions' tokens (800 + 200 = 1000 → "1.0k") and call counts (×4).
		expect(rows[0]?.textContent).toContain("1.0k");
		expect(rows[0]?.textContent).toContain("×4");
		expect(getByTestId("ctx-bd-tool-fn-count").textContent).toContain("2 fn");
		// Function pills are NOT visible until the row is expanded.
		expect(queryByTestId("ctx-bd-fn-list")).toBeNull();
		expect(queryByTestId("ctx-bd-fn-pill")).toBeNull();
	});

	test("expanding an extension row reveals the function rows with tokens + %", async () => {
		const breakdown: ContextBreakdown = {
			inputTokens: 8_000,
			outputTokens: 2_000,
			toolTokens: 1_500,
			totalTokens: 10_000,
			pctInput: 80,
			pctOutput: 20,
			pctTools: 15,
		};
		const toolBreakdown: ToolBreakdownEntry[] = [
			{
				extensionName: "playwright",
				toolName: "browser_click",
				callCount: 2,
				tokens: 800,
				pct: 8,
				calls: [
					{ tokens: 500, pct: 5, preview: "btn1" },
					{ tokens: 300, pct: 3, preview: "btn2" },
				],
			},
			{
				extensionName: "playwright",
				toolName: "browser_navigate",
				callCount: 1,
				tokens: 200,
				pct: 2,
				calls: [{ tokens: 200, pct: 2, preview: "https://example.com" }],
			},
		];
		const { getByTestId, getAllByTestId, queryByTestId } = render(ContextUsageIndicator, {
			usedTokens: 8_000,
			contextWindow: 200_000,
			breakdown,
			toolBreakdown,
		});

		await fireEvent.mouseEnter(getByTestId("context-usage-indicator").parentElement!);
		await fireEvent.click(getByTestId("ctx-bd-tool-row"));

		// Function level appears, sorted by tokens desc.
		const fnRows = getAllByTestId("ctx-bd-fn-row");
		expect(fnRows).toHaveLength(2);
		expect(fnRows[0]?.getAttribute("data-fn")).toBe("browser_click");
		expect(fnRows[0]?.textContent).toContain("browser_click");
		expect(fnRows[0]?.textContent).toContain("×2");
		expect(fnRows[0]?.textContent).toContain("8.0%");
		expect(fnRows[1]?.getAttribute("data-fn")).toBe("browser_navigate");
		expect(fnRows[1]?.textContent).not.toContain("×"); // single call

		// Per-call detail still hidden until a function row is clicked.
		expect(queryByTestId("ctx-bd-call-list")).toBeNull();
	});

	test("expanding a function row reveals its per-call previews", async () => {
		const breakdown: ContextBreakdown = {
			inputTokens: 8_000,
			outputTokens: 2_000,
			toolTokens: 1_500,
			totalTokens: 10_000,
			pctInput: 80,
			pctOutput: 20,
			pctTools: 15,
		};
		const toolBreakdown: ToolBreakdownEntry[] = [
			{
				extensionName: "fs",
				toolName: "read_file",
				callCount: 3,
				tokens: 1_000,
				pct: 10,
				calls: [
					{ tokens: 500, pct: 5, preview: "/big" },
					{ tokens: 300, pct: 3, preview: "/medium" },
					{ tokens: 200, pct: 2, preview: "/small" },
				],
			},
		];
		const { getByTestId, getAllByTestId, queryByTestId } = render(ContextUsageIndicator, {
			usedTokens: 8_000,
			contextWindow: 200_000,
			breakdown,
			toolBreakdown,
		});

		await fireEvent.mouseEnter(getByTestId("context-usage-indicator").parentElement!);
		await fireEvent.click(getByTestId("ctx-bd-tool-row"));
		await fireEvent.click(getByTestId("ctx-bd-fn-row"));

		const callRows = getAllByTestId("ctx-bd-call-row");
		expect(callRows).toHaveLength(3);
		expect(callRows[0]?.textContent).toContain("/big");
		expect(callRows[0]?.textContent).toContain("500");
		expect(callRows[0]?.textContent).toContain("5.0%");
		expect(callRows[1]?.textContent).toContain("/medium");
		expect(callRows[2]?.textContent).toContain("/small");

		// Collapse function: calls go away, function row stays visible.
		await fireEvent.click(getByTestId("ctx-bd-fn-row"));
		expect(queryByTestId("ctx-bd-call-list")).toBeNull();
		expect(getByTestId("ctx-bd-fn-row")).not.toBeNull();
	});

	test("built-in tools (no extension) skip the function level — expand jumps straight to calls", async () => {
		// Built-ins are one-tool-per-group, so an extra function-level click
		// would be pure noise. The popover must skip it.
		const breakdown: ContextBreakdown = {
			inputTokens: 1_000,
			outputTokens: 0,
			toolTokens: 100,
			totalTokens: 1_000,
			pctInput: 100,
			pctOutput: 0,
			pctTools: 10,
		};
		const toolBreakdown: ToolBreakdownEntry[] = [
			{
				extensionName: "",
				toolName: "Bash",
				callCount: 2,
				tokens: 100,
				pct: 10,
				calls: [
					{ tokens: 60, pct: 6, preview: "ls -la" },
					{ tokens: 40, pct: 4, preview: "pwd" },
				],
			},
		];
		const { getByTestId, getAllByTestId, queryByTestId } = render(ContextUsageIndicator, {
			usedTokens: 1_000,
			contextWindow: 200_000,
			breakdown,
			toolBreakdown,
		});

		await fireEvent.mouseEnter(getByTestId("context-usage-indicator").parentElement!);

		const row = getByTestId("ctx-bd-tool-row");
		expect(row.getAttribute("data-tool")).toBe("Bash");
		expect(row.getAttribute("data-ext")).toBe("");
		// "x fns" badge is hidden for built-ins (would be misleading: there's only one).
		expect(queryByTestId("ctx-bd-tool-fn-count")).toBeNull();
		// Top-level pill still shows the tool name.
		expect(getByTestId("ctx-bd-tool-pill").textContent?.trim()).toBe("Bash");

		await fireEvent.click(row);

		// No function level — go directly to calls.
		expect(queryByTestId("ctx-bd-fn-list")).toBeNull();
		expect(queryByTestId("ctx-bd-fn-row")).toBeNull();
		const callRows = getAllByTestId("ctx-bd-call-row");
		expect(callRows).toHaveLength(2);
		expect(callRows[0]?.textContent).toContain("ls -la");
		expect(callRows[1]?.textContent).toContain("pwd");
	});

	test("multiple built-ins each get their OWN top-level row (do not collapse together)", async () => {
		const breakdown: ContextBreakdown = {
			inputTokens: 1_000,
			outputTokens: 0,
			toolTokens: 300,
			totalTokens: 1_000,
			pctInput: 100,
			pctOutput: 0,
			pctTools: 30,
		};
		const toolBreakdown: ToolBreakdownEntry[] = [
			{ extensionName: "", toolName: "Bash", callCount: 1, tokens: 150, pct: 15, calls: [{ tokens: 150, pct: 15, preview: "ls" }] },
			{ extensionName: "", toolName: "Read", callCount: 1, tokens: 100, pct: 10, calls: [{ tokens: 100, pct: 10, preview: "/foo" }] },
			{ extensionName: "", toolName: "Edit", callCount: 1, tokens: 50, pct: 5, calls: [{ tokens: 50, pct: 5, preview: "/foo" }] },
		];
		const { getByTestId, getAllByTestId } = render(ContextUsageIndicator, {
			usedTokens: 1_000,
			contextWindow: 200_000,
			breakdown,
			toolBreakdown,
		});

		await fireEvent.mouseEnter(getByTestId("context-usage-indicator").parentElement!);
		const rows = getAllByTestId("ctx-bd-tool-row");
		expect(rows).toHaveLength(3);
		expect(rows.map((r) => r.getAttribute("data-tool"))).toEqual(["Bash", "Read", "Edit"]);
		// Each row's pill is the built-in name (not an extension name).
		const pills = rows.map((r) => r.querySelector('[data-testid="ctx-bd-tool-pill"]')?.textContent?.trim());
		expect(pills).toEqual(["Bash", "Read", "Edit"]);
	});

	test("collapses GROUPS beyond the row limit into a +N more footer", async () => {
		// Top-level limit applies to tool/extension groups, not functions.
		// Use 9 distinct extensions so each becomes its own group.
		const breakdown: ContextBreakdown = {
			inputTokens: 8_000,
			outputTokens: 2_000,
			toolTokens: 4_000,
			totalTokens: 10_000,
			pctInput: 80,
			pctOutput: 20,
			pctTools: 40,
		};
		const toolBreakdown: ToolBreakdownEntry[] = Array.from({ length: 9 }, (_, i) => ({
			extensionName: `ext${i}`,
			toolName: "fn",
			callCount: 1,
			tokens: 500 - i,
			pct: 5,
			calls: [{ tokens: 500 - i, pct: 5, preview: `call${i}` }],
		}));
		const { getByTestId, getAllByTestId } = render(ContextUsageIndicator, {
			usedTokens: 8_000,
			contextWindow: 200_000,
			breakdown,
			toolBreakdown,
		});

		await fireEvent.mouseEnter(getByTestId("context-usage-indicator").parentElement!);

		expect(getAllByTestId("ctx-bd-tool-row")).toHaveLength(6);
		expect(getByTestId("ctx-bd-tool-overflow").textContent).toContain("+3 more");
	});

	test("collapses FUNCTIONS beyond the row limit inside an expanded group", async () => {
		// Within a single extension, more than FUNC_ROW_LIMIT functions
		// must spill into a "+N more fns" footer once the group is open.
		const breakdown: ContextBreakdown = {
			inputTokens: 8_000,
			outputTokens: 2_000,
			toolTokens: 4_000,
			totalTokens: 10_000,
			pctInput: 80,
			pctOutput: 20,
			pctTools: 40,
		};
		const toolBreakdown: ToolBreakdownEntry[] = Array.from({ length: 9 }, (_, i) => ({
			extensionName: "playwright",
			toolName: `browser_fn${i}`,
			callCount: 1,
			tokens: 500 - i,
			pct: 5,
			calls: [{ tokens: 500 - i, pct: 5, preview: `call${i}` }],
		}));
		const { getByTestId, getAllByTestId } = render(ContextUsageIndicator, {
			usedTokens: 8_000,
			contextWindow: 200_000,
			breakdown,
			toolBreakdown,
		});

		await fireEvent.mouseEnter(getByTestId("context-usage-indicator").parentElement!);
		// One top-level row only — all 9 functions roll under it.
		expect(getAllByTestId("ctx-bd-tool-row")).toHaveLength(1);

		await fireEvent.click(getByTestId("ctx-bd-tool-row"));
		expect(getAllByTestId("ctx-bd-fn-row")).toHaveLength(6);
		expect(getByTestId("ctx-bd-fn-overflow").textContent).toContain("+3 more fns");
	});

	test("clicking an extension row twice collapses it back (toggle)", async () => {
		const breakdown: ContextBreakdown = {
			inputTokens: 8_000,
			outputTokens: 2_000,
			toolTokens: 1_500,
			totalTokens: 10_000,
			pctInput: 80,
			pctOutput: 20,
			pctTools: 15,
		};
		const toolBreakdown: ToolBreakdownEntry[] = [
			{
				extensionName: "fs",
				toolName: "read_file",
				callCount: 1,
				tokens: 1_000,
				pct: 10,
				calls: [{ tokens: 1_000, pct: 10, preview: "/foo" }],
			},
		];
		const { getByTestId, queryByTestId } = render(ContextUsageIndicator, {
			usedTokens: 8_000,
			contextWindow: 200_000,
			breakdown,
			toolBreakdown,
		});

		await fireEvent.mouseEnter(getByTestId("context-usage-indicator").parentElement!);
		const row = getByTestId("ctx-bd-tool-row");
		expect(row.getAttribute("aria-expanded")).toBe("false");
		expect(queryByTestId("ctx-bd-fn-list")).toBeNull();

		await fireEvent.click(row);
		expect(row.getAttribute("aria-expanded")).toBe("true");
		expect(queryByTestId("ctx-bd-fn-list")).not.toBeNull();

		await fireEvent.click(row);
		expect(row.getAttribute("aria-expanded")).toBe("false");
		expect(queryByTestId("ctx-bd-fn-list")).toBeNull();
	});

	test("expanded per-call list (under a function) collapses excess calls into a +N more footer", async () => {
		const breakdown: ContextBreakdown = {
			inputTokens: 8_000,
			outputTokens: 2_000,
			toolTokens: 5_000,
			totalTokens: 10_000,
			pctInput: 80,
			pctOutput: 20,
			pctTools: 50,
		};
		const calls = Array.from({ length: 12 }, (_, i) => ({
			tokens: 1_000 - i,
			pct: 1,
			preview: `call${i}`,
		}));
		const toolBreakdown: ToolBreakdownEntry[] = [
			{ extensionName: "fs", toolName: "read_file", callCount: 12, tokens: 5_000, pct: 50, calls },
		];
		const { getByTestId, getAllByTestId } = render(ContextUsageIndicator, {
			usedTokens: 8_000,
			contextWindow: 200_000,
			breakdown,
			toolBreakdown,
		});

		await fireEvent.mouseEnter(getByTestId("context-usage-indicator").parentElement!);
		await fireEvent.click(getByTestId("ctx-bd-tool-row"));
		await fireEvent.click(getByTestId("ctx-bd-fn-row"));

		// Cap at 8 visible call rows + overflow footer.
		expect(getAllByTestId("ctx-bd-call-row")).toHaveLength(8);
		expect(getByTestId("ctx-bd-call-overflow").textContent).toContain("+4 more");
	});

	test("expanded per-call list under a built-in (no function level) caps at limit + footer", async () => {
		const breakdown: ContextBreakdown = {
			inputTokens: 8_000,
			outputTokens: 2_000,
			toolTokens: 5_000,
			totalTokens: 10_000,
			pctInput: 80,
			pctOutput: 20,
			pctTools: 50,
		};
		const calls = Array.from({ length: 11 }, (_, i) => ({
			tokens: 1_000 - i,
			pct: 1,
			preview: `cmd${i}`,
		}));
		const toolBreakdown: ToolBreakdownEntry[] = [
			{ extensionName: "", toolName: "Bash", callCount: 11, tokens: 5_000, pct: 50, calls },
		];
		const { getByTestId, getAllByTestId } = render(ContextUsageIndicator, {
			usedTokens: 8_000,
			contextWindow: 200_000,
			breakdown,
			toolBreakdown,
		});

		await fireEvent.mouseEnter(getByTestId("context-usage-indicator").parentElement!);
		// Single click — built-ins skip the function level.
		await fireEvent.click(getByTestId("ctx-bd-tool-row"));
		expect(getAllByTestId("ctx-bd-call-row")).toHaveLength(8);
		expect(getByTestId("ctx-bd-call-overflow").textContent).toContain("+3 more");
	});

	test("clicking a per-call row fires `oncallclick` with the source callId and closes the popover", async () => {
		// The chat page wires `oncallclick` to a scrollIntoView on the
		// `#tool-call-${id}` anchor it writes for every rendered tool card.
		// Two contracts to lock down here so that wiring keeps working:
		//   1. The handler receives the EXACT callId from the breakdown row.
		//   2. The popover closes on click — leaving it open would obscure
		//      the target the user just navigated to.
		const breakdown: ContextBreakdown = {
			inputTokens: 8_000,
			outputTokens: 2_000,
			toolTokens: 1_500,
			totalTokens: 10_000,
			pctInput: 80,
			pctOutput: 20,
			pctTools: 15,
		};
		const toolBreakdown: ToolBreakdownEntry[] = [
			{
				extensionName: "",
				toolName: "Bash",
				callCount: 2,
				tokens: 100,
				pct: 10,
				calls: [
					{ callId: "call-aaa", tokens: 60, pct: 6, preview: "ls -la" },
					{ callId: "call-bbb", tokens: 40, pct: 4, preview: "pwd" },
				],
			},
		];
		const calls: string[] = [];
		const { getByTestId, getAllByTestId, queryByTestId } = render(ContextUsageIndicator, {
			usedTokens: 8_000,
			contextWindow: 200_000,
			breakdown,
			toolBreakdown,
			oncallclick: (id: string) => calls.push(id),
		});

		await fireEvent.mouseEnter(getByTestId("context-usage-indicator").parentElement!);
		await fireEvent.click(getByTestId("ctx-bd-tool-row"));

		const callRows = getAllByTestId("ctx-bd-call-row");
		expect(callRows).toHaveLength(2);
		// Clickable rows render as <button> with data-call-id set, so the
		// page can also use event-delegation later if it ever wants to.
		expect(callRows[0]?.tagName).toBe("BUTTON");
		expect(callRows[0]?.getAttribute("data-call-id")).toBe("call-aaa");

		await fireEvent.click(callRows[0]!);
		expect(calls).toEqual(["call-aaa"]);
		// Popover dismissed so the scroll lands on a clean viewport.
		expect(queryByTestId("context-usage-popover")).toBeNull();
	});

	test("calls without a callId render as a non-clickable <div> even when oncallclick is provided", async () => {
		// Defence against silent breakage: a missing id (legacy data, partial
		// stream) MUST NOT render a button — clicking would call back with
		// `undefined` and `getElementById('tool-call-undefined')` would 404.
		const breakdown: ContextBreakdown = {
			inputTokens: 1_000,
			outputTokens: 0,
			toolTokens: 100,
			totalTokens: 1_000,
			pctInput: 100,
			pctOutput: 0,
			pctTools: 10,
		};
		const toolBreakdown: ToolBreakdownEntry[] = [
			{
				extensionName: "",
				toolName: "Bash",
				callCount: 1,
				tokens: 100,
				pct: 10,
				calls: [{ /* no callId */ tokens: 100, pct: 10, preview: "legacy" }],
			},
		];
		let fired = 0;
		const { getByTestId } = render(ContextUsageIndicator, {
			usedTokens: 1_000,
			contextWindow: 200_000,
			breakdown,
			toolBreakdown,
			oncallclick: () => fired++,
		});

		await fireEvent.mouseEnter(getByTestId("context-usage-indicator").parentElement!);
		await fireEvent.click(getByTestId("ctx-bd-tool-row"));

		const row = getByTestId("ctx-bd-call-row");
		expect(row.tagName).toBe("DIV");
		await fireEvent.click(row);
		expect(fired).toBe(0);
	});

	test("call rows render as <div> when oncallclick is NOT provided (back-compat with old callers)", async () => {
		// Existing tests in this file (and existing call sites in the wild)
		// pass no handler. Those rows must stay non-interactive — adding the
		// click affordance unconditionally would shift the focus order and
		// pollute the tab sequence.
		const breakdown: ContextBreakdown = {
			inputTokens: 1_000,
			outputTokens: 0,
			toolTokens: 100,
			totalTokens: 1_000,
			pctInput: 100,
			pctOutput: 0,
			pctTools: 10,
		};
		const toolBreakdown: ToolBreakdownEntry[] = [
			{
				extensionName: "",
				toolName: "Bash",
				callCount: 1,
				tokens: 100,
				pct: 10,
				calls: [{ callId: "call-x", tokens: 100, pct: 10, preview: "pwd" }],
			},
		];
		const { getByTestId } = render(ContextUsageIndicator, {
			usedTokens: 1_000,
			contextWindow: 200_000,
			breakdown,
			toolBreakdown,
		});

		await fireEvent.mouseEnter(getByTestId("context-usage-indicator").parentElement!);
		await fireEvent.click(getByTestId("ctx-bd-tool-row"));

		const row = getByTestId("ctx-bd-call-row");
		expect(row.tagName).toBe("DIV");
	});

	test("clicking an extension-tool's nested function call also fires `oncallclick`", async () => {
		// Extension/MCP groups go through the function level first; the call
		// rows under a function row must wire up the same handler.
		const breakdown: ContextBreakdown = {
			inputTokens: 8_000,
			outputTokens: 2_000,
			toolTokens: 1_500,
			totalTokens: 10_000,
			pctInput: 80,
			pctOutput: 20,
			pctTools: 15,
		};
		const toolBreakdown: ToolBreakdownEntry[] = [
			{
				extensionName: "playwright",
				toolName: "browser_click",
				callCount: 1,
				tokens: 500,
				pct: 5,
				calls: [{ callId: "ext-call-1", tokens: 500, pct: 5, preview: "btn1" }],
			},
		];
		const seen: string[] = [];
		const { getByTestId } = render(ContextUsageIndicator, {
			usedTokens: 8_000,
			contextWindow: 200_000,
			breakdown,
			toolBreakdown,
			oncallclick: (id: string) => seen.push(id),
		});

		await fireEvent.mouseEnter(getByTestId("context-usage-indicator").parentElement!);
		await fireEvent.click(getByTestId("ctx-bd-tool-row"));
		await fireEvent.click(getByTestId("ctx-bd-fn-row"));
		await fireEvent.click(getByTestId("ctx-bd-call-row"));

		expect(seen).toEqual(["ext-call-1"]);
	});

	test("popover falls back to summary text when no breakdown is provided", async () => {
		const { getByTestId } = render(ContextUsageIndicator, {
			usedTokens: 50_000,
			contextWindow: 200_000,
		});
		const trigger = getByTestId("context-usage-indicator").parentElement!;
		await fireEvent.mouseEnter(trigger);

		const popover = getByTestId("context-usage-popover");
		expect(popover.textContent).toContain("50k / 200k tokens used (25%)");
	});
});
