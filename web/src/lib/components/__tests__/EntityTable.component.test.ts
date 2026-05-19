/**
 * Phase 5 — DOM tests for EntityTable.svelte.
 *
 * Verifies:
 *   - Empty state (0 records) renders the "+ Create" CTA + empty hint
 *   - N records render in alphabetical-by-slug order
 *   - Schema-drift records show a "drift" badge
 *   - Edit button opens the modal with prefilled values
 *   - Delete button calls the API + reloads
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/svelte";
import EntityTable from "../EntityTable.svelte";

const DECL = {
	type: "post-type",
	label: "Post Type",
	pluralLabel: "Post Types",
	scope: "user" as const,
	schema: {
		type: "object" as const,
		properties: {
			name: { type: "string" as const, minLength: 1 },
			cadence: {
				type: "string" as const,
				enum: ["weekly", "monthly", "ad-hoc"],
			},
		},
		required: ["name", "cadence"] as const,
	},
	preview: "{name} ({cadence})",
};

function makeFetchStub(routes: Array<{
	method: string;
	match: string;
	respond: (body?: unknown) => { status: number; body: unknown };
}>) {
	return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		const method = (init?.method ?? "GET").toUpperCase();
		const route = routes.find((r) => r.method === method && url.includes(r.match));
		if (!route) {
			return new Response(JSON.stringify({ items: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		const body = init?.body ? JSON.parse(init.body as string) : undefined;
		const out = route.respond(body);
		return new Response(JSON.stringify(out.body), {
			status: out.status,
			headers: { "content-type": "application/json" },
		});
	});
}

beforeEach(() => {
	vi.stubGlobal("confirm", () => true);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("EntityTable — empty state", () => {
	test("renders empty hint + Create CTA when no records", async () => {
		vi.stubGlobal(
			"fetch",
			makeFetchStub([
				{
					method: "GET",
					match: "/entities/post-type",
					respond: () => ({ status: 200, body: { items: [] } }),
				},
			]),
		);
		render(EntityTable, { props: { extensionId: "ext-1", decl: DECL } });
		await waitFor(() =>
			expect(screen.getByTestId("entity-empty-post-type")).toBeTruthy(),
		);
		expect(screen.getByTestId("entity-create-post-type")).toBeTruthy();
	});
});

describe("EntityTable — populated", () => {
	test("renders rows alphabetized by slug with preview", async () => {
		vi.stubGlobal(
			"fetch",
			makeFetchStub([
				{
					method: "GET",
					match: "/entities/post-type",
					respond: () => ({
						status: 200,
						body: {
							items: [
								{
									slug: "weekly",
									data: { name: "Weekly", cadence: "weekly" },
								},
								{
									slug: "ad-hoc",
									data: { name: "Ad-Hoc", cadence: "ad-hoc" },
								},
								{
									slug: "monthly",
									data: { name: "Monthly", cadence: "monthly" },
								},
							],
						},
					}),
				},
			]),
		);
		render(EntityTable, { props: { extensionId: "ext-1", decl: DECL } });
		await waitFor(() =>
			expect(screen.getByTestId("entity-rows-post-type")).toBeTruthy(),
		);
		const rows = document.querySelectorAll(
			'[data-testid^="entity-row-post-type-"]',
		);
		const slugs = Array.from(rows).map((r) =>
			r.getAttribute("data-testid")!.replace("entity-row-post-type-", ""),
		);
		expect(slugs).toEqual(["ad-hoc", "monthly", "weekly"]);
	});

	test("shows a drift badge on records with _validationWarning", async () => {
		vi.stubGlobal(
			"fetch",
			makeFetchStub([
				{
					method: "GET",
					match: "/entities/post-type",
					respond: () => ({
						status: 200,
						body: {
							items: [
								{
									slug: "weekly",
									data: { name: "Weekly", cadence: "biweekly" },
									_validationWarning: {
										code: "SCHEMA_DRIFT",
										issues: [
											{
												path: "cadence",
												message: "expected one of weekly|monthly|ad-hoc, got biweekly",
											},
										],
									},
								},
							],
						},
					}),
				},
			]),
		);
		render(EntityTable, { props: { extensionId: "ext-1", decl: DECL } });
		await waitFor(() =>
			expect(screen.getByTestId("entity-drift-post-type-weekly")).toBeTruthy(),
		);
	});

	test("clicking Edit opens the modal with prefilled data", async () => {
		vi.stubGlobal(
			"fetch",
			makeFetchStub([
				{
					method: "GET",
					match: "/entities/post-type",
					respond: () => ({
						status: 200,
						body: {
							items: [
								{
									slug: "weekly",
									data: { name: "Weekly", cadence: "weekly" },
								},
							],
						},
					}),
				},
			]),
		);
		render(EntityTable, { props: { extensionId: "ext-1", decl: DECL } });
		await waitFor(() =>
			expect(screen.getByTestId("entity-row-post-type-weekly")).toBeTruthy(),
		);

		await fireEvent.click(screen.getByTestId("entity-edit-post-type-weekly"));
		await waitFor(() =>
			expect(screen.getByTestId("entity-form-modal-post-type")).toBeTruthy(),
		);
		expect(screen.getByTestId("entity-form-slug-readonly").textContent).toBe(
			"weekly",
		);
		const nameInput = screen.getByTestId("entity-input-name") as HTMLInputElement;
		expect(nameInput.value).toBe("Weekly");
	});

	test("clicking Delete calls the API and reloads", async () => {
		const calls: Array<{ url: string; method: string }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				const method = (init?.method ?? "GET").toUpperCase();
				calls.push({ url, method });
				if (method === "DELETE") {
					return new Response(JSON.stringify({ deleted: true }), {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				}
				// First GET → 1 row; subsequent GETs → 0 rows.
				const items =
					calls.filter((c) => c.method === "GET").length === 1
						? [{ slug: "weekly", data: { name: "Weekly", cadence: "weekly" } }]
						: [];
				return new Response(JSON.stringify({ items }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}),
		);

		render(EntityTable, { props: { extensionId: "ext-1", decl: DECL } });
		await waitFor(() =>
			expect(screen.getByTestId("entity-row-post-type-weekly")).toBeTruthy(),
		);

		await fireEvent.click(screen.getByTestId("entity-delete-post-type-weekly"));
		await waitFor(() =>
			expect(screen.getByTestId("entity-empty-post-type")).toBeTruthy(),
		);
		const deleteCalls = calls.filter((c) => c.method === "DELETE");
		expect(deleteCalls.length).toBe(1);
		expect(deleteCalls[0]!.url).toContain("/entities/post-type/weekly");
	});

	test("create button opens an empty modal", async () => {
		vi.stubGlobal(
			"fetch",
			makeFetchStub([
				{
					method: "GET",
					match: "/entities/post-type",
					respond: () => ({ status: 200, body: { items: [] } }),
				},
			]),
		);
		render(EntityTable, { props: { extensionId: "ext-1", decl: DECL } });
		await waitFor(() =>
			expect(screen.getByTestId("entity-create-post-type")).toBeTruthy(),
		);
		await fireEvent.click(screen.getByTestId("entity-create-post-type"));
		await waitFor(() =>
			expect(screen.getByTestId("entity-form-modal-post-type")).toBeTruthy(),
		);
		const slugInput = screen.getByTestId("entity-form-slug") as HTMLInputElement;
		expect(slugInput.value).toBe("");
	});
});
