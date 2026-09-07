import "@testing-library/jest-dom/vitest";
import { fireEvent, render, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({
	fetchProviders: vi.fn(), fetchSettings: vi.fn(), saveProviderKey: vi.fn(), deleteProviderKey: vi.fn(), disconnectOAuth: vi.fn(), upsertSetting: vi.fn(), testProviderConnection: vi.fn(), refreshProviderModels: vi.fn(),
}));
const refreshQuickstart = vi.hoisted(() => vi.fn());
const oauth = vi.hoisted(() => ({
	startOAuthFlow: vi.fn(), completeOAuthWithCode: vi.fn(), listenForOAuthResult: vi.fn(),
}));

vi.mock("$lib/api.js", () => api);
vi.mock("$lib/stores.svelte.js", () => ({ refreshQuickstart }));
vi.mock("$lib/oauth.js", () => oauth);

import ProviderSettings from "./ProviderSettings.svelte";

const byokProvider = { provider: "anthropic", hasKey: true, source: "byok" as const, oauthConnected: false, oauthExpired: false, oauthSupported: false, expiresAt: null };
const oauthProvider = { provider: "openai", hasKey: false, source: "none" as const, oauthConnected: true, oauthExpired: false, oauthSupported: true, expiresAt: null };
const unconfiguredAnthropic = { ...byokProvider, hasKey: false, source: "none" as const };

function providerCard(container: HTMLElement, provider: string) {
	return within(container.querySelector<HTMLElement>(`[data-testid="provider-card-${provider}"]`)!);
}

describe("ProviderSettings completion refresh", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		api.fetchSettings.mockResolvedValue({});
		api.saveProviderKey.mockResolvedValue(undefined);
		api.deleteProviderKey.mockResolvedValue(undefined);
		api.disconnectOAuth.mockResolvedValue(undefined);
		api.upsertSetting.mockResolvedValue(undefined);
		api.testProviderConnection.mockResolvedValue({ success: true });
		api.refreshProviderModels.mockResolvedValue({ success: true, count: 0 });
		refreshQuickstart.mockResolvedValue(undefined);
		oauth.listenForOAuthResult.mockReturnValue(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

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

	test("shows usable connection states and setup choices for each provider", async () => {
		api.fetchProviders.mockResolvedValue([
			unconfiguredAnthropic,
			{ provider: "kilo", hasKey: false, source: "none" as const, oauthConnected: false, oauthExpired: false, oauthSupported: false, expiresAt: null },
			{ provider: "openai", hasKey: true, source: "byok" as const, oauthConnected: true, oauthExpired: false, oauthSupported: true, expiresAt: "2026-09-07T12:00:00.000Z" },
			{ provider: "google", hasKey: false, source: "none" as const, oauthConnected: true, oauthExpired: true, oauthSupported: true, expiresAt: "2026-09-05T12:00:00.000Z" },
			{ provider: "openrouter", hasKey: true, source: "env" as const, oauthConnected: false, oauthExpired: false, oauthSupported: false, expiresAt: null },
		]);
		const { container } = render(ProviderSettings);
		await waitFor(() => expect(providerCard(container, "anthropic").getByText("Not configured")).toBeVisible());

		expect(providerCard(container, "anthropic").getByText("OAuth not available -- Anthropic requires API keys.")).toBeVisible();
		expect(providerCard(container, "kilo").getByText("Free tier active")).toBeVisible();
		expect(providerCard(container, "kilo").getByTestId("provider-free-tier-note-kilo")).toBeVisible();
		expect(providerCard(container, "openai").getByText("Subscription")).toBeVisible();
		expect(providerCard(container, "openai").getByText("API Key")).toBeVisible();
		expect(providerCard(container, "openai").getByLabelText("Preferred access:")).toHaveValue("auto");
		expect(providerCard(container, "google").getByText("Token expired")).toBeVisible();
		expect(providerCard(container, "google").getByRole("button", { name: "Reconnect" })).toBeVisible();
		expect(providerCard(container, "openrouter").getByText("Env")).toBeVisible();
	});

	test("saves an API key, refreshes quickstart, and exposes the saved-key controls", async () => {
		let providers = [unconfiguredAnthropic];
		api.fetchProviders.mockImplementation(async () => providers);
		api.saveProviderKey.mockImplementation(async () => {
			providers = [byokProvider];
		});
		const { container } = render(ProviderSettings);
		await waitFor(() => expect(container.querySelector('[data-testid="provider-card-anthropic"]')).not.toBeNull());
		const card = providerCard(container, "anthropic");
		await waitFor(() => expect(card.getByLabelText("API key for Anthropic (Claude)")).toBeVisible());
		await fireEvent.input(card.getByLabelText("API key for Anthropic (Claude)"), { target: { value: " sk-test " } });
		await fireEvent.click(card.getByRole("button", { name: "Save Key" }));

		await waitFor(() => expect(api.saveProviderKey).toHaveBeenCalledWith("anthropic", "sk-test"));
		await waitFor(() => expect(card.getByText("Key saved")).toBeVisible());
		expect(refreshQuickstart).toHaveBeenCalledTimes(1);
		expect(api.refreshProviderModels).toHaveBeenCalledWith("anthropic");
	});

	test("keeps an API key field available after save failure", async () => {
		api.fetchProviders.mockResolvedValue([unconfiguredAnthropic]);
		api.saveProviderKey.mockRejectedValue(new Error("offline"));
		const { container, getByTestId } = render(ProviderSettings);
		await waitFor(() => expect(container.querySelector('[data-testid="provider-card-anthropic"]')).not.toBeNull());
		const card = providerCard(container, "anthropic");
		await waitFor(() => expect(card.getByLabelText("API key for Anthropic (Claude)")).toBeVisible());
		await fireEvent.input(card.getByLabelText("API key for Anthropic (Claude)"), { target: { value: "sk-test" } });
		await fireEvent.click(card.getByRole("button", { name: "Save Key" }));

		await waitFor(() => expect(getByTestId("provider-error")).toHaveTextContent("Failed to save key for anthropic"));
		expect(card.getByLabelText("API key for Anthropic (Claude)")).toHaveValue("sk-test");
	});

	test("updates a saved key and lets the user show or hide the replacement", async () => {
		api.fetchProviders.mockResolvedValue([byokProvider]);
		const { container } = render(ProviderSettings);
		await waitFor(() => expect(container.querySelector('[data-testid="provider-card-anthropic"]')).not.toBeNull());
		const card = providerCard(container, "anthropic");
		await waitFor(() => expect(card.getByRole("button", { name: "Update" })).toBeVisible());
		await fireEvent.click(card.getByRole("button", { name: "Update" }));
		const input = card.getByLabelText("API key for Anthropic (Claude)") as HTMLInputElement;
		expect(input.type).toBe("password");
		await fireEvent.click(card.getByRole("button", { name: "Show API key for Anthropic (Claude)" }));
		expect(input.type).toBe("text");
		await fireEvent.click(card.getByRole("button", { name: "Hide API key for Anthropic (Claude)" }));
		expect(input.type).toBe("password");
		await fireEvent.click(card.getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(card.getByText("Key saved")).toBeVisible());
	});

	test("reports provider test and model refresh results", async () => {
		api.fetchProviders.mockResolvedValue([{ provider: "kilo", hasKey: false, source: "none", oauthConnected: false, oauthExpired: false, oauthSupported: false, expiresAt: null }]);
		api.testProviderConnection.mockResolvedValueOnce({ success: false, error: "No route" });
		api.refreshProviderModels.mockResolvedValueOnce({ success: true, count: 4, freeCount: 2 });
		const { container } = render(ProviderSettings);
		await waitFor(() => expect(container.querySelector('[data-testid="provider-card-kilo"]')).not.toBeNull());
		const card = providerCard(container, "kilo");
		await waitFor(() => expect(card.getByRole("button", { name: "Test" })).toBeVisible());
		await fireEvent.click(card.getByRole("button", { name: "Test" }));
		await waitFor(() => expect(card.getByText("No route")).toBeVisible());
		await fireEvent.click(card.getByRole("button", { name: "Refresh models" }));
		await waitFor(() => expect(card.getByTestId("provider-refresh-result-kilo")).toHaveTextContent("Loaded 4 models — 2 free"));
	});

	test("connects an OAuth provider by pasted callback and saves its access choice", async () => {
		let providers = [{ ...oauthProvider, oauthConnected: false }];
		api.fetchProviders.mockImplementation(async () => providers);
		oauth.startOAuthFlow.mockResolvedValue({ provider: "openai", authUrl: "https://auth.example.test" });
		oauth.completeOAuthWithCode.mockImplementation(async () => {
			providers = [{ ...oauthProvider, hasKey: true, source: "byok" as const }];
			return { success: true, provider: "openai" };
		});
		const open = vi.spyOn(window, "open").mockImplementation(() => null);
		const { container, getByText } = render(ProviderSettings);
		await waitFor(() => expect(container.querySelector('[data-testid="provider-card-openai"]')).not.toBeNull());
		const card = providerCard(container, "openai");
		await waitFor(() => expect(card.getByRole("button", { name: "Connect OpenAI Subscription" })).toBeVisible());
		await fireEvent.click(card.getByRole("button", { name: "Connect OpenAI Subscription" }));
		await waitFor(() => expect(getByText("Connect OpenAI")).toBeVisible());
		expect(open).toHaveBeenCalledWith("https://auth.example.test", "_blank");
		await fireEvent.input(container.querySelector<HTMLInputElement>('input[placeholder^="Paste the callback URL"]')!, { target: { value: "http://callback" } });
		await fireEvent.click(getByText("Submit"));
		await waitFor(() => expect(oauth.completeOAuthWithCode).toHaveBeenCalled());
		await waitFor(() => expect(card.getByLabelText("Preferred access:")).toBeVisible());
		await fireEvent.change(card.getByLabelText("Preferred access:"), { target: { value: "apikey" } });
		await waitFor(() => expect(api.upsertSetting).toHaveBeenCalledWith("provider:accessMode:openai", "apikey"));
		open.mockRestore();
	});

	test("shows OAuth callback errors", async () => {
		api.fetchProviders.mockResolvedValue([{ ...oauthProvider, oauthConnected: false }]);
		oauth.startOAuthFlow.mockResolvedValue({ provider: "openai", authUrl: "https://auth.example.test" });
		oauth.completeOAuthWithCode.mockResolvedValue({ success: false, error: "Code was rejected" });
		vi.spyOn(window, "open").mockImplementation(() => null);
		const { container, getByText } = render(ProviderSettings);
		await waitFor(() => expect(container.querySelector('[data-testid="provider-card-openai"]')).not.toBeNull());
		const card = providerCard(container, "openai");
		await waitFor(() => expect(card.getByRole("button", { name: "Connect OpenAI Subscription" })).toBeVisible());
		await fireEvent.click(card.getByRole("button", { name: "Connect OpenAI Subscription" }));
		await fireEvent.input(container.querySelector<HTMLInputElement>('input[placeholder^="Paste the callback URL"]')!, { target: { value: "http://callback" } });
		await fireEvent.click(getByText("Submit"));
		await waitFor(() => expect(getByText("Code was rejected")).toBeVisible());

	});

	test("shows a readable error when provider status cannot load", async () => {
		api.fetchProviders.mockRejectedValue(new Error("offline"));
		const { getByTestId } = render(ProviderSettings);
		await waitFor(() => expect(getByTestId("provider-error")).toHaveTextContent("Failed to load provider status"));
	});
});
