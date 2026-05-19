/**
 * Unit tests for the stream-resume orchestration extracted from
 * `routes/(app)/project/[id]/chat/[convId]/+page.svelte` (W9 of the chat-page
 * split — HIGHEST RISK wave: timing-sensitive WS reconnect / zombie-detection
 * / run-resume code).
 *
 * The module exposes plain inner functions (`runActiveRunCheck`,
 * `shouldFireReconnectCheck`, `pollStaleness`, `runZombieCheck`) plus the
 * `attachStreamResume` rune-host wrapper. We test the inner functions
 * directly so the suite doesn't have to stand up a Svelte effect scope —
 * same approach panel-persistence (W4) and useSelectMode (W6) used.
 *
 * `fetch-policy.backgroundFetch` and `stores.svelte.startStreaming /
 * stopStreaming / store` are mocked so we can assert exact wiring without
 * touching real network or the global reactive store.
 */

import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import type { Message } from "$lib/api.js";
import type { ToolCallState } from "$lib/stores.svelte.js";

// ── Mocks ────────────────────────────────────────────────────────────────

const backgroundFetchMock = mock(
	async (
		_key: string,
		_url: string,
		_init?: RequestInit,
		_opts?: { minIntervalMs?: number },
	): Promise<Response | null> => null,
);

const startStreamingMock = mock((_runId: string, _convId: string) => true);
const stopStreamingMock = mock((_runId: string) => {});

// Mutable store stub — only the fields stream-resume actually reads/writes.
const storeStub: { connected: boolean; streamingToolCalls: Record<string, ToolCallState[]> } = {
	connected: false,
	streamingToolCalls: {},
};

mock.module("$lib/utils/fetch-policy.js", () => ({
	backgroundFetch: backgroundFetchMock,
	userFetch: mock(async () => new Response("{}", { status: 200 })),
	invalidate: mock(() => {}),
}));

mock.module("$lib/stores.svelte.js", () => ({
	store: storeStub,
	startStreaming: startStreamingMock,
	stopStreaming: stopStreamingMock,
}));

afterAll(() => mock.restore());

// Now safe to import the SUT.
const {
	RECONNECT_CHECK_COOLDOWN_MS,
	ZOMBIE_TIMEOUT_FRESH_MS,
	ZOMBIE_TIMEOUT_RESUMED_MS,
	STALENESS_POLL_INTERVAL_MS,
	runActiveRunCheck,
	shouldFireReconnectCheck,
	pollStaleness,
	runZombieCheck,
	__resetReconnectCooldown,
} = await import("../stream-resume.svelte.ts");

type StreamResumeHost = import("../stream-resume.svelte.ts").StreamResumeHost;

// ── Helpers ──────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function makeOptimisticMessage(
	overrides: Partial<Message> & Pick<Message, "conversationId">,
): Message {
	return {
		id: "",
		role: "user",
		content: "",
		thinkingContent: null,
		model: null,
		provider: null,
		usage: null,
		runId: null,
		parentMessageId: null,
		excluded: false,
		createdAt: "2025-01-01T00:00:00.000Z",
		...overrides,
	};
}

interface HostState {
	convId: string;
	loadGeneration: number;
	initialLoadDone: boolean;
	selectedModel: { provider: string; model: string } | null;
	activeRunId: string | null;
	activeRunStartedAt: number | null;
	serverStalenessMs: number | null;
	resumedRun: boolean;
	checkingActiveRun: boolean;
	allMessages: Message[];
	activeLeafId: string | null;
	currentStreamingText: string | undefined;
	isStreaming: boolean;
	loadMessagesCalls: number;
}

function makeHost(initial: Partial<HostState> = {}): {
	host: StreamResumeHost;
	state: HostState;
} {
	const state: HostState = {
		convId: "conv-1",
		loadGeneration: 1,
		initialLoadDone: true,
		selectedModel: { provider: "anthropic", model: "claude-3-7-sonnet" },
		activeRunId: null,
		activeRunStartedAt: null,
		serverStalenessMs: null,
		resumedRun: false,
		checkingActiveRun: false,
		allMessages: [],
		activeLeafId: null,
		currentStreamingText: undefined,
		isStreaming: false,
		loadMessagesCalls: 0,
		...initial,
	};
	const host: StreamResumeHost = {
		convId: () => state.convId,
		loadGeneration: () => state.loadGeneration,
		initialLoadDone: () => state.initialLoadDone,
		selectedModel: () => state.selectedModel,
		activeRunId: { get: () => state.activeRunId, set: (v) => { state.activeRunId = v; } },
		activeRunStartedAt: { get: () => state.activeRunStartedAt, set: (v) => { state.activeRunStartedAt = v; } },
		serverStalenessMs: { get: () => state.serverStalenessMs, set: (v) => { state.serverStalenessMs = v; } },
		resumedRun: { get: () => state.resumedRun, set: (v) => { state.resumedRun = v; } },
		checkingActiveRun: { get: () => state.checkingActiveRun, set: (v) => { state.checkingActiveRun = v; } },
		allMessages: { get: () => state.allMessages, set: (v) => { state.allMessages = v; } },
		activeLeafId: { get: () => state.activeLeafId, set: (v) => { state.activeLeafId = v; } },
		loadMessages: async () => { state.loadMessagesCalls += 1; },
		makeOptimisticMessage,
		currentStreamingText: () => state.currentStreamingText,
		isStreaming: () => state.isStreaming,
	};
	return { host, state };
}

beforeEach(() => {
	backgroundFetchMock.mockReset();
	startStreamingMock.mockReset();
	startStreamingMock.mockImplementation(() => true);
	stopStreamingMock.mockReset();
	storeStub.connected = false;
	storeStub.streamingToolCalls = {};
	__resetReconnectCooldown();
});

// ── runActiveRunCheck ────────────────────────────────────────────────────

describe("runActiveRunCheck (checkActiveRun)", () => {
	test("no run in flight → does nothing, no startStreaming, clears checkingActiveRun", async () => {
		backgroundFetchMock.mockImplementationOnce(async () =>
			jsonResponse({ runId: null }),
		);
		const { host, state } = makeHost({ checkingActiveRun: true });
		await runActiveRunCheck(host, state.loadGeneration);

		expect(startStreamingMock).not.toHaveBeenCalled();
		expect(state.activeRunId).toBeNull();
		expect(state.resumedRun).toBe(false);
		expect(state.checkingActiveRun).toBe(false);
		expect(state.loadMessagesCalls).toBe(0);
	});

	test("API non-OK → no-op", async () => {
		backgroundFetchMock.mockImplementationOnce(async () => null);
		const { host, state } = makeHost({ checkingActiveRun: true });
		await runActiveRunCheck(host, state.loadGeneration);

		expect(startStreamingMock).not.toHaveBeenCalled();
		expect(state.checkingActiveRun).toBe(false);
	});

	test("status flipped to non-running → calls loadMessages, no startStreaming", async () => {
		backgroundFetchMock.mockImplementationOnce(async () =>
			jsonResponse({ runId: "run-123", status: "completed" }),
		);
		const { host, state } = makeHost();
		await runActiveRunCheck(host, state.loadGeneration);

		expect(startStreamingMock).not.toHaveBeenCalled();
		expect(state.loadMessagesCalls).toBe(1);
		expect(state.activeRunId).toBeNull();
	});

	test("run in flight → sets activeRunId/resumedRun/activeRunStartedAt, calls startStreaming, pushes placeholder", async () => {
		const startedAt = "2025-01-01T12:00:00.000Z";
		backgroundFetchMock.mockImplementationOnce(async () =>
			jsonResponse({
				runId: "run-abc",
				status: "running",
				startedAt,
				stalenessMs: 1234,
				partialResponse: "partial text",
			}),
		);
		const userMsg = makeOptimisticMessage({
			id: "user-1",
			conversationId: "conv-1",
			role: "user",
			content: "hi",
		});
		const { host, state } = makeHost({ allMessages: [userMsg] });
		await runActiveRunCheck(host, state.loadGeneration);

		expect(startStreamingMock).toHaveBeenCalledWith("run-abc", "conv-1");
		expect(state.activeRunId).toBe("run-abc");
		expect(state.resumedRun).toBe(true);
		expect(state.activeRunStartedAt).toBe(new Date(startedAt).getTime());
		expect(state.serverStalenessMs).toBe(1234);
		// Placeholder appended at the end with parent = last message.
		expect(state.allMessages.length).toBe(2);
		const placeholder = state.allMessages[1]!;
		expect(placeholder.id).toBe("streaming-run-abc");
		expect(placeholder.role).toBe("assistant");
		expect(placeholder.content).toBe("partial text");
		expect(placeholder.runId).toBe("run-abc");
		expect(placeholder.parentMessageId).toBe("user-1");
		expect(placeholder.model).toBe("claude-3-7-sonnet");
		expect(state.activeLeafId).toBe("streaming-run-abc");
		expect(state.checkingActiveRun).toBe(false);
	});

	test("startedAt missing → falls back to Date.now()", async () => {
		const before = Date.now();
		backgroundFetchMock.mockImplementationOnce(async () =>
			jsonResponse({ runId: "run-x", status: "running" }),
		);
		const { host, state } = makeHost();
		await runActiveRunCheck(host, state.loadGeneration);
		const after = Date.now();
		expect(state.activeRunStartedAt).toBeGreaterThanOrEqual(before);
		expect(state.activeRunStartedAt!).toBeLessThanOrEqual(after);
	});

	test("startStreaming returns false → falls back to loadMessages", async () => {
		backgroundFetchMock.mockImplementationOnce(async () =>
			jsonResponse({ runId: "run-busy", status: "running" }),
		);
		startStreamingMock.mockImplementationOnce(() => false);
		const { host, state } = makeHost();
		await runActiveRunCheck(host, state.loadGeneration);

		expect(state.activeRunId).toBeNull();
		expect(state.resumedRun).toBe(false);
		expect(state.loadMessagesCalls).toBe(1);
	});

	test("stale generation (post-await) → bails, no streaming, no message mutations", async () => {
		backgroundFetchMock.mockImplementationOnce(async () =>
			jsonResponse({ runId: "run-stale", status: "running" }),
		);
		const { host, state } = makeHost({ loadGeneration: 1 });
		// Caller passes gen=1; bump host's loadGeneration mid-call so the
		// post-fetch guard trips.
		state.loadGeneration = 2;
		await runActiveRunCheck(host, 1);

		expect(startStreamingMock).not.toHaveBeenCalled();
		expect(state.activeRunId).toBeNull();
		expect(state.allMessages.length).toBe(0);
		expect(state.checkingActiveRun).toBe(false);
	});

	test("pendingPermissions → re-injects synthetic running tool-call cards", async () => {
		backgroundFetchMock.mockImplementationOnce(async () =>
			jsonResponse({
				runId: "run-perm",
				status: "running",
				pendingPermissions: [
					{
						toolCallId: "tc-1",
						toolName: "fs__write",
						input: { path: "a.md" },
						cardType: "fs-write",
						category: "fs",
					},
				],
			}),
		);
		const { host, state } = makeHost();
		await runActiveRunCheck(host, state.loadGeneration);

		const calls = storeStub.streamingToolCalls["run-perm"];
		expect(calls).toBeDefined();
		expect(calls!.length).toBe(1);
		const entry = calls![0]!;
		expect(entry.id).toBe("tc-1");
		expect(entry.toolName).toBe("fs__write");
		expect(entry.status).toBe("running");
		expect((entry as ToolCallState & { permissionPending?: boolean }).permissionPending).toBe(true);
		expect(entry.cardType).toBe("fs-write");
	});

	test("pendingAskUser → re-injects synthetic ask-user-question cards", async () => {
		backgroundFetchMock.mockImplementationOnce(async () =>
			jsonResponse({
				runId: "run-ask",
				status: "running",
				pendingAskUser: [
					{ toolCallId: "tc-ask-1", question: "Confirm?", options: ["yes", "no"] },
				],
			}),
		);
		const { host, state } = makeHost();
		await runActiveRunCheck(host, state.loadGeneration);

		const calls = storeStub.streamingToolCalls["run-ask"];
		expect(calls).toBeDefined();
		expect(calls!.length).toBe(1);
		const entry = calls![0]!;
		expect(entry.toolName).toBe("ask-user__ask_user_question");
		expect(entry.cardType).toBe("ask-user-question");
		expect(entry.input).toEqual({ question: "Confirm?", options: ["yes", "no"] });
	});

	test("pendingAskUser dedups by toolCallId — re-running on a WS reconnect does NOT double the entry", async () => {
		// Reproduces the user-reported "question card renders twice" bug:
		// the live `tool:start` SSE populated the entry; later a WS
		// reconnect re-fired this resume path, and the active-run endpoint
		// returned the same `pendingAskUser` entry. Without the dedup
		// guard, the entry would be appended again, rendering the card
		// twice. This test pins the dedup so future regressions are loud.
		const respond = async () =>
			jsonResponse({
				runId: "run-dup",
				status: "running",
				pendingAskUser: [
					{ toolCallId: "tc-dup-1", question: "Pick", options: ["a", "b"] },
				],
			});
		backgroundFetchMock.mockImplementationOnce(respond);
		backgroundFetchMock.mockImplementationOnce(respond);
		const { host, state } = makeHost();

		await runActiveRunCheck(host, state.loadGeneration);
		await runActiveRunCheck(host, state.loadGeneration);

		const calls = storeStub.streamingToolCalls["run-dup"];
		expect(calls).toBeDefined();
		expect(calls!.length).toBe(1);
		expect(calls![0]!.id).toBe("tc-dup-1");
	});

	test("pendingPermissions dedups by toolCallId — same WS-reconnect race", async () => {
		const respond = async () =>
			jsonResponse({
				runId: "run-perm-dup",
				status: "running",
				pendingPermissions: [
					{ toolCallId: "tc-p-1", toolName: "fs__write", input: { path: "a" }, cardType: "fs-write" },
				],
			});
		backgroundFetchMock.mockImplementationOnce(respond);
		backgroundFetchMock.mockImplementationOnce(respond);
		const { host, state } = makeHost();

		await runActiveRunCheck(host, state.loadGeneration);
		await runActiveRunCheck(host, state.loadGeneration);

		const calls = storeStub.streamingToolCalls["run-perm-dup"];
		expect(calls).toBeDefined();
		expect(calls!.length).toBe(1);
	});

	test("streaming-${runId} placeholder dedups — re-running does NOT push a second placeholder", async () => {
		// Companion to the above: the placeholder-message push at the end
		// of the resume path also has to dedup, otherwise Svelte ends up
		// with two messages keyed `streaming-<runId>` and the bubble
		// briefly renders twice on reconnect.
		const respond = async () =>
			jsonResponse({
				runId: "run-pl",
				status: "running",
				pendingAskUser: [
					{ toolCallId: "tc-pl-1", question: "Pick", options: ["a"] },
				],
			});
		backgroundFetchMock.mockImplementationOnce(respond);
		backgroundFetchMock.mockImplementationOnce(respond);
		const { host, state } = makeHost();

		await runActiveRunCheck(host, state.loadGeneration);
		const after1 = state.allMessages.filter((m) => m.id === "streaming-run-pl").length;
		expect(after1).toBe(1);

		await runActiveRunCheck(host, state.loadGeneration);
		const after2 = state.allMessages.filter((m) => m.id === "streaming-run-pl").length;
		expect(after2).toBe(1);
	});

	test("backgroundFetch throws → caught, checkingActiveRun cleared", async () => {
		backgroundFetchMock.mockImplementationOnce(async () => {
			throw new Error("network down");
		});
		const { host, state } = makeHost({ checkingActiveRun: true });
		await runActiveRunCheck(host, state.loadGeneration);

		expect(state.checkingActiveRun).toBe(false);
		expect(state.activeRunId).toBeNull();
	});
});

// ── shouldFireReconnectCheck (cooldown semantics) ───────────────────────

describe("shouldFireReconnectCheck — cooldown semantics", () => {
	test("fires on transition wasConnected=false → connected=true", () => {
		const { host } = makeHost();
		const fired = shouldFireReconnectCheck(host, true, false, 0, 100_000);
		expect(fired).toBe(true);
	});

	test("does not fire when already connected (no transition)", () => {
		const { host } = makeHost();
		const fired = shouldFireReconnectCheck(host, true, true, 0, 100_000);
		expect(fired).toBe(false);
	});

	test("does not fire on disconnect", () => {
		const { host } = makeHost();
		const fired = shouldFireReconnectCheck(host, false, true, 0, 100_000);
		expect(fired).toBe(false);
	});

	test("does not fire when activeRunId is set (already streaming, no need to resume)", () => {
		const { host } = makeHost({ activeRunId: "run-x" });
		const fired = shouldFireReconnectCheck(host, true, false, 0, 100_000);
		expect(fired).toBe(false);
	});

	test("does not fire before initial load completes", () => {
		const { host } = makeHost({ initialLoadDone: false });
		const fired = shouldFireReconnectCheck(host, true, false, 0, 100_000);
		expect(fired).toBe(false);
	});

	test("two reconnects within cooldown → only the first passes the gate", () => {
		const { host } = makeHost();
		// Use realistic Date.now()-style timestamps (cooldown is `now - last`,
		// so the initial last=0 only stalls for cooldown-ms after epoch).
		const t1 = 1_700_000_000_000;
		const fire1 = shouldFireReconnectCheck(host, true, false, t1 - RECONNECT_CHECK_COOLDOWN_MS, t1);
		expect(fire1).toBe(true);
		// Second reconnect at t1 + (cooldown - 1) → blocked.
		const fire2 = shouldFireReconnectCheck(
			host,
			true,
			false,
			t1,
			t1 + RECONNECT_CHECK_COOLDOWN_MS - 1,
		);
		expect(fire2).toBe(false);
	});

	test("two reconnects beyond cooldown → both pass the gate", () => {
		const { host } = makeHost();
		const t1 = 1_700_000_000_000;
		const fire1 = shouldFireReconnectCheck(host, true, false, t1 - RECONNECT_CHECK_COOLDOWN_MS, t1);
		expect(fire1).toBe(true);
		const fire2 = shouldFireReconnectCheck(
			host,
			true,
			false,
			t1,
			t1 + RECONNECT_CHECK_COOLDOWN_MS,
		);
		expect(fire2).toBe(true);
	});

	test("first reconnect from cold start (lastReconnectCheckAt=0) fires immediately at real Date.now()", () => {
		const { host } = makeHost();
		// Mirrors the production initial state: lastReconnectCheckAt=0,
		// now=Date.now() is ~1.7e12 ms, well past cooldown threshold.
		const fired = shouldFireReconnectCheck(host, true, false, 0, Date.now());
		expect(fired).toBe(true);
	});

	test("cooldown is exactly 10 seconds", () => {
		expect(RECONNECT_CHECK_COOLDOWN_MS).toBe(10_000);
	});
});

// ── pollStaleness (10s metadata refresh) ─────────────────────────────────

describe("pollStaleness", () => {
	test("no-ops when activeRunId is null", async () => {
		const { host } = makeHost({ activeRunId: null });
		await pollStaleness(host);
		expect(backgroundFetchMock).not.toHaveBeenCalled();
	});

	test("refreshes serverStalenessMs from response", async () => {
		backgroundFetchMock.mockImplementationOnce(async () =>
			jsonResponse({ runId: "run-poll", stalenessMs: 8000 }),
		);
		const { host, state } = makeHost({ activeRunId: "run-poll" });
		await pollStaleness(host);
		expect(state.serverStalenessMs).toBe(8000);
	});

	test("ignores response when runId no longer matches activeRunId", async () => {
		backgroundFetchMock.mockImplementationOnce(async () =>
			jsonResponse({ runId: "run-OLD", stalenessMs: 9999 }),
		);
		const { host, state } = makeHost({ activeRunId: "run-NEW" });
		await pollStaleness(host);
		expect(state.serverStalenessMs).toBeNull();
	});

	test("populates activeRunStartedAt only when previously null", async () => {
		const startedAt = "2025-02-02T08:00:00.000Z";
		backgroundFetchMock.mockImplementationOnce(async () =>
			jsonResponse({ runId: "run-x", startedAt, stalenessMs: 100 }),
		);
		const { host, state } = makeHost({
			activeRunId: "run-x",
			activeRunStartedAt: null,
		});
		await pollStaleness(host);
		expect(state.activeRunStartedAt).toBe(new Date(startedAt).getTime());
	});

	test("does NOT overwrite activeRunStartedAt when already set", async () => {
		const original = 12345;
		backgroundFetchMock.mockImplementationOnce(async () =>
			jsonResponse({
				runId: "run-x",
				startedAt: "2099-12-31T23:59:59.000Z",
				stalenessMs: 100,
			}),
		);
		const { host, state } = makeHost({
			activeRunId: "run-x",
			activeRunStartedAt: original,
		});
		await pollStaleness(host);
		expect(state.activeRunStartedAt).toBe(original);
	});

	test("network error is non-fatal", async () => {
		backgroundFetchMock.mockImplementationOnce(async () => {
			throw new Error("offline");
		});
		const { host, state } = makeHost({ activeRunId: "run-x" });
		await pollStaleness(host); // should not throw
		expect(state.serverStalenessMs).toBeNull();
	});
});

// ── runZombieCheck (timeout-fired re-check) ──────────────────────────────

describe("runZombieCheck", () => {
	test("no-ops when activeRunId is null", async () => {
		const { host } = makeHost({ activeRunId: null });
		await runZombieCheck(host, "");
		expect(backgroundFetchMock).not.toHaveBeenCalled();
	});

	test("aborts when streaming text changed (a token arrived)", async () => {
		const { host } = makeHost({
			activeRunId: "run-x",
			currentStreamingText: "new partial",
		});
		await runZombieCheck(host, "old partial");
		expect(backgroundFetchMock).not.toHaveBeenCalled();
		expect(stopStreamingMock).not.toHaveBeenCalled();
	});

	test("server says run flipped to non-running → stopStreaming", async () => {
		backgroundFetchMock.mockImplementationOnce(async () =>
			jsonResponse({ runId: "run-x", status: "completed" }),
		);
		const { host } = makeHost({
			activeRunId: "run-x",
			currentStreamingText: "stuck",
		});
		await runZombieCheck(host, "stuck");
		expect(stopStreamingMock).toHaveBeenCalledWith("run-x");
	});

	test("server says run id no longer matches → stopStreaming", async () => {
		backgroundFetchMock.mockImplementationOnce(async () =>
			jsonResponse({ runId: "run-DIFFERENT", status: "running" }),
		);
		const { host } = makeHost({
			activeRunId: "run-x",
			currentStreamingText: "stuck",
		});
		await runZombieCheck(host, "stuck");
		expect(stopStreamingMock).toHaveBeenCalledWith("run-x");
	});

	test("server confirms still running → refreshes serverStalenessMs, no stopStreaming", async () => {
		backgroundFetchMock.mockImplementationOnce(async () =>
			jsonResponse({ runId: "run-x", status: "running", stalenessMs: 31_000 }),
		);
		const { host, state } = makeHost({
			activeRunId: "run-x",
			currentStreamingText: "stuck",
		});
		await runZombieCheck(host, "stuck");
		expect(stopStreamingMock).not.toHaveBeenCalled();
		expect(state.serverStalenessMs).toBe(31_000);
	});

	test("network error is non-fatal", async () => {
		backgroundFetchMock.mockImplementationOnce(async () => {
			throw new Error("offline");
		});
		const { host } = makeHost({
			activeRunId: "run-x",
			currentStreamingText: "stuck",
		});
		await runZombieCheck(host, "stuck"); // should not throw
		expect(stopStreamingMock).not.toHaveBeenCalled();
	});
});

// ── Constant exports (smoke) ─────────────────────────────────────────────

describe("constants moved from page", () => {
	test("ZOMBIE_TIMEOUT_FRESH_MS is 30s, ZOMBIE_TIMEOUT_RESUMED_MS is 5s", () => {
		expect(ZOMBIE_TIMEOUT_FRESH_MS).toBe(30_000);
		expect(ZOMBIE_TIMEOUT_RESUMED_MS).toBe(5_000);
	});

	test("STALENESS_POLL_INTERVAL_MS is 10s", () => {
		expect(STALENESS_POLL_INTERVAL_MS).toBe(10_000);
	});
});
