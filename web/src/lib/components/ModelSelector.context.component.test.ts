/**
 * Integration tests for ModelSelector's `oncontextwindowchange` callback.
 * Mounts the real component, mocks `/api/models`, and asserts the callback
 * fires with the right contextWindow on initial load, re-emits when the
 * `selected` prop changes, and emits null when the selection doesn't
 * exist in the models list.
 */

import { render, cleanup, fireEvent } from "@testing-library/svelte";
import { describe, test, expect, afterEach, beforeEach, vi } from "vitest";
import ModelSelector from "./ModelSelector.svelte";

type ModelPayload = {
	provider: string;
	model: string;
	tier: string;
	costTier: string;
	displayName?: string;
	available: boolean;
	contextWindow?: number;
};

const MODELS: ModelPayload[] = [
	{ provider: "anthropic", model: "claude-opus-4-7", tier: "powerful", costTier: "high", available: true, contextWindow: 1_000_000, displayName: "Opus 4.7" },
	{ provider: "anthropic", model: "claude-sonnet-4-6", tier: "balanced", costTier: "medium", available: true, contextWindow: 200_000, displayName: "Sonnet 4.6" },
	{ provider: "openai", model: "gpt-5", tier: "balanced", costTier: "medium", available: true, contextWindow: 128_000, displayName: "GPT-5" },
];

let fetchCalls: string[];
let originalFetch: typeof fetch;

beforeEach(() => {
	fetchCalls = [];
	originalFetch = globalThis.fetch;
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = typeof input === "string" ? input : input.toString();
		fetchCalls.push(url);
		if (url.endsWith("/api/models")) {
			return new Response(JSON.stringify(MODELS), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response("not found", { status: 404 });
	}) as unknown as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	cleanup();
});

async function flushLoad() {
	// loadModels is async; yield to the microtask queue + a macrotask so
	// the Svelte effect has a chance to settle after `models` state mutates.
	await new Promise((r) => setTimeout(r, 0));
	await new Promise((r) => setTimeout(r, 0));
}

describe("ModelSelector · oncontextwindowchange", () => {
	test("emits contextWindow of preselected model on initial load", async () => {
		const calls: (number | null)[] = [];
		render(ModelSelector, {
			selected: { provider: "anthropic", model: "claude-sonnet-4-6" },
			onselect: vi.fn(),
			oncontextwindowchange: (cw: number | null) => calls.push(cw),
		});

		await flushLoad();

		expect(calls).toContain(200_000);
	});

	test("emits null when selected model is not in the loaded list", async () => {
		const calls: (number | null)[] = [];
		render(ModelSelector, {
			selected: { provider: "anthropic", model: "ghost-model" },
			onselect: vi.fn(),
			oncontextwindowchange: (cw: number | null) => calls.push(cw),
		});

		await flushLoad();

		expect(calls).toContain(null);
	});

	test("re-emits when the user picks a different model from the dropdown", async () => {
		const calls: (number | null)[] = [];
		const onselect = vi.fn();
		const { getByRole, getByText } = render(ModelSelector, {
			selected: { provider: "anthropic", model: "claude-sonnet-4-6" },
			onselect,
			oncontextwindowchange: (cw: number | null) => calls.push(cw),
		});

		await flushLoad();
		calls.length = 0; // ignore the initial-load emit

		// Open the dropdown (trigger button) and click "Opus 4.7".
		await fireEvent.click(getByRole("button"));
		await fireEvent.click(getByText("Opus 4.7"));

		expect(onselect).toHaveBeenCalledWith("anthropic", "claude-opus-4-7");
		expect(calls.at(-1)).toBe(1_000_000);
	});

	test("does not emit when no selection and no models (guard against spurious nulls)", async () => {
		const calls: (number | null)[] = [];
		// Override fetch to return an empty list so autoselect doesn't fire.
		globalThis.fetch = vi.fn(async () =>
			new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
		) as unknown as typeof fetch;

		render(ModelSelector, {
			selected: null,
			onselect: vi.fn(),
			oncontextwindowchange: (cw: number | null) => calls.push(cw),
		});

		await flushLoad();

		// No selection + no models → component never resolves a model, so no emit.
		expect(calls).toHaveLength(0);
	});
});
