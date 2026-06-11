/**
 * DOM tests for CustomModelsSection — the Custom Models registry on the
 * merged /settings/models page.
 *
 * Coverage:
 *   1. Ollama-provider entries are hidden from the registry list
 *      (locked decision 6: they render in the Ollama provider card)
 *      and the "managed in the Ollama provider card" note appears
 *   2. Non-ollama entries render with provider/tier metadata
 *   3. Adding a model PUTs provider:customModels and appends one row
 *   4. Duplicate model id is rejected client-side (no second row, no PUT)
 *   5. Remove deletes the row and persists
 */
import { describe, test, expect, vi, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import CustomModelsSection from "../settings/CustomModelsSection.svelte";
import type { CustomModelEntry } from "$lib/settings-models";

interface FetchCall {
	url: string;
	method: string;
	body?: unknown;
}
let fetchCalls: FetchCall[] = [];

function stubFetch() {
	fetchCalls = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			fetchCalls.push({
				url: String(input),
				method: init?.method ?? "GET",
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
			});
			return Response.json({ ok: true });
		}),
	);
}

afterEach(() => vi.unstubAllGlobals());

const mixedModels: CustomModelEntry[] = [
	{ modelId: "llama3", provider: "ollama", tier: "balanced", baseUrl: "http://localhost:11434" },
	{ modelId: "gpt-4-turbo", provider: "openai", tier: "powerful" },
];

describe("CustomModelsSection dedupe", () => {
	test("hides ollama entries and shows the managed-elsewhere note", () => {
		stubFetch();
		const { queryByText, getByText, getByTestId } = render(CustomModelsSection, {
			props: { customModels: mixedModels },
		});

		expect(queryByText("llama3")).not.toBeInTheDocument();
		expect(getByText("gpt-4-turbo")).toBeInTheDocument();
		expect(getByTestId("ollama-managed-note")).toHaveTextContent(
			"1 Ollama model is managed in the Ollama provider card above.",
		);
	});

	test("no note when there are no ollama entries", () => {
		stubFetch();
		const { queryByTestId } = render(CustomModelsSection, {
			props: { customModels: [{ modelId: "gpt-4-turbo", provider: "openai", tier: "powerful" }] },
		});
		expect(queryByTestId("ollama-managed-note")).not.toBeInTheDocument();
	});
});

describe("CustomModelsSection add/remove", () => {
	test("adding a model persists and renders exactly one row", async () => {
		stubFetch();
		const { getByLabelText, getByText, getAllByText } = render(CustomModelsSection, {
			props: { customModels: [] },
		});

		const idInput = getByLabelText("Model ID");
		await fireEvent.input(idInput, { target: { value: "my-model" } });
		await fireEvent.click(getByText("Add"));

		await waitFor(() => {
			expect(getAllByText("my-model")).toHaveLength(1);
		});
		const put = fetchCalls.find((c) => c.method === "PUT");
		expect(put?.url).toContain("/api/settings/");
		expect((put?.body as { value: CustomModelEntry[] }).value).toEqual([
			{ modelId: "my-model", provider: "anthropic", tier: "balanced" },
		]);
	});

	test("duplicate model id is a no-op", async () => {
		stubFetch();
		const { getByLabelText, getByText, getAllByText } = render(CustomModelsSection, {
			props: { customModels: [{ modelId: "dup-model", provider: "openai", tier: "balanced" }] },
		});

		await fireEvent.input(getByLabelText("Model ID"), { target: { value: "dup-model" } });
		await fireEvent.click(getByText("Add"));

		expect(getAllByText("dup-model")).toHaveLength(1);
		expect(fetchCalls.filter((c) => c.method === "PUT")).toHaveLength(0);
	});

	test("remove deletes the row and persists the shrunken list", async () => {
		stubFetch();
		const { getByText, queryByText } = render(CustomModelsSection, {
			props: { customModels: [{ modelId: "bye-model", provider: "openai", tier: "fast" }] },
		});

		await fireEvent.click(getByText("Remove"));

		await waitFor(() => {
			expect(queryByText("bye-model")).not.toBeInTheDocument();
		});
		const put = fetchCalls.find((c) => c.method === "PUT");
		expect((put?.body as { value: CustomModelEntry[] }).value).toEqual([]);
	});
});
