/**
 * Phase 49.4 — ExtensionAttachPicker component tests.
 *
 * Renders the modal, mocks `/api/extensions`, and asserts:
 *   - Cards populate with name, description, and tool count from
 *     the manifest.
 *   - Search filters cards by name/description (uses fuzzyScore so
 *     `summa` matches `summarizer`).
 *   - Multi-select toggle works.
 *   - Submit fires `onsubmit(ids)` and closes via `onclose()`.
 *   - Cancel button calls `onclose()` without firing submit.
 *   - `initialSelected` pre-checks cards on open.
 *   - Closing without submit doesn't mutate parent (we assert no
 *     submit was called).
 *   - API failure shows an error and a "no extensions" affordance.
 */

import "@testing-library/jest-dom/vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach } from "vitest";

import ExtensionAttachPicker from "$lib/components/ExtensionAttachPicker.svelte";

interface PickerProps {
	open: boolean;
	initialSelected?: string[];
	onclose: () => void;
	onsubmit: (ids: string[]) => void;
}

function mockExtensionsApi(extensions: unknown[]) {
	const fetchMock = vi.fn(async (url: string) => {
		if (url === "/api/extensions") {
			return new Response(JSON.stringify({ extensions }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		return new Response("", { status: 404 });
	});
	(globalThis as { fetch: typeof fetch }).fetch =
		fetchMock as unknown as typeof fetch;
	return fetchMock;
}

beforeEach(() => {
	vi.restoreAllMocks();
});

describe("ExtensionAttachPicker", () => {
	test("populates cards from /api/extensions with name + tool count", async () => {
		mockExtensionsApi([
			{
				id: "ext-1",
				name: "summarizer",
				description: "summarize text",
				manifest: { tools: [{ name: "summarize" }, { name: "tldr" }] },
			},
			{
				id: "ext-2",
				name: "translator",
				description: "translate prose",
				manifest: { tools: [{ name: "translate" }] },
			},
		]);
		const props: PickerProps = {
			open: true,
			onclose: vi.fn(),
			onsubmit: vi.fn(),
		};
		const { findAllByTestId } = render(ExtensionAttachPicker, props);
		const cards = await findAllByTestId("extension-attach-picker-card");
		expect(cards.length).toBe(2);
		expect(cards[0]!.textContent).toContain("summarizer");
		expect(cards[0]!.textContent).toContain("2 tools");
		expect(cards[1]!.textContent).toContain("translator");
		expect(cards[1]!.textContent).toContain("1 tools");
	});

	test("search filters cards by name/description (fuzzy)", async () => {
		mockExtensionsApi([
			{ id: "ext-1", name: "summarizer", description: "summarize text", manifest: { tools: [] } },
			{ id: "ext-2", name: "translator", description: "translate prose", manifest: { tools: [] } },
			{ id: "ext-3", name: "code-reviewer", description: "review code", manifest: { tools: [] } },
		]);
		const props: PickerProps = {
			open: true,
			onclose: vi.fn(),
			onsubmit: vi.fn(),
		};
		const { findByTestId, findAllByTestId } = render(ExtensionAttachPicker, props);
		await findAllByTestId("extension-attach-picker-card");
		const search = (await findByTestId("extension-attach-picker-search")) as HTMLInputElement;
		await fireEvent.input(search, { target: { value: "summa" } });
		await waitFor(async () => {
			const remaining = await findAllByTestId("extension-attach-picker-card");
			expect(remaining.length).toBe(1);
			expect(remaining[0]!.textContent).toContain("summarizer");
		});
	});

	test("multi-select toggle: clicking cards adds/removes from selection", async () => {
		mockExtensionsApi([
			{ id: "ext-1", name: "ext-one", manifest: { tools: [] } },
			{ id: "ext-2", name: "ext-two", manifest: { tools: [] } },
		]);
		const onsubmit = vi.fn();
		const props: PickerProps = {
			open: true,
			onclose: vi.fn(),
			onsubmit,
		};
		const { findAllByTestId, findByTestId } = render(ExtensionAttachPicker, props);
		const cards = await findAllByTestId("extension-attach-picker-card");
		await fireEvent.click(cards[0]!);
		expect(cards[0]!.getAttribute("data-selected")).toBe("true");
		await fireEvent.click(cards[1]!);
		expect((await findByTestId("extension-attach-picker-count")).textContent).toContain("2 selected");
		// Toggle the first one off → count drops to 1.
		await fireEvent.click(cards[0]!);
		expect(cards[0]!.getAttribute("data-selected")).toBe("false");
		expect((await findByTestId("extension-attach-picker-count")).textContent).toContain("1 selected");
	});

	test("submit fires onsubmit with the selected ids and calls onclose", async () => {
		mockExtensionsApi([
			{ id: "ext-1", name: "ext-one", manifest: { tools: [] } },
			{ id: "ext-2", name: "ext-two", manifest: { tools: [] } },
		]);
		const onsubmit = vi.fn();
		const onclose = vi.fn();
		const props: PickerProps = {
			open: true,
			onclose,
			onsubmit,
		};
		const { findAllByTestId, findByTestId } = render(ExtensionAttachPicker, props);
		const cards = await findAllByTestId("extension-attach-picker-card");
		await fireEvent.click(cards[1]!);
		const submit = await findByTestId("extension-attach-picker-submit");
		await fireEvent.click(submit);
		expect(onsubmit).toHaveBeenCalledTimes(1);
		expect(onsubmit.mock.calls[0]![0]).toEqual(["ext-2"]);
		expect(onclose).toHaveBeenCalledTimes(1);
	});

	test("Cancel button calls onclose without submitting", async () => {
		mockExtensionsApi([
			{ id: "ext-1", name: "ext-one", manifest: { tools: [] } },
		]);
		const onsubmit = vi.fn();
		const onclose = vi.fn();
		const props: PickerProps = {
			open: true,
			onclose,
			onsubmit,
		};
		const { findAllByTestId, findByText } = render(ExtensionAttachPicker, props);
		await findAllByTestId("extension-attach-picker-card");
		const cancel = await findByText("Cancel");
		await fireEvent.click(cancel);
		expect(onclose).toHaveBeenCalledTimes(1);
		expect(onsubmit).not.toHaveBeenCalled();
	});

	test("initialSelected pre-checks the matching cards", async () => {
		mockExtensionsApi([
			{ id: "ext-1", name: "ext-one", manifest: { tools: [] } },
			{ id: "ext-2", name: "ext-two", manifest: { tools: [] } },
		]);
		const props: PickerProps = {
			open: true,
			initialSelected: ["ext-2"],
			onclose: vi.fn(),
			onsubmit: vi.fn(),
		};
		const { findAllByTestId, findByTestId } = render(ExtensionAttachPicker, props);
		const cards = await findAllByTestId("extension-attach-picker-card");
		const card2 = cards.find((c) => c.getAttribute("data-ext-id") === "ext-2");
		expect(card2).toBeDefined();
		expect(card2!.getAttribute("data-selected")).toBe("true");
		expect((await findByTestId("extension-attach-picker-count")).textContent).toContain("1 selected");
	});

	test("API failure surfaces an error message", async () => {
		const fetchMock = vi.fn(async () => {
			return new Response("nope", { status: 500 });
		});
		(globalThis as { fetch: typeof fetch }).fetch =
			fetchMock as unknown as typeof fetch;
		const props: PickerProps = {
			open: true,
			onclose: vi.fn(),
			onsubmit: vi.fn(),
		};
		const { findByText } = render(ExtensionAttachPicker, props);
		expect(await findByText(/Failed to load extensions/i)).toBeInTheDocument();
	});

	test("empty extensions list shows 'No extensions installed yet.'", async () => {
		mockExtensionsApi([]);
		const props: PickerProps = {
			open: true,
			onclose: vi.fn(),
			onsubmit: vi.fn(),
		};
		const { findByTestId } = render(ExtensionAttachPicker, props);
		const empty = await findByTestId("extension-attach-picker-empty");
		expect(empty.textContent).toContain("No extensions installed");
	});
});
