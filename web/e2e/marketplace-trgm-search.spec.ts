/**
 * Marketplace search UI contract.
 *
 * The browser owns the request and the rendered result order. PostgreSQL owns
 * the short-query policy, typo recall, and trigram ranking; those contracts run
 * against the real query in `query-aux-marketplace-trgm.test.ts` and
 * `marketplace-search-perf.test.ts`. Mocked browser data must not claim it
 * proves that database behavior.
 */

import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";
import type { MockOverrides } from "./fixtures/api-mocks.js";
import type { Page } from "@playwright/test";

type Listing = {
	id: string;
	name: string;
	description: string;
	category: string;
	latestVersion: string;
	authorId: string;
	authorName: string;
	agentConfigId: null;
	installCount: number;
	ratingPositive: number;
	ratingTotal: number;
	ratingPercent: number;
	status: "active";
	tags: string[];
	createdAt: string;
	updatedAt: string;
};

function listing(id: string, name: string): Listing {
	return {
		id,
		name,
		description: `${name} marketplace listing`,
		category: "Development",
		latestVersion: "1.0.0",
		authorId: "author-1",
		authorName: "Marketplace Author",
		agentConfigId: null,
		installCount: 10,
		ratingPositive: 9,
		ratingTotal: 10,
		ratingPercent: 90,
		status: "active",
		tags: ["development"],
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

const browseListings = [listing("alpha", "Alpha Agent"), listing("gamma", "Gamma Agent")];
const searchResponses: Record<string, Listing[]> = {
	iphne: [listing("iphone", "iPhone Assistant")],
	g: browseListings,
	gi: browseListings,
	git: [listing("github", "GitHub Code Reviewer"), listing("gitlab", "GitLab Sync")],
};

test.describe("Marketplace search UI", () => {
	const project = makeProject({ id: "marketplace-project" });

	async function setup({ page, mockApi }: { page: Page; mockApi: (overrides?: MockOverrides) => Promise<void> }) {
		const queries: string[] = [];
		await mockApi({
			projects: [project],
			routes: {
				"/api/marketplace": (url) => {
					const query = url.searchParams.get("q") ?? "";
					queries.push(query);
					return { listings: searchResponses[query] ?? browseListings, featured: [] };
				},
			},
		});
		await page.goto("/marketplace");
		await expect(page.getByRole("link", { name: /Alpha Agent/ })).toBeVisible();
		return queries;
	}

	async function search(page: Page, query: string) {
		const response = page.waitForResponse((candidate) => {
			const url = new URL(candidate.url());
			return url.pathname === "/api/marketplace" && url.searchParams.get("q") === query;
		});
		await page.getByPlaceholder("Search agents...").fill(query);
		await response;
	}

	test("sends a typo query and renders the API recall result", async ({ page, mockApi }) => {
		const queries = await setup({ page, mockApi });

		await search(page, "iphne");

		expect(queries).toContain("iphne");
		await expect(page.getByRole("link", { name: /iPhone Assistant/ })).toBeVisible();
		await expect(page.getByRole("link", { name: /Alpha Agent/ })).toHaveCount(0);
	});

	test("renders the one-character browse response in API order", async ({ page, mockApi }) => {
		const queries = await setup({ page, mockApi });

		await search(page, "g");

		expect(queries).toContain("g");
		const cards = page.getByRole("link").filter({ hasText: /Alpha Agent|Gamma Agent/ });
		await expect(cards).toHaveCount(2);
		const names = await cards.allTextContents();
		expect(names).toEqual([
			expect.stringContaining("Alpha Agent"),
			expect.stringContaining("Gamma Agent"),
		]);
	});

	test("renders the two-character browse response in API order", async ({ page, mockApi }) => {
		const queries = await setup({ page, mockApi });

		await search(page, "gi");

		expect(queries).toContain("gi");
		const cards = page.getByRole("link").filter({ hasText: /Alpha Agent|Gamma Agent/ });
		await expect(cards).toHaveCount(2);
		await expect(cards.nth(0)).toContainText("Alpha Agent");
		await expect(cards.nth(1)).toContainText("Gamma Agent");
	});

	test("renders a three-character search response in API order", async ({ page, mockApi }) => {
		const queries = await setup({ page, mockApi });

		await search(page, "git");

		expect(queries).toContain("git");
		const cards = page.getByRole("link").filter({ hasText: /GitHub Code Reviewer|GitLab Sync/ });
		await expect(cards).toHaveCount(2);
		await expect(cards.nth(0)).toContainText("GitHub Code Reviewer");
		await expect(cards.nth(1)).toContainText("GitLab Sync");
	});
});
