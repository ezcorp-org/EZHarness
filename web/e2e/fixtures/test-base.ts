import { test as base } from "@playwright/test";
import { setupApiMocks, type MockOverrides } from "./api-mocks.js";
import { setupWsMock, emitWsEvent, emitSseEvent } from "./ws-mock.js";

export const test = base.extend<{
	mockApi: (overrides?: MockOverrides) => Promise<void>;
	emitWs: (event: { type: string; data: unknown }) => Promise<void>;
	/**
	 * Emit a Server-Sent Event into the page's fake EventSource(s).
	 * Optional `urlMatch` filters to a specific stream (e.g. the Ez
	 * panel's runtime-events listener for a given conversation id).
	 */
	emitSse: (event: { type: string; data: unknown }, urlMatch?: string) => Promise<void>;
}>({
	mockApi: async ({ page }, use) => {
		await use(async (overrides?: MockOverrides) => {
			await setupWsMock(page);
			await setupApiMocks(page, overrides);
		});
	},
	emitWs: async ({ page }, use) => {
		await use((event) => emitWsEvent(page, event));
	},
	emitSse: async ({ page }, use) => {
		await use((event, urlMatch) => emitSseEvent(page, event, urlMatch));
	},
});

export { expect } from "@playwright/test";
export { captureEvidence } from "./evidence";
