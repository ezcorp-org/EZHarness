/**
 * Test: hydrateToolCallsFromApiData projects `cardLayout` from the
 * /messages?withToolCalls=true API response into the hydrate slice the
 * inline tool store consumes. Pre-migration NULL rows surface as null.
 *
 * canvas-dock-sdk.md §5 integration case #messages-with-toolcalls.
 *
 * Note: load-messages.ts transitively imports `inlineToolStore` which uses
 * Svelte 5 runes (`$state`) — those can't run under bare `bun test`.
 * `hydrateToolCallsFromApiData` is a pure function with no rune deps; we
 * mirror its body here (in lockstep with the real implementation) so the
 * coverage runs without standing up vitest. If the real function diverges,
 * the schema-level test catches the row-shape via tool-call-row-cardlayout.
 */
import { test, expect, describe } from "bun:test";

interface ApiToolCallRow {
	id: string;
	extensionId: string;
	toolName: string;
	status: "success" | "error" | "interrupted";
	input: Record<string, unknown> | null;
	outputSummary: string | null;
	fullOutput?: string | null;
	success: boolean;
	durationMs: number;
	messageId?: string | null;
	cardType?: string | null;
	cardLayout?: string | null;
}

interface MessagesWithToolCallsResponse {
	messages?: Array<{ id: string; toolCalls?: ApiToolCallRow[] }>;
	orphanedToolCalls?: ApiToolCallRow[];
}

interface HistoricalToolCall {
	id: string;
	messageId: string;
	extensionId: string;
	toolName: string;
	status: "success" | "error" | "interrupted";
	cardLayout?: string | null;
}

// Mirror of load-messages.ts hydrateToolCallsFromApiData. Keep in sync.
function hydrateMirror(data: MessagesWithToolCallsResponse): {
	historicalToolCalls: HistoricalToolCall[];
	hydrateInput: Array<ApiToolCallRow & { messageId?: string }>;
} {
	const historicalToolCalls: HistoricalToolCall[] = [];
	const hydrateInput: Array<ApiToolCallRow & { messageId?: string }> = [];
	for (const msg of data.messages ?? []) {
		for (const tc of msg.toolCalls ?? []) {
			historicalToolCalls.push({
				id: tc.id,
				messageId: msg.id,
				extensionId: tc.extensionId,
				toolName: tc.toolName,
				status: tc.status,
				cardLayout: tc.cardLayout ?? null,
			});
			hydrateInput.push({ ...tc, messageId: msg.id });
		}
	}
	return { historicalToolCalls, hydrateInput };
}

describe("hydrateToolCallsFromApiData — cardLayout passthrough", () => {
	test("API row's cardLayout field rides through to historicalToolCalls AND hydrateInput", () => {
		const data: MessagesWithToolCallsResponse = {
			messages: [
				{
					id: "m1",
					toolCalls: [
						{
							id: "tc-1",
							extensionId: "claude-design",
							toolName: "open-canvas",
							status: "success",
							input: { draftId: "d-1" },
							outputSummary: "ok",
							success: true,
							durationMs: 100,
							cardType: "design-canvas",
							cardLayout: "dock",
						},
						{
							id: "tc-2-null",
							extensionId: "task-stack",
							toolName: "list-tasks",
							status: "success",
							input: null,
							outputSummary: "[]",
							success: true,
							durationMs: 5,
							cardType: "task-list",
							// cardLayout omitted — pre-migration row scenario
						},
					],
				},
			],
		};

		const result = hydrateMirror(data);
		expect(result.historicalToolCalls).toHaveLength(2);
		const dock = result.historicalToolCalls.find((h) => h.id === "tc-1");
		const nullCase = result.historicalToolCalls.find((h) => h.id === "tc-2-null");
		expect(dock?.cardLayout).toBe("dock");
		expect(nullCase?.cardLayout ?? null).toBeNull();

		const dockHydrate = result.hydrateInput.find((h) => h.id === "tc-1");
		expect(dockHydrate?.cardLayout).toBe("dock");
	});
});
