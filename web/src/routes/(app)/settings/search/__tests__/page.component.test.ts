/**
 * DOM tests for the Settings → Search page wrapper
 * (`settings/search/+page.svelte`).
 *
 * The happy path (admin sees prefilled defaults + edits round-trip) is
 * e2e-covered in `settings-search-page.spec.ts`. This unit-level test
 * closes the one branch e2e can't easily force: the `$effect` load
 * REJECT path (`+page.svelte:14-20`) — a member-gated `fetchSettings()`
 * 403 must be swallowed and the page must still mount over the
 * `readSearchDefaults({})` hard-default fallback (NOT stay stuck on the
 * skeleton).
 *
 * The two child sections fetch on mount, so they're substituted: the
 * backend section with an empty renderer, the defaults section with a
 * recording stub that exposes the resolved `defaults` as data-attrs.
 *
 * Convention call: NO `+page.svelte` wrapper page is pinned in
 * `coverage-thresholds.json` anywhere in the repo (peer settings pages
 * included), so this test is added WITHOUT pinning the page — matching
 * the established convention.
 */
import "@testing-library/jest-dom/vitest";
import { render, waitFor } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach } from "vitest";

const { fetchSettingsMock } = vi.hoisted(() => ({
	fetchSettingsMock: vi.fn(),
}));

vi.mock("$lib/api.js", () => ({ fetchSettings: fetchSettingsMock }));
// scrollToLocationHash touches window.location.hash + DOM scroll — no-op it.
vi.mock("$lib/scroll-to-hash.js", () => ({ scrollToLocationHash: vi.fn() }));

// SearchBackendSection fetches /api/search/backend on mount — empty stub.
vi.mock("$lib/components/settings/SearchBackendSection.svelte", async () => {
	const stub = await import("../../../../../__tests__/stubs/empty-component.js");
	return { default: stub.default };
});
// SearchDefaultsSection auto-saves on change — recording stub so we can
// read back the `defaults` the page resolved + passed down.
vi.mock("$lib/components/settings/SearchDefaultsSection.svelte", async () => {
	const stub = await import("./SearchDefaultsStub.svelte");
	return { default: stub.default };
});

import SearchPage from "../+page.svelte";

beforeEach(() => {
	fetchSettingsMock.mockReset();
});

describe("settings/search page load", () => {
	test("happy path: resolves defaults from fetched settings and mounts the sections", async () => {
		fetchSettingsMock.mockResolvedValue({
			"global:search:allowedByDefault": false,
			"global:search:defaultQuota": 250,
			"global:search:defaultMaxResults": 9,
			"global:search:defaultProviders": ["searxng", "brave"],
		});
		const { getByTestId } = render(SearchPage);

		await waitFor(() => expect(getByTestId("search-defaults-stub")).toBeInTheDocument());
		const stub = getByTestId("search-defaults-stub");
		expect(stub.getAttribute("data-allowed")).toBe("false");
		expect(stub.getAttribute("data-quota")).toBe("250");
		expect(stub.getAttribute("data-maxresults")).toBe("9");
		expect(stub.getAttribute("data-providers")).toBe("searxng, brave");
	});

	test("load REJECT (member-403): swallows the error and mounts over the hard-default fallback", async () => {
		fetchSettingsMock.mockRejectedValue(new Error("403 Forbidden"));
		const { getByTestId } = render(SearchPage);

		// The page must leave the skeleton and mount the sections — the
		// catch branch sets pageLoading = false even on failure.
		await waitFor(() => expect(getByTestId("search-defaults-stub")).toBeInTheDocument());

		// Defaults are the `readSearchDefaults({})` hard defaults
		// (quota 100 / maxResults 5 / providers "all" / allowed true).
		const stub = getByTestId("search-defaults-stub");
		expect(stub.getAttribute("data-allowed")).toBe("true");
		expect(stub.getAttribute("data-quota")).toBe("100");
		expect(stub.getAttribute("data-maxresults")).toBe("5");
		expect(stub.getAttribute("data-providers")).toBe("all");
	});
});
