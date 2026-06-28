/**
 * Sortable Extensions list — component/integration test for the route page
 * (`web/src/routes/(app)/extensions/+page.svelte`).
 *
 * The page renders the active-tab cards through `sortExtensions(list, mode)`
 * (default A–Z). This mounts the route with deliberately-unsorted names +
 * timestamps and asserts the rendered card order for each mode the user can
 * pick from the `ext-sort-select` dropdown:
 *   - default render → names A–Z
 *   - name-desc       → names Z–A
 *   - recent          → updatedAt DESC
 *
 * Card order is read off the visible `<h3>` name in each `[data-testid="ext-card"]`.
 * As in the MCP-tab test, the page first-paints from the SSR `data` prop then
 * re-fetches via `loadExtensions()` on mount; both go through a URL-keyed
 * fetch spy, and `$lib/toast` is mocked to a no-op.
 */
import "@testing-library/jest-dom/vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("$lib/toast.svelte.js", () => ({ addToast: vi.fn() }));

import ExtensionsPage from "../routes/(app)/extensions/+page.svelte";

function makeExt(overrides: Record<string, unknown> = {}) {
	const manifest = {
		tools: [{ name: "t", description: "a tool" }],
		permissions: {},
	};
	return {
		id: "ext-id",
		name: "ext",
		version: "1.0.0",
		description: "desc",
		enabled: true,
		source: "local",
		consecutiveFailures: 0,
		isBundled: false,
		grantedPermissions: {},
		...overrides,
		manifest,
	};
}

// Deliberately unsorted insertion order. Names chosen so A–Z, Z–A and
// updatedAt-DESC each produce a DISTINCT order, so a passing assertion can
// only come from the right comparator.
//   A–Z:           Alpha, Bravo, Charlie
//   Z–A:           Charlie, Bravo, Alpha
//   updatedAt DESC: Bravo (2026), Charlie (2024), Alpha (2020)
const alpha = makeExt({
	id: "id-alpha",
	name: "Alpha",
	createdAt: "2020-01-01T00:00:00.000Z",
	updatedAt: "2020-01-01T00:00:00.000Z",
});
const bravo = makeExt({
	id: "id-bravo",
	name: "Bravo",
	createdAt: "2021-01-01T00:00:00.000Z",
	updatedAt: "2026-06-01T00:00:00.000Z",
});
const charlie = makeExt({
	id: "id-charlie",
	name: "Charlie",
	createdAt: "2022-01-01T00:00:00.000Z",
	updatedAt: "2024-01-01T00:00:00.000Z",
});

const unsorted = [charlie, alpha, bravo];

/** URL-keyed fetch spy: the on-mount `/api/extensions` reload returns the list. */
function listFetch(list: unknown[]) {
	const original = globalThis.fetch;
	const spy = vi.fn(async (input: RequestInfo | URL) => {
		const url = typeof input === "string" ? input : input.toString();
		const json = (body: unknown) =>
			new Response(JSON.stringify(body), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		if (url === "/api/extensions") return json(list);
		return json({});
	});
	globalThis.fetch = spy as unknown as typeof fetch;
	return () => {
		globalThis.fetch = original;
	};
}

let restoreFetch: () => void;

beforeEach(() => {
	localStorage.clear();
});

afterEach(() => {
	restoreFetch?.();
	vi.restoreAllMocks();
});

/** Read the rendered card order by each card's visible `<h3>` name. */
function cardNames(container: HTMLElement): string[] {
	return Array.from(container.querySelectorAll('[data-testid="ext-card"] h3')).map(
		(h) => h.textContent?.trim() ?? "",
	);
}

describe("Extensions page — sortable list", () => {
	test("default render orders cards A–Z by name", async () => {
		restoreFetch = listFetch(unsorted);
		const { container, findByText } = render(ExtensionsPage, {
			props: { data: { bundledExtensions: [], installedExtensions: unsorted } },
		});

		await findByText("Alpha");
		await waitFor(() => expect(cardNames(container)).toEqual(["Alpha", "Bravo", "Charlie"]));
	});

	test("changing sort to name-desc reorders cards Z–A", async () => {
		restoreFetch = listFetch(unsorted);
		const { container, getByTestId, findByText } = render(ExtensionsPage, {
			props: { data: { bundledExtensions: [], installedExtensions: unsorted } },
		});
		await findByText("Alpha");

		await fireEvent.change(getByTestId("ext-sort-select"), { target: { value: "name-desc" } });
		await waitFor(() => expect(cardNames(container)).toEqual(["Charlie", "Bravo", "Alpha"]));
	});

	test("changing sort to recent reorders cards by updatedAt DESC", async () => {
		restoreFetch = listFetch(unsorted);
		const { container, getByTestId, findByText } = render(ExtensionsPage, {
			props: { data: { bundledExtensions: [], installedExtensions: unsorted } },
		});
		await findByText("Alpha");

		await fireEvent.change(getByTestId("ext-sort-select"), { target: { value: "recent" } });
		// Bravo (2026) > Charlie (2024) > Alpha (2020)
		await waitFor(() => expect(cardNames(container)).toEqual(["Bravo", "Charlie", "Alpha"]));
	});
});
