import { test, expect, describe, mock, beforeEach, afterEach } from "bun:test";
import {
	insertMentionToken,
	detectMentionTrigger,
	parseMentions,
	getSegments,
} from "../lib/mention-logic";
import { searchMentions, type MentionResult } from "../lib/api";

/**
 * Tests for the auto-open tool form feature:
 * When a user selects an extension mention from the popover, handleChipClick
 * should be called automatically to open the tool form/picker.
 * Agent mentions should NOT trigger auto-open.
 */

// ---------------------------------------------------------------------------
// Pure extraction of handleMentionSelect logic (mirrors ChatInput.svelte)
// ---------------------------------------------------------------------------

interface ToolDefinition {
	name: string;
	description?: string;
	inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
}

interface ChipClickResult {
	action: "show-form" | "show-picker" | "noop" | "error";
	tools?: ToolDefinition[];
	selectedTool?: ToolDefinition;
}

async function handleChipClickLogic(
	extName: string,
	fetchFn: typeof fetch,
): Promise<ChipClickResult> {
	try {
		const res = await fetchFn(`/api/extensions/${encodeURIComponent(extName)}/tools`);
		if (!res.ok) return { action: "noop" };
		const { tools }: { tools: ToolDefinition[] } = await res.json();
		if (tools.length === 1) {
			return { action: "show-form", tools, selectedTool: tools[0] };
		} else if (tools.length > 1) {
			return { action: "show-picker", tools };
		}
		return { action: "noop", tools };
	} catch {
		return { action: "error" };
	}
}

interface MentionItem {
	name: string;
	kind: "agent" | "extension";
	description?: string;
}

interface MentionSelectResult {
	text: string;
	cursor: number;
	autoOpenTriggered: boolean;
	chipClickResult?: ChipClickResult;
}

/**
 * Simulates the full handleMentionSelect logic from ChatInput.svelte:
 * 1. Insert mention token
 * 2. If extension, auto-trigger handleChipClick
 */
async function handleMentionSelectLogic(
	item: MentionItem,
	currentText: string,
	cursorPos: number,
	fetchFn: typeof fetch,
): Promise<MentionSelectResult> {
	const kind = item.kind === "extension" ? "ext" : item.kind;
	const result = insertMentionToken(currentText, cursorPos, {
		kind: kind as "agent" | "ext",
		name: item.name,
	});

	let autoOpenTriggered = false;
	let chipClickResult: ChipClickResult | undefined;

	// Auto-open tool form/picker for extension mentions
	if (kind === "ext") {
		autoOpenTriggered = true;
		chipClickResult = await handleChipClickLogic(item.name, fetchFn);
	}

	return {
		text: result.text,
		cursor: result.cursor,
		autoOpenTriggered,
		chipClickResult,
	};
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
	originalFetch = globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function mockFetch(status: number, body: Record<string, unknown>) {
	globalThis.fetch = mock(() =>
		Promise.resolve(
			new Response(JSON.stringify(body), {
				status,
				headers: { "Content-Type": "application/json" },
			}),
		),
	) as unknown as typeof fetch;
}

function makeTool(name: string, props?: Record<string, unknown>): ToolDefinition {
	return {
		name,
		description: `${name} tool`,
		inputSchema: props
			? { properties: props, required: Object.keys(props) }
			: undefined,
	};
}

function mockSearchResults(results: MentionResult[]) {
	globalThis.fetch = mock(async () =>
		new Response(JSON.stringify(results), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		}),
	) as any;
}

// ---------------------------------------------------------------------------
// Unit tests: auto-open triggers only for extensions
// ---------------------------------------------------------------------------

describe("auto-open: extension vs agent mention selection", () => {
	test("extension mention triggers auto-open", async () => {
		mockFetch(200, { tools: [makeTool("listFiles")] });
		const result = await handleMentionSelectLogic(
			{ name: "project-analyzer", kind: "extension" },
			"!pro",
			4,
			globalThis.fetch,
		);
		expect(result.autoOpenTriggered).toBe(true);
		expect(result.chipClickResult).toBeDefined();
	});

	test("agent mention does NOT trigger auto-open", async () => {
		const result = await handleMentionSelectLogic(
			{ name: "code-helper", kind: "agent" },
			"!co",
			3,
			globalThis.fetch,
		);
		expect(result.autoOpenTriggered).toBe(false);
		expect(result.chipClickResult).toBeUndefined();
	});

	test("extension mention inserts correct token AND triggers auto-open", async () => {
		mockFetch(200, { tools: [makeTool("analyze")] });
		const result = await handleMentionSelectLogic(
			{ name: "analyzer", kind: "extension" },
			"hello !ana",
			10,
			globalThis.fetch,
		);
		expect(result.text).toBe("hello ![ext:analyzer] ");
		expect(result.autoOpenTriggered).toBe(true);
	});

	test("agent mention inserts correct token without auto-open", async () => {
		const result = await handleMentionSelectLogic(
			{ name: "Code Assistant", kind: "agent" },
			"hello !co",
			9,
			globalThis.fetch,
		);
		expect(result.text).toBe("hello ![agent:Code Assistant] ");
		expect(result.autoOpenTriggered).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Unit tests: auto-open result varies by tool count
// ---------------------------------------------------------------------------

describe("auto-open: tool count determines form vs picker vs noop", () => {
	test("single tool → show-form with auto-selected tool", async () => {
		const tool = makeTool("readFile", { path: { type: "string" } });
		mockFetch(200, { tools: [tool] });
		const result = await handleMentionSelectLogic(
			{ name: "code-review-delegator", kind: "extension" },
			"!code",
			5,
			globalThis.fetch,
		);
		expect(result.chipClickResult!.action).toBe("show-form");
		expect(result.chipClickResult!.selectedTool).toEqual(tool);
	});

	test("multiple tools → show-picker", async () => {
		const tools = [makeTool("listFiles"), makeTool("readFile")];
		mockFetch(200, { tools });
		const result = await handleMentionSelectLogic(
			{ name: "project-analyzer", kind: "extension" },
			"!pro",
			4,
			globalThis.fetch,
		);
		expect(result.chipClickResult!.action).toBe("show-picker");
		expect(result.chipClickResult!.tools).toHaveLength(2);
		expect(result.chipClickResult!.selectedTool).toBeUndefined();
	});

	test("zero tools → noop", async () => {
		mockFetch(200, { tools: [] });
		const result = await handleMentionSelectLogic(
			{ name: "empty-ext", kind: "extension" },
			"!emp",
			4,
			globalThis.fetch,
		);
		expect(result.chipClickResult!.action).toBe("noop");
	});

	test("API 404 → noop (extension not found)", async () => {
		mockFetch(404, { error: "Not found" });
		const result = await handleMentionSelectLogic(
			{ name: "ghost-ext", kind: "extension" },
			"!gho",
			4,
			globalThis.fetch,
		);
		expect(result.chipClickResult!.action).toBe("noop");
	});

	test("network error → error state", async () => {
		globalThis.fetch = mock(() => Promise.reject(new Error("network"))) as unknown as typeof fetch;
		const result = await handleMentionSelectLogic(
			{ name: "broken-ext", kind: "extension" },
			"!bro",
			4,
			globalThis.fetch,
		);
		expect(result.chipClickResult!.action).toBe("error");
	});
});

// ---------------------------------------------------------------------------
// Integration: full flow from typing → search → select → auto-open
// ---------------------------------------------------------------------------

describe("integration: type → search → select → auto-open", () => {
	test("extension with 2 tools: type → select → picker opens", async () => {
		// Step 1: User types "!pro"
		const text = "check this !pro";
		const cursor = 15;
		const trigger = detectMentionTrigger(text, cursor);
		expect(trigger).toEqual({ active: true, query: "pro", type: undefined, sigil: "!" });

		// Step 2: Search returns extension result
		mockSearchResults([
			{ name: "project-analyzer", description: "Analyzes projects", kind: "extension" },
		]);
		const results = await searchMentions(trigger!.query);
		expect(results).toHaveLength(1);
		expect(results[0].kind).toBe("extension");

		// Step 3: User selects the extension → auto-open triggers
		const tools = [makeTool("listFiles"), makeTool("readFile")];
		mockFetch(200, { tools });
		const selectResult = await handleMentionSelectLogic(
			{ name: results[0].name, kind: results[0].kind as "extension" },
			text,
			cursor,
			globalThis.fetch,
		);

		// Verify token inserted
		expect(selectResult.text).toBe("check this ![ext:project-analyzer] ");
		const mentions = parseMentions(selectResult.text);
		expect(mentions).toHaveLength(1);
		expect(mentions[0].kind).toBe("ext");
		expect(mentions[0].name).toBe("project-analyzer");

		// Verify auto-open triggered picker (2 tools)
		expect(selectResult.autoOpenTriggered).toBe(true);
		expect(selectResult.chipClickResult!.action).toBe("show-picker");
		expect(selectResult.chipClickResult!.tools).toHaveLength(2);
	});

	test("extension with 1 tool: type → select → form opens directly", async () => {
		const text = "!code";
		const cursor = 5;
		const trigger = detectMentionTrigger(text, cursor);
		expect(trigger).toEqual({ active: true, query: "code", type: undefined, sigil: "!" });

		mockSearchResults([
			{ name: "code-review-delegator", description: "Reviews code", kind: "extension" },
		]);
		const results = await searchMentions(trigger!.query);

		const tool = makeTool("review", { filePath: { type: "string" } });
		mockFetch(200, { tools: [tool] });
		const selectResult = await handleMentionSelectLogic(
			{ name: results[0].name, kind: "extension" },
			text,
			cursor,
			globalThis.fetch,
		);

		expect(selectResult.text).toBe("![ext:code-review-delegator] ");
		expect(selectResult.autoOpenTriggered).toBe(true);
		expect(selectResult.chipClickResult!.action).toBe("show-form");
		expect(selectResult.chipClickResult!.selectedTool!.name).toBe("review");
	});

	test("agent: type → select → no auto-open, just chip", async () => {
		const text = "ask !hel";
		const cursor = 8;
		const trigger = detectMentionTrigger(text, cursor);
		expect(trigger).toEqual({ active: true, query: "hel", type: undefined, sigil: "!" });

		mockSearchResults([
			{ name: "helper-bot", description: "Helps", kind: "agent" },
		]);
		const results = await searchMentions(trigger!.query);

		// No need to mock tools fetch — it should not be called
		const fetchSpy = mock(() => {
			throw new Error("fetch should not be called for agent mentions");
		}) as any;

		const selectResult = await handleMentionSelectLogic(
			{ name: results[0].name, kind: "agent" },
			text,
			cursor,
			fetchSpy,
		);

		expect(selectResult.text).toBe("ask ![agent:helper-bot] ");
		expect(selectResult.autoOpenTriggered).toBe(false);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test("extension with prefix filter: @ext:mark → select → auto-open", async () => {
		const text = "use !ext:mark";
		const cursor = 13;
		const trigger = detectMentionTrigger(text, cursor);
		expect(trigger).toEqual({ active: true, query: "mark", type: "ext", sigil: "!" });

		mockSearchResults([
			{ name: "markdown-utils", description: "MD tools", kind: "extension" },
		]);
		const results = await searchMentions(trigger!.query, trigger!.type);

		const tools = [makeTool("toHtml"), makeTool("toPdf")];
		mockFetch(200, { tools });
		const selectResult = await handleMentionSelectLogic(
			{ name: results[0].name, kind: "extension" },
			text,
			cursor,
			globalThis.fetch,
		);

		expect(selectResult.text).toBe("use ![ext:markdown-utils] ");
		expect(selectResult.autoOpenTriggered).toBe(true);
		expect(selectResult.chipClickResult!.action).toBe("show-picker");
	});
});

// ---------------------------------------------------------------------------
// Integration: multiple mentions with mixed types
// ---------------------------------------------------------------------------

describe("integration: multiple mentions with auto-open", () => {
	test("agent then extension: only second triggers auto-open", async () => {
		// First: agent mention (no auto-open)
		let text = "!ag";
		let cursor = 3;
		const agentResult = await handleMentionSelectLogic(
			{ name: "helper", kind: "agent" },
			text,
			cursor,
			globalThis.fetch,
		);
		expect(agentResult.autoOpenTriggered).toBe(false);
		text = agentResult.text;
		cursor = agentResult.cursor;

		// Type more, then extension mention
		text += "now use !ana";
		cursor = text.length;

		const trigger = detectMentionTrigger(text, cursor);
		expect(trigger).not.toBeNull();

		mockFetch(200, { tools: [makeTool("analyze")] });
		const extResult = await handleMentionSelectLogic(
			{ name: "analyzer", kind: "extension" },
			text,
			cursor,
			globalThis.fetch,
		);
		expect(extResult.autoOpenTriggered).toBe(true);
		expect(extResult.chipClickResult!.action).toBe("show-form");

		// Both mentions present in final text
		const mentions = parseMentions(extResult.text);
		expect(mentions).toHaveLength(2);
		expect(mentions[0].kind).toBe("agent");
		expect(mentions[1].kind).toBe("ext");
	});

	test("extension then extension: both trigger auto-open independently", async () => {
		// First extension
		mockFetch(200, { tools: [makeTool("lint")] });
		const first = await handleMentionSelectLogic(
			{ name: "linter", kind: "extension" },
			"!lin",
			4,
			globalThis.fetch,
		);
		expect(first.autoOpenTriggered).toBe(true);
		expect(first.chipClickResult!.action).toBe("show-form");

		// Second extension
		const text = first.text + "also !fmt";
		const cursor = text.length;
		mockFetch(200, { tools: [makeTool("format"), makeTool("check")] });
		const second = await handleMentionSelectLogic(
			{ name: "formatter", kind: "extension" },
			text,
			cursor,
			globalThis.fetch,
		);
		expect(second.autoOpenTriggered).toBe(true);
		expect(second.chipClickResult!.action).toBe("show-picker");
	});
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("auto-open edge cases", () => {
	test("extension with special characters in name auto-opens correctly", async () => {
		const tool = makeTool("run");
		mockFetch(200, { tools: [tool] });
		const result = await handleMentionSelectLogic(
			{ name: "my-cool.extension_v2", kind: "extension" },
			"!my",
			3,
			globalThis.fetch,
		);
		expect(result.text).toBe("![ext:my-cool.extension_v2] ");
		expect(result.autoOpenTriggered).toBe(true);
		expect(result.chipClickResult!.action).toBe("show-form");

		// Verify the fetch URL was correctly encoded
		const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;
		const calledUrl = (fetchMock as any).mock.calls[0][0];
		expect(calledUrl).toBe("/api/extensions/my-cool.extension_v2/tools");
	});

	test("API returns 500 → error state, token still inserted", async () => {
		mockFetch(500, { error: "Internal Server Error" });
		const result = await handleMentionSelectLogic(
			{ name: "buggy-ext", kind: "extension" },
			"!bug",
			4,
			globalThis.fetch,
		);
		// Token is still inserted regardless of API failure
		expect(result.text).toBe("![ext:buggy-ext] ");
		expect(result.autoOpenTriggered).toBe(true);
		// 500 is !res.ok → noop
		expect(result.chipClickResult!.action).toBe("noop");
	});

	test("segments render correctly after auto-open extension mention", async () => {
		mockFetch(200, { tools: [makeTool("scan")] });
		const result = await handleMentionSelectLogic(
			{ name: "scanner", kind: "extension" },
			"run !sca",
			8,
			globalThis.fetch,
		);
		const segments = getSegments(result.text);
		expect(segments).toEqual([
			{ type: "text", text: "run " },
			{ type: "mention", kind: "ext", name: "scanner", raw: "![ext:scanner]" },
			{ type: "text", text: " " },
		]);
	});

	test("cursor position is correct after auto-open", async () => {
		mockFetch(200, { tools: [makeTool("run")] });
		const result = await handleMentionSelectLogic(
			{ name: "runner", kind: "extension" },
			"test !run",
			9,
			globalThis.fetch,
		);
		// Cursor should be after the token + trailing space
		expect(result.text).toBe("test ![ext:runner] ");
		expect(result.cursor).toBe(result.text.length);
	});
});

// ---------------------------------------------------------------------------
// Staging behavior: form confirm stages, submit fires
// ---------------------------------------------------------------------------

interface StagedToolCall {
	extensionName: string;
	toolName: string;
	input: Record<string, unknown>;
}

/**
 * Simulates ChatInput's staging logic:
 * - handleFormConfirm stages a tool call (does NOT fire fetch)
 * - submit() calls ontoolinvoke with staged calls, then clears them
 */
class StagingSimulator {
	stagedCalls: StagedToolCall[] = [];
	invokedCalls: StagedToolCall[][] = [];

	handleFormConfirm(extensionName: string, toolName: string, input: Record<string, unknown>) {
		this.stagedCalls = [...this.stagedCalls, { extensionName, toolName, input }];
	}

	submit(text: string): string | null {
		const trimmed = text.trim();
		if (!trimmed) return null;
		if (this.stagedCalls.length > 0) {
			this.invokedCalls.push([...this.stagedCalls]);
			this.stagedCalls = [];
		}
		return trimmed;
	}
}

describe("staging: form confirm stages, submit fires", () => {
	test("form confirm does NOT immediately invoke — only stages", () => {
		const sim = new StagingSimulator();
		sim.handleFormConfirm("my-ext", "search", { query: "hello" });

		expect(sim.stagedCalls).toHaveLength(1);
		expect(sim.invokedCalls).toHaveLength(0); // nothing fired yet
	});

	test("submit fires staged calls", () => {
		const sim = new StagingSimulator();
		sim.handleFormConfirm("my-ext", "search", { query: "hello" });
		sim.submit("run ![ext:my-ext] please");

		expect(sim.stagedCalls).toHaveLength(0); // cleared
		expect(sim.invokedCalls).toHaveLength(1);
		expect(sim.invokedCalls[0]).toEqual([
			{ extensionName: "my-ext", toolName: "search", input: { query: "hello" } },
		]);
	});

	test("submit without staged calls does not invoke", () => {
		const sim = new StagingSimulator();
		sim.submit("just a message");

		expect(sim.invokedCalls).toHaveLength(0);
	});

	test("empty submit does not fire staged calls", () => {
		const sim = new StagingSimulator();
		sim.handleFormConfirm("ext", "tool", {});
		const result = sim.submit("   ");

		expect(result).toBeNull();
		expect(sim.stagedCalls).toHaveLength(1); // still staged
		expect(sim.invokedCalls).toHaveLength(0);
	});

	test("multiple staged calls fire together on submit", () => {
		const sim = new StagingSimulator();
		sim.handleFormConfirm("ext-a", "tool-1", { x: 1 });
		sim.handleFormConfirm("ext-b", "tool-2", { y: 2 });

		expect(sim.stagedCalls).toHaveLength(2);
		sim.submit("run both ![ext:ext-a] ![ext:ext-b]");

		expect(sim.stagedCalls).toHaveLength(0);
		expect(sim.invokedCalls).toHaveLength(1);
		expect(sim.invokedCalls[0]).toHaveLength(2);
	});

	test("staged calls are cleared after submit, second submit has none", () => {
		const sim = new StagingSimulator();
		sim.handleFormConfirm("ext", "tool", { a: 1 });
		sim.submit("first message");

		expect(sim.invokedCalls).toHaveLength(1);

		sim.submit("second message without tools");
		expect(sim.invokedCalls).toHaveLength(1); // no new invocation
	});
});

// ---------------------------------------------------------------------------
// E2E: full flow from mention select → form confirm → submit → invoke
// ---------------------------------------------------------------------------

describe("e2e: mention select → auto-open → form confirm → submit", () => {
	test("extension with 1 tool: select → form → confirm → submit fires tool", async () => {
		// 1. Select extension mention (auto-opens form)
		const tool = makeTool("readFile", { path: { type: "string" } });
		mockFetch(200, { tools: [tool] });
		const selectResult = await handleMentionSelectLogic(
			{ name: "file-reader", kind: "extension" },
			"!fil",
			4,
			globalThis.fetch,
		);
		expect(selectResult.chipClickResult!.action).toBe("show-form");
		expect(selectResult.chipClickResult!.selectedTool!.name).toBe("readFile");

		// 2. User fills form and confirms (stages, does not fire)
		const sim = new StagingSimulator();
		sim.handleFormConfirm("file-reader", "readFile", { path: "/src/index.ts" });
		expect(sim.stagedCalls).toHaveLength(1);
		expect(sim.invokedCalls).toHaveLength(0);

		// 3. User submits prompt → tool invocation fires
		sim.submit(selectResult.text + "read this file");
		expect(sim.invokedCalls).toHaveLength(1);
		expect(sim.invokedCalls[0][0]).toEqual({
			extensionName: "file-reader",
			toolName: "readFile",
			input: { path: "/src/index.ts" },
		});
	});

	test("extension with 2 tools: select → picker → pick → form → confirm → submit", async () => {
		// 1. Select extension (auto-opens picker)
		const tools = [makeTool("listFiles"), makeTool("readFile", { path: { type: "string" } })];
		mockFetch(200, { tools });
		const selectResult = await handleMentionSelectLogic(
			{ name: "project-analyzer", kind: "extension" },
			"!pro",
			4,
			globalThis.fetch,
		);
		expect(selectResult.chipClickResult!.action).toBe("show-picker");

		// 2. User picks readFile tool, fills form, confirms
		const sim = new StagingSimulator();
		sim.handleFormConfirm("project-analyzer", "readFile", { path: "/README.md" });

		// 3. Submit
		sim.submit(selectResult.text + "analyze this");
		expect(sim.invokedCalls[0][0]).toEqual({
			extensionName: "project-analyzer",
			toolName: "readFile",
			input: { path: "/README.md" },
		});
	});

	test("agent mention: select → no auto-open → submit with no tool calls", async () => {
		const selectResult = await handleMentionSelectLogic(
			{ name: "helper", kind: "agent" },
			"!hel",
			4,
			globalThis.fetch,
		);
		expect(selectResult.autoOpenTriggered).toBe(false);

		const sim = new StagingSimulator();
		sim.submit(selectResult.text + "help me");
		expect(sim.invokedCalls).toHaveLength(0);
	});
});
