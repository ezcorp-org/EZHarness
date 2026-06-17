/**
 * DOM tests for SearchBackendSection (settings/search): loads backend
 * status from /api/search/backend on mount, saves the SearXNG URL +
 * BYOK keys (presence-only — a stored key shows "Set" + Remove, never the
 * value), and reloads after a write.
 */
import { describe, test, expect, vi, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import SearchBackendSection from "../settings/SearchBackendSection.svelte";

interface FetchCall {
	url: string;
	method: string;
	body?: any;
}
let fetchCalls: FetchCall[] = [];

function stubFetch(opts: {
	providers?: Array<{ provider: string; hasKey: boolean }>;
	searxngUrl?: string;
	writeMode?: "ok" | "reject";
} = {}) {
	fetchCalls = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			fetchCalls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
			if (url.includes("/api/search/backend") && method === "GET") {
				return Response.json({
					providers:
						opts.providers ??
						["tavily", "brave", "exa", "serpapi", "jina"].map((p) => ({ provider: p, hasKey: false })),
					searxngUrl: opts.searxngUrl ?? "",
				});
			}
			if (opts.writeMode === "reject") return new Response("{}", { status: 500 });
			return Response.json({ success: true });
		}),
	);
}

const writes = () => fetchCalls.filter((c) => c.method === "POST" || c.method === "DELETE");

afterEach(() => vi.unstubAllGlobals());

describe("SearchBackendSection load", () => {
	test("renders the SearXNG URL and BYOK rows from the status endpoint", async () => {
		stubFetch({ searxngUrl: "http://searxng:8080", providers: [
			{ provider: "tavily", hasKey: true },
			{ provider: "brave", hasKey: false },
			{ provider: "exa", hasKey: false },
			{ provider: "serpapi", hasKey: false },
			{ provider: "jina", hasKey: false },
		] });
		const { getByTestId } = render(SearchBackendSection);

		await waitFor(() => {
			expect((getByTestId("search-searxng-url") as HTMLInputElement).value).toBe("http://searxng:8080");
			// tavily has a key → "Set" badge + Remove, no input.
			expect(getByTestId("search-byok-tavily-set")).toBeInTheDocument();
			expect(getByTestId("search-byok-tavily-remove")).toBeInTheDocument();
			// brave has none → an input + Save.
			expect(getByTestId("search-byok-brave-input")).toBeInTheDocument();
		});
		// The key value is never rendered — only the presence badge.
		expect(getByTestId("search-byok-tavily").textContent).not.toContain("enc:");
	});
});

describe("SearchBackendSection writes", () => {
	test("Save URL POSTs { searxngUrl }", async () => {
		stubFetch();
		const { getByTestId } = render(SearchBackendSection);
		await waitFor(() => expect(getByTestId("search-searxng-url")).toBeInTheDocument());

		const input = getByTestId("search-searxng-url") as HTMLInputElement;
		await fireEvent.input(input, { target: { value: "http://my-searxng:9000" } });
		await fireEvent.click(getByTestId("search-searxng-save"));

		await waitFor(() => {
			const post = writes().find((c) => c.method === "POST");
			expect(post!.url).toContain("/api/search/backend");
			expect(post!.body).toEqual({ searxngUrl: "http://my-searxng:9000" });
		});
	});

	test("Save a BYOK key POSTs { provider, apiKey } then reloads", async () => {
		stubFetch();
		const { getByTestId } = render(SearchBackendSection);
		await waitFor(() => expect(getByTestId("search-byok-brave-input")).toBeInTheDocument());

		const input = getByTestId("search-byok-brave-input") as HTMLInputElement;
		await fireEvent.input(input, { target: { value: "brave-key" } });
		await fireEvent.click(getByTestId("search-byok-brave-save"));

		await waitFor(() => {
			const post = writes().find((c) => c.method === "POST");
			expect(post!.body).toEqual({ provider: "brave", apiKey: "brave-key" });
		});
		// A reload GET fires after the successful save.
		await waitFor(() =>
			expect(fetchCalls.filter((c) => c.method === "GET").length).toBeGreaterThanOrEqual(2),
		);
	});

	test("the Save button stays disabled for an empty key input", async () => {
		stubFetch();
		const { getByTestId } = render(SearchBackendSection);
		await waitFor(() => expect(getByTestId("search-byok-exa-save")).toBeInTheDocument());
		expect(getByTestId("search-byok-exa-save")).toBeDisabled();
	});

	test("Remove DELETEs the provider key then reloads", async () => {
		stubFetch({ providers: [
			{ provider: "tavily", hasKey: true },
			{ provider: "brave", hasKey: false },
			{ provider: "exa", hasKey: false },
			{ provider: "serpapi", hasKey: false },
			{ provider: "jina", hasKey: false },
		] });
		const { getByTestId } = render(SearchBackendSection);
		await waitFor(() => expect(getByTestId("search-byok-tavily-remove")).toBeInTheDocument());

		await fireEvent.click(getByTestId("search-byok-tavily-remove"));

		await waitFor(() => {
			const del = writes().find((c) => c.method === "DELETE");
			expect(del!.body).toEqual({ provider: "tavily" });
		});
	});

	test("a failed URL save flashes the error indicator", async () => {
		stubFetch({ writeMode: "reject" });
		const { getByTestId } = render(SearchBackendSection);
		await waitFor(() => expect(getByTestId("search-searxng-save")).toBeInTheDocument());

		await fireEvent.click(getByTestId("search-searxng-save"));

		await waitFor(() => expect(getByTestId("save-indicator-error")).toBeInTheDocument());
	});
});
