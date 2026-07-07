import { test, expect, describe } from "bun:test";
import { canonicalProvider, PROVIDER_META } from "$lib/provider-meta.js";

// ── Pure logic extracted from ChatMessage.svelte ─────────────────────────────
//
// ChatMessage now delegates icon rendering to ProviderIcon.svelte which uses
// canonicalProvider() for alias resolution. These tests pin the behaviour of
// the shared provider-meta module as used by ChatMessage.

// ── Provider alias resolution ───────────────────────────────────────────────

describe("canonicalProvider", () => {
	test("resolves claude to anthropic", () => {
		expect(canonicalProvider("claude")).toBe("anthropic");
	});

	test("resolves gemini to google", () => {
		expect(canonicalProvider("gemini")).toBe("google");
	});

	test("passes through canonical names unchanged", () => {
		expect(canonicalProvider("anthropic")).toBe("anthropic");
		expect(canonicalProvider("openai")).toBe("openai");
		expect(canonicalProvider("google")).toBe("google");
		expect(canonicalProvider("openrouter")).toBe("openrouter");
		expect(canonicalProvider("ollama")).toBe("ollama");
	});

	test("passes through unknown providers unchanged", () => {
		expect(canonicalProvider("mystery-ai")).toBe("mystery-ai");
	});
});

describe("PROVIDER_META", () => {
	test("has metadata for all canonical providers", () => {
		expect(PROVIDER_META["anthropic"]).toBeDefined();
		expect(PROVIDER_META["openai"]).toBeDefined();
		expect(PROVIDER_META["google"]).toBeDefined();
		expect(PROVIDER_META["openrouter"]).toBeDefined();
		expect(PROVIDER_META["ollama"]).toBeDefined();
	});

	test("anthropic display name includes Claude", () => {
		expect(PROVIDER_META["anthropic"]!.name).toContain("Claude");
	});

	test("google display name includes Gemini", () => {
		expect(PROVIDER_META["google"]!.name).toContain("Gemini");
	});

	test("openrouter entry carries the BYOK metadata (no OAuth)", () => {
		const or = PROVIDER_META["openrouter"]!;
		expect(or.name).toBe("OpenRouter");
		expect(or.shortName).toBe("OpenRouter");
		expect(or.label).toBe("OR");
		expect(or.placeholder).toBe("sk-or-v1-...");
		// BYOK-only — OpenRouter has no subscription OAuth flow.
		expect(or.oauthLabel).toBe("");
	});

	test("returns undefined for unknown provider", () => {
		expect(PROVIDER_META["mystery-ai"]).toBeUndefined();
	});
});

// ── isError detection ────────────────────────────────────────────────────────

function isError(role: string, content: string): boolean {
	return (
		role === "assistant" &&
		(content.startsWith("Error:") || content.startsWith("error:"))
	);
}

describe("isError", () => {
	test("true for assistant with 'Error:' prefix", () => {
		expect(isError("assistant", "Error: something went wrong")).toBe(true);
	});

	test("true for assistant with lowercase 'error:' prefix", () => {
		expect(isError("assistant", "error: bad request")).toBe(true);
	});

	test("false for user role even with Error: prefix", () => {
		expect(isError("user", "Error: this won't be an error")).toBe(false);
	});

	test("false for system role", () => {
		expect(isError("system", "Error: system message")).toBe(false);
	});

	test("false for normal assistant message", () => {
		expect(isError("assistant", "Here is your answer.")).toBe(false);
	});

	test("false for assistant message containing error not at start", () => {
		expect(isError("assistant", "There was no error here")).toBe(false);
	});

	test("false for empty content", () => {
		expect(isError("assistant", "")).toBe(false);
	});
});

// ── providerError parsing ────────────────────────────────────────────────────

interface ProviderUnavailableError {
	type: "provider_unavailable";
	failedProvider: string;
	failedModel: string;
	suggestion: { provider: string; model: string; tier: string } | null;
	message: string;
}

function parseProviderError(
	content: string,
	errorFlag: boolean,
): ProviderUnavailableError | null {
	if (!errorFlag) return null;
	try {
		const raw = content.replace(/^[Ee]rror:\s*/, "");
		const parsed = JSON.parse(raw);
		if (parsed?.type === "provider_unavailable") {
			return parsed as ProviderUnavailableError;
		}
	} catch {
		// not JSON or wrong type
	}
	return null;
}

describe("parseProviderError", () => {
	const validPayload: ProviderUnavailableError = {
		type: "provider_unavailable",
		failedProvider: "openai",
		failedModel: "gpt-4",
		suggestion: { provider: "claude", model: "claude-3-5-sonnet", tier: "standard" },
		message: "OpenAI is down",
	};

	test("returns null when errorFlag is false", () => {
		expect(parseProviderError(JSON.stringify(validPayload), false)).toBeNull();
	});

	test("parses provider_unavailable JSON payload", () => {
		const content = JSON.stringify(validPayload);
		const result = parseProviderError(content, true);
		expect(result).not.toBeNull();
		expect(result!.type).toBe("provider_unavailable");
		expect(result!.failedProvider).toBe("openai");
		expect(result!.failedModel).toBe("gpt-4");
	});

	test("strips 'Error: ' prefix before parsing", () => {
		const content = "Error: " + JSON.stringify(validPayload);
		const result = parseProviderError(content, true);
		expect(result).not.toBeNull();
		expect(result!.failedProvider).toBe("openai");
	});

	test("strips lowercase 'error: ' prefix before parsing", () => {
		const content = "error: " + JSON.stringify(validPayload);
		const result = parseProviderError(content, true);
		expect(result).not.toBeNull();
		expect(result!.failedProvider).toBe("openai");
	});

	test("returns null for plain error text (not JSON)", () => {
		const result = parseProviderError("Error: something broke", true);
		expect(result).toBeNull();
	});

	test("returns null for JSON with wrong type", () => {
		const content = JSON.stringify({ type: "other_error", message: "oops" });
		const result = parseProviderError(content, true);
		expect(result).toBeNull();
	});

	test("parses suggestion as null when no fallback available", () => {
		const payload = { ...validPayload, suggestion: null };
		const result = parseProviderError(JSON.stringify(payload), true);
		expect(result).not.toBeNull();
		expect(result!.suggestion).toBeNull();
	});

	test("returns null for empty content even with errorFlag true", () => {
		const result = parseProviderError("", true);
		expect(result).toBeNull();
	});
});

// ── sourceCount ──────────────────────────────────────────────────────────────
// Memories have their own collapsible MemoriesCard above the response; the
// "sources used" popover now only surfaces knowledge-base chunks.

function sourceCount(
	_memoriesUsed: { id: string }[] | undefined,
	kbSourcesUsed: { id: string }[] | undefined,
): number {
	return kbSourcesUsed?.length ?? 0;
}

function hasSources(
	_memoriesUsed: { id: string }[] | undefined,
	kbSourcesUsed: { id: string }[] | undefined,
): boolean {
	return (kbSourcesUsed?.length ?? 0) > 0;
}

describe("sourceCount", () => {
	test("returns 0 when both are undefined", () => {
		expect(sourceCount(undefined, undefined)).toBe(0);
	});

	test("returns 0 when both are empty", () => {
		expect(sourceCount([], [])).toBe(0);
	});

	test("ignores memories (they render as their own card)", () => {
		expect(sourceCount([{ id: "m1" }, { id: "m2" }], undefined)).toBe(0);
	});

	test("counts kb sources only", () => {
		expect(sourceCount(undefined, [{ id: "k1" }])).toBe(1);
	});

	test("counts kb sources even when memories are present", () => {
		expect(sourceCount([{ id: "m1" }], [{ id: "k1" }, { id: "k2" }])).toBe(2);
	});
});

describe("hasSources", () => {
	test("false when both undefined", () => {
		expect(hasSources(undefined, undefined)).toBe(false);
	});

	test("false when both empty", () => {
		expect(hasSources([], [])).toBe(false);
	});

	test("false when only memories present (memories have their own card)", () => {
		expect(hasSources([{ id: "m1" }], [])).toBe(false);
	});

	test("true when kb sources present", () => {
		expect(hasSources([], [{ id: "k1" }])).toBe(true);
	});

	test("true when kb sources present alongside memories", () => {
		expect(hasSources([{ id: "m1" }], [{ id: "k1" }])).toBe(true);
	});
});

// ── usageTitle ───────────────────────────────────────────────────────────────

function usageTitle(
	usage: { inputTokens: number; outputTokens: number } | null | undefined,
): string | undefined {
	return usage
		? `Input: ${usage.inputTokens} tokens | Output: ${usage.outputTokens} tokens`
		: undefined;
}

describe("usageTitle", () => {
	test("returns undefined for null usage", () => {
		expect(usageTitle(null)).toBeUndefined();
	});

	test("returns undefined for undefined usage", () => {
		expect(usageTitle(undefined)).toBeUndefined();
	});

	test("formats usage correctly", () => {
		expect(usageTitle({ inputTokens: 100, outputTokens: 200 })).toBe(
			"Input: 100 tokens | Output: 200 tokens",
		);
	});

	test("handles zero tokens", () => {
		expect(usageTitle({ inputTokens: 0, outputTokens: 0 })).toBe(
			"Input: 0 tokens | Output: 0 tokens",
		);
	});

	test("handles large token counts", () => {
		expect(usageTitle({ inputTokens: 128000, outputTokens: 8192 })).toBe(
			"Input: 128000 tokens | Output: 8192 tokens",
		);
	});
});

// ── isStreaming / displayContent ─────────────────────────────────────────────

function getIsStreaming(
	streamingText: string | undefined,
	streamingStatus: string | undefined,
): boolean {
	return streamingText !== undefined || streamingStatus !== undefined;
}

function getDisplayContent(
	streamingText: string | undefined,
	messageContent: string,
): string {
	return streamingText || messageContent;
}

describe("getIsStreaming", () => {
	test("true when streamingText is set", () => {
		expect(getIsStreaming("hello", undefined)).toBe(true);
	});

	test("true when streamingStatus is set", () => {
		expect(getIsStreaming(undefined, "Thinking...")).toBe(true);
	});

	test("true when both are set", () => {
		expect(getIsStreaming("hello", "Thinking...")).toBe(true);
	});

	test("false when both are undefined", () => {
		expect(getIsStreaming(undefined, undefined)).toBe(false);
	});

	test("true when streamingText is empty string (explicitly set)", () => {
		// Empty string is different from undefined — streaming has started
		expect(getIsStreaming("", undefined)).toBe(true);
	});
});

describe("getDisplayContent", () => {
	test("returns streamingText when it exists", () => {
		expect(getDisplayContent("streaming content", "saved content")).toBe("streaming content");
	});

	test("returns message content when streamingText is undefined", () => {
		expect(getDisplayContent(undefined, "saved content")).toBe("saved content");
	});

	test("falls back to message content when streamingText is empty string", () => {
		// empty string is falsy → falls back
		expect(getDisplayContent("", "saved content")).toBe("saved content");
	});
});

// ── tooltipForMention ────────────────────────────────────────────────────────

type InlineToolCall = {
	extensionName: string;
	toolName: string;
	input: Record<string, unknown>;
};

function tooltipForMention(
	mentionName: string,
	inlineToolCalls: InlineToolCall[] | undefined,
): string | undefined {
	if (!inlineToolCalls?.length) return undefined;
	const matches = inlineToolCalls.filter((c) => c.extensionName === mentionName);
	if (!matches.length) return undefined;
	return matches
		.map((c) => {
			const inputs = Object.entries(c.input)
				.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
				.join("\n");
			return `Tool: ${c.toolName}${inputs ? "\n" + inputs : ""}`;
		})
		.join("\n\n");
}

describe("tooltipForMention", () => {
	test("returns undefined when inlineToolCalls is undefined", () => {
		expect(tooltipForMention("MyExt", undefined)).toBeUndefined();
	});

	test("returns undefined when inlineToolCalls is empty", () => {
		expect(tooltipForMention("MyExt", [])).toBeUndefined();
	});

	test("returns undefined when no calls match the extension name", () => {
		const calls: InlineToolCall[] = [
			{ extensionName: "OtherExt", toolName: "search", input: {} },
		];
		expect(tooltipForMention("MyExt", calls)).toBeUndefined();
	});

	test("returns tooltip for a single matching call with no input", () => {
		const calls: InlineToolCall[] = [
			{ extensionName: "MyExt", toolName: "run_query", input: {} },
		];
		expect(tooltipForMention("MyExt", calls)).toBe("Tool: run_query");
	});

	test("includes string inputs verbatim", () => {
		const calls: InlineToolCall[] = [
			{
				extensionName: "MyExt",
				toolName: "search",
				input: { query: "hello world" },
			},
		];
		expect(tooltipForMention("MyExt", calls)).toBe("Tool: search\nquery: hello world");
	});

	test("JSON-serialises non-string input values", () => {
		const calls: InlineToolCall[] = [
			{
				extensionName: "MyExt",
				toolName: "filter",
				input: { limit: 10, active: true },
			},
		];
		const result = tooltipForMention("MyExt", calls);
		expect(result).toContain("limit: 10");
		expect(result).toContain("active: true");
	});

	test("joins multiple matching calls with double newline", () => {
		const calls: InlineToolCall[] = [
			{ extensionName: "MyExt", toolName: "search", input: { q: "foo" } },
			{ extensionName: "MyExt", toolName: "filter", input: { n: 5 } },
		];
		const result = tooltipForMention("MyExt", calls);
		expect(result).toContain("Tool: search");
		expect(result).toContain("Tool: filter");
		expect(result).toContain("\n\n");
	});

	test("only matches calls for the specified extension", () => {
		const calls: InlineToolCall[] = [
			{ extensionName: "ExtA", toolName: "toolA", input: {} },
			{ extensionName: "ExtB", toolName: "toolB", input: {} },
		];
		expect(tooltipForMention("ExtA", calls)).toBe("Tool: toolA");
		expect(tooltipForMention("ExtB", calls)).toBe("Tool: toolB");
	});
});
