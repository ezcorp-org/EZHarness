import { test, expect, describe } from "bun:test";
import { parseMentions } from "../lib/mention-logic";

/**
 * Unit tests for the logic behind closing tool forms when mention chips are deleted.
 * The ChatInput component checks: if activeExtension is set but no matching mention
 * exists in the text, reset the inline tool state.
 */

function shouldResetToolState(activeExtension: string | null, text: string): boolean {
	if (!activeExtension) return false;
	const mentions = parseMentions(text);
	return !mentions.some(m => m.kind === "ext" && m.name === activeExtension);
}

describe("tool form dismissal on mention chip deletion", () => {
	test("returns false when no active extension", () => {
		expect(shouldResetToolState(null, "hello ![ext:analyzer] world")).toBe(false);
	});

	test("returns false when mention still present", () => {
		expect(shouldResetToolState("analyzer", "hello ![ext:analyzer] world")).toBe(false);
	});

	test("returns true when mention is deleted", () => {
		expect(shouldResetToolState("analyzer", "hello  world")).toBe(true);
	});

	test("returns true when mention is partially deleted", () => {
		expect(shouldResetToolState("analyzer", "hello ![ext:anal world")).toBe(true);
	});

	test("returns false when a different ext mention exists but active one is gone", () => {
		expect(shouldResetToolState("analyzer", "hello ![ext:formatter] world")).toBe(true);
	});

	test("returns false when active extension mention is among multiple", () => {
		expect(shouldResetToolState("analyzer", "![ext:formatter] ![ext:analyzer] go")).toBe(false);
	});

	test("ignores agent mentions — only checks ext kind", () => {
		expect(shouldResetToolState("analyzer", "![agent:analyzer] go")).toBe(true);
	});
});
