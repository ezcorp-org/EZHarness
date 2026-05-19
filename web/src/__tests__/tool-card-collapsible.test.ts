/**
 * Unit tests for `isCollapsibleDevCard` — the pure helper that decides
 * whether ToolCardRouter wraps a card in the collapse shell.
 *
 * Mirrors the `shouldRenderInDock` / `getCardComponentName` split: the
 * sibling component test (`ToolCardRouter.component.test.ts`) pins that
 * the router actually MOUNTS a CollapsibleCard for an inline dev card;
 * this file exhaustively pins the DECISION matrix without a renderer.
 *
 * Contract:
 *  - only the three noisy dev-command cards collapse: TerminalCard
 *    (Bash), DiffCard (Edit/Write), SearchResultsCard (grep/glob)
 *  - only inline; the dock is a dedicated panel and never collapses
 *  - input is the resolved `cardName` (getCardComponentName output), so
 *    a permission-gated Bash call is `PermissionGate` and is NOT
 *    collapsed — pinned end-to-end below
 */
import { test, expect, describe } from "bun:test";
import {
	isCollapsibleDevCard,
	getCardComponentName,
} from "../lib/components/tool-cards/utils.js";

describe("isCollapsibleDevCard — collapses the three dev cards inline", () => {
	test("TerminalCard + inline → true", () => {
		expect(isCollapsibleDevCard("TerminalCard", "inline")).toBe(true);
	});

	test("DiffCard + inline → true", () => {
		expect(isCollapsibleDevCard("DiffCard", "inline")).toBe(true);
	});

	test("SearchResultsCard + inline → true", () => {
		expect(isCollapsibleDevCard("SearchResultsCard", "inline")).toBe(true);
	});
});

describe("isCollapsibleDevCard — never collapses in the dock", () => {
	for (const name of ["TerminalCard", "DiffCard", "SearchResultsCard"]) {
		test(`${name} + dock → false (dock is a dedicated panel)`, () => {
			expect(isCollapsibleDevCard(name, "dock")).toBe(false);
		});
	}

	test("missing/null/undefined mode → false (defensive: not inline)", () => {
		expect(isCollapsibleDevCard("TerminalCard", undefined)).toBe(false);
		expect(isCollapsibleDevCard("TerminalCard", null)).toBe(false);
	});
});

describe("isCollapsibleDevCard — non-dev cards never collapse", () => {
	for (const name of [
		"DefaultCard",
		"PermissionGate",
		"TaskListCard",
		"TaskDetailCard",
		"AskUserQuestionCard",
		"DesignCanvasCard",
		"DesignBriefCard",
		"KokoroTtsPlayerCard",
		"PriceChartCard",
		"WeatherCard",
		"ImageGenCard",
		"EzToolResultCard",
	]) {
		test(`${name} + inline → false`, () => {
			expect(isCollapsibleDevCard(name, "inline")).toBe(false);
		});
	}
});

describe("isCollapsibleDevCard ∘ getCardComponentName — gated dev calls are NOT collapsed", () => {
	test("ungated Bash (cardType 'terminal') collapses inline", () => {
		const cardName = getCardComponentName("terminal", false);
		expect(cardName).toBe("TerminalCard");
		expect(isCollapsibleDevCard(cardName, "inline")).toBe(true);
	});

	test("permission-gated Bash resolves to PermissionGate → NOT collapsed", () => {
		// permissionPending overrides cardType: a gated call must show the
		// Allow/Deny gate full-size, never hidden behind a collapse header.
		const cardName = getCardComponentName("terminal", true);
		expect(cardName).toBe("PermissionGate");
		expect(isCollapsibleDevCard(cardName, "inline")).toBe(false);
	});

	test("gated grep + gated diff also resolve to PermissionGate → NOT collapsed", () => {
		expect(isCollapsibleDevCard(getCardComponentName("search-results", true), "inline")).toBe(false);
		expect(isCollapsibleDevCard(getCardComponentName("diff", true), "inline")).toBe(false);
	});
});
