import { test, expect, describe } from "bun:test";
import { commandSourceLabel } from "$lib/command-source-label";

describe("commandSourceLabel", () => {
	test("project Claude Code commands", () => {
		expect(commandSourceLabel("project:claude-commands")).toEqual({
			scope: "Project",
			folder: ".claude/commands",
			display: "Project · .claude/commands",
		});
	});

	test("project Claude agents folder", () => {
		expect(commandSourceLabel("project:claude-agents")?.display).toBe(
			"Project · .claude/agents",
		);
	});

	test("project Codex prompts", () => {
		expect(commandSourceLabel("project:codex-prompts")?.display).toBe(
			"Project · .codex/prompts",
		);
	});

	test("project plain agents/ folder", () => {
		expect(commandSourceLabel("project:agents")?.display).toBe(
			"Project · agents",
		);
	});

	test("global Claude commands get ~/ prefix", () => {
		expect(commandSourceLabel("user:claude-commands")?.display).toBe(
			"Global · ~/.claude/commands",
		);
	});

	test("global Codex prompts get ~/ prefix", () => {
		expect(commandSourceLabel("user:codex-prompts")?.display).toBe(
			"Global · ~/.codex/prompts",
		);
	});

	test("DB source is labelled 'Saved' (no ~/ prefix)", () => {
		expect(commandSourceLabel("user:db")).toEqual({
			scope: "Global",
			folder: "Saved",
			display: "Global · Saved",
		});
	});

	test("unknown source falls through to raw strings", () => {
		expect(commandSourceLabel("weird:thing")?.display).toBe("weird · thing");
	});

	test("undefined source returns null", () => {
		expect(commandSourceLabel(undefined)).toBeNull();
	});

	test("malformed source (no colon) returns null", () => {
		expect(commandSourceLabel("no-colon")).toBeNull();
	});
});
