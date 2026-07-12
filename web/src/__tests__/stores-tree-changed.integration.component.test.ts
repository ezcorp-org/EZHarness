/**
 * INTEGRATION test for the Sessions P4 `conversation:tree-changed` arm of the
 * REAL `stores.svelte.ts` SSE subscriber (not a copy).
 *
 * Mocks the WS client to capture the subscriber the store registers, emits a
 * `conversation:tree-changed` bus event at it, and asserts the store
 * re-dispatches it as a `window` CustomEvent (the bridge ChatThread listens on)
 * carrying the raw event data. Mirrors
 * stores-tool-error-status.integration.component.test.ts.
 */

import { describe, test, expect, beforeEach, vi } from "vitest";

let capturedSubscriber: ((evt: { type: string; data: unknown }) => void) | null = null;

vi.mock("$lib/ws", () => ({
	createWSClient: () => ({
		subscribe: (fn: (evt: { type: string; data: unknown }) => void) => {
			capturedSubscriber = fn;
			return () => {};
		},
		close: () => {},
		manualRetry: () => {},
	}),
}));

vi.mock("$lib/api", () => ({
	fetchAgents: () => Promise.resolve([]),
	fetchRuns: () => Promise.resolve([]),
	fetchProjects: () => Promise.resolve([]),
	fetchSettings: () => Promise.resolve({}),
	fetchAgentConfigs: () => Promise.resolve([]),
	fetchPipelines: () => Promise.resolve([]),
}));

import { initStores } from "$lib/stores.svelte";

function emit(type: string, data: unknown) {
	if (!capturedSubscriber) throw new Error("subscriber not captured — initStores not called?");
	capturedSubscriber({ type, data });
}

describe("stores.svelte.ts — conversation:tree-changed re-dispatch (Sessions P4)", () => {
	beforeEach(() => {
		capturedSubscriber = null;
		initStores();
	});

	test("re-dispatches the bus event as a window CustomEvent carrying the raw data", () => {
		const received: Array<{ conversationId?: string; currentLeaf?: string | null }> = [];
		const listener = (e: Event) => received.push((e as CustomEvent).detail);
		window.addEventListener("conversation:tree-changed", listener);
		try {
			emit("conversation:tree-changed", { conversationId: "conv-9", currentLeaf: "m-7" });
		} finally {
			window.removeEventListener("conversation:tree-changed", listener);
		}
		expect(received).toEqual([{ conversationId: "conv-9", currentLeaf: "m-7" }]);
	});
});
