import { test, expect, describe } from "bun:test";

// ── Types (mirroring api.ts Mode interface) ──────────────────────────────────

interface Mode {
	id: string;
	name: string;
	slug: string;
	icon: string | null;
	description: string;
	systemPromptInstruction: string;
	instructionPosition: "prepend" | "append" | "replace";
	preferredModel: string | null;
	preferredProvider: string | null;
	preferredThinkingLevel: string | null;
	temperature: number | null;
	toolRestriction: "all" | "read-only" | "none";
	builtin: boolean;
}

// ── Logic extracted from ModeSelector.svelte ─────────────────────────────────

const TOOL_RESTRICTION_LABELS: Record<string, string> = {
	"read-only": "read-only",
	"none": "no tools",
};

function getToolRestrictionBadge(toolRestriction: string): string | undefined {
	return TOOL_RESTRICTION_LABELS[toolRestriction];
}

function getModeIcon(mode: Mode): string {
	return mode.icon ?? "";
}

function isSelected(selected: Mode | null, mode: Mode): boolean {
	return selected?.id === mode.id;
}

function isDefaultSelected(selected: Mode | null): boolean {
	return selected === null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const makeMode = (overrides: Partial<Mode> = {}): Mode => ({
	id: "mode-1",
	name: "Code Review",
	slug: "code-review",
	icon: "🔍",
	description: "Review code carefully",
	systemPromptInstruction: "You are a code reviewer.",
	instructionPosition: "prepend",
	preferredModel: null,
	preferredProvider: null,
	preferredThinkingLevel: null,
	temperature: null,
	toolRestriction: "all",
	builtin: false,
	...overrides,
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("TOOL_RESTRICTION_LABELS", () => {
	test("read-only maps to 'read-only'", () => {
		expect(TOOL_RESTRICTION_LABELS["read-only"]).toBe("read-only");
	});

	test("none maps to 'no tools'", () => {
		expect(TOOL_RESTRICTION_LABELS["none"]).toBe("no tools");
	});

	test("all has no badge label (undefined)", () => {
		expect(TOOL_RESTRICTION_LABELS["all"]).toBeUndefined();
	});
});

describe("getToolRestrictionBadge", () => {
	test("returns label for read-only restriction", () => {
		expect(getToolRestrictionBadge("read-only")).toBe("read-only");
	});

	test("returns label for no-tools restriction", () => {
		expect(getToolRestrictionBadge("none")).toBe("no tools");
	});

	test("returns undefined for 'all' (no badge shown)", () => {
		expect(getToolRestrictionBadge("all")).toBeUndefined();
	});

	test("returns undefined for unknown restriction value", () => {
		expect(getToolRestrictionBadge("custom")).toBeUndefined();
	});
});

describe("getModeIcon", () => {
	test("returns icon when present", () => {
		const mode = makeMode({ icon: "🤖" });
		expect(getModeIcon(mode)).toBe("🤖");
	});

	test("returns empty string when icon is null", () => {
		const mode = makeMode({ icon: null });
		expect(getModeIcon(mode)).toBe("");
	});
});

describe("isSelected", () => {
	test("returns true when mode id matches selected id", () => {
		const mode = makeMode({ id: "abc" });
		const selected = makeMode({ id: "abc" });
		expect(isSelected(selected, mode)).toBe(true);
	});

	test("returns false when ids differ", () => {
		const mode = makeMode({ id: "abc" });
		const selected = makeMode({ id: "xyz" });
		expect(isSelected(selected, mode)).toBe(false);
	});

	test("returns false when selected is null (default mode active)", () => {
		const mode = makeMode({ id: "abc" });
		expect(isSelected(null, mode)).toBe(false);
	});
});

describe("isDefaultSelected", () => {
	test("returns true when selected is null", () => {
		expect(isDefaultSelected(null)).toBe(true);
	});

	test("returns false when a mode is selected", () => {
		const mode = makeMode();
		expect(isDefaultSelected(mode)).toBe(false);
	});
});

describe("mode list processing", () => {
	test("modes array preserves insertion order", () => {
		const modes: Mode[] = [
			makeMode({ id: "1", name: "Alpha" }),
			makeMode({ id: "2", name: "Beta" }),
			makeMode({ id: "3", name: "Gamma" }),
		];
		expect(modes.map((m) => m.name)).toEqual(["Alpha", "Beta", "Gamma"]);
	});

	test("empty modes list is valid (only default option shown)", () => {
		const modes: Mode[] = [];
		expect(modes.length).toBe(0);
	});

	test("builtin and custom modes can coexist", () => {
		const modes: Mode[] = [
			makeMode({ id: "1", name: "Built-in", builtin: true }),
			makeMode({ id: "2", name: "Custom", builtin: false }),
		];
		expect(modes.filter((m) => m.builtin)).toHaveLength(1);
		expect(modes.filter((m) => !m.builtin)).toHaveLength(1);
	});

	test("modes with all tool restrictions are valid", () => {
		const restrictions: Array<"all" | "read-only" | "none"> = ["all", "read-only", "none"];
		const modes = restrictions.map((r, i) =>
			makeMode({ id: String(i), toolRestriction: r }),
		);
		expect(modes.map((m) => m.toolRestriction)).toEqual(["all", "read-only", "none"]);
	});

	test("description is optional (can be empty string)", () => {
		const mode = makeMode({ description: "" });
		expect(mode.description).toBe("");
	});

	test("preferredModel can be null", () => {
		const mode = makeMode({ preferredModel: null });
		expect(mode.preferredModel).toBeNull();
	});

	test("preferredModel can be a model string", () => {
		const mode = makeMode({ preferredModel: "claude-3-7-sonnet" });
		expect(mode.preferredModel).toBe("claude-3-7-sonnet");
	});
});

describe("badge visibility logic", () => {
	test("badge shown for read-only modes", () => {
		const mode = makeMode({ toolRestriction: "read-only" });
		expect(getToolRestrictionBadge(mode.toolRestriction)).toBeDefined();
	});

	test("badge shown for none modes", () => {
		const mode = makeMode({ toolRestriction: "none" });
		expect(getToolRestrictionBadge(mode.toolRestriction)).toBeDefined();
	});

	test("badge not shown for all-tools modes", () => {
		const mode = makeMode({ toolRestriction: "all" });
		expect(getToolRestrictionBadge(mode.toolRestriction)).toBeUndefined();
	});
});
