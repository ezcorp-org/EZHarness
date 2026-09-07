import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { refreshQuickstart, store } from "$lib/stores.svelte.js";

function quickstartResponse(provider: boolean): Response {
	return new Response(
		JSON.stringify({ steps: { provider, chat: false, extension: false, agent: false } }),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

describe("refreshQuickstart", () => {
	beforeEach(() => {
		store.quickstartSteps = { provider: false, chat: false, extension: false, agent: false };
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test("keeps the newest completion state when an older refresh resolves last", async () => {
		let resolveOlder: (response: Response) => void = () => {};
		const older = new Promise<Response>((resolve) => {
			resolveOlder = resolve;
		});
		vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(older).mockResolvedValueOnce(quickstartResponse(true)));

		const staleRefresh = refreshQuickstart();
		await refreshQuickstart();
		expect(store.quickstartSteps?.provider).toBe(true);

		resolveOlder(quickstartResponse(false));
		await staleRefresh;
		expect(store.quickstartSteps?.provider).toBe(true);
	});

	test("keeps the last known completion state when refresh fails", async () => {
		store.quickstartSteps = { provider: true, chat: true, extension: false, agent: false };
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

		await refreshQuickstart();
		expect(store.quickstartSteps).toEqual({ provider: true, chat: true, extension: false, agent: false });
	});
});
