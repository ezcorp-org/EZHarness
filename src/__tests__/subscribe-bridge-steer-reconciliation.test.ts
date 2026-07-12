/**
 * subscribe-bridge `message_start` reconciliation (P4 §1.2).
 *
 * When a steer is DELIVERED, pi drains it and emits `message_start` carrying the
 * exact UserMessage object steerConversation queued. If the caller persisted a
 * DB row for that steer up-front (agent-chat), its parent was the leaf-at-REQUEST
 * — but the LLM sees the steer at a LATER branch position. subscribe-bridge
 * re-parents the row to the current branch leaf and threads later turns through
 * it, so the NEXT run's loadHistory rebuilds the sequence the LLM saw.
 *
 * Harness mirrors subscribe-bridge-turn-saved-final.test.ts: fake pi-Agent stub,
 * closure-bound bus, mocked DB writes. Here createMessage returns incrementing
 * ids and captures each turn's parentMessageId, and reparentMessage captures its
 * (id, newParent) so we can assert the branch the persistence layer built.
 */
import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

interface CreateCall { role: string; parentMessageId?: string }
interface ReparentCall { conversationId: string; messageId: string; newParent: string | null }

const createCalls: CreateCall[] = [];
const reparentCalls: ReparentCall[] = [];
let turnSeq = 0;

mock.module("../db/queries/conversations", () => ({
	createMessage: async (_conv: string, data: CreateCall) => {
		createCalls.push({ role: data.role, parentMessageId: data.parentMessageId });
		return { id: `turn-${++turnSeq}` };
	},
	reparentMessage: async (conversationId: string, messageId: string, newParent: string | null) => {
		reparentCalls.push({ conversationId, messageId, newParent });
		return { id: messageId };
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

function makeCtx(initialLeaf: string | null): StreamChatContext {
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
		lastSavedMessageId: initialLeaf,
		dbQueue: Promise.resolve(),
		totalUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as any,
	} as unknown as StreamChatContext;
}

/** Executor stub whose consumeSteerPersistedId returns `persistedId` exactly
 *  once for a message whose content matches `steerContent` (mirrors the real
 *  latch), else undefined. */
function makeHost(bus: any, opts: { persist?: boolean; steerContent?: string; persistedId?: string } = {}): StreamChatHost {
	const persist = opts.persist ?? true;
	let consumed = false;
	return {
		bus,
		persist,
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
		executor: {
			consumeSteerPersistedId: (_runId: string, message: any) => {
				if (consumed || !opts.persistedId) return undefined;
				if (message?.content !== opts.steerContent) return undefined;
				consumed = true;
				return opts.persistedId;
			},
		} as any,
		errorMessagePersisted: new Set<string>(),
		permissionEngine: {} as any,
	};
}

function assistantTurn(text: string) {
	return {
		type: "turn_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			usage: { input: 5, output: 7 },
		},
	};
}

function steerStart(content: string) {
	return { type: "message_start", message: { role: "user", content, timestamp: 1 } };
}

beforeEach(() => {
	ExtensionRegistry.resetInstance();
	createCalls.length = 0;
	reparentCalls.length = 0;
	turnSeq = 0;
});

describe("subscribeBridge — P4 §1.2 steered-row reconciliation", () => {
	test("delivered steer is re-parented to the injection leaf; the next turn threads through it", async () => {
		const emits: EmittedEvent[] = [];
		const bus = makeBus(emits);
		const piAgent = makePiAgent();
		// Active run whose context leaf at request time is "leaf-req".
		const ctx = makeCtx("leaf-req");
		const host = makeHost(bus, { steerContent: "steer", persistedId: "row-U" });
		subscribeBridge(ctx, host, piAgent as any, "conv-1", {}, null);

		// Turn B streams and persists, parented on the request leaf.
		piAgent.fire({ type: "turn_start" });
		piAgent.fire(assistantTurn("B"));
		await ctx.dbQueue; // turn-1 saved, lastSavedMessageId = "turn-1"

		// The steer is drained mid-run → reconcile the persisted row.
		piAgent.fire(steerStart("steer"));
		await ctx.dbQueue; // reparent runs, lastSavedMessageId = "row-U"

		// Turn C responds to the steer and persists onto it.
		piAgent.fire({ type: "turn_start" });
		piAgent.fire(assistantTurn("C"));
		await ctx.dbQueue;

		// The steer row was re-parented onto the pre-injection leaf (turn-1 = B).
		expect(reparentCalls).toEqual([
			{ conversationId: "conv-1", messageId: "row-U", newParent: "turn-1" },
		]);
		// Turn B parented on the request leaf; turn C parented on the STEER row —
		// so the branch is leaf-req → B → steer → C (what the LLM saw).
		expect(createCalls).toEqual([
			{ role: "assistant", parentMessageId: "leaf-req" },
			{ role: "assistant", parentMessageId: "row-U" },
		]);
	});

	test("reconciliation serializes on ctx.dbQueue behind a concurrent turn_end save (no race)", async () => {
		const emits: EmittedEvent[] = [];
		const bus = makeBus(emits);
		const piAgent = makePiAgent();
		const ctx = makeCtx("leaf-req");
		const host = makeHost(bus, { steerContent: "steer", persistedId: "row-U" });
		subscribeBridge(ctx, host, piAgent as any, "conv-1", {}, null);

		// Fire the turn save and the steer BACK-TO-BACK with no await between —
		// both DB ops are queued before the queue drains. The reparent must still
		// use the turn's id (turn-1), not the stale pre-turn leaf.
		piAgent.fire({ type: "turn_start" });
		piAgent.fire(assistantTurn("B"));
		piAgent.fire(steerStart("steer"));
		await ctx.dbQueue;

		expect(reparentCalls).toEqual([
			{ conversationId: "conv-1", messageId: "row-U", newParent: "turn-1" },
		]);
		expect(ctx.lastSavedMessageId).toBe("row-U");
	});

	test("injection at run start (no prior turn) skips the reparent but still threads the steer", async () => {
		const emits: EmittedEvent[] = [];
		const bus = makeBus(emits);
		const piAgent = makePiAgent();
		// No prior leaf — the steer arrives before any turn persists.
		const ctx = makeCtx(null);
		const host = makeHost(bus, { steerContent: "steer", persistedId: "row-U" });
		subscribeBridge(ctx, host, piAgent as any, "conv-1", {}, null);

		piAgent.fire(steerStart("steer"));
		await ctx.dbQueue;

		// Nothing to reparent onto (null leaf) → no DB reparent, but the steer row
		// becomes the leaf so the next turn threads through it.
		expect(reparentCalls).toHaveLength(0);
		expect(ctx.lastSavedMessageId).toBe("row-U");
	});

	test("a steer with NO persisted row (send_to_agent) is a no-op — no reparent, leaf unchanged", async () => {
		const emits: EmittedEvent[] = [];
		const bus = makeBus(emits);
		const piAgent = makePiAgent();
		const ctx = makeCtx("leaf-req");
		// steerContent set but persistedId absent → consume returns undefined.
		const host = makeHost(bus, { steerContent: "steer" });
		subscribeBridge(ctx, host, piAgent as any, "conv-1", {}, null);

		piAgent.fire(assistantTurn("B"));
		await ctx.dbQueue;
		piAgent.fire(steerStart("steer"));
		await ctx.dbQueue;
		piAgent.fire(assistantTurn("C"));
		await ctx.dbQueue;

		expect(reparentCalls).toHaveLength(0);
		// The send_to_agent steer is NOT persisted — C parents on B (turn-1), the
		// ephemeral-prompt behavior; the leaf never points at a steer row.
		expect(createCalls).toEqual([
			{ role: "assistant", parentMessageId: "leaf-req" },
			{ role: "assistant", parentMessageId: "turn-1" },
		]);
	});

	test("non-persist host → reconciliation is skipped entirely", async () => {
		const emits: EmittedEvent[] = [];
		const bus = makeBus(emits);
		const piAgent = makePiAgent();
		const ctx = makeCtx("leaf-req");
		const host = makeHost(bus, { persist: false, steerContent: "steer", persistedId: "row-U" });
		subscribeBridge(ctx, host, piAgent as any, "conv-1", {}, null);

		piAgent.fire(steerStart("steer"));
		await ctx.dbQueue;

		expect(reparentCalls).toHaveLength(0);
		expect(ctx.lastSavedMessageId).toBe("leaf-req"); // untouched
	});

	test("an assistant message_start is ignored (only user steers reconcile)", async () => {
		const emits: EmittedEvent[] = [];
		const bus = makeBus(emits);
		const piAgent = makePiAgent();
		const ctx = makeCtx("leaf-req");
		const host = makeHost(bus, { steerContent: "steer", persistedId: "row-U" });
		subscribeBridge(ctx, host, piAgent as any, "conv-1", {}, null);

		// An assistant-role message_start must never be treated as a steer.
		piAgent.fire({ type: "message_start", message: { role: "assistant", content: "x" } });
		await ctx.dbQueue;

		expect(reparentCalls).toHaveLength(0);
		expect(ctx.lastSavedMessageId).toBe("leaf-req");
	});
});
