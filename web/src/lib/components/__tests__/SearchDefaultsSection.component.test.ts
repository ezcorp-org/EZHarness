/**
 * DOM tests for SearchDefaultsSection (settings/search): the defaults-for-
 * extensions policy controls are an EXPLICIT-save form (consistent with the
 * Search Backend section). Editing buffers locally; clicking Save commits all
 * four `global:search:*` keys via PUT /api/settings/<key> in one go. A failed
 * save keeps the admin's edits (no optimistic write to roll back).
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
const putFor = (keySuffix: string) => puts().find((c) => c.url.includes(`/api/settings/global:search:${keySuffix}`));

afterEach(() => vi.unstubAllGlobals());

describe("SearchDefaultsSection explicit save", () => {
	test("Save commits all four global:search:* keys in one click", async () => {
		stubFetch();
		const { getByTestId } = render(SearchDefaultsSection, { props: { defaults: form() } });

		await fireEvent.click(getByTestId("search-defaults-save"));

		await waitFor(() => {
			expect(puts()).toHaveLength(4);
			expect(putFor("allowedByDefault")!.body).toEqual({ value: true });
			expect(putFor("defaultQuota")!.body).toEqual({ value: 100 });
			expect(putFor("defaultMaxResults")!.body).toEqual({ value: 5 });
			// providers "all" PUTs the literal "all" (the === "all" branch).
			expect(putFor("defaultProviders")!.body).toEqual({ value: "all" });
			expect(getByTestId("save-indicator-saved")).toBeInTheDocument();
		});
	});

	test("edits are buffered until Save, then committed + normalized", async () => {
		stubFetch();
		const { getByTestId } = render(SearchDefaultsSection, { props: { defaults: form() } });

		// Toggle off, edit each field — NONE of this should save yet.
		const toggle = getByTestId("search-default-allowed");
		await fireEvent.click(toggle);
		expect(toggle.getAttribute("aria-checked")).toBe("false");

		const quota = getByTestId("search-default-quota") as HTMLInputElement;
		await fireEvent.input(quota, { target: { value: "250" } });
		const maxResults = getByTestId("search-default-maxresults") as HTMLInputElement;
		await fireEvent.input(maxResults, { target: { value: "9" } });
		const providers = getByTestId("search-default-providers") as HTMLInputElement;
		await fireEvent.input(providers, { target: { value: "searxng,brave" } });

		// Nothing persisted by editing alone.
		expect(puts()).toHaveLength(0);

		await fireEvent.click(getByTestId("search-defaults-save"));

		await waitFor(() => {
			expect(puts()).toHaveLength(4);
			expect(putFor("allowedByDefault")!.body).toEqual({ value: false });
			expect(putFor("defaultQuota")!.body).toEqual({ value: 250 });
			expect(putFor("defaultMaxResults")!.body).toEqual({ value: 9 });
			// providers list PUTs the parsed array (the join-normalize branch).
			expect(putFor("defaultProviders")!.body).toEqual({ value: ["searxng", "brave"] });
		});
		// After a successful save the providers field normalizes to the canonical form.
		await waitFor(() => expect(providers.value).toBe("searxng, brave"));
	});

	test("an invalid quota is clamped to the hard default before saving", async () => {
		stubFetch();
		const { getByTestId } = render(SearchDefaultsSection, { props: { defaults: form({ quota: 7 }) } });

		const quota = getByTestId("search-default-quota") as HTMLInputElement;
		await fireEvent.input(quota, { target: { value: "0" } });
		await fireEvent.click(getByTestId("search-defaults-save"));

		await waitFor(() => expect(putFor("defaultQuota")!.body).toEqual({ value: 100 }));
	});

	test("a failed save flashes error and keeps the admin's edits", async () => {
		stubFetch("reject");
		const { getByTestId } = render(SearchDefaultsSection, { props: { defaults: form() } });

		const quota = getByTestId("search-default-quota") as HTMLInputElement;
		await fireEvent.input(quota, { target: { value: "250" } });
		await fireEvent.click(getByTestId("search-defaults-save"));

		await waitFor(() => {
			expect(getByTestId("save-indicator-error")).toBeInTheDocument();
			// Edits are NOT rolled back — the form is the pending edit to retry.
			expect(quota.value).toBe("250");
		});
	});
});
