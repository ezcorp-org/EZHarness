/**
 * DOM tests for UpdateBanner.svelte. The banner fetches /api/version on
 * mount, decides whether to render based on VersionInfo + sessionStorage
 * dismissal keyed by `latest`, and hides itself when the dismiss × is
 * clicked. We stub fetch + wait for the microtask queue to flush.
 *
 * Pure logic (shouldShowBanner, dismissValue) is covered by the sibling
 * logic file; this exercises the component-level state transitions.
 */

import { render, fireEvent, cleanup, waitFor } from "@testing-library/svelte";
import { describe, test, expect, afterEach, beforeEach, vi } from "vitest";
import UpdateBanner from "./UpdateBanner.svelte";
import { DISMISS_STORAGE_KEY } from "./UpdateBanner.helpers";

function makeFetchResponse(body: unknown, ok = true): Response {
	return {
		ok,
		json: async () => body,
	} as unknown as Response;
}

beforeEach(() => {
	sessionStorage.clear();
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("UpdateBanner", () => {
	test("renders nothing when API says no update available", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				makeFetchResponse({
					current: "1.0.0",
					latest: "1.0.0",
					updateAvailable: false,
					checkedAt: null,
					source: "github-releases",
				}),
			),
		);
		const { queryByRole } = render(UpdateBanner);
		// Wait a microtask so onMount's async fetch resolves.
		await new Promise((r) => setTimeout(r, 0));
		expect(queryByRole("status")).toBeNull();
	});

	test("renders the banner with latest + current versions when update available", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				makeFetchResponse({
					current: "1.0.0",
					latest: "1.1.0",
					updateAvailable: true,
					checkedAt: null,
					source: "github-releases",
					releaseUrl: "https://example.com/r/1.1.0",
				}),
			),
		);
		const { getByRole, getByText } = render(UpdateBanner);
		const banner = await waitFor(() => getByRole("status"));
		expect(banner).toHaveTextContent("1.1.0");
		expect(banner).toHaveTextContent("(current: 1.0.0)");
		// releaseUrl becomes a target=_blank anchor.
		const link = getByText("Release notes") as HTMLAnchorElement;
		expect(link).toHaveAttribute("href", "https://example.com/r/1.1.0");
		expect(link).toHaveAttribute("target", "_blank");
	});

	test("omits 'Release notes' anchor when releaseUrl is missing", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				makeFetchResponse({
					current: "1.0.0",
					latest: "1.1.0",
					updateAvailable: true,
					checkedAt: null,
					source: "github-releases",
				}),
			),
		);
		const { queryByText, findByRole } = render(UpdateBanner);
		await findByRole("status");
		expect(queryByText("Release notes")).toBeNull();
	});

	test("clicking × hides the banner and persists latest version to sessionStorage", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				makeFetchResponse({
					current: "1.0.0",
					latest: "2.0.0",
					updateAvailable: true,
					checkedAt: null,
					source: "github-releases",
				}),
			),
		);
		const { getByLabelText, queryByRole, findByRole } = render(UpdateBanner);
		await findByRole("status");
		await fireEvent.click(getByLabelText("Dismiss"));
		expect(queryByRole("status")).toBeNull();
		expect(sessionStorage.getItem(DISMISS_STORAGE_KEY)).toBe("2.0.0");
	});

	test("stays hidden when sessionStorage already has dismissal for the same `latest`", async () => {
		sessionStorage.setItem(DISMISS_STORAGE_KEY, "2.0.0");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				makeFetchResponse({
					current: "1.0.0",
					latest: "2.0.0",
					updateAvailable: true,
					checkedAt: null,
					source: "github-releases",
				}),
			),
		);
		const { queryByRole } = render(UpdateBanner);
		await new Promise((r) => setTimeout(r, 10));
		expect(queryByRole("status")).toBeNull();
	});

	test("renders again when `latest` differs from the stored dismissal", async () => {
		sessionStorage.setItem(DISMISS_STORAGE_KEY, "1.5.0");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				makeFetchResponse({
					current: "1.0.0",
					latest: "2.0.0",
					updateAvailable: true,
					checkedAt: null,
					source: "github-releases",
				}),
			),
		);
		const { findByRole } = render(UpdateBanner);
		expect(await findByRole("status")).toBeInTheDocument();
	});
});
