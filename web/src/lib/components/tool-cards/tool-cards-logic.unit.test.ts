/**
 * Coverage-measured suite for the tool-card pure logic
 * (`utils.ts` + `ez-install-card-logic.ts`).
 *
 * Why this file exists alongside the older bun suites (`default-card`,
 * `tool-card-router`, `tool-card-utils-dock`, `tool-card-collapsible`,
 * `diff-card`, `task-card`, `search-results-card`, `terminal-card`,
 * `ez-install-card-logic`): those run in the web BUN leg, which the
 * coverage pipeline does not instrument — only the Vitest leg is. So
 * every line of these two modules was unmeasured, and the patch-coverage
 * gate rightly refuses a change to a file no gate can see. Renaming the
 * bun suites onto the Vitest leg is a `Gate integrity` violation (test
 * renames need a maintainer label), so this is the measured suite and
 * the bun ones keep running as-is.
 *
 * It therefore aims at BREADTH — every exported function, and the
 * branches that carry real behavior — rather than re-listing each
 * sibling case. Cases with no coverage anywhere else (`getSecurityNote`,
 * `extractCommandText`, the status-map default arms, the `ez-draft`
 * route, the install card's `ok:false` guard) are asserted in full.
 */

import { test, expect, describe } from "vitest";
import {
	extractCommandText,
	extractDiffDetails,
	extractDiffInput,
	extractInputSummary,
	describeToolInput,
	formatOutputPreview,
	generateDiffText,
	getCardComponentName,
	getSecurityNote,
	getStatusBadge,
	getStatusColor,
	getStatusIcon,
	isCollapsibleDevCard,
	isNewFile,
	isStackList,
	parseGlobOutput,
	parseGrepOutput,
	parseListOutput,
	parseTaskOutput,
	shouldRenderInDock,
	stripAnsi,
} from "./utils.js";
import { extractEzCardObject, parseInstallCardResult } from "./ez-install-card-logic.js";

describe("getCardComponentName", () => {
	test.each([
		["terminal", "TerminalCard"],
		["diff", "DiffCard"],
		["search-results", "SearchResultsCard"],
		["task-list", "TaskListCard"],
		["task-detail", "TaskDetailCard"],
		["ask-user-question", "AskUserQuestionCard"],
		["design-canvas", "DesignCanvasCard"],
		["design-brief", "DesignBriefCard"],
		["kokoro-tts-player", "KokoroTtsPlayerCard"],
		["price-chart", "PriceChartCard"],
		["grade-delta-chart", "GradeDeltaCard"],
		["substack-review", "SubstackReviewCard"],
		["weather-panel", "WeatherCard"],
		["city-conditions", "CityConditionsCard"],
		["time-clock", "TimeClockCard"],
		["image-gen-grid", "ImageGenCard"],
		["ez-install", "EzToolResultCard"],
		// Both extension-author cards share one component.
		["ez-draft", "EzToolResultCard"],
		["ez-propose", "EzToolResultCard"],
		["ez-preview-consent", "PreviewConsentCard"],
		// The two web-search shapes share one component: a ranked link list
		// and a single fetched page are the same question — what did the
		// model read? — so they route together.
		["web-search", "WebContextCard"],
		["web-page", "WebContextCard"],
	])("%s → %s", (cardType, component) => {
		expect(getCardComponentName(cardType, false)).toBe(component);
	});

	test("unknown / absent cardType degrades to DefaultCard", () => {
		expect(getCardComponentName("weather-pannel", false)).toBe("DefaultCard");
		expect(getCardComponentName(undefined, false)).toBe("DefaultCard");
	});

	test("a pending permission gate overrides every cardType", () => {
		expect(getCardComponentName("terminal", true)).toBe("PermissionGate");
		expect(getCardComponentName(undefined, true)).toBe("PermissionGate");
	});
});

describe("shouldRenderInDock / isCollapsibleDevCard", () => {
	test("docks only a complete dock-layout call", () => {
		expect(shouldRenderInDock("dock", "complete")).toBe(true);
		expect(shouldRenderInDock("dock", "running")).toBe(false);
		expect(shouldRenderInDock("inline", "complete")).toBe(false);
		expect(shouldRenderInDock(null, "complete")).toBe(false);
	});

	test("collapses the noisy dev cards inline only", () => {
		expect(isCollapsibleDevCard("TerminalCard", "inline")).toBe(true);
		expect(isCollapsibleDevCard("DiffCard", "inline")).toBe(true);
		expect(isCollapsibleDevCard("SearchResultsCard", "inline")).toBe(true);
		expect(isCollapsibleDevCard("WeatherCard", "inline")).toBe(false);
		expect(isCollapsibleDevCard("TerminalCard", "dock")).toBe(false);
		expect(isCollapsibleDevCard("TerminalCard", null)).toBe(false);
	});
});

describe("getSecurityNote", () => {
	test("execute and write warn about what the tool will do", () => {
		expect(getSecurityNote("execute")).toBe("This tool will run a shell command");
		expect(getSecurityNote("write")).toBe("This tool will modify files");
	});

	test("read and unknown categories carry no warning", () => {
		expect(getSecurityNote("read")).toBe("");
		expect(getSecurityNote("something-else")).toBe("");
		expect(getSecurityNote(undefined)).toBe("");
	});
});

describe("describeToolInput — the consent-prompt summary", () => {
	test("prefers the known dev-tool key when there is one", () => {
		expect(describeToolInput({ command: "ls -la", other: 1 })).toBe("ls -la");
	});

	test("falls back to compact JSON for arbitrary argument names", () => {
		// Caller-executed tools declare their OWN parameter names, so the
		// allowlist misses them and the gate would otherwise render nothing —
		// asking the user to authorise arguments they cannot see.
		expect(describeToolInput({ app: "Notes" })).toBe('{"app":"Notes"}');
		expect(describeToolInput({ bundleId: "com.x", activate: true })).toBe(
			'{"bundleId":"com.x","activate":true}',
		);
	});

	test("truncates a long fallback rather than flooding the prompt", () => {
		const long = describeToolInput({ blob: "x".repeat(400) }, 60)!;
		expect(long).toHaveLength(60);
		expect(long.endsWith("...")).toBe(true);
	});

	test("nothing to say stays undefined", () => {
		// `{}` tells the reader nothing the tool name did not.
		expect(describeToolInput({})).toBeUndefined();
		expect(describeToolInput(null)).toBeUndefined();
		expect(describeToolInput("a string")).toBeUndefined();
		expect(describeToolInput(undefined)).toBeUndefined();
	});
});

describe("extractInputSummary", () => {
	test("prefers the most specific dev-tool key", () => {
		expect(extractInputSummary({ file_path: "/a.ts", path: "/b" })).toBe("/a.ts");
		expect(extractInputSummary({ pattern: "**/*.ts" })).toBe("**/*.ts");
		expect(extractInputSummary({ command: "ls -la" })).toBe("ls -la");
		expect(extractInputSummary({ query: "q" })).toBe("q");
		expect(extractInputSummary({ url: "https://x" })).toBe("https://x");
		expect(extractInputSummary({ content: "c" })).toBe("c");
	});

	// The extension-author tools take ONLY these, so without them a
	// failed install_draft had no header summary at all.
	test("knows the extension-author keys", () => {
		expect(extractInputSummary({ draftId: "draft-abc" })).toBe("draft-abc");
		expect(extractInputSummary({ name: "weather" })).toBe("weather");
		// A more specific key still wins.
		expect(extractInputSummary({ draftId: "d1", path: "index.ts" })).toBe("index.ts");
	});

	test("truncates long values and tolerates junk input", () => {
		const r = extractInputSummary({ command: "a".repeat(100) });
		expect(r!.length).toBe(60);
		expect(r!.endsWith("...")).toBe(true);
		expect(extractInputSummary({ command: "a".repeat(20) }, 10)!.length).toBe(10);
		expect(extractInputSummary({ other: "x" })).toBeUndefined();
		expect(extractInputSummary(null)).toBeUndefined();
		expect(extractInputSummary("string")).toBeUndefined();
	});
});

describe("extractCommandText — the FULL, untruncated primary arg", () => {
	test("command wins and is never truncated (unlike the header summary)", () => {
		const long = `echo ${"x".repeat(500)}`;
		expect(extractCommandText({ command: long })).toBe(long);
		expect(extractCommandText({ command: "ls", file_path: "/a.ts" })).toBe("ls");
	});

	test("falls back through the remaining dev-card keys", () => {
		expect(extractCommandText({ file_path: "/a.ts" })).toBe("/a.ts");
		expect(extractCommandText({ path: "/b" })).toBe("/b");
		expect(extractCommandText({ pattern: "**/*" })).toBe("**/*");
		expect(extractCommandText({ query: "q" })).toBe("q");
		expect(extractCommandText({ url: "https://x" })).toBe("https://x");
		expect(extractCommandText({ content: "c" })).toBe("c");
		expect(extractCommandText({ command: 42 })).toBe("42");
	});

	test("no usable arg → undefined so the caller omits the block", () => {
		expect(extractCommandText({})).toBeUndefined();
		expect(extractCommandText({ command: "" })).toBeUndefined();
		expect(extractCommandText(null)).toBeUndefined();
		expect(extractCommandText("a string")).toBeUndefined();
	});
});

describe("formatOutputPreview", () => {
	test("truncates, stringifies, and drops empty payloads", () => {
		expect(formatOutputPreview("short")).toBe("short");
		expect(formatOutputPreview({ a: 1 })).toBe('{"a":1}');
		const long = formatOutputPreview("b".repeat(80));
		expect(long!.length).toBe(50);
		expect(formatOutputPreview(null)).toBeUndefined();
		expect(formatOutputPreview({})).toBeUndefined();
		expect(formatOutputPreview("")).toBeUndefined();
	});
});

describe("stripAnsi / grep / glob parsing", () => {
	test("strips escape sequences", () => {
		expect(stripAnsi("[31mred[0m")).toBe("red");
	});

	test("groups grep hits by file, keeping line numbers", () => {
		const groups = parseGrepOutput("src/a.ts:12:hit one\nsrc/a.ts:20-context\nsrc/b.ts:3:hit two\n--\n");
		expect(groups.length).toBe(2);
		expect(groups[0]!.filePath).toBe("src/a.ts");
		expect(groups[0]!.matches).toEqual([
			{ lineNum: 12, content: "hit one" },
			{ lineNum: 20, content: "context" },
		]);
		expect(groups[1]!.matches[0]!.lineNum).toBe(3);
		expect(parseGrepOutput("")).toEqual([]);
		expect(parseGrepOutput("no colon here")).toEqual([]);
	});

	test("glob output drops blanks and the truncation marker", () => {
		expect(parseGlobOutput(" a.ts \n\nb.ts\n[truncated 5 more]")).toEqual(["a.ts", "b.ts"]);
		expect(parseGlobOutput("")).toEqual([]);
	});
});

describe("diff helpers", () => {
	test("reads details first, then the flat shape", () => {
		expect(extractDiffDetails({ details: { oldContent: "a", newContent: "b" } })).toEqual({
			oldContent: "a",
			newContent: "b",
		});
		expect(extractDiffDetails({ oldContent: "a", newContent: "b" })).toEqual({
			oldContent: "a",
			newContent: "b",
		});
		expect(extractDiffDetails({ details: { oldContent: 1 } })).toEqual({
			oldContent: undefined,
			newContent: undefined,
		});
		expect(extractDiffDetails(null)).toEqual({});
	});

	test("input fallback mirrors the diff panel's field choice", () => {
		expect(extractDiffInput({ old_string: "a", new_string: "b" })).toEqual({
			oldContent: "a",
			newContent: "b",
		});
		expect(extractDiffInput({ content: "b" }).newContent).toBe("b");
		expect(extractDiffInput(null)).toEqual({});
	});

	test("generates a unified diff; a new file has no removals", () => {
		const d = generateDiffText("old", "new", "a.ts");
		expect(d).toContain("--- a/a.ts");
		expect(d).toContain("-old");
		expect(d).toContain("+new");
		// A new file has no removal LINES (the `--- a/…` header aside).
		expect(generateDiffText("", "new", "a.ts")).not.toContain("\n-");
		expect(generateDiffText("", "", "a.ts")).toBe("");
		expect(isNewFile("", "new")).toBe(true);
		expect(isNewFile("old", "new")).toBe(false);
	});
});

describe("task helpers", () => {
	test("parses task + list payloads, tolerating junk", () => {
		expect(parseTaskOutput('{"id":"t1","title":"T"}')).toEqual({ id: "t1", title: "T" });
		expect(parseTaskOutput({ id: "t2" })).toEqual({ id: "t2" });
		expect(parseTaskOutput("[1,2]")).toBeNull();
		expect(parseTaskOutput("nope")).toBeNull();
		expect(parseTaskOutput(null)).toBeNull();
		expect(parseListOutput('[{"id":"t1"}]')).toEqual([{ id: "t1" }]);
		expect(parseListOutput('{"id":"t1"}')).toEqual([]);
		expect(parseListOutput("nope")).toEqual([]);
		expect(parseListOutput(null)).toEqual([]);
	});

	test("isStackList distinguishes a stack list from a task list", () => {
		// Stacks carry `name` and no `status`; tasks carry `status`.
		expect(isStackList([{ name: "Backlog" }])).toBe(true);
		expect(isStackList([{ name: "Backlog", status: "active" }])).toBe(false);
		expect(isStackList([{ title: "Ship it", status: "active" }])).toBe(false);
		expect(isStackList([])).toBe(false);
	});

	test("status maps, including the default arms", () => {
		expect(getStatusBadge("completed").text).toBe("Completed");
		expect(getStatusBadge("active").text).toBe("Active");
		expect(getStatusBadge("pending").text).toBe("Pending");
		expect(getStatusBadge("failed").text).toBe("Failed");
		// An unknown status keeps its own label rather than inventing one.
		expect(getStatusBadge("queued")).toEqual({
			text: "queued",
			classes: "bg-gray-500/20 text-gray-300",
		});
		expect(getStatusBadge(undefined).text).toBe("Unknown");

		expect(getStatusColor("completed")).toBe("text-green-400");
		expect(getStatusColor("active")).toBe("text-blue-400");
		expect(getStatusColor("failed")).toBe("text-red-400");
		expect(getStatusColor("queued")).toBe("text-[var(--color-text-muted)]");

		expect(getStatusIcon("completed")).toBe("✓");
		expect(getStatusIcon("active")).toBe("▶");
		expect(getStatusIcon("failed")).toBe("✗");
		expect(getStatusIcon("queued")).toBe("○");
	});
});

describe("ez-install card parsing", () => {
	test("unwraps a JSON string, an object, and an MCP text envelope", () => {
		expect(extractEzCardObject('{"a":1}')).toEqual({ a: 1 });
		expect(extractEzCardObject({ a: 1 })).toEqual({ a: 1 });
		expect(
			extractEzCardObject({ content: [{ type: "text", text: '{"a":1}' }] }),
		).toEqual({ a: 1 });
	});

	test("returns null for anything not object-shaped", () => {
		expect(extractEzCardObject(null)).toBeNull();
		expect(extractEzCardObject("not json")).toBeNull();
		expect(extractEzCardObject("[1,2]")).toBeNull();
		expect(extractEzCardObject(42)).toBeNull();
		expect(extractEzCardObject({ content: [{ type: "image" }] })).toEqual({
			content: [{ type: "image" }],
		});
		expect(extractEzCardObject({ content: [{ type: "text", text: "{bad" }] })).toBeNull();
	});

	test("a usable install result renders name-specific copy", () => {
		const r = parseInstallCardResult(
			JSON.stringify({ ok: true, name: "weather", openUrl: "/extensions/weather" }),
		);
		expect(r?.openUrl).toBe("/extensions/weather");
		expect(r?.openUrlLabel).toBe("Open extension");
		expect(r?.title).toBe('Extension "weather" installed');
		expect(r?.summary).toContain("weather");
	});

	test("without a name the copy stays generic", () => {
		const r = parseInstallCardResult(JSON.stringify({ openUrl: "/extensions/y" }));
		expect(r?.title).toBe("Extension installed");
		expect(r?.summary).toContain("Extensions Library");
	});

	// The card states flatly that the extension "is installed and
	// enabled" — it must never render for a result that says otherwise.
	test("ok:false is rejected even when an openUrl is present", () => {
		expect(
			parseInstallCardResult(
				JSON.stringify({ ok: false, code: "ENABLE_FAILED", openUrl: "/extensions/w" }),
			),
		).toBeNull();
	});

	test("no usable openUrl → null so the router falls back to DefaultCard", () => {
		expect(parseInstallCardResult(JSON.stringify({ ok: true, name: "w" }))).toBeNull();
		expect(parseInstallCardResult(JSON.stringify({ openUrl: "" }))).toBeNull();
		expect(parseInstallCardResult("nonsense")).toBeNull();
	});
});
