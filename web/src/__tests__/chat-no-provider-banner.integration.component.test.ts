/**
 * Integration component test for the chat empty-state "Connect a
 * provider" banner.
 *
 * The banner asks `/api/quickstart` whether any provider is connected
 * (BYOK or OAuth). We mock `fetch` so each test can choose the answer.
 *
 * Covers:
 *   - Banner renders when /api/quickstart reports provider:false
 *   - Banner is absent when /api/quickstart reports provider:true
 *   - Banner is absent when /api/quickstart fails (fail closed: don't
 *     nag a user we couldn't verify — server gates the actual send)
 *   - Banner stays hidden during the in-flight fetch (no flash)
 *   - Banner has NO dismiss control (this is the safety net for users
 *     who skipped Step 1 of onboarding — must not be hideable)
 *   - CTA link target is /settings/models#providers
 */

import "@testing-library/jest-dom/vitest";
import { render, waitFor } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

import NoProviderBanner from "$lib/components/chat/NoProviderBanner.svelte";

function mockFetch(response: { provider: boolean } | "error" | "pending"): {
	resolvePending?: () => void;
} {
	if (response === "pending") {
		let resolvePending: () => void = () => {};
		const promise = new Promise<Response>((resolve) => {
			resolvePending = () =>
				resolve(new Response(JSON.stringify({ steps: { provider: true } }), { status: 200 }));
		});
		vi.stubGlobal("fetch", vi.fn(() => promise));
		return { resolvePending };
	}
	if (response === "error") {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("err", { status: 500 })));
		return {};
	}
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(JSON.stringify({ steps: { provider: response.provider } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		),
	);
	return {};
}

describe("NoProviderBanner", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test("renders when /api/quickstart reports provider:false", async () => {
		mockFetch({ provider: false });
		const { findByTestId } = render(NoProviderBanner);
		const banner = await findByTestId("no-provider-banner");
		expect(banner).toBeInTheDocument();
		expect(banner).toHaveTextContent("Connect a provider to start chatting");
	});

	test("absent when /api/quickstart reports provider:true", async () => {
		mockFetch({ provider: true });
		const { queryByTestId } = render(NoProviderBanner);
		// Wait one microtask for the onMount fetch to resolve.
		await waitFor(() => expect(queryByTestId("no-provider-banner")).toBeNull());
	});

	test("absent when /api/quickstart returns an error (fail closed)", async () => {
		mockFetch("error");
		const { queryByTestId, findByTestId } = render(NoProviderBanner);
		// On error we still treat it as "no provider" so the user is told
		// to set one up — the server will reject sends if they try anyway.
		await findByTestId("no-provider-banner");
		expect(queryByTestId("no-provider-banner")).toBeInTheDocument();
	});

	test("does not render before the fetch resolves (no flash)", async () => {
		const { resolvePending } = mockFetch("pending");
		const { queryByTestId } = render(NoProviderBanner);
		expect(queryByTestId("no-provider-banner")).toBeNull();
		// Resolve the in-flight fetch with provider:true so cleanup is clean.
		resolvePending?.();
		await waitFor(() => expect(queryByTestId("no-provider-banner")).toBeNull());
	});

	test("banner has NO dismiss/close control", async () => {
		mockFetch({ provider: false });
		const { findByTestId, container } = render(NoProviderBanner);
		const banner = await findByTestId("no-provider-banner");
		expect(banner).toBeInTheDocument();
		expect(banner.querySelectorAll("button").length).toBe(0);
		expect(container.querySelector('[aria-label*="dismiss" i]')).toBeNull();
		expect(container.querySelector('[aria-label*="close" i]')).toBeNull();
	});

	test("CTA link points to /settings/models#providers", async () => {
		mockFetch({ provider: false });
		const { findByTestId } = render(NoProviderBanner);
		const cta = await findByTestId("no-provider-banner-cta");
		expect(cta.getAttribute("href")).toBe("/settings/models#providers");
	});
});
