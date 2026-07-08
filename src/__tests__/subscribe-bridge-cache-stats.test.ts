/**
 * WS0 — subscribe-bridge prompt-cache observability.
 *
 * `turn_end` must (a) persist the per-turn cache meter onto the assistant
 * message's `usage` (cacheReadTokens / cacheWriteTokens / cacheHitRate) via the
 * EXISTING createMessage usage path, and (b) emit the raw usage on `run:usage`.
 * Mirrors subscribe-bridge-turn-saved-final.test.ts: fake pi-Agent stub,
 * closure-bound bus, mocked DB writes; drive turn_start → turn_end and inspect
 * the createMessage payload the bridge queued.
 */
import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

const createMessageCalls: Array<{ conversationId: string; data: any }> = [];

mock.module("../db/queries/conversations", () => ({
	createMessage: async (conversationId: string, data: any) => {
		createMessageCalls.push({ conversationId, data });
		return { id: `msg-${createMessageCalls.length}` };
	},
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
		subscribe(fn: (e: any) => void) { cb = fn; return () => {}; },
		fire(e: any) { cb(e); },
	};
}

function makeCtx(): StreamChatContext {
	return {
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
}

function makeHost(bus: any): StreamChatHost {
	return {
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
		errorMessagePersisted: new Set<string>(),
		permissionEngine: {} as any,
	};
}

function assistantTurn(usage: { input: number; output: number; cacheRead: number; cacheWrite: number }) {
	return {
		type: "turn_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "the answer" }],
			usage,
		},
	};
}

beforeEach(() => {
	createMessageCalls.length = 0;
	ExtensionRegistry.resetInstance();
});

describe("subscribeBridge — prompt-cache meter", () => {
	test("persists cacheReadTokens/cacheWriteTokens/cacheHitRate onto message.usage", async () => {
		const emits: EmittedEvent[] = [];
		const bus = makeBus(emits);
		const piAgent = makePiAgent();
		const ctx = makeCtx();
		subscribeBridge(ctx, makeHost(bus), piAgent as any, "conv-1", { provider: "anthropic", model: "claude" }, null);

		piAgent.fire({ type: "turn_start" });
		piAgent.fire({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "the answer" } });
		// input 100 + cacheRead 800 + cacheWrite 100 = 1000 prompt; hitRate 0.8
		piAgent.fire(assistantTurn({ input: 100, output: 50, cacheRead: 800, cacheWrite: 100 }));

		await ctx.dbQueue;

		expect(createMessageCalls).toHaveLength(1);
		const usage = createMessageCalls[0]!.data.usage;
		expect(usage.inputTokens).toBe(100);
		expect(usage.outputTokens).toBe(50);
		expect(usage.cacheReadTokens).toBe(800);
		expect(usage.cacheWriteTokens).toBe(100);
		expect(usage.cacheHitRate).toBeCloseTo(0.8, 10);
	});

	test("still emits raw usage (with cache fields) on run:usage", async () => {
		const emits: EmittedEvent[] = [];
		const bus = makeBus(emits);
		const piAgent = makePiAgent();
		const ctx = makeCtx();
		subscribeBridge(ctx, makeHost(bus), piAgent as any, "conv-1", {}, null);

		piAgent.fire({ type: "turn_start" });
		piAgent.fire(assistantTurn({ input: 10, output: 5, cacheRead: 0, cacheWrite: 90 }));

		await ctx.dbQueue;

		const usageEvt = emits.find((e) => e.name === "run:usage");
		expect(usageEvt, "run:usage emitted").toBeDefined();
		expect(usageEvt!.data.usage.cacheWrite).toBe(90);
		// First-turn write only → 0% hit-rate persisted.
		expect(createMessageCalls[0]!.data.usage.cacheHitRate).toBe(0);
	});

	test("multi-turn run (tool turn then terminal turn) persists cache for each turn", async () => {
		const emits: EmittedEvent[] = [];
		const bus = makeBus(emits);
		const piAgent = makePiAgent();
		const ctx = makeCtx();
		subscribeBridge(ctx, makeHost(bus), piAgent as any, "conv-1", { provider: "anthropic", model: "claude" }, null);

		// Turn 1 — has a tool call (writes cache), not terminal.
		piAgent.fire({ type: "turn_start" });
		piAgent.fire({ type: "tool_execution_start", toolCallId: "tc-1", toolName: "grep", args: { pattern: "x" } });
		piAgent.fire(assistantTurn({ input: 200, output: 10, cacheRead: 0, cacheWrite: 900 }));
		// Turn 2 — synthesis, no tool calls → terminal (reads cache).
		piAgent.fire({ type: "turn_start" });
		piAgent.fire(assistantTurn({ input: 50, output: 30, cacheRead: 900, cacheWrite: 0 }));

		await ctx.dbQueue;

		expect(createMessageCalls).toHaveLength(2);
		expect(createMessageCalls[0]!.data.usage.cacheWriteTokens).toBe(900);
		expect(createMessageCalls[0]!.data.usage.cacheHitRate).toBe(0);
		expect(createMessageCalls[1]!.data.usage.cacheReadTokens).toBe(900);
		expect(createMessageCalls[1]!.data.usage.cacheHitRate).toBeCloseTo(900 / 950, 10);
	});
});
