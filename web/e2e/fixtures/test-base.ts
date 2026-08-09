import { setupApiMocks, type MockOverrides } from "./api-mocks.js";
// `hydration.ts` — NOT `@playwright/test` — is the base: its `page` fixture
// gates every `goto` on the client app actually having hydrated (issue #145).
// Extending it here means the mock tier inherits that gate for free, and the
// real-auth tier gets the same gate by importing `hydration.js` directly
// (it must not reach this module — see playwright.real.config.ts).
import { test as base } from "./hydration.js";
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
export { waitForHydration, HYDRATION_ATTR } from "./hydration.js";
