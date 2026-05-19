import { test, expect, describe } from "bun:test";
import {
	subConvoToAgentCallState,
	type SubConvoRecord,
} from "$lib/sub-convo-agent-state.js";

function makeSc(partial: Partial<SubConvoRecord> = {}): SubConvoRecord {
	return {
		id: "sub-1",
		agentName: "Worker",
		agentConfigId: "cfg-1",
		parentMessageId: "msg-1",
		messageCount: 0,
		lastMessagePreview: null,
		...partial,
	};
}

describe("subConvoToAgentCallState — no assignment (heuristic path)", () => {
	test("no response yet → status='error', preview='Agent did not respond'", () => {
		const state = subConvoToAgentCallState(makeSc({ messageCount: 0 }));
		expect(state.status).toBe("error");
		expect(state.resultPreview).toBe("Agent did not respond");
	});

	test("has response → status='complete' and preview from lastMessagePreview", () => {
		const state = subConvoToAgentCallState(
			makeSc({ messageCount: 2, lastMessagePreview: "done" }),
		);
		expect(state.status).toBe("complete");
		expect(state.resultPreview).toBe("done");
	});

	test("has response but null preview → status='complete', preview=undefined", () => {
		const state = subConvoToAgentCallState(
			makeSc({ messageCount: 1, lastMessagePreview: null }),
		);
		expect(state.status).toBe("complete");
		expect(state.resultPreview).toBeUndefined();
	});

	test("undefined messageCount → treated as 0 → status='error'", () => {
		const state = subConvoToAgentCallState(
			makeSc({ messageCount: undefined, lastMessagePreview: "ignored" }),
		);
		expect(state.status).toBe("error");
		expect(state.resultPreview).toBe("Agent did not respond");
	});
});

describe("subConvoToAgentCallState — with task-tracking assignment (authoritative)", () => {
	test("assignment.status='running' → status='running'", () => {
		const state = subConvoToAgentCallState(makeSc(), { status: "running" });
		expect(state.status).toBe("running");
	});

	test("assignment.status='failed' → status='error'", () => {
		const state = subConvoToAgentCallState(makeSc(), { status: "failed" });
		expect(state.status).toBe("error");
	});

	test("assignment.status='completed' → status='complete'", () => {
		const state = subConvoToAgentCallState(makeSc(), { status: "completed" });
		expect(state.status).toBe("complete");
	});

	test("assignment.status='assigned' → status='complete' (non-running, non-failed fallback)", () => {
		const state = subConvoToAgentCallState(makeSc(), { status: "assigned" });
		expect(state.status).toBe("complete");
	});

	test("assignment resultPreview wins over sc.lastMessagePreview", () => {
		const state = subConvoToAgentCallState(
			makeSc({ lastMessagePreview: "from-messages" }),
			{ status: "completed", resultPreview: "from-assignment" },
		);
		expect(state.resultPreview).toBe("from-assignment");
	});

	test("assignment without resultPreview falls back to sc.lastMessagePreview", () => {
		const state = subConvoToAgentCallState(
			makeSc({ lastMessagePreview: "from-messages" }),
			{ status: "completed" },
		);
		expect(state.resultPreview).toBe("from-messages");
	});

	test("assignment overrides the no-response heuristic — running agent with 0 messages", () => {
		// Without assignment this would be 'error / Agent did not respond'.
		// With a real assignment, the UI must show 'running' instead.
		const state = subConvoToAgentCallState(
			makeSc({ messageCount: 0 }),
			{ status: "running" },
		);
		expect(state.status).toBe("running");
		// preview falls back to sc.lastMessagePreview (null → undefined) — NOT
		// the 'Agent did not respond' heuristic string.
		expect(state.resultPreview).toBeUndefined();
	});
});

describe("subConvoToAgentCallState — static fields", () => {
	test("copies id/name/configId, leaves task empty and startedAt=0", () => {
		const state = subConvoToAgentCallState(
			makeSc({
				id: "sub-xyz",
				agentName: "Specialist",
				agentConfigId: "cfg-99",
				parentMessageId: "msg-7",
				messageCount: 3,
				lastMessagePreview: "ok",
			}),
		);
		expect(state.subConversationId).toBe("sub-xyz");
		expect(state.agentName).toBe("Specialist");
		expect(state.agentConfigId).toBe("cfg-99");
		expect(state.task).toBe("");
		expect(state.startedAt).toBe(0);
	});
});
