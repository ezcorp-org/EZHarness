/**
 * DOM tests for TopicContextsSection.svelte — the topic-contexts model
 * picker (settings/personalization).
 *
 * Covers (spec test matrix):
 *   - hydrates the stored `contexts:model` setting into the picker
 *   - onselect PUTs `contexts:model="provider/model"` optimistically +
 *     flashes "Saved ✓"
 *   - a failed save rolls the optimistic selection back + flashes the
 *     error indicator
 *   - onclear (pill ×) resets to default-local (PUTs "")
 *   - the "Current Chat Model" sentinel also resets to default-local
 *   - a malformed / absent setting starts on the default (no pill)
 *
 * Model-picker interaction mirrors BriefingSettings.component.test.ts:
 * the real ModelSearchPicker loads its options from GET /api/models, then
 * options are chosen via mouseDown; the selected pill clears on mouseDown
 * of its × (SelectedPill removes on mousedown, not click).
 */
import { render, fireEvent, screen, waitFor, within } from "@testing-library/svelte";
import { describe, test, expect, vi, afterEach } from "vitest";
import TopicContextsSection from "../settings/TopicContextsSection.svelte";

const MODELS = [
	{ provider: "anthropic", model: "claude-fable-5", tier: "frontier", costTier: "high", displayName: "Fable 5", available: true },
	{ provider: "openai", model: "gpt-5.5", tier: "frontier", costTier: "high", displayName: "GPT-5.5", available: true },
];

interface FetchCall {
	url: string;
	method: string;
	body?: unknown;
}

function stubFetch(opts: { settings?: Record<string, unknown>; putReject?: boolean } = {}): FetchCall[] {
	const calls: FetchCall[] = [];
	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			const method = (init?.method ?? "GET").toUpperCase();
			calls.push({
				url,
				method,
				body: init?.body ? JSON.parse(init.body as string) : undefined,
			});

			if (url.includes("/api/models")) return json(MODELS);
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

function picker(): HTMLElement {
	return screen.getByTestId("contexts-model-picker");
}

async function pickOption(label: string) {
	const input = screen.getByTestId("open-model-search-picker");
	await fireEvent.focus(input);
	const option = await waitFor(() => {
		const btn = Array.from(document.querySelectorAll("#model-picker-listbox button")).find((b) =>
			b.textContent?.includes(label),
		);
		expect(btn).toBeTruthy();
		return btn as HTMLElement;
	});
	await fireEvent.mouseDown(option);
}

function lastPut(calls: FetchCall[]): FetchCall | undefined {
	return [...calls].reverse().find((c) => c.method === "PUT");
}

afterEach(() => vi.unstubAllGlobals());

describe("TopicContextsSection — hydrate", () => {
	test("stored contexts:model renders as the picker's selected model", async () => {
		stubFetch({ settings: { "contexts:model": "openai/gpt-5.5" } });
		render(TopicContextsSection);
		await waitFor(() => expect(picker().textContent).toContain("GPT-5.5"));
	});

	test("no stored setting starts on the default (no selected pill)", async () => {
		stubFetch({ settings: {} });
		render(TopicContextsSection);
		// Give onMount + /api/models a chance to settle.
		await waitFor(() => expect(screen.getByTestId("open-model-search-picker")).not.toBeNull());
		expect(within(picker()).queryByTestId("selected-pill")).toBeNull();
		expect(picker().textContent).not.toContain("GPT-5.5");
	});

	test("a malformed stored value (no slash) is ignored → default", async () => {
		stubFetch({ settings: { "contexts:model": "noslash" } });
		render(TopicContextsSection);
		await waitFor(() => expect(screen.getByTestId("open-model-search-picker")).not.toBeNull());
		expect(picker().textContent).not.toContain("GPT-5.5");
	});
});

describe("TopicContextsSection — save", () => {
	test("selecting a model PUTs contexts:model=provider/model and flashes Saved", async () => {
		const calls = stubFetch({ settings: {} });
		render(TopicContextsSection);
		await waitFor(() => expect(screen.getByTestId("open-model-search-picker")).not.toBeNull());

		await pickOption("GPT-5.5");
		await waitFor(() => {
			const put = lastPut(calls);
			expect(decodeURIComponent(put?.url ?? "")).toContain("/api/settings/contexts:model");
			expect(put?.body).toEqual({ value: "openai/gpt-5.5" });
		});
		await waitFor(() => expect(screen.queryByTestId("save-indicator-saved")).not.toBeNull());
	});

	test('"Current Chat Model" sentinel resets to default-local (PUTs "")', async () => {
		const calls = stubFetch({ settings: {} });
		render(TopicContextsSection);
		await waitFor(() => expect(screen.getByTestId("open-model-search-picker")).not.toBeNull());

		await pickOption("Current Chat Model");
		await waitFor(() => {
			const put = lastPut(calls);
			expect(put?.body).toEqual({ value: "" });
		});
	});

	test("clearing the selected pill PUTs an empty value (default-local)", async () => {
		const calls = stubFetch({ settings: { "contexts:model": "openai/gpt-5.5" } });
		render(TopicContextsSection);
		await waitFor(() => expect(picker().textContent).toContain("GPT-5.5"));

		// SelectedPill removes on MOUSEDOWN, not click (modes-extensions e2e lesson).
		const removeBtn = await waitFor(() => {
			const btn = picker().querySelector("button[aria-label^='Remove']");
			expect(btn).toBeTruthy();
			return btn as HTMLButtonElement;
		});
		await fireEvent.mouseDown(removeBtn);

		await waitFor(() => expect(lastPut(calls)?.body).toEqual({ value: "" }));
	});

	test("a failed save rolls the selection back and flashes the error", async () => {
		const calls = stubFetch({ settings: {}, putReject: true });
		render(TopicContextsSection);
		await waitFor(() => expect(screen.getByTestId("open-model-search-picker")).not.toBeNull());

		await pickOption("GPT-5.5");
		await waitFor(() => expect(lastPut(calls)?.body).toEqual({ value: "openai/gpt-5.5" }));
		// Error indicator shows and the optimistic selection is rolled back.
		await waitFor(() => expect(screen.queryByTestId("save-indicator-error")).not.toBeNull());
		await waitFor(() => expect(picker().textContent).not.toContain("GPT-5.5"));
	});
});
