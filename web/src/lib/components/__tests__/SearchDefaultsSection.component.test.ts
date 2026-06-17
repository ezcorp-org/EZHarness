/**
 * DOM tests for SearchDefaultsSection (settings/search): the defaults-
 * for-extensions policy controls auto-save the `global:search:*` keys via
 * PUT /api/settings/<key>, with optimistic rollback on failure.
 */
import { describe, test, expect, vi, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import SearchDefaultsSection from "../settings/SearchDefaultsSection.svelte";
import type { SearchDefaultsForm } from "$lib/settings-search-config.js";

interface FetchCall {
	url: string;
	method: string;
	body?: any;
}
let fetchCalls: FetchCall[] = [];

function stubFetch(mode: "ok" | "reject" = "ok") {
	fetchCalls = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			fetchCalls.push({
				url: String(input),
				method: init?.method ?? "GET",
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
			});
			if (mode === "reject") return new Response("{}", { status: 500 });
			return Response.json({ ok: true });
		}),
	);
}

function form(over: Partial<SearchDefaultsForm> = {}): SearchDefaultsForm {
	return { allowedByDefault: true, quota: 100, maxResults: 5, providers: "all", ...over };
}

const puts = () => fetchCalls.filter((c) => c.method === "PUT");

afterEach(() => vi.unstubAllGlobals());

describe("SearchDefaultsSection auto-save", () => {
	test("toggling allowedByDefault PUTs global:search:allowedByDefault", async () => {
		stubFetch();
		const { getByTestId } = render(SearchDefaultsSection, { props: { defaults: form() } });

		await fireEvent.click(getByTestId("search-default-allowed"));

		await waitFor(() => {
			expect(puts()).toHaveLength(1);
			expect(puts()[0]!.url).toContain("/api/settings/global:search:allowedByDefault");
			expect(puts()[0]!.body).toEqual({ value: false });
		});
	});

	test("changing quota PUTs the sanitized value", async () => {
		stubFetch();
		const { getByTestId } = render(SearchDefaultsSection, { props: { defaults: form() } });

		const input = getByTestId("search-default-quota") as HTMLInputElement;
		await fireEvent.input(input, { target: { value: "250" } });
		await fireEvent.change(input);

		await waitFor(() => {
			expect(puts()[0]!.url).toContain("/api/settings/global:search:defaultQuota");
			expect(puts()[0]!.body).toEqual({ value: 250 });
		});
	});

	test("an invalid quota is clamped to the hard default before saving", async () => {
		stubFetch();
		const { getByTestId } = render(SearchDefaultsSection, { props: { defaults: form({ quota: 7 }) } });

		const input = getByTestId("search-default-quota") as HTMLInputElement;
		await fireEvent.input(input, { target: { value: "0" } });
		await fireEvent.change(input);

		await waitFor(() => expect(puts()[0]!.body).toEqual({ value: 100 }));
	});

	test("changing maxResults PUTs the value", async () => {
		stubFetch();
		const { getByTestId } = render(SearchDefaultsSection, { props: { defaults: form() } });

		const input = getByTestId("search-default-maxresults") as HTMLInputElement;
		await fireEvent.input(input, { target: { value: "9" } });
		await fireEvent.change(input);

		await waitFor(() => {
			expect(puts()[0]!.url).toContain("/api/settings/global:search:defaultMaxResults");
			expect(puts()[0]!.body).toEqual({ value: 9 });
		});
	});

	test("providers text 'searxng, brave' PUTs the parsed array", async () => {
		stubFetch();
		const { getByTestId } = render(SearchDefaultsSection, { props: { defaults: form() } });

		const input = getByTestId("search-default-providers") as HTMLInputElement;
		await fireEvent.input(input, { target: { value: "searxng, brave" } });
		await fireEvent.change(input);

		await waitFor(() => {
			expect(puts()[0]!.url).toContain("/api/settings/global:search:defaultProviders");
			expect(puts()[0]!.body).toEqual({ value: ["searxng", "brave"] });
		});
	});

	test("providers text 'all' PUTs the literal 'all'", async () => {
		stubFetch();
		const { getByTestId } = render(SearchDefaultsSection, { props: { defaults: form({ providers: "searxng" }) } });

		const input = getByTestId("search-default-providers") as HTMLInputElement;
		await fireEvent.input(input, { target: { value: "all" } });
		await fireEvent.change(input);

		await waitFor(() => expect(puts()[0]!.body).toEqual({ value: "all" }));
	});

	test("a failed save rolls back the optimistic toggle and flashes error", async () => {
		stubFetch("reject");
		const { getByTestId } = render(SearchDefaultsSection, { props: { defaults: form() } });

		const toggle = getByTestId("search-default-allowed");
		expect(toggle.getAttribute("aria-checked")).toBe("true");
		await fireEvent.click(toggle);

		await waitFor(() => {
			expect(getByTestId("save-indicator-error")).toBeInTheDocument();
			// Rolled back to the pre-click value.
			expect(toggle.getAttribute("aria-checked")).toBe("true");
		});
	});
});
