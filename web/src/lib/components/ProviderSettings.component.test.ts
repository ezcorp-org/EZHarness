import "@testing-library/jest-dom/vitest";
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({
	fetchProviders: vi.fn(), fetchSettings: vi.fn(), saveProviderKey: vi.fn(), deleteProviderKey: vi.fn(), disconnectOAuth: vi.fn(), upsertSetting: vi.fn(), testProviderConnection: vi.fn(), refreshProviderModels: vi.fn(),
}));
const refreshQuickstart = vi.hoisted(() => vi.fn());

vi.mock("$lib/api.js", () => api);
vi.mock("$lib/stores.svelte.js", () => ({ refreshQuickstart }));
vi.mock("$lib/oauth.js", () => ({ startOAuthFlow: vi.fn(), completeOAuthWithCode: vi.fn(), listenForOAuthResult: vi.fn(() => () => {}) }));

import ProviderSettings from "./ProviderSettings.svelte";

const byokProvider = { provider: "anthropic", hasKey: true, source: "byok" as const, oauthConnected: false, oauthExpired: false, oauthSupported: false, expiresAt: null };
const oauthProvider = { provider: "openai", hasKey: false, source: "none" as const, oauthConnected: true, oauthExpired: false, oauthSupported: true, expiresAt: null };

describe("ProviderSettings completion refresh", () => {
	beforeEach(() => {
		api.fetchSettings.mockResolvedValue({});
		api.saveProviderKey.mockResolvedValue(undefined);
		api.deleteProviderKey.mockResolvedValue(undefined);
		api.disconnectOAuth.mockResolvedValue(undefined);
		api.upsertSetting.mockResolvedValue(undefined);
		api.testProviderConnection.mockResolvedValue({ success: true });
		api.refreshProviderModels.mockResolvedValue({ success: true, count: 0 });
		refreshQuickstart.mockResolvedValue(undefined);
	});

	afterEach(() => vi.clearAllMocks());

	test("refreshes quickstart after an API key is removed", async () => {
		api.fetchProviders.mockResolvedValue([byokProvider]);
		const { getByRole } = render(ProviderSettings);
		await waitFor(() => expect(getByRole("button", { name: "Remove" })).toBeVisible());
		await fireEvent.click(getByRole("button", { name: "Remove" }));
		await fireEvent.click(getByRole("button", { name: "Confirm" }));
		await waitFor(() => expect(api.deleteProviderKey).toHaveBeenCalledWith("anthropic"));
		expect(refreshQuickstart).toHaveBeenCalledTimes(1);
	});

	test("refreshes quickstart after OAuth is disconnected", async () => {
		api.fetchProviders.mockResolvedValue([oauthProvider]);
		const { getByRole } = render(ProviderSettings);
		await waitFor(() => expect(getByRole("button", { name: "Disconnect" })).toBeVisible());
		await fireEvent.click(getByRole("button", { name: "Disconnect" }));
		await fireEvent.click(getByRole("button", { name: "Confirm" }));
		await waitFor(() => expect(api.disconnectOAuth).toHaveBeenCalledWith("openai"));
		expect(refreshQuickstart).toHaveBeenCalledTimes(1);
	});
});
