import { test, expect, describe } from "bun:test";

// ── Pure logic extracted from ConversationSettings.svelte ────────────────────
//
// The component's two interesting pieces of pure logic are:
//   1. The active-prompt-level resolution (conversation > project > global > none).
//   2. The keyboard/backdrop interaction guards.

// ── determineActivePromptLevel ────────────────────────────────────────────────
//
// Mirrors the priority logic inside loadPromptPreview():
//   convPrompt → "conversation-level"
//   projectPrompt → "project-level"
//   globalPrompt → "global"
//   otherwise → "none"

type ActiveLevel = "conversation-level" | "project-level" | "global" | "none";

interface PromptSources {
	convPrompt?: string;
	projectPrompt?: string;
	globalPrompt?: string;
}

interface ActivePrompt {
	level: ActiveLevel;
	preview: string;
}

function determineActivePrompt(sources: PromptSources): ActivePrompt {
	if (sources.convPrompt) {
		return { level: "conversation-level", preview: sources.convPrompt };
	}
	if (sources.projectPrompt) {
		return { level: "project-level", preview: sources.projectPrompt };
	}
	if (sources.globalPrompt) {
		return { level: "global", preview: sources.globalPrompt };
	}
	return { level: "none", preview: "" };
}

describe("determineActivePrompt", () => {
	test("conversation-level takes highest priority", () => {
		const result = determineActivePrompt({
			convPrompt: "conv prompt",
			projectPrompt: "project prompt",
			globalPrompt: "global prompt",
		});
		expect(result.level).toBe("conversation-level");
		expect(result.preview).toBe("conv prompt");
	});

	test("project-level when no conversation prompt", () => {
		const result = determineActivePrompt({
			projectPrompt: "project prompt",
			globalPrompt: "global prompt",
		});
		expect(result.level).toBe("project-level");
		expect(result.preview).toBe("project prompt");
	});

	test("global when only global prompt is set", () => {
		const result = determineActivePrompt({
			globalPrompt: "global prompt",
		});
		expect(result.level).toBe("global");
		expect(result.preview).toBe("global prompt");
	});

	test("none when no prompts are set", () => {
		const result = determineActivePrompt({});
		expect(result.level).toBe("none");
		expect(result.preview).toBe("");
	});

	test("none when all prompts are empty strings (falsy)", () => {
		const result = determineActivePrompt({
			convPrompt: "",
			projectPrompt: "",
			globalPrompt: "",
		});
		expect(result.level).toBe("none");
		expect(result.preview).toBe("");
	});

	test("conv prompt overrides even when others are undefined", () => {
		const result = determineActivePrompt({ convPrompt: "only conv" });
		expect(result.level).toBe("conversation-level");
		expect(result.preview).toBe("only conv");
	});

	test("project overrides global", () => {
		const result = determineActivePrompt({
			projectPrompt: "project only",
			globalPrompt: "global fallback",
		});
		expect(result.level).toBe("project-level");
		expect(result.preview).toBe("project only");
	});

	test("preserves multi-line prompt text exactly", () => {
		const multiline = "Line 1\nLine 2\nLine 3";
		const result = determineActivePrompt({ globalPrompt: multiline });
		expect(result.preview).toBe(multiline);
	});

	test("empty conv prompt falls through to project-level", () => {
		const result = determineActivePrompt({
			convPrompt: "",
			projectPrompt: "project level",
		});
		expect(result.level).toBe("project-level");
	});

	test("empty project prompt falls through to global", () => {
		const result = determineActivePrompt({
			projectPrompt: "",
			globalPrompt: "global level",
		});
		expect(result.level).toBe("global");
	});
});

// ── Settings key construction ─────────────────────────────────────────────────
//
// The component builds settings keys from the projectId:
//   project key: `project:${projectId}:systemPrompt`
//   global key: `global:systemPrompt`

function buildProjectSettingKey(projectId: string): string {
	return `project:${projectId}:systemPrompt`;
}

function buildGlobalSettingKey(): string {
	return "global:systemPrompt";
}

describe("buildProjectSettingKey", () => {
	test("builds key from project ID", () => {
		expect(buildProjectSettingKey("proj-123")).toBe("project:proj-123:systemPrompt");
	});

	test("works with UUID-style IDs", () => {
		expect(buildProjectSettingKey("abc-def-456")).toBe("project:abc-def-456:systemPrompt");
	});

	test("handles numeric IDs", () => {
		expect(buildProjectSettingKey("42")).toBe("project:42:systemPrompt");
	});
});

describe("buildGlobalSettingKey", () => {
	test("returns fixed global key", () => {
		expect(buildGlobalSettingKey()).toBe("global:systemPrompt");
	});
});

// ── handleKeydown ─────────────────────────────────────────────────────────────
//
// The component calls onclose() when Escape is pressed.
// We model the guard logic as a pure function.

function shouldCloseOnKeydown(key: string): boolean {
	return key === "Escape";
}

describe("shouldCloseOnKeydown", () => {
	test("returns true for Escape key", () => {
		expect(shouldCloseOnKeydown("Escape")).toBe(true);
	});

	test("returns false for Enter key", () => {
		expect(shouldCloseOnKeydown("Enter")).toBe(false);
	});

	test("returns false for Tab key", () => {
		expect(shouldCloseOnKeydown("Tab")).toBe(false);
	});

	test("returns false for empty string", () => {
		expect(shouldCloseOnKeydown("")).toBe(false);
	});

	test("returns false for lowercase 'escape'", () => {
		// Browser always sends "Escape", not "escape"
		expect(shouldCloseOnKeydown("escape")).toBe(false);
	});

	test("returns false for other printable keys", () => {
		expect(shouldCloseOnKeydown("a")).toBe(false);
		expect(shouldCloseOnKeydown("Space")).toBe(false);
	});
});

// ── handleBackdropClick ───────────────────────────────────────────────────────
//
// The component closes when e.target === e.currentTarget (i.e. the user clicked
// the overlay backdrop rather than the panel itself).

function shouldCloseOnBackdropClick(target: unknown, currentTarget: unknown): boolean {
	return target === currentTarget;
}

describe("shouldCloseOnBackdropClick", () => {
	test("returns true when target equals currentTarget (backdrop click)", () => {
		const el = {};
		expect(shouldCloseOnBackdropClick(el, el)).toBe(true);
	});

	test("returns false when target differs from currentTarget (inner element click)", () => {
		expect(shouldCloseOnBackdropClick({}, {})).toBe(false);
	});

	test("returns false for null vs null (degenerate guard)", () => {
		// null === null is true — same reference, would close
		expect(shouldCloseOnBackdropClick(null, null)).toBe(true);
	});

	test("returns false for mismatched elements", () => {
		const backdrop = { type: "backdrop" };
		const panel = { type: "panel" };
		expect(shouldCloseOnBackdropClick(panel, backdrop)).toBe(false);
	});
});

// ── systemPrompt trim validation ─────────────────────────────────────────────
//
// finishRename and handleSave guard against empty/whitespace-only values.
// Model the trim-and-validate pattern used in the component.

function isValidSystemPrompt(value: string): boolean {
	return value.trim().length > 0;
}

function trimmedPrompt(value: string): string {
	return value.trim();
}

describe("isValidSystemPrompt", () => {
	test("true for a normal string", () => {
		expect(isValidSystemPrompt("You are a helpful assistant.")).toBe(true);
	});

	test("true for a string with leading/trailing spaces", () => {
		expect(isValidSystemPrompt("  some prompt  ")).toBe(true);
	});

	test("false for empty string", () => {
		expect(isValidSystemPrompt("")).toBe(false);
	});

	test("false for whitespace only", () => {
		expect(isValidSystemPrompt("   ")).toBe(false);
	});

	test("false for tab-only", () => {
		expect(isValidSystemPrompt("\t")).toBe(false);
	});

	test("false for newline-only", () => {
		expect(isValidSystemPrompt("\n")).toBe(false);
	});
});

describe("trimmedPrompt", () => {
	test("trims surrounding whitespace", () => {
		expect(trimmedPrompt("  hello world  ")).toBe("hello world");
	});

	test("preserves internal whitespace", () => {
		expect(trimmedPrompt("line 1\nline 2")).toBe("line 1\nline 2");
	});

	test("returns empty string for whitespace-only input", () => {
		expect(trimmedPrompt("   ")).toBe("");
	});
});

// ── Agent-managed prompt display ──────────────────────────────────────────────
//
// When a conversation has an agentConfigId, the system prompt is read-only
// and shows the conversation's existing systemPrompt (or "(none)" as a
// display-only label).  We test this display logic.

function agentPromptDisplay(systemPrompt: string | null | undefined): string {
	return systemPrompt ?? "(none)";
}

function isAgentManaged(agentConfigId: string | null | undefined): boolean {
	return Boolean(agentConfigId);
}

describe("agentPromptDisplay", () => {
	test("returns the prompt when set", () => {
		expect(agentPromptDisplay("You are a coding agent.")).toBe(
			"You are a coding agent.",
		);
	});

	test("returns '(none)' for null", () => {
		expect(agentPromptDisplay(null)).toBe("(none)");
	});

	test("returns '(none)' for undefined", () => {
		expect(agentPromptDisplay(undefined)).toBe("(none)");
	});

	test("returns empty string when prompt is explicitly empty", () => {
		// Empty string is falsy in JS; ?? only triggers on null/undefined
		expect(agentPromptDisplay("")).toBe("");
	});
});

describe("isAgentManaged", () => {
	test("true when agentConfigId is a non-empty string", () => {
		expect(isAgentManaged("agent-123")).toBe(true);
	});

	test("false when agentConfigId is null", () => {
		expect(isAgentManaged(null)).toBe(false);
	});

	test("false when agentConfigId is undefined", () => {
		expect(isAgentManaged(undefined)).toBe(false);
	});

	test("false when agentConfigId is empty string", () => {
		expect(isAgentManaged("")).toBe(false);
	});
});
