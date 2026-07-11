import { describe, test, expect, beforeEach } from "bun:test";

/**
 * Tests for the `agent:complete` handling in web/src/lib/stores.svelte.ts
 * (Phase B4). Same test-double rationale as stores-task-snapshot.test.ts:
 * Svelte 5 runes don't run under `bun test`, so we re-implement the handler
 * body around plain properties and exercise it.
 *
 * Focus: `agent:complete` now fires for EVERY assignment terminal (was:
 * only the user-driven agent-chat idle path). For a tool-spawned / background
 * agent that auto-continued (auto-continue / autonomous / schema-retry cycle),
 * the terminal event's `runId` is the LAST cycle's run id — which differs from
 * the initial spawn run id that keyed the chip. The handler resolves the chip
 * by its stable `subConversationId` across ALL run buckets so such an agent
 * flips complete/error instead of sticking "running".
 */

interface AgentCallState {
	subConversationId: string;
	agentName: string;
	agentConfigId: string;
	task: string;
	status: "running" | "complete" | "error";
	resultPreview?: string;
	agentRunId?: string;
	startedAt: number;
}

interface WSEvent {
	type: string;
	data: unknown;
}

class TestStore {
	streamingAgentCalls: Record<string, AgentCallState[]> = {};

	/** Mirrors the `agent:complete` case body's chip-resolution logic. */
	handleWSEvent(event: WSEvent): void {
		if (event.type !== "agent:complete") return;
		const { subConversationId, success: agentSuccess, resultPreview } = event.data as {
			subConversationId: string; success: boolean; resultPreview: string;
		};
		let matchedAgentCall = false;
		const nextAgentCalls: Record<string, AgentCallState[]> = {};
		for (const [bucketRunId, calls] of Object.entries(this.streamingAgentCalls)) {
			nextAgentCalls[bucketRunId] = calls.map(a => {
				if (a.subConversationId !== subConversationId) return a;
				matchedAgentCall = true;
				return { ...a, status: agentSuccess ? "complete" as const : "error" as const, resultPreview };
			});
		}
		if (matchedAgentCall) {
			this.streamingAgentCalls = nextAgentCalls;
		}
	}
}

function makeCall(overrides: Partial<AgentCallState> = {}): AgentCallState {
	return {
		subConversationId: overrides.subConversationId ?? "sub-1",
		agentName: overrides.agentName ?? "researcher",
		agentConfigId: overrides.agentConfigId ?? "cfg-1",
		task: overrides.task ?? "do it",
		status: overrides.status ?? "running",
		startedAt: overrides.startedAt ?? 0,
		...overrides,
	};
}

function completeEvent(data: {
	runId: string; subConversationId: string; success: boolean; resultPreview: string; agentRunId?: string;
}): WSEvent {
	return { type: "agent:complete", data };
}

describe("agent:complete chip resolution (Phase B4)", () => {
	let store: TestStore;
	beforeEach(() => { store = new TestStore(); });

	test("resolves the chip in the same bucket for a non-cycling agent", () => {
		store.streamingAgentCalls = {
			"run-A": [makeCall({ subConversationId: "sub-1", status: "running" })],
		};
		store.handleWSEvent(completeEvent({
			runId: "run-A", subConversationId: "sub-1", success: true, resultPreview: "done",
		}));
		expect(store.streamingAgentCalls["run-A"][0].status).toBe("complete");
		expect(store.streamingAgentCalls["run-A"][0].resultPreview).toBe("done");
	});

	test("resolves a cycled agent whose terminal runId differs from the chip's bucket", () => {
		// The chip lives under the INITIAL spawn run id (run-A); the terminal
		// event carries the LAST cycle's run id (run-Z). Keying strictly on the
		// event runId would miss it and leave the chip stuck "running".
		store.streamingAgentCalls = {
			"run-A": [makeCall({ subConversationId: "sub-1", status: "running" })],
		};
		store.handleWSEvent(completeEvent({
			runId: "run-Z", subConversationId: "sub-1", success: true, resultPreview: "final",
		}));
		expect(store.streamingAgentCalls["run-A"][0].status).toBe("complete");
		expect(store.streamingAgentCalls["run-A"][0].resultPreview).toBe("final");
	});

	test("marks the chip 'error' when the terminal reports failure", () => {
		store.streamingAgentCalls = {
			"run-A": [makeCall({ subConversationId: "sub-1", status: "running" })],
		};
		store.handleWSEvent(completeEvent({
			runId: "run-A", subConversationId: "sub-1", success: false, resultPreview: "boom",
		}));
		expect(store.streamingAgentCalls["run-A"][0].status).toBe("error");
	});

	test("only the matching sub-agent chip is updated; siblings are untouched", () => {
		store.streamingAgentCalls = {
			"run-A": [
				makeCall({ subConversationId: "sub-1", status: "running" }),
				makeCall({ subConversationId: "sub-2", status: "running", agentName: "coder" }),
			],
		};
		store.handleWSEvent(completeEvent({
			runId: "run-A", subConversationId: "sub-2", success: true, resultPreview: "ok",
		}));
		expect(store.streamingAgentCalls["run-A"][0].status).toBe("running");
		expect(store.streamingAgentCalls["run-A"][1].status).toBe("complete");
	});

	test("no-op (no new reference) when no chip matches the sub-conversation", () => {
		store.streamingAgentCalls = {
			"run-A": [makeCall({ subConversationId: "sub-1", status: "running" })],
		};
		const before = store.streamingAgentCalls;
		store.handleWSEvent(completeEvent({
			runId: "run-A", subConversationId: "unknown-sub", success: true, resultPreview: "x",
		}));
		// Unchanged reference — the handler skips the assignment when nothing matched.
		expect(store.streamingAgentCalls).toBe(before);
	});
});
