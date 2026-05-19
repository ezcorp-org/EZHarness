/**
 * subscribe-bridge `turn_end` must tell the client (a) the turn's thinking
 * content and (b) whether this is the FINAL turn (no tool calls → the agent
 * loop terminates, no follow-up turn will stream).
 *
 * The client (ChatThread.handleTurnSaved) uses `final` to avoid spawning a
 * spurious empty streaming placeholder that would trip the skeleton over the
 * just-rendered thinking card, and uses `thinkingContent` to render the
 * thinking card on the persisted row immediately (no thinking→text→thinking
 * flicker while the run:complete reconcile is in flight).
 *
 * Strategy mirrors subscribe-bridge-cardlayout.test.ts: fake pi-Agent stub,
 * closure-bound bus, mocked DB writes; drive turn_start → (tool?) → turn_end
 * and assert the run:turn_saved payload.
 */
import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

mock.module("../db/queries/conversations", () => ({
	createMessage: async () => ({ id: "msg-1" }),
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

function assistantTurn(thinking: string, text: string) {
	return {
		type: "turn_end",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking },
				{ type: "text", text },
			],
			usage: { input: 5, output: 7 },
		},
	};
}

beforeEach(() => {
	ExtensionRegistry.resetInstance();
});

describe("subscribeBridge — run:turn_saved {thinkingContent, final}", () => {
	test("terminal turn (no tool calls) → final:true, thinkingContent forwarded", async () => {
		const emits: EmittedEvent[] = [];
		const bus = makeBus(emits);
		const piAgent = makePiAgent();
		const ctx = makeCtx();
		subscribeBridge(ctx, makeHost(bus), piAgent as any, "conv-1", {}, null);

		piAgent.fire({ type: "turn_start" });
		piAgent.fire({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", delta: "let me reason" },
		});
		piAgent.fire({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "the answer" },
		});
		piAgent.fire(assistantTurn("let me reason", "the answer"));

		await ctx.dbQueue;

		const saved = emits.find((e) => e.name === "run:turn_saved");
		expect(saved, "run:turn_saved emitted").toBeDefined();
		expect(saved!.data.final).toBe(true);
		expect(saved!.data.thinkingContent).toBe("let me reason");
		expect(saved!.data.content).toBe("the answer");
		// reset still fires (harmless for terminal — no placeholder reads it)
		expect(emits.some((e) => e.name === "run:turn_text_reset")).toBe(true);
	});

	test("turn with tool calls → final:false (a follow-up turn will stream)", async () => {
		const emits: EmittedEvent[] = [];
		const bus = makeBus(emits);
		const piAgent = makePiAgent();
		const ctx = makeCtx();
		subscribeBridge(ctx, makeHost(bus), piAgent as any, "conv-1", {}, null);

		piAgent.fire({ type: "turn_start" });
		piAgent.fire({
			type: "tool_execution_start",
			toolCallId: "tc-1",
			toolName: "grep",
			args: { pattern: "x" },
		});
		piAgent.fire(assistantTurn("inspecting", ""));

		await ctx.dbQueue;

		const saved = emits.find((e) => e.name === "run:turn_saved");
		expect(saved, "run:turn_saved emitted").toBeDefined();
		expect(saved!.data.final).toBe(false);
		expect(saved!.data.thinkingContent).toBe("inspecting");
	});

	test("final is captured per-turn, not read late: turn1(tools)=false then turn2(no tools)=true", async () => {
		const emits: EmittedEvent[] = [];
		const bus = makeBus(emits);
		const piAgent = makePiAgent();
		const ctx = makeCtx();
		subscribeBridge(ctx, makeHost(bus), piAgent as any, "conv-1", {}, null);

		// Turn 1 — has a tool call → not final.
		piAgent.fire({ type: "turn_start" });
		piAgent.fire({
			type: "tool_execution_start",
			toolCallId: "tc-1",
			toolName: "grep",
			args: { pattern: "x" },
		});
		piAgent.fire(assistantTurn("turn1 thinking", ""));
		// Turn 2 — synthesis, no tool calls → final. turn_start resets the flag.
		piAgent.fire({ type: "turn_start" });
		piAgent.fire(assistantTurn("turn2 thinking", "final answer"));

		await ctx.dbQueue;

		const saved = emits.filter((e) => e.name === "run:turn_saved");
		expect(saved.length).toBe(2);
		expect(saved[0]!.data.final).toBe(false);
		expect(saved[0]!.data.thinkingContent).toBe("turn1 thinking");
		expect(saved[1]!.data.final).toBe(true);
		expect(saved[1]!.data.thinkingContent).toBe("turn2 thinking");
		expect(saved[1]!.data.content).toBe("final answer");
	});
});
