import { describe, test, expect } from "bun:test";
import {
	getActiveRunIdForConversation,
	resolveRunForConversation,
	registerSpawn,
	unregisterSpawn,
	emptyRoutingState,
	type RoutingState,
	type AgentSpawnEvent,
	type AgentCompleteEvent,
} from "../lib/sub-agent-routing";

function makeState(overrides: Partial<RoutingState> = {}): RoutingState {
	return {
		streamingRunToConversation: {},
		subConvToRootRun: {},
		agentRunToRootRun: {},
		...overrides,
	};
}

describe("sub-agent-routing: emptyRoutingState", () => {
	test("returns an object with all three maps empty", () => {
		const state = emptyRoutingState();
		expect(state.streamingRunToConversation).toEqual({});
		expect(state.subConvToRootRun).toEqual({});
		expect(state.agentRunToRootRun).toEqual({});
	});

	test("returns a fresh object on each call (no shared references)", () => {
		const a = emptyRoutingState();
		const b = emptyRoutingState();
		expect(a).not.toBe(b);
		expect(a.streamingRunToConversation).not.toBe(b.streamingRunToConversation);
		expect(a.subConvToRootRun).not.toBe(b.subConvToRootRun);
		expect(a.agentRunToRootRun).not.toBe(b.agentRunToRootRun);
	});
});

describe("sub-agent-routing: getActiveRunIdForConversation", () => {
	test("returns runId for an active conversation", () => {
		const state = makeState({
			streamingRunToConversation: { "run-1": "conv-A" },
		});
		expect(getActiveRunIdForConversation(state, "conv-A")).toBe("run-1");
	});

	test("returns undefined for unknown conversationId", () => {
		const state = makeState({
			streamingRunToConversation: { "run-1": "conv-A" },
		});
		expect(getActiveRunIdForConversation(state, "conv-unknown")).toBeUndefined();
	});

	test("returns first match when multiple runIds map to the same conversationId", () => {
		// This shouldn't happen in practice, but we document the behavior:
		// Object.entries iteration order preserves insertion order for string keys.
		const state = makeState({
			streamingRunToConversation: {
				"run-1": "conv-A",
				"run-2": "conv-A",
			},
		});
		expect(getActiveRunIdForConversation(state, "conv-A")).toBe("run-1");
	});

	test("works with empty state", () => {
		const state = emptyRoutingState();
		expect(getActiveRunIdForConversation(state, "conv-A")).toBeUndefined();
	});

	test("correctly disambiguates between multiple active runs", () => {
		const state = makeState({
			streamingRunToConversation: {
				"run-1": "conv-A",
				"run-2": "conv-B",
				"run-3": "conv-C",
			},
		});
		expect(getActiveRunIdForConversation(state, "conv-B")).toBe("run-2");
		expect(getActiveRunIdForConversation(state, "conv-C")).toBe("run-3");
	});
});

describe("sub-agent-routing: resolveRunForConversation", () => {
	test("returns root runId via direct lookup when conversationId is a root conversation", () => {
		const state = makeState({
			streamingRunToConversation: { "run-1": "conv-A" },
		});
		expect(resolveRunForConversation(state, "conv-A")).toBe("run-1");
	});

	test("returns root runId via subConvToRootRun fallback for a sub-conversation", () => {
		const state = makeState({
			streamingRunToConversation: { "run-1": "conv-A" },
			subConvToRootRun: { "sub-conv-B": "run-1" },
		});
		expect(resolveRunForConversation(state, "sub-conv-B")).toBe("run-1");
	});

	test("direct lookup takes precedence over subConvToRootRun when the same ID is in both", () => {
		// Edge case: an ID appears as both an active streaming conversation and
		// a sub-conversation mapping. Direct lookup wins.
		const state = makeState({
			streamingRunToConversation: { "run-direct": "conv-shared" },
			subConvToRootRun: { "conv-shared": "run-fallback" },
		});
		expect(resolveRunForConversation(state, "conv-shared")).toBe("run-direct");
	});

	test("returns undefined when conversationId is neither root nor sub", () => {
		const state = makeState({
			streamingRunToConversation: { "run-1": "conv-A" },
			subConvToRootRun: { "sub-conv-B": "run-1" },
		});
		expect(resolveRunForConversation(state, "conv-unknown")).toBeUndefined();
	});

	test("returns undefined with empty state", () => {
		expect(resolveRunForConversation(emptyRoutingState(), "anything")).toBeUndefined();
	});
});

describe("sub-agent-routing: registerSpawn", () => {
	test("registers a top-level spawn where parent runId is a root run", () => {
		const state = makeState({
			streamingRunToConversation: { "run-1": "conv-A" },
		});
		const event: AgentSpawnEvent = {
			runId: "run-1",
			agentRunId: "agent-run-2",
			subConversationId: "sub-conv-B",
		};

		const next = registerSpawn(state, event);

		expect(next.subConvToRootRun["sub-conv-B"]).toBe("run-1");
		expect(next.agentRunToRootRun["agent-run-2"]).toBe("run-1");
		expect(next.streamingRunToConversation).toEqual({ "run-1": "conv-A" });
	});

	test("registers a nested spawn (depth 2) by inheriting root from agentRunToRootRun", () => {
		// After a depth-1 spawn, run-2 is registered as agentRun pointing to root run-1.
		const state = makeState({
			streamingRunToConversation: { "run-1": "conv-A" },
			subConvToRootRun: { "sub-conv-B": "run-1" },
			agentRunToRootRun: { "agent-run-2": "run-1" },
		});
		// Now spawn from agent-run-2 (which is a child, not a root).
		const event: AgentSpawnEvent = {
			runId: "agent-run-2",
			agentRunId: "agent-run-3",
			subConversationId: "sub-conv-C",
		};

		const next = registerSpawn(state, event);

		expect(next.subConvToRootRun["sub-conv-C"]).toBe("run-1");
		expect(next.agentRunToRootRun["agent-run-3"]).toBe("run-1");
		// Prior mappings preserved.
		expect(next.subConvToRootRun["sub-conv-B"]).toBe("run-1");
		expect(next.agentRunToRootRun["agent-run-2"]).toBe("run-1");
	});

	test("registers deeply nested spawns (depth 3+) chaining through multiple levels", () => {
		let state = makeState({
			streamingRunToConversation: { "run-1": "conv-A" },
		});

		state = registerSpawn(state, {
			runId: "run-1",
			agentRunId: "agent-run-2",
			subConversationId: "sub-conv-B",
		});
		state = registerSpawn(state, {
			runId: "agent-run-2",
			agentRunId: "agent-run-3",
			subConversationId: "sub-conv-C",
		});
		state = registerSpawn(state, {
			runId: "agent-run-3",
			agentRunId: "agent-run-4",
			subConversationId: "sub-conv-D",
		});
		state = registerSpawn(state, {
			runId: "agent-run-4",
			agentRunId: "agent-run-5",
			subConversationId: "sub-conv-E",
		});

		// Every level should resolve back to the original root.
		expect(state.subConvToRootRun["sub-conv-B"]).toBe("run-1");
		expect(state.subConvToRootRun["sub-conv-C"]).toBe("run-1");
		expect(state.subConvToRootRun["sub-conv-D"]).toBe("run-1");
		expect(state.subConvToRootRun["sub-conv-E"]).toBe("run-1");
		expect(state.agentRunToRootRun["agent-run-2"]).toBe("run-1");
		expect(state.agentRunToRootRun["agent-run-3"]).toBe("run-1");
		expect(state.agentRunToRootRun["agent-run-4"]).toBe("run-1");
		expect(state.agentRunToRootRun["agent-run-5"]).toBe("run-1");
	});

	test("returns unchanged state when parent runId cannot be resolved", () => {
		const state = makeState({
			streamingRunToConversation: { "run-1": "conv-A" },
		});
		const event: AgentSpawnEvent = {
			runId: "unknown-run",
			agentRunId: "agent-run-X",
			subConversationId: "sub-conv-X",
		};

		const next = registerSpawn(state, event);

		// Returns the exact same reference (not a fresh copy) when nothing changes.
		expect(next).toBe(state);
		expect(next.subConvToRootRun["sub-conv-X"]).toBeUndefined();
		expect(next.agentRunToRootRun["agent-run-X"]).toBeUndefined();
	});

	test("does not mutate the input state", () => {
		const state = makeState({
			streamingRunToConversation: { "run-1": "conv-A" },
		});
		const snapshot = {
			streamingRunToConversation: { ...state.streamingRunToConversation },
			subConvToRootRun: { ...state.subConvToRootRun },
			agentRunToRootRun: { ...state.agentRunToRootRun },
		};

		registerSpawn(state, {
			runId: "run-1",
			agentRunId: "agent-run-2",
			subConversationId: "sub-conv-B",
		});

		expect(state.streamingRunToConversation).toEqual(snapshot.streamingRunToConversation);
		expect(state.subConvToRootRun).toEqual(snapshot.subConvToRootRun);
		expect(state.agentRunToRootRun).toEqual(snapshot.agentRunToRootRun);
	});

	test("returns a new state object with new map references (for reactivity)", () => {
		const state = makeState({
			streamingRunToConversation: { "run-1": "conv-A" },
		});
		const next = registerSpawn(state, {
			runId: "run-1",
			agentRunId: "agent-run-2",
			subConversationId: "sub-conv-B",
		});

		expect(next).not.toBe(state);
		expect(next.subConvToRootRun).not.toBe(state.subConvToRootRun);
		expect(next.agentRunToRootRun).not.toBe(state.agentRunToRootRun);
	});

	test("preserves existing mappings from prior spawns", () => {
		const state = makeState({
			streamingRunToConversation: { "run-1": "conv-A" },
			subConvToRootRun: { "sub-conv-prior": "run-1" },
			agentRunToRootRun: { "agent-run-prior": "run-1" },
		});

		const next = registerSpawn(state, {
			runId: "run-1",
			agentRunId: "agent-run-new",
			subConversationId: "sub-conv-new",
		});

		expect(next.subConvToRootRun["sub-conv-prior"]).toBe("run-1");
		expect(next.subConvToRootRun["sub-conv-new"]).toBe("run-1");
		expect(next.agentRunToRootRun["agent-run-prior"]).toBe("run-1");
		expect(next.agentRunToRootRun["agent-run-new"]).toBe("run-1");
	});
});

describe("sub-agent-routing: unregisterSpawn", () => {
	test("removes subConversationId from subConvToRootRun", () => {
		const state = makeState({
			streamingRunToConversation: { "run-1": "conv-A" },
			subConvToRootRun: { "sub-conv-B": "run-1" },
			agentRunToRootRun: { "agent-run-2": "run-1" },
		});

		const next = unregisterSpawn(state, { subConversationId: "sub-conv-B" });

		expect(next.subConvToRootRun["sub-conv-B"]).toBeUndefined();
		expect(next.subConvToRootRun).toEqual({});
	});

	test("removes agentRunId from agentRunToRootRun when provided", () => {
		const state = makeState({
			streamingRunToConversation: { "run-1": "conv-A" },
			subConvToRootRun: { "sub-conv-B": "run-1" },
			agentRunToRootRun: { "agent-run-2": "run-1" },
		});

		const next = unregisterSpawn(state, {
			subConversationId: "sub-conv-B",
			agentRunId: "agent-run-2",
		});

		expect(next.subConvToRootRun["sub-conv-B"]).toBeUndefined();
		expect(next.agentRunToRootRun["agent-run-2"]).toBeUndefined();
	});

	test("leaves agentRunToRootRun unchanged when agentRunId is undefined", () => {
		const state = makeState({
			streamingRunToConversation: { "run-1": "conv-A" },
			subConvToRootRun: { "sub-conv-B": "run-1" },
			agentRunToRootRun: { "agent-run-2": "run-1" },
		});

		const next = unregisterSpawn(state, { subConversationId: "sub-conv-B" });

		expect(next.agentRunToRootRun["agent-run-2"]).toBe("run-1");
	});

	test("does not mutate the input state", () => {
		const state = makeState({
			streamingRunToConversation: { "run-1": "conv-A" },
			subConvToRootRun: { "sub-conv-B": "run-1" },
			agentRunToRootRun: { "agent-run-2": "run-1" },
		});
		const snapshot = {
			streamingRunToConversation: { ...state.streamingRunToConversation },
			subConvToRootRun: { ...state.subConvToRootRun },
			agentRunToRootRun: { ...state.agentRunToRootRun },
		};

		unregisterSpawn(state, {
			subConversationId: "sub-conv-B",
			agentRunId: "agent-run-2",
		});

		expect(state.streamingRunToConversation).toEqual(snapshot.streamingRunToConversation);
		expect(state.subConvToRootRun).toEqual(snapshot.subConvToRootRun);
		expect(state.agentRunToRootRun).toEqual(snapshot.agentRunToRootRun);
	});

	test("handles missing subConversationId entry gracefully (no-op)", () => {
		const state = makeState({
			streamingRunToConversation: { "run-1": "conv-A" },
			subConvToRootRun: { "sub-conv-B": "run-1" },
		});

		const next = unregisterSpawn(state, { subConversationId: "sub-conv-does-not-exist" });

		expect(next.subConvToRootRun).toEqual({ "sub-conv-B": "run-1" });
	});

	test("handles missing agentRunId entry gracefully (no-op)", () => {
		const state = makeState({
			streamingRunToConversation: { "run-1": "conv-A" },
			agentRunToRootRun: { "agent-run-2": "run-1" },
		});

		const next = unregisterSpawn(state, {
			subConversationId: "sub-conv-nope",
			agentRunId: "agent-run-does-not-exist",
		});

		expect(next.agentRunToRootRun).toEqual({ "agent-run-2": "run-1" });
	});

	test("fully empty event on empty state is a safe no-op", () => {
		const state = emptyRoutingState();
		const next = unregisterSpawn(state, { subConversationId: "nothing" });
		expect(next.subConvToRootRun).toEqual({});
		expect(next.agentRunToRootRun).toEqual({});
	});

	test("preserves other mappings when cleaning up one spawn", () => {
		const state = makeState({
			streamingRunToConversation: { "run-1": "conv-A" },
			subConvToRootRun: {
				"sub-conv-B": "run-1",
				"sub-conv-C": "run-1",
				"sub-conv-D": "run-1",
			},
			agentRunToRootRun: {
				"agent-run-2": "run-1",
				"agent-run-3": "run-1",
				"agent-run-4": "run-1",
			},
		});

		const next = unregisterSpawn(state, {
			subConversationId: "sub-conv-C",
			agentRunId: "agent-run-3",
		});

		expect(next.subConvToRootRun).toEqual({
			"sub-conv-B": "run-1",
			"sub-conv-D": "run-1",
		});
		expect(next.agentRunToRootRun).toEqual({
			"agent-run-2": "run-1",
			"agent-run-4": "run-1",
		});
		// Root streaming map untouched.
		expect(next.streamingRunToConversation).toEqual({ "run-1": "conv-A" });
	});
});

describe("sub-agent-routing: end-to-end scenarios", () => {
	test("spawn → resolve → complete → resolve-fails cycle", () => {
		// Start with an active root run.
		let state = makeState({
			streamingRunToConversation: { "run-1": "conv-A" },
		});

		// Resolving the root works from the start.
		expect(resolveRunForConversation(state, "conv-A")).toBe("run-1");

		// Spawn a sub-agent.
		state = registerSpawn(state, {
			runId: "run-1",
			agentRunId: "agent-run-2",
			subConversationId: "sub-conv-B",
		});

		// Sub-conv resolves to the root run.
		expect(resolveRunForConversation(state, "sub-conv-B")).toBe("run-1");

		// Sub-agent completes → mappings cleaned up.
		state = unregisterSpawn(state, {
			subConversationId: "sub-conv-B",
			agentRunId: "agent-run-2",
		});

		// After unregister, sub-conv-B no longer resolves.
		expect(resolveRunForConversation(state, "sub-conv-B")).toBeUndefined();
		// Root run is still active and resolvable.
		expect(resolveRunForConversation(state, "conv-A")).toBe("run-1");
	});

	test("nested spawn chain: every depth resolves back to the same root", () => {
		let state = makeState({
			streamingRunToConversation: { "run-1": "conv-A" },
		});

		// Spawn 1: depth 1 from root run-1
		state = registerSpawn(state, {
			runId: "run-1",
			agentRunId: "agent-run-2",
			subConversationId: "sub-conv-B",
		});
		expect(resolveRunForConversation(state, "sub-conv-B")).toBe("run-1");

		// Spawn 2: depth 2, parent is agent-run-2 (not a root)
		state = registerSpawn(state, {
			runId: "agent-run-2",
			agentRunId: "agent-run-3",
			subConversationId: "sub-conv-C",
		});
		expect(resolveRunForConversation(state, "sub-conv-C")).toBe("run-1");

		// Spawn 3: depth 3, parent is agent-run-3
		state = registerSpawn(state, {
			runId: "agent-run-3",
			agentRunId: "agent-run-4",
			subConversationId: "sub-conv-D",
		});
		expect(resolveRunForConversation(state, "sub-conv-D")).toBe("run-1");

		// All three sub-conversations still resolve to run-1.
		expect(resolveRunForConversation(state, "sub-conv-B")).toBe("run-1");
		expect(resolveRunForConversation(state, "sub-conv-C")).toBe("run-1");
		expect(resolveRunForConversation(state, "sub-conv-D")).toBe("run-1");
	});

	test("concurrent sub-agents sharing a root", () => {
		let state = makeState({
			streamingRunToConversation: { "run-1": "conv-A" },
		});

		// Two sibling spawns from the same root.
		state = registerSpawn(state, {
			runId: "run-1",
			agentRunId: "agent-run-2",
			subConversationId: "sub-conv-B",
		});
		state = registerSpawn(state, {
			runId: "run-1",
			agentRunId: "agent-run-3",
			subConversationId: "sub-conv-C",
		});

		// Both resolve to run-1.
		expect(resolveRunForConversation(state, "sub-conv-B")).toBe("run-1");
		expect(resolveRunForConversation(state, "sub-conv-C")).toBe("run-1");

		// Unregister sub-conv-B only.
		state = unregisterSpawn(state, {
			subConversationId: "sub-conv-B",
			agentRunId: "agent-run-2",
		});

		// sub-conv-B is gone; sub-conv-C still works.
		expect(resolveRunForConversation(state, "sub-conv-B")).toBeUndefined();
		expect(resolveRunForConversation(state, "sub-conv-C")).toBe("run-1");
		// Root conversation remains resolvable.
		expect(resolveRunForConversation(state, "conv-A")).toBe("run-1");
	});

	test("unrelated complete event does not affect current mappings", () => {
		let state = makeState({
			streamingRunToConversation: { "run-1": "conv-A" },
		});
		state = registerSpawn(state, {
			runId: "run-1",
			agentRunId: "agent-run-2",
			subConversationId: "sub-conv-B",
		});

		// Completion for a sub-conv that was never registered.
		const next = unregisterSpawn(state, {
			subConversationId: "never-registered",
			agentRunId: "never-registered-agent",
		});

		expect(next.subConvToRootRun["sub-conv-B"]).toBe("run-1");
		expect(next.agentRunToRootRun["agent-run-2"]).toBe("run-1");
	});

	test("AgentCompleteEvent type accepts event without agentRunId (branch coverage)", () => {
		const state = makeState({
			subConvToRootRun: { "sub-conv-B": "run-1" },
			agentRunToRootRun: { "agent-run-2": "run-1" },
		});
		const event: AgentCompleteEvent = { subConversationId: "sub-conv-B" };
		const next = unregisterSpawn(state, event);
		expect(next.subConvToRootRun["sub-conv-B"]).toBeUndefined();
		expect(next.agentRunToRootRun["agent-run-2"]).toBe("run-1");
	});
});
