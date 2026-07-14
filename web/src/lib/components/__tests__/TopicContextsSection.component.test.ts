/**
 * DOM tests for TopicContextsSection.svelte — the topic-contexts model picker
 * (settings/personalization), now built on the app-wide chat `ModelSelector`.
 *
 * Covers (spec test matrix):
 *   - hydrates the stored `contexts:model` setting into the picker
 *   - a pinned model shows the "Use local default" reset; the default does not
 *   - selecting a model PUTs `contexts:model="provider/model"` + flashes Saved
 *   - "Use local default" PUTs "" (default-local) and hides the reset
 *   - a malformed / absent setting starts on the default (no pill, no reset)
 *   - a failed save rolls the optimistic selection back + flashes the error
 *
 * ModelSelector loads its own options from GET /api/models (array of
 * ModelOption); a model is chosen by opening the selector and clicking its
 * option button.
 */
import { render, fireEvent, screen, waitFor, within } from "@testing-library/svelte";
import { describe, test, expect, vi, afterEach } from "vitest";
import TopicContextsSection from "../settings/TopicContextsSection.svelte";

const MODELS = [
	{ provider: "anthropic", model: "claude-fable-5", tier: "powerful", costTier: "high", displayName: "Fable 5", available: true },
	{ provider: "openai", model: "gpt-5.5", tier: "powerful", costTier: "high", displayName: "GPT-5.5", available: true },
];

interface FetchCall {
	url: string;
	method: string;
	body?: unknown;
}

const DEFAULT_SUPPORT = { localModel: "qwen3.5:4b", configured: true, probed: true, supported: true, reason: null };

function stubFetch(
	opts: {
		settings?: Record<string, unknown>;
		putReject?: boolean;
		support?: Record<string, unknown>;
		supportRecheck?: Record<string, unknown>;
	} = {},
): FetchCall[] {
	const calls: FetchCall[] = [];
	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			const method = (init?.method ?? "GET").toUpperCase();
			calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });

			if (url.includes("/api/models")) return json(MODELS);
			if (url.includes("/api/contexts/model-support")) {
				const recheck = url.includes("recheck=1");
				return json((recheck ? opts.supportRecheck : opts.support) ?? opts.support ?? DEFAULT_SUPPORT);
			}
			if (url.includes("/api/settings/")) {
				// Single-key PUT via upsertSetting.
				if (opts.putReject) return json({ error: "nope" }, 500);
				return json({ ok: true });
			}
			if (url.endsWith("/api/settings")) return json(opts.settings ?? {});
			return json({});
		}),
	);
	return calls;
}

/** The ModelSelector toggle button (the only button before it is opened). */
function selectorButton(): HTMLElement {
	return within(screen.getByTestId("model-selector")).getAllByRole("button")[0]!;
}

/** Open the selector and click the model whose row text includes `displayName`. */
async function pickModel(displayName: string) {
	await fireEvent.click(selectorButton());
	const opt = await waitFor(() => {
		const btn = Array.from(document.querySelectorAll("#model-selector-listbox button")).find((b) =>
			b.textContent?.includes(displayName),
		);
		expect(btn).toBeTruthy();
		return btn as HTMLElement;
	});
	await fireEvent.click(opt);
}

function lastPut(calls: FetchCall[]): FetchCall | undefined {
	return [...calls].reverse().find((c) => c.method === "PUT");
}

afterEach(() => vi.unstubAllGlobals());

describe("TopicContextsSection — hydrate", () => {
	test("stored contexts:model renders as the ModelSelector's selected model + shows reset", async () => {
		stubFetch({ settings: { "contexts:model": "openai/gpt-5.5" } });
		render(TopicContextsSection);
		await waitFor(() => expect(screen.getByTestId("model-selector").textContent).toContain("GPT-5.5"));
		// The reset affordance appears only when a model is pinned.
		expect(screen.queryByTestId("contexts-model-reset")).not.toBeNull();
	});

	test("no stored setting → 'Select model', no reset button", async () => {
		stubFetch({ settings: {} });
		render(TopicContextsSection);
		await waitFor(() => expect(screen.getByTestId("model-selector").textContent).toContain("Select model"));
		expect(screen.queryByTestId("contexts-model-reset")).toBeNull();
	});

	test("a malformed stored value (no slash) is ignored → default, no reset", async () => {
		stubFetch({ settings: { "contexts:model": "noslash" } });
		render(TopicContextsSection);
		await waitFor(() => expect(screen.getByTestId("model-selector").textContent).toContain("Select model"));
		expect(screen.queryByTestId("contexts-model-reset")).toBeNull();
	});
});

describe("TopicContextsSection — save + reset", () => {
	test("selecting a model PUTs contexts:model=provider/model and flashes Saved", async () => {
		const calls = stubFetch({ settings: {} });
		render(TopicContextsSection);
		await waitFor(() => expect(calls.some((c) => c.url.includes("/api/models"))).toBe(true));

		await pickModel("GPT-5.5");
		await waitFor(() => {
			const put = lastPut(calls);
			expect(decodeURIComponent(put?.url ?? "")).toContain("/api/settings/contexts:model");
			expect(put?.body).toEqual({ value: "openai/gpt-5.5" });
		});
		await waitFor(() => expect(screen.queryByTestId("save-indicator-saved")).not.toBeNull());
	});

	test("'Use local default' resets to default-local (PUTs '') and hides the reset", async () => {
		const calls = stubFetch({ settings: { "contexts:model": "openai/gpt-5.5" } });
		render(TopicContextsSection);
		await waitFor(() => expect(screen.queryByTestId("contexts-model-reset")).not.toBeNull());

		await fireEvent.click(screen.getByTestId("contexts-model-reset"));
		await waitFor(() => expect(lastPut(calls)?.body).toEqual({ value: "" }));
		await waitFor(() => expect(screen.queryByTestId("contexts-model-reset")).toBeNull());
	});

	test("a failed save rolls the selection back and flashes the error", async () => {
		const calls = stubFetch({ settings: {}, putReject: true });
		render(TopicContextsSection);
		await waitFor(() => expect(calls.some((c) => c.url.includes("/api/models"))).toBe(true));

		await pickModel("GPT-5.5");
		await waitFor(() => expect(lastPut(calls)?.body).toEqual({ value: "openai/gpt-5.5" }));
		await waitFor(() => expect(screen.queryByTestId("save-indicator-error")).not.toBeNull());
		// The optimistic selection is rolled back → no longer showing GPT-5.5.
		await waitFor(() => expect(screen.getByTestId("model-selector").textContent).not.toContain("GPT-5.5"));
	});
});

describe("TopicContextsSection — support status", () => {
	test("supported model shows a ✓ status line", async () => {
		stubFetch({ support: { localModel: "qwen3.5:4b", configured: true, probed: true, supported: true, reason: null } });
		render(TopicContextsSection);
		await waitFor(() => expect(screen.getByTestId("contexts-support-ok")).toHaveTextContent("qwen3.5:4b"));
	});

	test("unsupported model shows a ✗ status line with the reason", async () => {
		stubFetch({
			support: { localModel: "qwen3.5:4b", configured: true, probed: true, supported: false, reason: "load-failed" },
		});
		render(TopicContextsSection);
		await waitFor(() => {
			const bad = screen.getByTestId("contexts-support-bad");
			expect(bad).toHaveTextContent("qwen3.5:4b");
			expect(bad).toHaveTextContent("couldn't load it");
		});
	});

	test("not-yet-probed model shows a neutral 'not checked' status", async () => {
		stubFetch({ support: { localModel: "qwen3.5:4b", configured: true, probed: false, supported: false, reason: null } });
		render(TopicContextsSection);
		await waitFor(() =>
			expect(screen.getByTestId("contexts-support-status")).toHaveTextContent("not checked yet"),
		);
	});

	test("no endpoint configured → 'No local model endpoint'", async () => {
		stubFetch({ support: { localModel: "qwen3.5:4b", configured: false, probed: false, supported: false, reason: "endpoint-down" } });
		render(TopicContextsSection);
		await waitFor(() =>
			expect(screen.getByTestId("contexts-support-status")).toHaveTextContent("No local model endpoint"),
		);
	});

	test("Re-check re-fetches with ?recheck=1 and updates the status", async () => {
		const calls = stubFetch({
			support: { localModel: "qwen3.5:4b", configured: true, probed: false, supported: false, reason: null },
			supportRecheck: { localModel: "qwen3.5:4b", configured: true, probed: true, supported: true, reason: null },
		});
		render(TopicContextsSection);
		await waitFor(() =>
			expect(screen.getByTestId("contexts-support-status")).toHaveTextContent("not checked yet"),
		);

		await fireEvent.click(screen.getByTestId("contexts-recheck-btn"));
		await waitFor(() => expect(screen.getByTestId("contexts-support-ok")).toHaveTextContent("qwen3.5:4b"));
		expect(calls.some((c) => c.url.includes("/api/contexts/model-support") && c.url.includes("recheck=1"))).toBe(true);
	});

	test("a failed support fetch leaves an unavailable status (no crash)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = typeof input === "string" ? input : input.toString();
				if (url.includes("/api/models")) return new Response(JSON.stringify(MODELS), { status: 200 });
				if (url.includes("/api/contexts/model-support")) return new Response("nope", { status: 500 });
				if (url.endsWith("/api/settings")) return new Response(JSON.stringify({}), { status: 200 });
				return new Response(JSON.stringify({}), { status: 200 });
			}),
		);
		render(TopicContextsSection);
		await waitFor(() =>
			expect(screen.getByTestId("contexts-support-status")).toHaveTextContent("status unavailable"),
		);
	});
});
