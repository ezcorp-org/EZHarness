import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const ws = vi.hoisted(() => ({ subscriber: null as ((event: { type: string; data: unknown }) => void) | null }));

vi.mock("$lib/ws.js", () => ({
	createWSClient: () => ({
		subscribe: (subscriber: (event: { type: string; data: unknown }) => void) => {
			ws.subscriber = subscriber;
			return () => {};
		},
		close: () => {},
		manualRetry: () => {},
	}),
}));

vi.mock("$lib/api.js", () => ({
	fetchAgents: () => Promise.resolve([]),
	fetchRuns: () => Promise.resolve([]),
	fetchProjects: () => Promise.resolve([]),
	fetchSettings: () => Promise.resolve({}),
	fetchAgentConfigs: () => Promise.resolve([]),
	fetchWorkflows: () => Promise.resolve([]),
}));

import { initStores } from "$lib/stores.svelte.js";

function quickstartResponse(): Response {
	return new Response(JSON.stringify({ steps: { provider: true, chat: false, extension: false, agent: false } }));
}

function emit(type: string, data: unknown) {
	if (!ws.subscriber) throw new Error("subscriber not captured");
	ws.subscriber({ type, data });
}

describe("quickstart refreshes from live events", () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		ws.subscriber = null;
		fetchMock = vi.fn(async () => quickstartResponse());
		vi.stubGlobal("fetch", fetchMock);
		initStores();
		expect(ws.subscriber).not.toBeNull();
		fetchMock.mockClear();
	});

	afterEach(() => vi.unstubAllGlobals());

	test("refreshes completion after an extension install", async () => {
		emit("extensions:installed", { extensionId: "ext-1" });
		await Promise.resolve();
		expect(fetchMock).toHaveBeenCalledWith("/api/quickstart");
	});

	test("refreshes completion after a server-created conversation", async () => {
		emit("conversation:created", { conversationId: "conv-1", projectId: "project-1" });
		await Promise.resolve();
		expect(fetchMock).toHaveBeenCalledWith("/api/quickstart");
	});
});
