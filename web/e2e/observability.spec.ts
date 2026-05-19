import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const makeObsStats = (overrides: Record<string, unknown> = {}) => ({
	totalInputTokens: 12500,
	totalOutputTokens: 8300,
	totalToolCalls: 47,
	totalTurnCount: 23,
	avgResponseMs: 1840,
	tokensByDay: [
		{ date: "2026-03-20", input: 2000, output: 1500 },
		{ date: "2026-03-21", input: 3000, output: 2000 },
		{ date: "2026-03-22", input: 2500, output: 1800 },
	],
	topExtensions: [
		{ extensionId: "file-reader", callCount: 30, successRate: 97, avgDurationMs: 120 },
		{ extensionId: "code-runner", callCount: 17, successRate: 88, avgDurationMs: 540 },
	],
	...overrides,
});

test.describe("Observability Page", () => {
	const proj = makeProject({ id: "proj-1", name: "Obs Project" });

	test("page loads and shows Observability heading", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: {
				"/api/observability": () => makeObsStats(),
			},
		});
		await page.goto("/observability");

		await expect(page.getByRole("heading", { name: "Observability" })).toBeVisible({ timeout: 5000 });
	});

	test("page shows all four summary stat cards", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: {
				"/api/observability": () => makeObsStats(),
			},
		});
		await page.goto("/observability");

		await expect(page.getByText("Total Tokens")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Tool Calls")).toBeVisible();
		await expect(page.getByText("Turns")).toBeVisible();
		await expect(page.getByText("Avg Response")).toBeVisible();
	});

	test("token counts are formatted and displayed correctly", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: {
				"/api/observability": () => makeObsStats({
					totalInputTokens: 12500,
					totalOutputTokens: 8300,
				}),
			},
		});
		await page.goto("/observability");

		// 12500 + 8300 = 20800 -> "20.8K"
		await expect(page.getByText("20.8K")).toBeVisible({ timeout: 5000 });
	});

	test("tool call count is displayed", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: {
				"/api/observability": () => makeObsStats({ totalToolCalls: 47 }),
			},
		});
		await page.goto("/observability");

		await expect(page.getByText("47")).toBeVisible({ timeout: 5000 });
	});

	test("avg response time is formatted with ms suffix", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: {
				"/api/observability": () => makeObsStats({ avgResponseMs: 840 }),
			},
		});
		await page.goto("/observability");

		await expect(page.getByText("840ms")).toBeVisible({ timeout: 5000 });
	});

	test("avg response time over 1 second uses seconds suffix", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: {
				"/api/observability": () => makeObsStats({ avgResponseMs: 2500 }),
			},
		});
		await page.goto("/observability");

		await expect(page.getByText("2.5s")).toBeVisible({ timeout: 5000 });
	});

	test("token usage chart section is shown when data exists", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: {
				"/api/observability": () => makeObsStats(),
			},
		});
		await page.goto("/observability");

		await expect(page.getByText("Token Usage by Day")).toBeVisible({ timeout: 5000 });
	});

	test("top extensions table is shown when data exists", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: {
				"/api/observability": () => makeObsStats(),
			},
		});
		await page.goto("/observability");

		await expect(page.getByText("Top Extensions")).toBeVisible({ timeout: 5000 });
		// Table headers — scope to table to avoid ambiguous matches
		const table = page.locator("table");
		await expect(table.getByRole("columnheader", { name: "Extension" })).toBeVisible();
		await expect(table.getByRole("columnheader", { name: "Calls" })).toBeVisible();
		await expect(table.getByRole("columnheader", { name: "Success Rate" })).toBeVisible();
		await expect(table.getByRole("columnheader", { name: "Avg Duration" })).toBeVisible();
	});

	test("extension rows show correct data", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: {
				"/api/observability": () => makeObsStats(),
			},
		});
		await page.goto("/observability");

		await expect(page.getByText("file-reader")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("code-runner")).toBeVisible();
	});

	test("range filter buttons are visible (7d, 30d, 90d)", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: {
				"/api/observability": () => makeObsStats(),
			},
		});
		await page.goto("/observability");

		await expect(page.getByRole("button", { name: "7d" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole("button", { name: "30d" })).toBeVisible();
		await expect(page.getByRole("button", { name: "90d" })).toBeVisible();
	});

	test("30d range filter is active by default", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: {
				"/api/observability": () => makeObsStats(),
			},
		});
		await page.goto("/observability");

		const btn30d = page.getByRole("button", { name: "30d" });
		await expect(btn30d).toBeVisible({ timeout: 5000 });
		// Active button has blue background class
		await expect(btn30d).toHaveClass(/bg-blue-600/);
	});

	test("clicking 7d range triggers new API request with days=7", async ({ page, mockApi }) => {
		const requests: string[] = [];

		await mockApi({
			projects: [proj],
			routes: {
				"/api/observability": (url) => {
					requests.push(url.search);
					return makeObsStats();
				},
			},
		});
		await page.goto("/observability");

		// Wait for initial load
		await expect(page.getByText("Total Tokens")).toBeVisible({ timeout: 5000 });
		requests.length = 0;

		await page.getByRole("button", { name: "7d" }).click();
		await page.waitForTimeout(300);

		const last = requests.find((r) => r.includes("days=7"));
		expect(last).toBeTruthy();
	});

	test("clicking 90d range triggers new API request with days=90", async ({ page, mockApi }) => {
		const requests: string[] = [];

		await mockApi({
			projects: [proj],
			routes: {
				"/api/observability": (url) => {
					requests.push(url.search);
					return makeObsStats();
				},
			},
		});
		await page.goto("/observability");

		await expect(page.getByText("Total Tokens")).toBeVisible({ timeout: 5000 });
		requests.length = 0;

		await page.getByRole("button", { name: "90d" }).click();
		await page.waitForTimeout(300);

		const last = requests.find((r) => r.includes("days=90"));
		expect(last).toBeTruthy();
	});

	test("shows empty state when no usage data", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: {
				"/api/observability": () => makeObsStats({
					totalInputTokens: 0,
					totalOutputTokens: 0,
					totalToolCalls: 0,
					totalTurnCount: 0,
					avgResponseMs: 0,
					tokensByDay: [],
					topExtensions: [],
				}),
			},
		});
		await page.goto("/observability");

		await expect(page.getByText("No observability data yet")).toBeVisible({ timeout: 5000 });
	});

	test("shows loading state before data arrives", async ({ page, mockApi }) => {
		// Delay the response so we can catch the loading state
		await page.route("**/api/observability**", async (route) => {
			await new Promise((r) => setTimeout(r, 1500));
			await route.fulfill({ json: makeObsStats() });
		});
		await mockApi({ projects: [proj] });
		await page.goto("/observability");

		await expect(page.getByText("Loading...")).toBeVisible({ timeout: 3000 });
	});

	test("shows error message when API request fails", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		// Added AFTER mockApi — Playwright LIFO means this specific route wins
		// over the **/api/** catch-all in setupApiMocks
		await page.route("**/api/observability**", (route) => {
			route.fulfill({ status: 500, body: "Internal Server Error" });
		});
		await page.goto("/observability");

		// Wait for both onMount and $effect fetches to complete (the page makes 2 calls)
		await expect(page.locator(".text-red-300")).toBeVisible({ timeout: 8000 });
	});

	// ── Token Usage by Day chart rendering (regression: chart was empty) ──

	test("token usage chart is hidden when tokensByDay is empty", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: {
				"/api/observability": () => makeObsStats({ tokensByDay: [] }),
			},
		});
		await page.goto("/observability");

		// Other sections still render, but the chart heading is absent
		await expect(page.getByText("Total Tokens")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Token Usage by Day")).toHaveCount(0);
	});

	test("token usage chart renders one bar per day in the response", async ({ page, mockApi }) => {
		const days = [
			{ date: "2026-04-17", input: 1000, output: 500 },
			{ date: "2026-04-18", input: 2000, output: 1500 },
			{ date: "2026-04-19", input: 500, output: 2500 },
		];
		await mockApi({
			projects: [proj],
			routes: {
				"/api/observability": () => makeObsStats({ tokensByDay: days }),
			},
		});
		await page.goto("/observability");

		await expect(page.getByText("Token Usage by Day")).toBeVisible({ timeout: 5000 });

		// The chart renders bars inside the section under the "Token Usage by Day" heading.
		const chart = page.locator('div:has(> h2:has-text("Token Usage by Day")) > div.flex.items-end');
		await expect(chart).toBeVisible();

		// Each day → one bar group. Non-zero tokens → inline height: N% (N > 0), not 0%.
		const bars = chart.locator(":scope > div > div.w-full");
		await expect(bars).toHaveCount(days.length);

		const styles = await bars.evaluateAll((els) => els.map((el) => (el as HTMLElement).getAttribute("style") ?? ""));
		expect(styles).toHaveLength(3);
		for (const style of styles) {
			const match = style.match(/height:\s*([\d.]+)%/);
			expect(match).not.toBeNull();
			expect(parseFloat(match![1]!)).toBeGreaterThan(0);
		}

		// Hover tooltip surfaces the date + formatted counts for the tallest bar.
		await bars.nth(1).hover();
		await expect(page.getByText("2026-04-18")).toBeVisible();
	});

	test("bars reflect input/output ratio via gradient cutoff", async ({ page, mockApi }) => {
		// 80% input / 20% output — the gradient stop should be at 80%.
		const days = [{ date: "2026-04-19", input: 800, output: 200 }];
		await mockApi({
			projects: [proj],
			routes: {
				"/api/observability": () => makeObsStats({ tokensByDay: days }),
			},
		});
		await page.goto("/observability");

		await expect(page.getByText("Token Usage by Day")).toBeVisible({ timeout: 5000 });
		const bar = page
			.locator('div:has(> h2:has-text("Token Usage by Day")) > div.flex.items-end')
			.locator(":scope > div > div.w-full")
			.first();
		const style = await bar.getAttribute("style");
		// Browsers may normalize hex to rgb() — match either form at the 80% stop.
		const inputStop = /(#3b82f6|rgb\(\s*59,\s*130,\s*246\s*\))\s+80%/i;
		const outputStop = /(#60a5fa|rgb\(\s*96,\s*165,\s*250\s*\))\s+80%/i;
		expect(style).toMatch(inputStop);
		expect(style).toMatch(outputStop);
	});
});
