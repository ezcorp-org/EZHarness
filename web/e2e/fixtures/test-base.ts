import { test as base } from "@playwright/test";
import { setupApiMocks, type MockOverrides } from "./api-mocks.js";
import { setupWsMock, emitWsEvent } from "./ws-mock.js";

export const test = base.extend<{
	mockApi: (overrides?: MockOverrides) => Promise<void>;
	emitWs: (event: { type: string; data: unknown }) => Promise<void>;
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
});

export { expect } from "@playwright/test";
