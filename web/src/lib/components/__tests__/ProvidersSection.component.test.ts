/**
 * DOM tests for ProvidersSection (models settings):
 *   1. saveOllamaUrl — PUT /api/settings/provider:ollamaUrl
 *   2. fetchOllamaModels — success list, error, "No models found",
 *      Docker hint on "not reachable", network-failure catch
 *   3. addOllamaModel — entry appended + PUT customModels; dedupe
 *      guard renders "Added" instead of an Add button
 *   4. removeOllamaModel — entry filtered + PUT customModels
 *   5. handleTestOllamaModel — check indicators + latency, catch path
 *   6. Header summary chips — provider status dots + Ollama chip
 */
import { describe, test, expect, vi, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import ProvidersSection from "../settings/ProvidersSection.svelte";
import type { CustomModelEntry } from "$lib/settings-models.js";

interface FetchCall {
	url: string;
	method: string;
	body?: any;
}
let fetchCalls: FetchCall[] = [];

type LocalModels = { models: { id: string; name?: string }[]; endpointType: string | null; error?: string };
type LocalTest = Record<string, unknown>;

function stubFetch(opts: {
	providers?: unknown[];
	localModels?: LocalModels | "reject";
	localTest?: LocalTest | "reject";
} = {}) {
	fetchCalls = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			fetchCalls.push({
				url,
				method,
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
						endpointType: "ollama",
						latencyMs: 150,
					},
				);
			}
			if (url.includes("/api/providers")) return Response.json(opts.providers ?? []);
			if (url.includes("/api/settings") && method === "GET") return Response.json({});
			return Response.json({ ok: true });
		}),
	);
}

function renderSection(customModels: CustomModelEntry[] = [], ollamaUrl = "http://localhost:11434") {
	return render(ProvidersSection, { props: { customModels, ollamaUrl } });
}

const puts = () => fetchCalls.filter((c) => c.method === "PUT");

afterEach(() => vi.unstubAllGlobals());

describe("ProvidersSection Ollama URL", () => {
	test("Save URL PUTs provider:ollamaUrl with the current value", async () => {
		stubFetch();
		const { getByText } = renderSection([], "http://my-host:11434");

		await fireEvent.click(getByText("Save URL"));

		await waitFor(() => {
			expect(puts()).toHaveLength(1);
			expect(puts()[0]!.url).toContain("/api/settings/provider:ollamaUrl");
			expect(puts()[0]!.body).toEqual({ value: "http://my-host:11434" });
		});
	});

	test("Fetch Models is disabled when the URL is blank", async () => {
		stubFetch();
		const { getByText } = renderSection([], "   ");
		expect(getByText("Fetch Models").closest("button")).toBeDisabled();
	});
});

describe("ProvidersSection Ollama URL binding", () => {
	test("editing the Base URL input updates through its two-way binding", async () => {
		stubFetch();
		const { getByLabelText } = renderSection([], "http://localhost:11434");
		await fireEvent.input(getByLabelText("Base URL"), {
			target: { value: "http://ollama-host:11434" },
		});
		expect((getByLabelText("Base URL") as HTMLInputElement).value).toBe("http://ollama-host:11434");
	});
});

describe("ProvidersSection fetch models", () => {
	test("success lists discovered models with Add buttons", async () => {
		stubFetch({
			localModels: { models: [{ id: "llama3", name: "Llama 3" }, { id: "qwen3" }], endpointType: "ollama" },
		});
		const { getByText } = renderSection();

		await fireEvent.click(getByText("Fetch Models"));

		await waitFor(() => expect(getByText("Available models:")).toBeInTheDocument());
		expect(getByText("Llama 3")).toBeInTheDocument(); // name preferred over id
		expect(getByText("qwen3")).toBeInTheDocument(); // falls back to id
	});

	test("API error renders the error text without the Docker hint", async () => {
		stubFetch({ localModels: { models: [], endpointType: null, error: "boom" } });
		const { getByText, queryByText } = renderSection();

		await fireEvent.click(getByText("Fetch Models"));

		await waitFor(() => expect(getByText("boom")).toBeInTheDocument());
		expect(queryByText(/OLLAMA_HOST/)).not.toBeInTheDocument();
	});

	test("'not reachable' error adds the Docker host hint", async () => {
		stubFetch({
			localModels: { models: [], endpointType: null, error: "Ollama not reachable at http://localhost:11434" },
		});
		const { getByText } = renderSection();

		await fireEvent.click(getByText("Fetch Models"));

		await waitFor(() => expect(getByText(/not reachable/)).toBeInTheDocument());
		expect(getByText(/If running in Docker/)).toBeInTheDocument();
		expect(getByText("OLLAMA_HOST=0.0.0.0")).toBeInTheDocument();
	});

	test("empty model list shows the pull-a-model message", async () => {
		stubFetch({ localModels: { models: [], endpointType: "ollama" } });
		const { getByText } = renderSection();

		await fireEvent.click(getByText("Fetch Models"));

		await waitFor(() =>
			expect(getByText(/No models found — pull a model with/)).toBeInTheDocument(),
		);
	});

	test("network failure shows the connect-failed message", async () => {
		stubFetch({ localModels: "reject" });
		const { getByText } = renderSection();

		await fireEvent.click(getByText("Fetch Models"));

		await waitFor(() => expect(getByText("Failed to connect to Ollama")).toBeInTheDocument());
	});
});

describe("ProvidersSection add / remove models", () => {
	test("Add appends an ollama entry and PUTs provider:customModels", async () => {
		stubFetch({ localModels: { models: [{ id: "llama3" }], endpointType: "ollama" } });
		const { getByText } = renderSection([], "http://localhost:11434");

		await fireEvent.click(getByText("Fetch Models"));
		await waitFor(() => expect(getByText("Add")).toBeInTheDocument());

		await fireEvent.click(getByText("Add"));

		await waitFor(() => {
			expect(puts()).toHaveLength(1);
			expect(puts()[0]!.url).toContain("/api/settings/provider:customModels");
			expect(puts()[0]!.body).toEqual({
				value: [{ modelId: "llama3", provider: "ollama", tier: "balanced", baseUrl: "http://localhost:11434" }],
			});
		});
		// Once added, the discovered row flips to the "Added" label.
		await waitFor(() => expect(getByText("Added")).toBeInTheDocument());
	});

	test("dedupe guard: an id already registered (any provider) renders Added, no Add button", async () => {
		stubFetch({ localModels: { models: [{ id: "llama3" }], endpointType: "ollama" } });
		const { getByText, queryByText } = renderSection([
			{ modelId: "llama3", provider: "openai", tier: "balanced" },
		]);

		await fireEvent.click(getByText("Fetch Models"));

		await waitFor(() => expect(getByText("Added")).toBeInTheDocument());
		expect(queryByText("Add")).not.toBeInTheDocument();
		expect(puts()).toHaveLength(0);
	});

	test("Remove filters the ollama entry and PUTs the remaining list", async () => {
		stubFetch();
		const { getByText } = renderSection([
			{ modelId: "llama3", provider: "ollama", tier: "balanced", baseUrl: "http://localhost:11434" },
			{ modelId: "gpt-4o", provider: "openai", tier: "powerful" },
		]);

		expect(getByText("Active models:")).toBeInTheDocument();
		await fireEvent.click(getByText("Remove"));

		await waitFor(() => {
			expect(puts()).toHaveLength(1);
			expect(puts()[0]!.body).toEqual({
				value: [{ modelId: "gpt-4o", provider: "openai", tier: "powerful" }],
			});
		});
	});
});

describe("ProvidersSection model test", () => {
	test("Test renders check indicators and latency on success", async () => {
		stubFetch();
		const { getByText, getByTitle } = renderSection([
			{ modelId: "llama3", provider: "ollama", tier: "balanced", baseUrl: "http://localhost:11434" },
		]);

		await fireEvent.click(getByText("Test"));

		await waitFor(() => expect(getByTitle("Reachable")).toHaveTextContent("✓"));
		expect(getByTitle("Model available")).toHaveTextContent("✓");
		expect(getByTitle("Inference OK")).toHaveTextContent("✓");
		expect(getByText("150ms")).toBeInTheDocument();

		const post = fetchCalls.find((c) => c.url.includes("/api/providers/local/test"));
		expect(post!.body).toEqual({ baseUrl: "http://localhost:11434", modelId: "llama3" });
	});

	test("network failure renders the unreachable cross", async () => {
		stubFetch({ localTest: "reject" });
		const { getByText, getByTitle } = renderSection([
			{ modelId: "llama3", provider: "ollama", tier: "balanced", baseUrl: "http://localhost:11434" },
		]);

		await fireEvent.click(getByText("Test"));

		await waitFor(() => expect(getByTitle("Reachable")).toHaveTextContent("✗"));
		expect(getByTitle("Reachable").className).toContain("text-red-400");
	});
});

describe("ProvidersSection header chips", () => {
	test("provider status dots reflect key / expiry state; Ollama chip turns green with models", async () => {
		stubFetch({
			providers: [
				{ provider: "anthropic", hasKey: true, source: "byok", oauthConnected: false, oauthExpired: false, oauthSupported: false },
				{ provider: "openai", hasKey: false, source: "none", oauthConnected: true, oauthExpired: true, oauthSupported: true },
				{ provider: "google", hasKey: false, source: "none", oauthConnected: false, oauthExpired: false, oauthSupported: true },
			],
		});
		const { getAllByText, container } = renderSection([
			{ modelId: "llama3", provider: "ollama", tier: "balanced", baseUrl: "http://localhost:11434" },
		]);

		// The name appears in both the header chip and the provider card.
		await waitFor(() => expect(getAllByText(/Anthropic/).length).toBeGreaterThan(0));

		const header = container.querySelector("button[aria-expanded]")!;
		await waitFor(() => {
			expect(header.querySelectorAll(".bg-green-500").length).toBeGreaterThanOrEqual(2); // anthropic + ollama
			expect(header.querySelectorAll(".bg-amber-500")).toHaveLength(1); // expired openai
			expect(header.querySelectorAll(".bg-gray-500")).toHaveLength(1); // unconfigured google
		});
	});

	test("Ollama chip shows the model count when configured, Not configured otherwise", async () => {
		stubFetch();
		const { getByText, rerender } = renderSection([
			{ modelId: "llama3", provider: "ollama", tier: "balanced", baseUrl: "http://localhost:11434" },
		]);
		expect(getByText("1 model")).toBeInTheDocument();

		await rerender({ customModels: [], ollamaUrl: "http://localhost:11434" });
		expect(getByText("Not configured")).toBeInTheDocument();
	});
});
