import { describe, test, expect } from "vitest";
import {
	suggestKey,
	isDraftEligible,
	isFresh,
	canApplyEnhancement,
	enhanceAllowed,
	nextEnhanceBackoff,
	popoverVisible,
	buildSuggestBody,
	appendExtensionMention,
	chooseInlineToolAction,
	MIN_SUGGEST_DRAFT_LENGTH,
	ENHANCE_BACKOFF_MS,
	SUGGEST_DEBOUNCE_MS,
} from "$lib/composer-suggest-logic";

describe("suggestKey", () => {
	test("trims and collapses whitespace", () => {
		expect(suggestKey("  fix   my\n\tcode  ")).toBe("fix my code");
	});

	test("trailing-space keystrokes don't change the key", () => {
		expect(suggestKey("fix my code")).toBe(suggestKey("fix my code "));
	});
});

describe("isDraftEligible", () => {
	const open = { mentionOpen: false, inlineToolOpen: false, muted: false };

	test("long-enough plain draft is eligible", () => {
		expect(isDraftEligible("please review this code", open)).toBe(true);
	});

	test("short drafts are not (no suggestions on 'hi')", () => {
		expect(isDraftEligible("hi", open)).toBe(false);
		expect(isDraftEligible("x".repeat(MIN_SUGGEST_DRAFT_LENGTH - 1), open)).toBe(false);
		expect(isDraftEligible("x".repeat(MIN_SUGGEST_DRAFT_LENGTH), open)).toBe(true);
	});

	test("whitespace padding can't fake the length gate", () => {
		expect(isDraftEligible("hi" + " ".repeat(40), open)).toBe(false);
	});

	test("suppressed while the mention popover or inline tool UI is open, or muted", () => {
		expect(isDraftEligible("please review this code", { ...open, mentionOpen: true })).toBe(false);
		expect(isDraftEligible("please review this code", { ...open, inlineToolOpen: true })).toBe(false);
		expect(isDraftEligible("please review this code", { ...open, muted: true })).toBe(false);
	});

	test("minLength is overridable", () => {
		expect(isDraftEligible("short", { ...open, minLength: 3 })).toBe(true);
	});
});

describe("isFresh", () => {
	test("matches only the current draft key", () => {
		expect(isFresh("a b", "a b")).toBe(true);
		expect(isFresh("a b", "a b c")).toBe(false);
	});
});

describe("canApplyEnhancement", () => {
	test("plain text → applicable", () => {
		expect(canApplyEnhancement("summarize the latest report")).toBe(true);
	});

	test("drafts carrying mention tokens are NOT rewritable (chips survive)", () => {
		expect(canApplyEnhancement("check @[file:src/app.ts] for bugs")).toBe(false);
		expect(canApplyEnhancement("![ext:analyzer] scan this")).toBe(false);
	});
});

describe("enhance backoff", () => {
	test("allowed when past the backoff timestamp", () => {
		expect(enhanceAllowed(1000, 0)).toBe(true);
		expect(enhanceAllowed(1000, 1000)).toBe(true);
		expect(enhanceAllowed(999, 1000)).toBe(false);
	});

	test("unavailable sidecar sets a backoff window; available clears it", () => {
		expect(nextEnhanceBackoff(5000, false)).toBe(5000 + ENHANCE_BACKOFF_MS);
		expect(nextEnhanceBackoff(5000, true)).toBe(0);
	});
});

describe("popoverVisible", () => {
	const tool = { name: "scan", extension: "analyzer", extensionType: "extension", description: "d", score: 0.9 };

	test("visible with tools or an enhancement — never for a lone spinner", () => {
		expect(popoverVisible({ tools: [tool], enhancement: null })).toBe(true);
		expect(popoverVisible({ tools: [], enhancement: { enhanced: "e", reason: "r" } })).toBe(true);
		expect(popoverVisible({ tools: [], enhancement: null })).toBe(false);
	});
});

describe("buildSuggestBody", () => {
	test("always carries modeId (authoritative, null = no mode)", () => {
		expect(JSON.parse(buildSuggestBody({ draft: "d", modeId: null, include: ["tools"] }))).toEqual({
			draft: "d",
			modeId: null,
			include: ["tools"],
		});
	});

	test("conversationId/projectId included only when present", () => {
		const body = JSON.parse(
			buildSuggestBody({
				draft: "d",
				conversationId: "c1",
				projectId: "p1",
				modeId: "m1",
				include: ["enhance"],
			}),
		);
		expect(body).toEqual({
			draft: "d",
			conversationId: "c1",
			projectId: "p1",
			modeId: "m1",
			include: ["enhance"],
		});
	});
});

describe("appendExtensionMention", () => {
	test("appends the wire token with a separating space and trailing gap", () => {
		expect(appendExtensionMention("scan my repo", "analyzer")).toEqual({
			wire: "scan my repo ![ext:analyzer] ",
			cursor: "scan my repo ![ext:analyzer] ".length,
		});
	});

	test("no double space when the draft already ends in whitespace", () => {
		expect(appendExtensionMention("scan my repo ", "analyzer").wire).toBe(
			"scan my repo ![ext:analyzer] ",
		);
	});

	test("empty draft gets just the token", () => {
		expect(appendExtensionMention("", "analyzer").wire).toBe("![ext:analyzer] ");
	});
});

describe("chooseInlineToolAction", () => {
	const scan = { name: "scan" };
	const lint = { name: "lint" };
	const fmt = { name: "fmt" };

	test("preselect names a tool among many → form on that exact tool (skip picker)", () => {
		expect(chooseInlineToolAction([scan, lint, fmt], "lint")).toEqual({
			action: "form",
			tool: lint,
		});
	});

	test("preselect misses among many → picker", () => {
		expect(chooseInlineToolAction([scan, lint, fmt], "nope")).toEqual({ action: "picker" });
	});

	test("preselect misses with a single tool → form on the lone tool", () => {
		expect(chooseInlineToolAction([scan], "nope")).toEqual({ action: "form", tool: scan });
	});

	test("no preselect, one tool → form", () => {
		expect(chooseInlineToolAction([scan])).toEqual({ action: "form", tool: scan });
	});

	test("no preselect, many tools → picker", () => {
		expect(chooseInlineToolAction([scan, lint])).toEqual({ action: "picker" });
	});

	test("empty list → none (with and without a preselect)", () => {
		expect(chooseInlineToolAction([])).toEqual({ action: "none" });
		expect(chooseInlineToolAction([], "anything")).toEqual({ action: "none" });
	});
});

describe("constants", () => {
	test("suggest debounce is slower than the 200ms mention autocomplete", () => {
		expect(SUGGEST_DEBOUNCE_MS).toBeGreaterThan(200);
	});
});
