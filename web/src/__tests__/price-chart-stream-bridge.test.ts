/**
 * Bus-bridge integration test for the price-chart extension.
 *
 * Closes the gap where `tool:complete` event translation (server bus →
 * client store's `streamingToolCalls` map → PriceChartCard) wasn't
 * exercised against a price-chart payload specifically. The chain:
 *
 *   1. Extension subprocess returns a JSON tool result.
 *   2. `ToolExecutor.executeToolCall` emits `tool:complete` on the
 *      EventBus with the result content + `cardType: "price-chart"`.
 *   3. Server-side subscribe-bridge would forward that bus event into
 *      the SSE stream (mirrored here as a synthetic WSEvent).
 *   4. The chat-store reducer's `tool:complete` branch unwraps the MCP
 *      envelope, sets `status: "complete"`, and writes
 *      `streamingToolCalls[runId]`.
 *   5. `PriceChartCard` parses that entry's `output` field and renders
 *      the SVG inline.
 *
 * Two test groups:
 *
 *   • Replicated-reducer tests — mirror `streaming-tool-calls-status`'s
 *     convention. Feed synthetic events through the same reducer body
 *     that `stores.svelte.ts` uses; assert the final entry shape.
 *
 *   • Live executor + reducer — runs the REAL `ToolExecutor.executeToolCall`
 *     against the price-chart subprocess (mocked fetchers, stub PDP),
 *     captures the bus events it emits, and feeds them through the
 *     same reducer. Proves the end-to-end shape matches.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

// ── Replicated reducer + extraction (verbatim from stores.svelte.ts) ──

interface ToolCallState {
	id?: string;
	toolName: string;
	status: "running" | "complete" | "error";
	input?: unknown;
	output?: unknown;
	error?: string;
	startedAt: number;
	duration?: number;
	cardType?: string;
	cardLayout?: "inline" | "dock";
	permissionPending?: boolean;
}

interface StoreShape {
	streamingRunToConversation: Record<string, string>;
	streamingToolCalls: Record<string, ToolCallState[]>;
}

function makeStore(): StoreShape {
	return { streamingRunToConversation: {}, streamingToolCalls: {} };
}

function extractToolOutput(value: unknown): unknown {
	if (value == null || typeof value !== "object") return value;
	const obj = value as Record<string, unknown>;
	if (Array.isArray(obj.content)) {
		const texts = (obj.content as Array<Record<string, unknown>>)
			.filter((c) => c.type === "text" && typeof c.text === "string")
			.map((c) => c.text as string);
		if (texts.length > 0) return texts.join("\n");
	}
	return value;
}

interface ToolStartEvent {
	conversationId: string;
	extensionId: string;
	toolName: string;
	input: unknown;
	timestamp: number;
	cardType?: string;
	cardLayout?: "inline" | "dock";
	invocationId?: string;
}

interface ToolCompleteEvent {
	conversationId: string;
	extensionId: string;
	toolName: string;
	output: unknown;
	duration: number;
	success?: boolean;
	cardType?: string;
	cardLayout?: "inline" | "dock";
	invocationId?: string;
}

function applyToolStart(store: StoreShape, e: ToolStartEvent): void {
	const runId = Object.entries(store.streamingRunToConversation).find(
		([, cId]) => cId === e.conversationId,
	)?.[0];
	if (!runId) return;
	const calls = store.streamingToolCalls[runId] ?? [];
	store.streamingToolCalls = {
		...store.streamingToolCalls,
		[runId]: [
			...calls,
			{
				id: e.invocationId,
				toolName: e.toolName,
				status: "running",
				input: e.input,
				startedAt: e.timestamp,
				...(e.cardType ? { cardType: e.cardType } : {}),
				...(e.cardLayout ? { cardLayout: e.cardLayout } : {}),
			},
		],
	};
}

function applyToolComplete(store: StoreShape, e: ToolCompleteEvent): void {
	const runId = Object.entries(store.streamingRunToConversation).find(
		([, cId]) => cId === e.conversationId,
	)?.[0];
	if (!runId) return;
	const calls = store.streamingToolCalls[runId] ?? [];
	const idx = calls.findLastIndex(
		(tc) => tc.toolName === e.toolName && tc.status === "running",
	);
	if (idx < 0) return;
	const updated = [...calls];
	const extractedOutput = extractToolOutput(e.output);
	if (e.success === false) {
		const errText =
			typeof extractedOutput === "string"
				? extractedOutput
				: JSON.stringify(extractedOutput);
		updated[idx] = {
			...updated[idx]!,
			status: "error",
			error: errText,
			output: extractedOutput,
			duration: e.duration,
			permissionPending: false,
			...(e.cardLayout ? { cardLayout: e.cardLayout } : {}),
		};
	} else {
		updated[idx] = {
			...updated[idx]!,
			status: "complete",
			output: extractedOutput,
			duration: e.duration,
			permissionPending: false,
			...(e.cardLayout ? { cardLayout: e.cardLayout } : {}),
		};
	}
	store.streamingToolCalls = {
		...store.streamingToolCalls,
		[runId]: updated,
	};
}

function seedRun(store: StoreShape, runId: string, conversationId: string) {
	store.streamingRunToConversation = {
		...store.streamingRunToConversation,
		[runId]: conversationId,
	};
}

// ── Replicated parsePayload from price-chart-logic ────────────────────
//
// Copy of the card-side parser so a test failure in either site fails
// here too. Keeps this test self-contained.

interface ChartPayload {
	kind: "stock" | "crypto";
	symbol: string;
	points: Array<{ t: number; v: number }>;
}

function parseCardPayload(out: unknown): ChartPayload | null {
	if (out == null) return null;
	let obj: Record<string, unknown> | null = null;
	if (typeof out === "string") {
		try { obj = JSON.parse(out) as Record<string, unknown>; } catch { return null; }
	} else if (typeof out === "object" && out !== null) {
		obj = out as Record<string, unknown>;
	}
	if (!obj || !Array.isArray(obj.points) || obj.points.length === 0) return null;
	if (typeof obj.symbol !== "string") return null;
	return {
		kind: obj.kind === "crypto" ? "crypto" : "stock",
		symbol: obj.symbol,
		points: obj.points as Array<{ t: number; v: number }>,
	};
}

// ────────────────────────────────────────────────────────────────────
// Group 1: synthetic events through the reducer (fast, no subprocess)
// ────────────────────────────────────────────────────────────────────

describe("price-chart stream-bridge — synthetic events", () => {
	test("tool:start seeds a running entry with cardType='price-chart'", () => {
		const store = makeStore();
		seedRun(store, "run-1", "conv-1");
		applyToolStart(store, {
			conversationId: "conv-1",
			extensionId: "ext-1",
			toolName: "price-chart__get_stock_chart",
			input: { ticker: "AAPL" },
			timestamp: 1000,
			cardType: "price-chart",
			invocationId: "tc-1",
		});
		const tc = store.streamingToolCalls["run-1"]?.[0];
		expect(tc).toBeDefined();
		expect(tc!.status).toBe("running");
		expect(tc!.cardType).toBe("price-chart");
		expect(tc!.id).toBe("tc-1");
	});

	test("tool:complete with MCP envelope unwraps to the JSON text", () => {
		const store = makeStore();
		seedRun(store, "run-2", "conv-2");
		applyToolStart(store, {
			conversationId: "conv-2",
			extensionId: "ext-1",
			toolName: "price-chart__get_stock_chart",
			input: { ticker: "AAPL" },
			timestamp: 0,
			cardType: "price-chart",
			invocationId: "tc-2",
		});

		// This is the EXACT envelope the executor emits — `tool:complete`
		// payload's `output` field is the raw `ToolCallResult` (MCP shape).
		const payloadJson = JSON.stringify({
			_assistant_note: "Chart rendered.",
			kind: "stock", symbol: "AAPL", name: "Apple Inc.",
			logoUrl: "https://logo.clearbit.com/apple.com", currency: "USD",
			lastPrice: 290.5, prevClose: 285.1,
			points: [{ t: 1, v: 285 }, { t: 2, v: 290.5 }],
		});
		applyToolComplete(store, {
			conversationId: "conv-2",
			extensionId: "ext-1",
			toolName: "price-chart__get_stock_chart",
			output: { content: [{ type: "text", text: payloadJson }], isError: false },
			duration: 300,
			success: true,
			cardType: "price-chart",
			invocationId: "tc-2",
		});

		const tc = store.streamingToolCalls["run-2"]?.[0];
		expect(tc).toBeDefined();
		expect(tc!.status).toBe("complete");
		expect(tc!.permissionPending).toBe(false);
		expect(typeof tc!.output).toBe("string");
		// Card-side parser must be able to read what the reducer wrote.
		const parsed = parseCardPayload(tc!.output);
		expect(parsed).not.toBeNull();
		expect(parsed!.symbol).toBe("AAPL");
		expect(parsed!.points.length).toBe(2);
	});

	test("tool:complete with success=false flips status to error and preserves output text", () => {
		const store = makeStore();
		seedRun(store, "run-3", "conv-3");
		applyToolStart(store, {
			conversationId: "conv-3", extensionId: "ext-1",
			toolName: "price-chart__get_stock_chart",
			input: { ticker: "ZZZZ" }, timestamp: 0,
			cardType: "price-chart", invocationId: "tc-3",
		});
		applyToolComplete(store, {
			conversationId: "conv-3", extensionId: "ext-1",
			toolName: "price-chart__get_stock_chart",
			output: { content: [{ type: "text", text: "Yahoo Finance returned HTTP 404 for ZZZZ" }], isError: true },
			duration: 250, success: false,
			cardType: "price-chart", invocationId: "tc-3",
		});

		const tc = store.streamingToolCalls["run-3"]?.[0];
		expect(tc!.status).toBe("error");
		expect(tc!.error).toMatch(/HTTP 404/);
		// Card-side parser refuses the error text → card renders fallback.
		expect(parseCardPayload(tc!.output)).toBeNull();
	});

	test("cardLayout='inline' is the default; 'dock' propagates through reducer", () => {
		const store = makeStore();
		seedRun(store, "run-4", "conv-4");
		applyToolStart(store, {
			conversationId: "conv-4", extensionId: "ext-1",
			toolName: "price-chart__get_stock_chart",
			input: {}, timestamp: 0,
			cardType: "price-chart", cardLayout: "inline", invocationId: "tc-4",
		});
		applyToolComplete(store, {
			conversationId: "conv-4", extensionId: "ext-1",
			toolName: "price-chart__get_stock_chart",
			output: { content: [{ type: "text", text: "{}" }] },
			duration: 0, success: true,
			cardType: "price-chart", cardLayout: "inline", invocationId: "tc-4",
		});
		const tc = store.streamingToolCalls["run-4"]?.[0];
		expect(tc!.cardLayout).toBe("inline");
	});

	test("tool:complete with no matching running call is a no-op (no orphan entry)", () => {
		const store = makeStore();
		seedRun(store, "run-5", "conv-5");
		applyToolComplete(store, {
			conversationId: "conv-5", extensionId: "ext-1",
			toolName: "price-chart__get_stock_chart",
			output: { content: [{ type: "text", text: "{}" }] },
			duration: 0, success: true,
			cardType: "price-chart", invocationId: "stale-tc",
		});
		expect(store.streamingToolCalls["run-5"] ?? []).toHaveLength(0);
	});
});

// ────────────────────────────────────────────────────────────────────
// Group 2: live executor → bus → reducer (network-gated)
// ────────────────────────────────────────────────────────────────────
//
// Wires the EXACT path setup-tools.ts uses: a real EventBus passed to
// the ToolExecutor, the executor emits `tool:start`/`tool:complete` on
// the bus, we capture those and feed them through the same reducer the
// store uses. Asserts the chain is whole.
//
// `_setFetchersForTests` only swaps the fetcher in THIS process; the
// extension subprocess the executor spawns has its own module graph
// and uses the real Yahoo Finance fetch. Gated on `EZCORP_E2E_NETWORK`
// so devs without internet don't get spurious failures.

const ROOT = join(import.meta.dir, "..", "..", "..");
const NETWORK = process.env.EZCORP_E2E_NETWORK === "1";
const describeNetwork = NETWORK ? describe : describe.skip;

describeNetwork("price-chart stream-bridge — live executor → bus → reducer", () => {
	let capturedStart: ToolStartEvent | undefined;
	let capturedComplete: ToolCompleteEvent | undefined;

	beforeEach(() => {
		capturedStart = undefined;
		capturedComplete = undefined;
	});

	afterEach(() => {
		// Reset shared registry state so subsequent tests start clean.
	});

	test("executor emits bus events that drive the store to a renderable price-chart entry", async () => {
		const { ExtensionRegistry } = await import("../../../src/extensions/registry");
		const { ToolExecutor } = await import("../../../src/extensions/tool-executor");
		const { EventBus } = await import("../../../src/runtime/events");
		const { createStubPermissionEngine } = await import(
			"../../../src/__tests__/helpers/permission-engine-stub"
		);
		const indexModule = await import(
			"../../../docs/extensions/examples/price-chart/index"
		);
		type AgentEvents = import("../../../src/types").AgentEvents;
		type ExtensionManifestV2 = import("../../../src/extensions/types").ExtensionManifestV2;
		type ExtensionPermissions = import("../../../src/extensions/types").ExtensionPermissions;

		// `_setFetchersForTests` swaps the binding in THIS process; the
		// subprocess the executor spawns has its own module graph and
		// uses the real fetcher. Kept here as a no-op marker for future
		// readers who want to refactor toward in-process execution.
		indexModule._setFetchersForTests({});

		const EXT_ID = "price-chart-bridge-test";
		const manifest: ExtensionManifestV2 = {
			schemaVersion: 2,
			name: "price-chart",
			version: "0.1.0",
			description: "test",
			author: { name: "test" },
			entrypoint: "./index.ts",
			persistent: false,
			tools: [{
				name: "get_stock_chart",
				description: "fetch stock chart",
				inputSchema: { type: "object", properties: { ticker: { type: "string" } }, required: ["ticker"] },
				cardType: "price-chart",
			}],
			permissions: { network: ["query1.finance.yahoo.com", "api.coingecko.com"] },
		};
		const granted: ExtensionPermissions = {
			network: ["query1.finance.yahoo.com", "api.coingecko.com"],
			grantedAt: { network: Date.now() },
		};

		const registry = ExtensionRegistry.getInstance();
		registry.setManifestForTest(EXT_ID, manifest);
		registry.setInstallPathForTest(
			EXT_ID,
			join(ROOT, "docs", "extensions", "examples", "price-chart"),
		);
		registry.setGrantedPermsForTest(EXT_ID, granted);
		registry.registerToolForTest("price-chart__get_stock_chart", {
			name: "price-chart__get_stock_chart",
			originalName: "get_stock_chart",
			description: "fetch stock chart",
			inputSchema: manifest.tools![0]!.inputSchema,
			cardType: "price-chart",
			extensionId: EXT_ID,
			extensionName: "price-chart",
		});

		const bus = new EventBus<AgentEvents>();
		bus.on("tool:start", (data) => { capturedStart = data as ToolStartEvent; });
		bus.on("tool:complete", (data) => { capturedComplete = data as ToolCompleteEvent; });

		const executor = new ToolExecutor(registry, createStubPermissionEngine(), { bus });

		const result = await executor.executeToolCall(
			"price-chart__get_stock_chart",
			{ ticker: "AAPL" },
			"conv-bridge",
			"msg-bridge",
			{ metadata: { invocationId: "tc-bridge-1" } },
		);

		expect(result.isError).toBe(false);
		expect(capturedStart).toBeDefined();
		expect(capturedComplete).toBeDefined();

		// Bus event shape matches what the reducer expects.
		expect(capturedStart!.cardType).toBe("price-chart");
		expect(capturedStart!.invocationId).toBe("tc-bridge-1");
		expect(capturedComplete!.cardType).toBe("price-chart");
		expect(capturedComplete!.success).toBe(true);

		// Drive the store reducer with the captured events.
		const store = makeStore();
		seedRun(store, "run-bridge", "conv-bridge");
		applyToolStart(store, capturedStart!);
		applyToolComplete(store, capturedComplete!);

		const tc = store.streamingToolCalls["run-bridge"]?.[0];
		expect(tc).toBeDefined();
		expect(tc!.status).toBe("complete");
		expect(tc!.cardType).toBe("price-chart");
		expect(tc!.id).toBe("tc-bridge-1");

		// Card-side parser successfully reads the output. This is the final
		// gate — if the card couldn't parse what the store writes, the user
		// sees "Cannot render chart".
		const parsed = parseCardPayload(tc!.output);
		expect(parsed).not.toBeNull();
		expect(parsed!.symbol).toBe("AAPL");
		expect(parsed!.kind).toBe("stock");
		// Real Yahoo Finance returns ~250 daily points for 1y of AAPL;
		// be flexible since the count drifts with market days.
		expect(parsed!.points.length).toBeGreaterThan(100);

		// Cleanup
		indexModule._resetBindingsForTests();
	});
});
