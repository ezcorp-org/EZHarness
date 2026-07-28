/**
 * Coverage-completing cases for `tool-cards/utils.ts`.
 *
 * The sibling suites (`default-card`, `tool-card-router`,
 * `tool-card-utils-dock`, `tool-card-collapsible`, `diff-card`,
 * `task-card`, `search-results-card`, `terminal-card`) cover the bulk
 * of this module. These are the arms none of them reach: the card-type
 * cases with no dedicated suite, `getSecurityNote`, the status-map
 * default arms, and `extractCommandText` — which had no test at all
 * despite being the function that decides what the always-visible
 * command block on a dev card shows.
 */

import { test, expect, describe } from "vitest";
import {
	extractCommandText,
	getCardComponentName,
	getSecurityNote,
	getStatusBadge,
	getStatusColor,
	getStatusIcon,
} from "./utils.js";

describe("getCardComponentName — cards without a dedicated suite", () => {
	test.each([
		["ask-user-question", "AskUserQuestionCard"],
		["design-canvas", "DesignCanvasCard"],
		["design-brief", "DesignBriefCard"],
		["substack-review", "SubstackReviewCard"],
		["weather-panel", "WeatherCard"],
		["time-clock", "TimeClockCard"],
		["image-gen-grid", "ImageGenCard"],
		["grade-delta-chart", "GradeDeltaCard"],
		["price-chart", "PriceChartCard"],
		["task-list", "TaskListCard"],
		["task-detail", "TaskDetailCard"],
		// Both extension-author cards route to the same shared card.
		["ez-install", "EzToolResultCard"],
		["ez-draft", "EzToolResultCard"],
		["ez-propose", "EzToolResultCard"],
	])("%s → %s", (cardType, component) => {
		expect(getCardComponentName(cardType, false)).toBe(component);
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

describe("status maps — the default arms", () => {
	test("an unknown status keeps its own label rather than inventing one", () => {
		expect(getStatusBadge("queued")).toEqual({
			text: "queued",
			classes: "bg-gray-500/20 text-gray-300",
		});
	});

	test("an absent status falls back to Unknown", () => {
		expect(getStatusBadge(undefined).text).toBe("Unknown");
	});

	test("unknown status colour + icon are the neutral defaults", () => {
		expect(getStatusColor("queued")).toBe("text-[var(--color-text-muted)]");
		expect(getStatusColor(undefined)).toBe("text-[var(--color-text-muted)]");
		expect(getStatusIcon("queued")).toBe("○");
		expect(getStatusIcon(undefined)).toBe("○");
	});
});

describe("extractCommandText — the FULL, untruncated primary arg", () => {
	test("command wins, and is never truncated (unlike the header summary)", () => {
		const long = `echo ${"x".repeat(500)}`;
		expect(extractCommandText({ command: long })).toBe(long);
	});

	test("falls back through the dev-card keys in order", () => {
		expect(extractCommandText({ file_path: "/a.ts", path: "/b" })).toBe("/a.ts");
		expect(extractCommandText({ path: "/b" })).toBe("/b");
		expect(extractCommandText({ pattern: "**/*.ts" })).toBe("**/*.ts");
		expect(extractCommandText({ query: "q" })).toBe("q");
		expect(extractCommandText({ url: "https://x" })).toBe("https://x");
		expect(extractCommandText({ content: "c" })).toBe("c");
	});

	test("command beats every other key", () => {
		expect(extractCommandText({ command: "ls", file_path: "/a.ts", query: "q" })).toBe("ls");
	});

	test("no usable arg → undefined so the caller omits the block entirely", () => {
		expect(extractCommandText({})).toBeUndefined();
		expect(extractCommandText({ other: "x" })).toBeUndefined();
		expect(extractCommandText({ command: "" })).toBeUndefined();
		expect(extractCommandText(null)).toBeUndefined();
		expect(extractCommandText(undefined)).toBeUndefined();
		expect(extractCommandText("a string")).toBeUndefined();
	});

	test("a non-string arg is stringified rather than dropped", () => {
		expect(extractCommandText({ command: 42 })).toBe("42");
	});
});
