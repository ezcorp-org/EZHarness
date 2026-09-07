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
import { store } from "$lib/stores.svelte.js";

function mockFetch(response: { provider: boolean; role?: "admin" | "member" } | "error" | "pending"): {
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
		vi.fn(async (input: RequestInfo | URL) => {
			if (String(input).includes("/api/auth/me")) {
				return new Response(JSON.stringify({ user: { role: response.role ?? "admin" } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(JSON.stringify({ steps: { provider: response.provider } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
	return {};
}

describe("NoProviderBanner", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
		store.quickstartSteps = null;
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
		const { queryByTestId } = render(NoProviderBanner);
		await waitFor(() => expect(queryByTestId("no-provider-banner")).toBeNull());
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

	test("member gets guidance without a settings CTA", async () => {
		mockFetch({ provider: false, role: "member" });
		const { findByTestId, queryByTestId } = render(NoProviderBanner);
		const banner = await findByTestId("no-provider-banner");
		expect(banner).toHaveTextContent("An administrator needs to connect a provider");
		expect(queryByTestId("no-provider-banner-cta")).toBeNull();
	});
});
