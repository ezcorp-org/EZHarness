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
 *   6. Local-endpoint discovery (Fetch Models): success/select/Add with
 *      baseUrl, error, empty-endpoint, network-failure paths
 *   7. Local model Test button: indicator row + latency, failure catch
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

type LocalModels = { models: { id: string; name?: string }[]; endpointType: string | null; error?: string };

function stubFetch(opts: { localModels?: LocalModels | "reject"; localTest?: Record<string, unknown> | "reject" } = {}) {
	fetchCalls = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			fetchCalls.push({
				url,
				method: init?.method ?? "GET",
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
			});
			if (url.includes("/api/providers/local/models")) {
				if (opts.localModels === "reject") throw new Error("network down");
				return Response.json(opts.localModels ?? { models: [], endpointType: null });
			}
			if (url.includes("/api/providers/local/test")) {
				if (opts.localTest === "reject") throw new Error("network down");
				return Response.json(
					opts.localTest ?? {
						reachable: true,
						modelAvailable: true,
						inferenceOk: true,
						endpointType: "openai-compatible",
						latencyMs: 150,
					},
				);
			}
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

describe("CustomModelsSection local-endpoint discovery", () => {
	async function setupOllamaProvider(opts: Parameters<typeof stubFetch>[0] = {}) {
		stubFetch(opts);
		const utils = render(CustomModelsSection, { props: { customModels: [] } });
		// Switching to the ollama provider auto-fills the default base URL
		// and reveals the discovery UI.
		await fireEvent.change(utils.getByLabelText("Model provider"), { target: { value: "ollama" } });
		expect(
			(utils.getByLabelText(/Base URL/) as HTMLInputElement).value,
		).toBe("http://localhost:11434");
		return utils;
	}

	test("Fetch Models lists discovered models; Add persists with the baseUrl", async () => {
		const { getByText, getByLabelText, getByTestId } = await setupOllamaProvider({
			localModels: { models: [{ id: "llama3", name: "Llama 3" }, { id: "qwen3" }], endpointType: "ollama" },
		});

		await fireEvent.click(getByText("Fetch Models"));
		await waitFor(() => expect(getByLabelText("Discovered model")).toBeInTheDocument());

		// First discovered model preselected; pick the second instead.
		await fireEvent.change(getByLabelText("Discovered model"), { target: { value: "qwen3" } });
		await fireEvent.click(getByText("Add"));

		// Ollama-provider entries are hidden from the registry list (locked
		// decision 6) — the managed-elsewhere note appears instead.
		await waitFor(() =>
			expect(getByTestId("ollama-managed-note")).toHaveTextContent(
				"1 Ollama model is managed in the Ollama provider card above.",
			),
		);
		const put = fetchCalls.find((c) => c.method === "PUT");
		expect((put?.body as { value: CustomModelEntry[] }).value).toEqual([
			{ modelId: "qwen3", provider: "ollama", tier: "balanced", baseUrl: "http://localhost:11434" },
		]);
	});

	test("discovery error from the endpoint is rendered", async () => {
		const { getByText } = await setupOllamaProvider({
			localModels: { models: [], endpointType: null, error: "connection refused" },
		});

		await fireEvent.click(getByText("Fetch Models"));
		await waitFor(() => expect(getByText("connection refused")).toBeInTheDocument());
	});

	test("empty endpoint shows the no-models message", async () => {
		const { getByText } = await setupOllamaProvider({
			localModels: { models: [], endpointType: "ollama" },
		});

		await fireEvent.click(getByText("Fetch Models"));
		await waitFor(() => expect(getByText("No models found on this endpoint")).toBeInTheDocument());
	});

	test("network failure shows the connect-failed message", async () => {
		const { getByText } = await setupOllamaProvider({ localModels: "reject" });

		await fireEvent.click(getByText("Fetch Models"));
		await waitFor(() => expect(getByText("Failed to connect to endpoint")).toBeInTheDocument());
	});

	test("editing the base URL clears prior discovery state", async () => {
		const { getByText, getByLabelText, queryByLabelText } = await setupOllamaProvider({
			localModels: { models: [{ id: "llama3" }], endpointType: "ollama" },
		});

		await fireEvent.click(getByText("Fetch Models"));
		await waitFor(() => expect(getByLabelText("Discovered model")).toBeInTheDocument());

		await fireEvent.change(getByLabelText(/Base URL/), { target: { value: "http://other:11434" } });
		expect(queryByLabelText("Discovered model")).not.toBeInTheDocument();
	});
});

describe("CustomModelsSection local model test", () => {
	const localModel: CustomModelEntry[] = [
		{ modelId: "phi4", provider: "openai", tier: "fast", baseUrl: "http://localhost:8080" },
	];

	test("Test renders check indicators and latency on success", async () => {
		stubFetch();
		const { getByText, getByTitle } = render(CustomModelsSection, {
			props: { customModels: localModel },
		});

		await fireEvent.click(getByText("Test"));

		await waitFor(() => expect(getByTitle("Reachable")).toHaveTextContent("✓"));
		expect(getByTitle("Model available")).toHaveTextContent("✓");
		expect(getByTitle("Inference OK")).toHaveTextContent("✓");
		expect(getByText("150ms")).toBeInTheDocument();

		const post = fetchCalls.find((c) => c.url.includes("/api/providers/local/test"));
		expect(post?.body).toEqual({ baseUrl: "http://localhost:8080", modelId: "phi4" });
	});

	test("network failure renders the unreachable cross", async () => {
		stubFetch({ localTest: "reject" });
		const { getByText, getByTitle } = render(CustomModelsSection, {
			props: { customModels: localModel },
		});

		await fireEvent.click(getByText("Test"));

		await waitFor(() => expect(getByTitle("Reachable")).toHaveTextContent("✗"));
		expect(getByTitle("Reachable").className).toContain("text-red-400");
	});
});
