import { test, expect, describe } from "bun:test";
import { isModelCommand } from "../commands";

describe("isModelCommand", () => {
	test("returns null for non-command input", () => {
		expect(isModelCommand("hello world")).toBeNull();
		expect(isModelCommand("")).toBeNull();
		expect(isModelCommand("what model should I use?")).toBeNull();
		expect(isModelCommand("/login openai")).toBeNull();
		expect(isModelCommand("/help")).toBeNull();
	});

	test("/model with no args returns list", () => {
		expect(isModelCommand("/model")).toEqual({ type: "list" });
	});

	test("/model with whitespace-only args returns list", () => {
		expect(isModelCommand("/model  ")).toEqual({ type: "list" });
		expect(isModelCommand("/model\t")).toEqual({ type: "list" });
	});

	test("is case insensitive for the command", () => {
		expect(isModelCommand("/MODEL")).toEqual({ type: "list" });
		expect(isModelCommand("/Model")).toEqual({ type: "list" });
	});

	test("/model provider/name returns switch with provider", () => {
		expect(isModelCommand("/model claude/claude-sonnet-4-20250514")).toEqual({
			type: "switch",
			provider: "claude",
			model: "claude-sonnet-4-20250514",
		});
		expect(isModelCommand("/model gemini/gemini-2.0-flash")).toEqual({
			type: "switch",
			provider: "gemini",
			model: "gemini-2.0-flash",
		});
		expect(isModelCommand("/model openai/gpt-4o")).toEqual({
			type: "switch",
			provider: "openai",
			model: "gpt-4o",
		});
	});

	test("lowercases provider but preserves model casing", () => {
		expect(isModelCommand("/model Claude/claude-sonnet-4-20250514")).toEqual({
			type: "switch",
			provider: "claude",
			model: "claude-sonnet-4-20250514",
		});
	});

	test("/model name without provider returns switch without provider", () => {
		expect(isModelCommand("/model gpt-4o")).toEqual({
			type: "switch",
			model: "gpt-4o",
		});
		expect(isModelCommand("/model claude-sonnet-4-20250514")).toEqual({
			type: "switch",
			model: "claude-sonnet-4-20250514",
		});
	});

	test("trims surrounding whitespace", () => {
		expect(isModelCommand("  /model  ")).toEqual({ type: "list" });
		expect(isModelCommand("  /model gpt-4o  ")).toEqual({
			type: "switch",
			model: "gpt-4o",
		});
	});
});
