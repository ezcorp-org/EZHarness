/**
 * DOM tests for TierLadderSection — the tier-ladder editor on
 * /settings/models (setting `provider:tierModels`).
 *
 * Coverage:
 *   1. three tiers render; a configured rung renders with its provider
 *   2. the heuristic default shows as the "what you're overriding" line, and
 *      as the add-select's placeholder
 *   3. add / remove / reorder each PUT the WHOLE ladder and mutate one tier
 *   4. a duplicate add is a client-side no-op (no PUT)
 *   5. a failed PUT rolls the optimistic mutation back
 *   6. a failed /api/models fetch still leaves a usable editor
 */
import { describe, test, expect, vi, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import TierLadderSection from "../settings/TierLadderSection.svelte";
import { emptyTierLadder, type TierLadder } from "$server/runtime/routing/tier-ladder";

const MODELS = [
	{ provider: "anthropic", model: "claude-haiku-4-5", tier: "fast", displayName: "Claude Haiku 4.5", available: true },
	{ provider: "anthropic", model: "claude-sonnet-4-5", tier: "balanced", displayName: "Claude Sonnet 4.5", available: true },
	{ provider: "anthropic", model: "claude-opus-4-1", tier: "powerful", displayName: "Claude Opus 4.1", available: true },
	{ provider: "openai", model: "gpt-4.1-mini", tier: "fast", displayName: "GPT-4.1 mini", available: true },
];

const ORDER = ["anthropic", "openai"];

interface FetchCall {
	url: string;
	method: string;
	body?: unknown;
}
let calls: FetchCall[] = [];

function stubFetch(opts: { models?: typeof MODELS | "reject"; put?: "reject" } = {}) {
	calls = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			calls.push({
				url,
				method: init?.method ?? "GET",
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
			});
			if (url.includes("/api/models")) {
				if (opts.models === "reject") throw new Error("offline");
				return Response.json(opts.models ?? MODELS);
			}
			if (opts.put === "reject") return new Response("nope", { status: 500 });
			return Response.json({ ok: true });
		}),
	);
}

afterEach(() => vi.unstubAllGlobals());

function ladderWith(fast: { provider: string; model: string }[]): TierLadder {
	return { ...emptyTierLadder(), fast };
}

const putCalls = () => calls.filter((c) => c.method === "PUT");

/**
 * Pick a model in the Fast add-select. The wait is load-bearing: a `<select>`
 * silently ignores a value with no matching `<option>`, so choosing before
 * /api/models has rendered its options leaves the select empty and every
 * assertion after it vacuous.
 */
async function pickModel(
	getByLabelText: (text: string) => HTMLElement,
	value: string,
): Promise<HTMLSelectElement> {
	const select = getByLabelText("Add a Fast model") as HTMLSelectElement;
	await waitFor(() =>
		expect(select.querySelector(`option[value="${value}"]`)).toBeInTheDocument(),
	);
	await fireEvent.change(select, { target: { value } });
	return select;
}

describe("TierLadderSection", () => {
	test("renders all three tiers and the configured rungs", async () => {
		stubFetch();
		const { getByTestId, getAllByTestId } = render(TierLadderSection, {
			props: {
				tierLadder: ladderWith([
					{ provider: "anthropic", model: "claude-haiku-4-5" },
					{ provider: "openai", model: "gpt-4.1-mini" },
				]),
				preferenceOrder: ORDER,
			},
		});

		expect(getByTestId("tier-ladder-fast")).toBeInTheDocument();
		expect(getByTestId("tier-ladder-balanced")).toBeInTheDocument();
		expect(getByTestId("tier-ladder-powerful")).toBeInTheDocument();

		const rungs = getAllByTestId("tier-ladder-rung");
		expect(rungs).toHaveLength(2);
		expect(rungs[0]).toHaveTextContent("claude-haiku-4-5");
		expect(rungs[0]).toHaveTextContent("Anthropic");
		expect(rungs[1]).toHaveTextContent("gpt-4.1-mini");
	});

	test("shows the heuristic default a tier would fall back to", async () => {
		stubFetch();
		const { getByTestId } = render(TierLadderSection, {
			props: { tierLadder: emptyTierLadder(), preferenceOrder: ORDER },
		});

		await waitFor(() =>
			expect(getByTestId("tier-ladder-default-fast")).toHaveTextContent(
				"Default (no override): anthropic/claude-haiku-4-5, openai/gpt-4.1-mini",
			),
		);
		// The add-select advertises the same default in its placeholder option.
		expect(getByTestId("tier-ladder-fast")).toHaveTextContent(
			"Add a model (default: anthropic/claude-haiku-4-5)",
		);
		// A tier with a configured rung says it FALLS BACK to the default instead.
		expect(getByTestId("tier-ladder-default-powerful")).toHaveTextContent(
			"Default (no override): anthropic/claude-opus-4-1",
		);
	});

	test("wording switches to a fallback note once a tier is configured", async () => {
		stubFetch();
		const { getByTestId } = render(TierLadderSection, {
			props: {
				tierLadder: ladderWith([{ provider: "anthropic", model: "claude-haiku-4-5" }]),
				preferenceOrder: ORDER,
			},
		});
		await waitFor(() =>
			expect(getByTestId("tier-ladder-default-fast")).toHaveTextContent("Falls back to:"),
		);
	});

	test("with no reachable models it says so, for both states", async () => {
		stubFetch({ models: [] });
		const { getByTestId } = render(TierLadderSection, {
			props: {
				tierLadder: ladderWith([{ provider: "anthropic", model: "claude-haiku-4-5" }]),
				preferenceOrder: ORDER,
			},
		});
		await waitFor(() =>
			expect(getByTestId("tier-ladder-default-fast")).toHaveTextContent("No fallback available"),
		);
		expect(getByTestId("tier-ladder-default-balanced")).toHaveTextContent(
			"No default available — connect a provider",
		);
	});

	test("adding a model PUTs the whole ladder with the new rung appended", async () => {
		stubFetch();
		const { getByTestId, getByLabelText, getAllByTestId } = render(TierLadderSection, {
			props: { tierLadder: emptyTierLadder(), preferenceOrder: ORDER },
		});
		const select = await pickModel(getByLabelText, "openai|gpt-4.1-mini");
		expect(select.value).toBe("openai|gpt-4.1-mini");
		await fireEvent.click(getByTestId("tier-ladder-add-fast"));

		await waitFor(() => expect(putCalls()).toHaveLength(1));
		expect(putCalls()[0]!.url).toContain("/api/settings/provider:tierModels");
		expect(putCalls()[0]!.body).toEqual({
			value: {
				fast: [{ provider: "openai", model: "gpt-4.1-mini" }],
				balanced: [],
				powerful: [],
			},
		});
		expect(getAllByTestId("tier-ladder-rung")).toHaveLength(1);
	});

	test("adding an already-listed model is a no-op — no PUT", async () => {
		stubFetch();
		const { getByTestId, getByLabelText } = render(TierLadderSection, {
			props: {
				tierLadder: ladderWith([{ provider: "openai", model: "gpt-4.1-mini" }]),
				preferenceOrder: ORDER,
			},
		});
		const select = await pickModel(getByLabelText, "openai|gpt-4.1-mini");
		// The pick really landed — so a missing PUT below is the dedupe, not a
		// select that never changed.
		expect(select.value).toBe("openai|gpt-4.1-mini");
		await fireEvent.click(getByTestId("tier-ladder-add-fast"));

		await waitFor(() => expect(putCalls()).toHaveLength(0));
	});

	test("the Add button ignores an empty selection", async () => {
		stubFetch();
		const { getByTestId } = render(TierLadderSection, {
			props: { tierLadder: emptyTierLadder(), preferenceOrder: ORDER },
		});
		await waitFor(() => expect(calls.length).toBeGreaterThan(0));
		// Nothing picked: the button is disabled AND the handler bails.
		const addButton = getByTestId("tier-ladder-add-fast");
		expect(addButton).toBeDisabled();
		await fireEvent.click(addButton);
		expect(putCalls()).toHaveLength(0);
	});

	test("reordering swaps two rungs and persists", async () => {
		stubFetch();
		const { getAllByTestId } = render(TierLadderSection, {
			props: {
				tierLadder: ladderWith([
					{ provider: "anthropic", model: "claude-haiku-4-5" },
					{ provider: "openai", model: "gpt-4.1-mini" },
				]),
				preferenceOrder: ORDER,
			},
		});

		// Second rung's "move up".
		await fireEvent.click(getAllByTestId("tier-ladder-rung")[1]!.querySelectorAll("button")[0]!);

		await waitFor(() => expect(putCalls()).toHaveLength(1));
		expect((putCalls()[0]!.body as { value: TierLadder }).value.fast).toEqual([
			{ provider: "openai", model: "gpt-4.1-mini" },
			{ provider: "anthropic", model: "claude-haiku-4-5" },
		]);
		expect(getAllByTestId("tier-ladder-rung")[0]!).toHaveTextContent("gpt-4.1-mini");
	});

	test("demoting the first rung persists the same swap from the other direction", async () => {
		stubFetch();
		const { getAllByTestId } = render(TierLadderSection, {
			props: {
				tierLadder: ladderWith([
					{ provider: "anthropic", model: "claude-haiku-4-5" },
					{ provider: "openai", model: "gpt-4.1-mini" },
				]),
				preferenceOrder: ORDER,
			},
		});

		// First rung's "move down".
		await fireEvent.click(getAllByTestId("tier-ladder-rung")[0]!.querySelectorAll("button")[1]!);

		await waitFor(() => expect(putCalls()).toHaveLength(1));
		expect((putCalls()[0]!.body as { value: TierLadder }).value.fast).toEqual([
			{ provider: "openai", model: "gpt-4.1-mini" },
			{ provider: "anthropic", model: "claude-haiku-4-5" },
		]);
		expect(getAllByTestId("tier-ladder-rung")[0]!).toHaveTextContent("gpt-4.1-mini");
	});

	test("the end-of-list move buttons are disabled (no pointless save)", async () => {
		stubFetch();
		const { getAllByTestId } = render(TierLadderSection, {
			props: {
				tierLadder: ladderWith([
					{ provider: "anthropic", model: "claude-haiku-4-5" },
					{ provider: "openai", model: "gpt-4.1-mini" },
				]),
				preferenceOrder: ORDER,
			},
		});
		const rungs = getAllByTestId("tier-ladder-rung");
		expect(rungs[0]!.querySelectorAll("button")[0]!).toBeDisabled();
		expect(rungs[1]!.querySelectorAll("button")[1]!).toBeDisabled();
	});

	test("removing a rung persists the shortened ladder", async () => {
		stubFetch();
		const { getAllByTestId, queryAllByTestId } = render(TierLadderSection, {
			props: {
				tierLadder: ladderWith([{ provider: "anthropic", model: "claude-haiku-4-5" }]),
				preferenceOrder: ORDER,
			},
		});

		await fireEvent.click(getAllByTestId("tier-ladder-rung")[0]!.querySelectorAll("button")[2]!);

		await waitFor(() => expect(putCalls()).toHaveLength(1));
		expect((putCalls()[0]!.body as { value: TierLadder }).value.fast).toEqual([]);
		expect(queryAllByTestId("tier-ladder-rung")).toHaveLength(0);
	});

	test("a failed save rolls the optimistic mutation back", async () => {
		stubFetch({ put: "reject" });
		const { getAllByTestId } = render(TierLadderSection, {
			props: {
				tierLadder: ladderWith([{ provider: "anthropic", model: "claude-haiku-4-5" }]),
				preferenceOrder: ORDER,
			},
		});

		await fireEvent.click(getAllByTestId("tier-ladder-rung")[0]!.querySelectorAll("button")[2]!);

		await waitFor(() => expect(putCalls()).toHaveLength(1));
		// The rung is back — the row on the server never changed.
		await waitFor(() => expect(getAllByTestId("tier-ladder-rung")).toHaveLength(1));
		expect(getAllByTestId("tier-ladder-rung")[0]!).toHaveTextContent("claude-haiku-4-5");
	});

	test("a failed /api/models fetch still leaves the configured ladder editable", async () => {
		stubFetch({ models: "reject" });
		const { getAllByTestId, getByTestId } = render(TierLadderSection, {
			props: {
				tierLadder: ladderWith([{ provider: "anthropic", model: "claude-haiku-4-5" }]),
				preferenceOrder: ORDER,
			},
		});

		expect(getAllByTestId("tier-ladder-rung")).toHaveLength(1);
		await waitFor(() =>
			expect(getByTestId("tier-ladder-default-fast")).toHaveTextContent("No fallback available"),
		);
		// Removal still works with no catalog loaded.
		await fireEvent.click(getAllByTestId("tier-ladder-rung")[0]!.querySelectorAll("button")[2]!);
		await waitFor(() => expect(putCalls()).toHaveLength(1));
	});

	test("a non-ok /api/models response is ignored rather than rendered", async () => {
		calls = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				calls.push({ url, method: init?.method ?? "GET" });
				if (url.includes("/api/models")) return new Response("boom", { status: 503 });
				return Response.json({ ok: true });
			}),
		);
		const { getByTestId } = render(TierLadderSection, {
			props: { tierLadder: emptyTierLadder(), preferenceOrder: ORDER },
		});
		await waitFor(() => expect(calls.length).toBeGreaterThan(0));
		expect(getByTestId("tier-ladder-default-fast")).toHaveTextContent("No default available");
	});
});
