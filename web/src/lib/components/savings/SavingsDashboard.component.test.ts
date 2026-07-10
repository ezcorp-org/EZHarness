/**
 * DOM tests for SavingsDashboard — the shared savings-analytics surface
 * behind `/analytics/savings` and `/project/[id]/savings`.
 *
 * Covers: SSR-initial render (no fetch), mount-time hydration when SSR
 * data is absent, range-selector refetch, the honest-negative rendering
 * rule (explicit − sign + danger accent on values AND bars), est.
 * badges, subscription note presence/absence, null hit-rate, empty
 * range, and the error → retry loop (non-ok + thrown fetch).
 */
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { SavingsResponse } from "$lib/savings-format";
import SavingsDashboard from "./SavingsDashboard.svelte";

const MINUS = "−";

function makeResponse(overrides: Partial<SavingsResponse> = {}): SavingsResponse {
	return {
		rangeDays: 30,
		stats: {
			cacheSavedUsd: -0.042,
			cacheReadSavedUsd: 0.018,
			cacheWriteSurchargeUsd: 0.06,
			write1hPremiumUsd: 0.031,
			routingSavedUsd: 0.155,
			tokensCachedRead: 84_200,
			tokensCacheWritten: 121_000,
			cacheHitRate: 0.41,
			turnsTotal: 18,
			turnsRouted: 7,
			turnsFailover: 1,
		},
		perModel: [
			{
				provider: "anthropic",
				model: "claude-opus-4",
				turns: 11,
				cacheSavedUsd: -0.05,
				routingSavedUsd: 0,
				tokensCachedRead: 60_200,
				cacheHitRate: 0.38,
				estimated: true,
			},
			{
				provider: "openai",
				model: "gpt-4o",
				turns: 7,
				cacheSavedUsd: 0.025,
				routingSavedUsd: 0.155,
				tokensCachedRead: 24_000,
				cacheHitRate: null,
				estimated: false,
			},
		],
		subscriptionProviders: ["anthropic"],
		estimated: true,
	};
}

function emptyResponse(rangeDays = 7): SavingsResponse {
	return {
		rangeDays,
		stats: {
			cacheSavedUsd: 0,
			cacheReadSavedUsd: 0,
			cacheWriteSurchargeUsd: 0,
			write1hPremiumUsd: 0,
			routingSavedUsd: 0,
			tokensCachedRead: 0,
			tokensCacheWritten: 0,
			cacheHitRate: null,
			turnsTotal: 0,
			turnsRouted: 0,
			turnsFailover: 0,
		},
		perModel: [],
		subscriptionProviders: [],
		estimated: true,
	};
}

function okFetch(body: SavingsResponse) {
	return vi.fn(async () => ({ ok: true, status: 200, json: async () => body }));
}

const endpoint = (days: number) => `/api/analytics/savings?days=${days}`;

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("SavingsDashboard", () => {
	test("renders SSR-provided data without fetching; negatives are explicit", async () => {
		const fetchMock = okFetch(makeResponse());
		vi.stubGlobal("fetch", fetchMock);
		const { getByTestId, getAllByTestId, getByText, container } = render(SavingsDashboard, {
			props: { heading: "Savings", endpoint, initial: makeResponse() },
		});

		expect(getByText("Savings")).toBeInTheDocument();
		expect(getByTestId("savings-stat-grid")).toBeInTheDocument();
		expect(fetchMock).not.toHaveBeenCalled();

		// Negative net cache savings: explicit − sign + danger accent.
		const cacheValue = getByTestId("savings-stat-cache-value");
		expect(cacheValue).toHaveTextContent(`${MINUS}$0.042`);
		expect(cacheValue).toHaveAttribute("data-negative", "true");
		expect(cacheValue.className).toContain("neg");
		expect(getByTestId("savings-stat-cache")).toHaveTextContent(
			"reads $0.018 · write surcharge $0.060",
		);

		// Positive routing savings: no negative styling.
		const routingValue = getByTestId("savings-stat-routing-value");
		expect(routingValue).toHaveTextContent("$0.155");
		expect(routingValue).toHaveAttribute("data-negative", "false");
		expect(routingValue.className).not.toContain("neg");
		expect(getByTestId("savings-stat-routing")).toHaveTextContent(
			"7/18 turns routed · 1 failover",
		);

		expect(getByTestId("savings-stat-tokens-value")).toHaveTextContent("84.2k");
		expect(getByTestId("savings-stat-tokens")).toHaveTextContent("written 121.0k");
		expect(getByTestId("savings-stat-hitrate-value")).toHaveTextContent("41.0%");
		expect(getByTestId("savings-stat-premium-value")).toHaveTextContent("$0.031");

		// est. badges on the three $ cards.
		const badges = container.querySelectorAll(".stat-grid .est-badge");
		expect(badges).toHaveLength(3);

		// Subscription note names the provider + not-billed caveat.
		expect(getByTestId("savings-subscription-note")).toHaveTextContent(
			"anthropic: subscription key — token savings shown; $ not billed",
		);

		// Per-model bars: loss row fills by |value| at full scale in the
		// danger accent; the profit row scales to half and stays neutral.
		const cacheRows = getAllByTestId("savings-model-row-cache");
		expect(cacheRows).toHaveLength(2);
		const lossFill = cacheRows[0]!.querySelector(".h-bar-fill")!;
		expect(lossFill.className).toContain("neg");
		expect(lossFill.getAttribute("style")).toContain("width: 100%");
		const lossValue = cacheRows[0]!.querySelector(".h-bar-value")!;
		expect(lossValue).toHaveTextContent(`${MINUS}$0.050`);
		expect(lossValue).toHaveAttribute("data-negative", "true");
		const gainFill = cacheRows[1]!.querySelector(".h-bar-fill")!;
		expect(gainFill.className).not.toContain("neg");
		expect(gainFill.getAttribute("style")).toContain("width: 50%");

		// est. badge only on the estimated model row (label column).
		expect(cacheRows[0]!.querySelector(".est-badge")).not.toBeNull();
		expect(cacheRows[1]!.querySelector(".est-badge")).toBeNull();

		// Null per-model hit rate renders an em-dash in the row tooltip.
		expect(cacheRows[1]!.querySelector(".h-bar-label")!.getAttribute("title")).toContain(
			"hit —",
		);

		// Routing panel renders alongside, with the zero-value row at 0 width.
		const routingRows = getAllByTestId("savings-model-row-routing");
		expect(routingRows).toHaveLength(2);
		expect(routingRows[0]!.querySelector(".h-bar-fill")!.getAttribute("style")).toContain(
			"width: 0%",
		);
		expect(routingRows[0]!.querySelector(".h-bar-value")).toHaveTextContent("$0.00");

		expect(getByText(/estimates from provider list prices/)).toBeInTheDocument();
	});

	test("hydrates on mount when SSR data is absent (skeleton while pending)", async () => {
		let resolve!: (v: unknown) => void;
		const pending = new Promise((r) => {
			resolve = r;
		});
		const fetchMock = vi.fn(() => pending);
		vi.stubGlobal("fetch", fetchMock);

		const { container, getByTestId } = render(SavingsDashboard, {
			props: { heading: "Savings", endpoint },
		});

		expect(fetchMock).toHaveBeenCalledWith("/api/analytics/savings?days=30");
		expect(container.querySelector(".skeleton-line")).not.toBeNull();

		resolve({ ok: true, status: 200, json: async () => makeResponse() });
		await waitFor(() => expect(getByTestId("savings-stat-grid")).toBeInTheDocument());
	});

	test("range change refetches, marks the active range, and re-renders", async () => {
		const ninety = makeResponse();
		ninety.rangeDays = 90;
		ninety.stats.cacheSavedUsd = 1.234;
		ninety.subscriptionProviders = [];
		const fetchMock = okFetch(ninety);
		vi.stubGlobal("fetch", fetchMock);

		const { getByTestId, queryByTestId } = render(SavingsDashboard, {
			props: { heading: "Savings", endpoint, initial: makeResponse(), initialRange: 30 },
		});
		expect(getByTestId("savings-range-30")).toHaveAttribute("aria-pressed", "true");

		await fireEvent.click(getByTestId("savings-range-90"));
		expect(fetchMock).toHaveBeenCalledWith("/api/analytics/savings?days=90");
		await waitFor(() =>
			expect(getByTestId("savings-stat-cache-value")).toHaveTextContent("$1.234"),
		);
		expect(getByTestId("savings-stat-cache-value")).toHaveAttribute(
			"data-negative",
			"false",
		);
		expect(getByTestId("savings-range-90")).toHaveAttribute("aria-pressed", "true");
		expect(getByTestId("savings-range-30")).toHaveAttribute("aria-pressed", "false");
		expect(getByTestId("savings-range-90").className).toContain("active");

		// No subscription note once the provider list is empty.
		expect(queryByTestId("savings-subscription-note")).toBeNull();
	});

	test("out-of-order range responses: a stale response never overwrites the newer range", async () => {
		// Click 90d (slow response) then 7d (fast response). The 90d payload
		// arrives LAST — it must be discarded, or the dashboard would show 90d
		// numbers under an active 7d button (dishonest labeling).
		let resolve90!: (v: unknown) => void;
		let resolve7!: (v: unknown) => void;
		const fetchMock = vi
			.fn()
			.mockReturnValueOnce(
				new Promise((r) => {
					resolve90 = r;
				}),
			)
			.mockReturnValueOnce(
				new Promise((r) => {
					resolve7 = r;
				}),
			);
		vi.stubGlobal("fetch", fetchMock);

		const ninety = makeResponse();
		ninety.rangeDays = 90;
		ninety.stats.cacheSavedUsd = 9.999;
		const seven = makeResponse();
		seven.rangeDays = 7;
		seven.stats.cacheSavedUsd = 0.777;

		const { getByTestId } = render(SavingsDashboard, {
			props: { heading: "Savings", endpoint, initial: makeResponse() },
		});
		await fireEvent.click(getByTestId("savings-range-90"));
		await fireEvent.click(getByTestId("savings-range-7"));
		expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/analytics/savings?days=90");
		expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/analytics/savings?days=7");

		resolve7({ ok: true, status: 200, json: async () => seven });
		await waitFor(() =>
			expect(getByTestId("savings-stat-cache-value")).toHaveTextContent("$0.777"),
		);

		resolve90({ ok: true, status: 200, json: async () => ninety });
		await new Promise((r) => setTimeout(r, 0)); // flush the stale handler
		expect(getByTestId("savings-stat-cache-value")).toHaveTextContent("$0.777");
		expect(getByTestId("savings-range-7")).toHaveAttribute("aria-pressed", "true");
	});

	test("a stale failed response neither errors nor blanks the newer range's data", async () => {
		let reject90!: (e: unknown) => void;
		let resolve7!: (v: unknown) => void;
		const fetchMock = vi
			.fn()
			.mockReturnValueOnce(
				new Promise((_, rej) => {
					reject90 = rej;
				}),
			)
			.mockReturnValueOnce(
				new Promise((r) => {
					resolve7 = r;
				}),
			);
		vi.stubGlobal("fetch", fetchMock);

		const seven = makeResponse();
		seven.stats.cacheSavedUsd = 0.777;

		const { getByTestId, queryByTestId } = render(SavingsDashboard, {
			props: { heading: "Savings", endpoint, initial: makeResponse() },
		});
		await fireEvent.click(getByTestId("savings-range-90"));
		await fireEvent.click(getByTestId("savings-range-7"));

		resolve7({ ok: true, status: 200, json: async () => seven });
		await waitFor(() =>
			expect(getByTestId("savings-stat-cache-value")).toHaveTextContent("$0.777"),
		);

		reject90(new Error("slow network loss"));
		await new Promise((r) => setTimeout(r, 0));
		expect(queryByTestId("savings-error")).toBeNull();
		expect(getByTestId("savings-stat-cache-value")).toHaveTextContent("$0.777");
	});

	test("negative zero renders as plain $0.00 — never a signed zero", () => {
		const resp = makeResponse();
		resp.stats.cacheSavedUsd = -0;
		resp.stats.routingSavedUsd = -0;
		const { getByTestId } = render(SavingsDashboard, {
			props: { heading: "Savings", endpoint, initial: resp },
		});
		const cache = getByTestId("savings-stat-cache-value");
		expect(cache).toHaveTextContent("$0.00");
		expect(cache.textContent).not.toContain(MINUS);
		expect(cache).toHaveAttribute("data-negative", "false");
	});

	test("empty range renders the empty state instead of cards", () => {
		const { getByTestId, queryByTestId } = render(SavingsDashboard, {
			props: { heading: "Savings", endpoint, initial: emptyResponse() },
		});
		expect(getByTestId("savings-empty")).toHaveTextContent("No usage in range.");
		expect(queryByTestId("savings-stat-grid")).toBeNull();
	});

	test("non-ok fetch → error state; Retry refetches into data", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
			.mockResolvedValueOnce({ ok: true, status: 200, json: async () => makeResponse() });
		vi.stubGlobal("fetch", fetchMock);

		const { getByTestId, getByText } = render(SavingsDashboard, {
			props: { heading: "Savings", endpoint },
		});

		await waitFor(() => expect(getByTestId("savings-error")).toBeInTheDocument());
		await fireEvent.click(getByText("Retry"));
		await waitFor(() => expect(getByTestId("savings-stat-grid")).toBeInTheDocument());
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	test("thrown fetch (network failure) → error state", async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error("boom"));
		vi.stubGlobal("fetch", fetchMock);

		const { getByTestId } = render(SavingsDashboard, {
			props: { heading: "Savings", endpoint },
		});
		await waitFor(() => expect(getByTestId("savings-error")).toBeInTheDocument());
	});
});
