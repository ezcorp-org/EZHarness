/**
 * DOM tests for ComposerSuggestSection (settings/personalization): the
 * composer-suggestions kill switch is an optimistic toggle that PUTs
 * `suggest:enabled` via /api/settings/<key> and rolls back on failure —
 * same contract as AdvancedSection's toggles.
 */
import { describe, test, expect, vi, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import "@testing-library/jest-dom/vitest";
import ComposerSuggestSection from "../settings/ComposerSuggestSection.svelte";

interface FetchCall {
	url: string;
	method: string;
	body?: unknown;
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

afterEach(() => vi.unstubAllGlobals());

describe("ComposerSuggestSection", () => {
	test("toggle OFF PUTs suggest:enabled=false optimistically", async () => {
		stubFetch();
		const { getByTestId } = render(ComposerSuggestSection, { props: { suggestEnabled: true } });
		const toggle = getByTestId("toggle-composer-suggestions");
		expect(toggle).toHaveAttribute("aria-checked", "true");

		await fireEvent.click(toggle);
		expect(toggle).toHaveAttribute("aria-checked", "false"); // optimistic
		await waitFor(() => {
			const put = fetchCalls.find((c) => c.method === "PUT");
			expect(put?.url).toContain("/api/settings/suggest:enabled");
			expect(put?.body).toEqual({ value: false });
		});
	});

	test("toggle back ON PUTs suggest:enabled=true", async () => {
		stubFetch();
		const { getByTestId } = render(ComposerSuggestSection, { props: { suggestEnabled: false } });
		await fireEvent.click(getByTestId("toggle-composer-suggestions"));
		await waitFor(() => {
			const put = fetchCalls.find((c) => c.method === "PUT");
			expect(put?.body).toEqual({ value: true });
		});
	});

	test("failed save rolls the optimistic toggle back", async () => {
		stubFetch("reject");
		const { getByTestId } = render(ComposerSuggestSection, { props: { suggestEnabled: true } });
		const toggle = getByTestId("toggle-composer-suggestions");
		await fireEvent.click(toggle);
		await waitFor(() => {
			expect(toggle).toHaveAttribute("aria-checked", "true"); // rolled back
		});
	});

	test("project scope PUTs the project:<id>: key and shows project copy", async () => {
		stubFetch();
		const { getByTestId, getByText } = render(ComposerSuggestSection, {
			props: { suggestEnabled: true, projectId: "proj-1" },
		});
		expect(getByText(/Applies to this project only/)).toBeInTheDocument();
		await fireEvent.click(getByTestId("toggle-composer-suggestions"));
		await waitFor(() => {
			const put = fetchCalls.find((c) => c.method === "PUT");
			expect(decodeURIComponent(put?.url ?? "")).toContain(
				"/api/settings/project:proj-1:suggest:enabled",
			);
			expect(put?.body).toEqual({ value: false });
		});
	});

	test("global scope shows override copy", () => {
		stubFetch();
		const { getByText } = render(ComposerSuggestSection, { props: { suggestEnabled: true } });
		expect(getByText(/Global override/)).toBeInTheDocument();
	});
});
