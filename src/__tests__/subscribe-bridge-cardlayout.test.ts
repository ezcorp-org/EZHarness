/**
 * subscribe-bridge fans out `cardLayout` on tool:start / tool:complete
 * events and persists it on the tool_calls row.
 *
 * canvas-dock-sdk.md §5 integration case #subscribe-bridge.
 *
 * Strategy: stand up a fake pi-Agent stub that exposes `.subscribe(fn)`,
 * register an extension tool with cardLayout="dock", then drive
 * `subscribeBridge` against the fake and synthesize tool_execution_start /
 * tool_execution_end events. Capture bus emits + persistToolCall calls
 * via mock.module + a closure-bound bus.
 */
import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// Capture-bag for persistToolCall calls.
const persisted: Array<Record<string, unknown>> = [];

mock.module("../db/queries/tool-calls", () => ({
	persistToolCall: async (row: Record<string, unknown>) => {
		persisted.push(row);
	},
	listToolCallOutputsForMessages: async () => [],
	getToolCallConversationById: async () => null,
}));
mock.module("../db/connection", () => ({
	getDb: () => ({
		update: () => ({ set: () => ({ where: async () => {} }) }),
	}),
}));
mock.module("../db/queries/extensions", () => ({
	listExtensions: async () => [],
}));

afterAll(() => restoreModuleMocks());

import { subscribeBridge } from "../runtime/stream-chat/subscribe-bridge";
import type { StreamChatContext } from "../runtime/stream-chat/context";
import type { StreamChatHost } from "../runtime/stream-chat/host";
import { ExtensionRegistry } from "../extensions/registry";

interface EmittedEvent { name: string; data: any }

function makeBus(emits: EmittedEvent[]) {
	return {
		emit: (name: string, data: any) => { emits.push({ name, data }); },
		on: () => () => {},
	} as any;
}

function makePiAgent() {
	let cb: (e: any) => void = () => {};
	return {
		subscribe(fn: (e: any) => void) {
			cb = fn;
			return () => {};
		},
		fire(e: any) { cb(e); },
	};
}

beforeEach(() => {
	persisted.length = 0;
	ExtensionRegistry.resetInstance();
});

describe("validation: subscribeBridge — clarify-brief tool propagation", () => {
	test("clarify-brief tool start/complete fan-out + persist with cardType=design-brief", async () => {
		// The new `claude-design:clarify-brief` form-card tool must round-trip
		// through subscribeBridge the same way knob-changing does. Without
		// this, the brief card never renders in chat. Mirrors the dock-mode
		// case below but locks in cardType="design-brief".
		const registry = ExtensionRegistry.getInstance();
		registry.registerToolForTest("claude-design__clarify-brief", {
			name: "claude-design__clarify-brief",
			description: "Open a structured-brief form card",
			inputSchema: { type: "object" },
			cardType: "design-brief",
			extensionId: "ext-cd",
			extensionName: "claude-design",
			originalName: "clarify-brief",
		});

		const emits: EmittedEvent[] = [];
		const bus = makeBus(emits);
		const piAgent = makePiAgent();
		const ctx: StreamChatContext = {
			run: { id: "run-1" } as any,
			controller: new AbortController(),
			system: undefined,
			agentTools: [],
			toolAbortControllers: new Map(),
			builtinToolDefsMap: new Map(),
			unsubModeChange: undefined,
			allTurnsText: "",
			turnText: "",
			turnThinking: "",
			turnHasToolCalls: false,
			pendingToolArgs: new Map(),
			unsub: undefined,
			unsubAgentActivity: [],
			lastSavedMessageId: null,
			dbQueue: Promise.resolve(),
			totalUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as any,
		} as unknown as StreamChatContext;
		const host: StreamChatHost = {
			bus,
			persist: true,
			pendingPermissions: new Map(),
			controllers: new Map(),
			runConversations: new Map(),
			activeAgents: new Map(),
			runs: new Map(),
			watchdog: {
				bumpActivity: () => {},
				noteToolStart: () => {},
				noteToolEnd: () => {},
			} as any,
			stateMediator: undefined,
			spawnQuota: {} as any,
			executor: {} as any,
		};
		subscribeBridge(ctx, host, piAgent as any, "conv-1", {}, null);

		piAgent.fire({ type: "turn_start" });
		piAgent.fire({
			type: "tool_execution_start",
			toolCallId: "tc-brief-1",
			toolName: "claude-design__clarify-brief",
			args: { fields: [{ key: "tone", label: "Tone", kind: "text" }] },
		});
		piAgent.fire({
			type: "tool_execution_end",
			toolCallId: "tc-brief-1",
			toolName: "claude-design__clarify-brief",
			isError: false,
			result: {
				content: [{ type: "text", text: JSON.stringify({ tone: "modern" }) }],
			},
		});

		const startEvt = emits.find((e) => e.name === "tool:start");
		const completeEvt = emits.find((e) => e.name === "tool:complete");
		expect(startEvt).toBeDefined();
		expect(completeEvt).toBeDefined();
		expect(startEvt!.data.cardType).toBe("design-brief");
		expect(completeEvt!.data.cardType).toBe("design-brief");

		await ctx.dbQueue;
		const row = persisted.find((r) => r.id === "tc-brief-1");
		expect(row).toBeDefined();
		expect(row!.cardType).toBe("design-brief");
	});
});

describe("subscribeBridge — cardLayout fan-out", () => {
	test('extension tool with cardLayout: "dock" → events carry cardLayout AND persistToolCall is called with it', async () => {
		const registry = ExtensionRegistry.getInstance();
		registry.registerToolForTest("claude-design__open-canvas", {
			name: "claude-design__open-canvas",
			description: "Open canvas",
			inputSchema: { type: "object" },
			cardType: "design-canvas",
			cardLayout: "dock",
			extensionId: "ext-cd",
			extensionName: "claude-design",
			originalName: "open-canvas",
		});

		const emits: EmittedEvent[] = [];
		const bus = makeBus(emits);
		const piAgent = makePiAgent();
		const ctx: StreamChatContext = {
			run: { id: "run-1" } as any,
			controller: new AbortController(),
			system: undefined,
			agentTools: [],
			toolAbortControllers: new Map(),
			builtinToolDefsMap: new Map(),
			unsubModeChange: undefined,
			allTurnsText: "",
			turnText: "",
			turnThinking: "",
			turnHasToolCalls: false,
			pendingToolArgs: new Map(),
			unsub: undefined,
			unsubAgentActivity: [],
			lastSavedMessageId: null,
			dbQueue: Promise.resolve(),
			totalUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as any,
		} as unknown as StreamChatContext;

		const host: StreamChatHost = {
			bus,
			persist: true,
			pendingPermissions: new Map(),
			controllers: new Map(),
			runConversations: new Map(),
			activeAgents: new Map(),
			runs: new Map(),
			watchdog: {
				bumpActivity: () => {},
				noteToolStart: () => {},
				noteToolEnd: () => {},
			} as any,
			stateMediator: undefined,
			spawnQuota: {} as any,
			executor: {} as any,
		};

		subscribeBridge(ctx, host, piAgent as any, "conv-1", {}, null);

		// Synthesize a complete cycle.
		piAgent.fire({ type: "turn_start" });
		piAgent.fire({
			type: "tool_execution_start",
			toolCallId: "tc-1",
			toolName: "claude-design__open-canvas",
			args: { draftId: "d-1" },
		});
		piAgent.fire({
			type: "tool_execution_end",
			toolCallId: "tc-1",
			toolName: "claude-design__open-canvas",
			isError: false,
			result: { content: [{ type: "text", text: "ok" }] },
		});

		const startEvt = emits.find((e) => e.name === "tool:start");
		const completeEvt = emits.find((e) => e.name === "tool:complete");
		expect(startEvt, "tool:start emitted").toBeDefined();
		expect(completeEvt, "tool:complete emitted").toBeDefined();
		expect(startEvt!.data.cardLayout).toBe("dock");
		expect(completeEvt!.data.cardLayout).toBe("dock");

		// Drain the dbQueue so the persistToolCall promise lands.
		await ctx.dbQueue;

		const row = persisted.find((r) => r.id === "tc-1");
		expect(row, "persistToolCall called for the tool").toBeDefined();
		expect(row!.cardLayout).toBe("dock");
	});
});
