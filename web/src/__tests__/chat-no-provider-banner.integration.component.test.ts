/**
 * Integration component test for the chat empty-state "Connect a
 * provider" banner.
 *
 * Covers:
 *   - Banner renders when `store.settings` has no provider keys
 *   - Banner is absent when a provider:<name>:apiKey key exists
 *   - Banner is absent when a provider:oauth:<name> key exists
 *   - Banner reactively disappears when settings updates mid-session
 *     (this is the key contract — the component must NOT need a
 *     reload to react to a connection in another tab)
 *   - Banner has NO dismiss control (this is the safety net for users
 *     who skipped Step 1 of onboarding — must not be hideable)
 *   - CTA link target is /settings#providers
 */

import "@testing-library/jest-dom/vitest";
import { render, waitFor } from "@testing-library/svelte";
import { describe, test, expect, beforeEach } from "vitest";

import NoProviderBanner from "$lib/components/chat/NoProviderBanner.svelte";
import { store } from "$lib/stores.svelte.js";

describe("NoProviderBanner", () => {
	beforeEach(() => {
		// Reset shared store between tests; the rune-backed $state survives module reloads.
		store.settings = {};
	});

	test("renders when store.settings has no provider keys", () => {
		const { getByTestId } = render(NoProviderBanner);
		const banner = getByTestId("no-provider-banner");
		expect(banner).toBeInTheDocument();
		expect(banner).toHaveTextContent("Connect a provider to start chatting");
	});

	test("absent when store.settings has a BYOK key", () => {
		store.settings = { "provider:anthropic:apiKey": "sk-test" };
		const { queryByTestId } = render(NoProviderBanner);
		expect(queryByTestId("no-provider-banner")).toBeNull();
	});

	test("absent when store.settings has an OAuth row", () => {
		store.settings = { "provider:oauth:openai": { token: "x" } };
		const { queryByTestId } = render(NoProviderBanner);
		expect(queryByTestId("no-provider-banner")).toBeNull();
	});

	test("reactively disappears when a provider key is added mid-session", async () => {
		const { queryByTestId } = render(NoProviderBanner);
		expect(queryByTestId("no-provider-banner")).toBeInTheDocument();

		store.settings = { ...store.settings, "provider:google:apiKey": "AIza-test" };

		await waitFor(() => expect(queryByTestId("no-provider-banner")).toBeNull());
	});

	test("non-provider settings (e.g. tier) do NOT clear the banner", () => {
		store.settings = { "provider:defaultTier": "balanced" };
		const { getByTestId } = render(NoProviderBanner);
		expect(getByTestId("no-provider-banner")).toBeInTheDocument();
	});

	test("loose-match guard: 'provider:foo:apiKeyBackup' (not exact :apiKey suffix) does NOT clear the banner", () => {
		// Catches the previous `.includes(":apiKey")` predicate that
		// would have falsely matched suffixed keys. Locks the
		// endsWith(":apiKey") contract that mirrors the server's
		// LIKE 'provider:%:apiKey' pattern.
		store.settings = { "provider:foo:apiKeyBackup": "x" };
		const { getByTestId } = render(NoProviderBanner);
		expect(getByTestId("no-provider-banner")).toBeInTheDocument();
	});

	test("banner has NO dismiss/close control", () => {
		const { getByTestId, container } = render(NoProviderBanner);
		const banner = container.querySelector('[data-testid="no-provider-banner"]')!;
		expect(getByTestId("no-provider-banner")).toBeInTheDocument();
		expect(banner.querySelectorAll("button").length).toBe(0);
		expect(banner.querySelector('[aria-label*="dismiss" i]')).toBeNull();
		expect(banner.querySelector('[aria-label*="close" i]')).toBeNull();
	});

	test("CTA link points to /settings#providers", () => {
		const { getByTestId } = render(NoProviderBanner);
		const cta = getByTestId("no-provider-banner-cta");
		expect(cta.getAttribute("href")).toBe("/settings#providers");
	});
});
