import { test, expect } from "./fixtures/test-base.js";
import { makeAgent } from "./fixtures/data.js";

/**
 * Set up all API mocks in a single handler, with an optional delayed path.
 * The delayed path will wait before responding, allowing skeleton states to be visible.
 */
async function setupRoutesWithDelay(
	page: import("@playwright/test").Page,
	opts: { delayPath: string; delayMs: number; delayJson: unknown },
) {
	// Also mock WebSocket to prevent connection errors
	await page.addInitScript(() => {
		const fakeWs = {
			readyState: 1,
			send() {},
			close() {},
			addEventListener() {},
			removeEventListener() {},
			set onopen(_: any) {},
			set onmessage(_: any) {},
			set onclose(_: any) {},
			set onerror(_: any) {},
		};
		(window as any).WebSocket = () => fakeWs;
		(window as any).WebSocket.CONNECTING = 0;
		(window as any).WebSocket.OPEN = 1;
		(window as any).WebSocket.CLOSING = 2;
		(window as any).WebSocket.CLOSED = 3;
	});

	await page.route("**/api/**", async (route) => {
		const url = new URL(route.request().url());
		const path = url.pathname;

		// If this is the path we want to delay, wait first then fulfill
		if (path === opts.delayPath) {
			await new Promise((r) => setTimeout(r, opts.delayMs));
			return route.fulfill({ json: opts.delayJson });
		}

		// Instant responses for everything else
		if (path === "/api/projects") return route.fulfill({ json: [] });
		if (path === "/api/conversations") return route.fulfill({ json: [] });
		if (path === "/api/providers") return route.fulfill({ json: [] });
		if (path === "/api/settings") return route.fulfill({ json: {} });
		if (path === "/api/agents") return route.fulfill({ json: [] });
		if (path === "/api/extensions") return route.fulfill({ json: [] });
		if (path === "/api/tools") return route.fulfill({ json: { tools: [], count: 0 } });
		if (path === "/api/auth/me") return route.fulfill({ json: { user: { id: "u1", email: "a@b.com", name: "Test", role: "member" } } });
		if (path === "/api/account") return route.fulfill({ json: { id: "u1", email: "a@b.com", name: "Test", role: "member", createdAt: "2026-01-01T00:00:00.000Z" } });
		if (path === "/api/favicon") return route.fulfill({ json: { icon: "" } });
		if (path === "/api/fs/list") return route.fulfill({ json: [] });
		if (path === "/api/mentions/search") return route.fulfill({ json: [] });
		return route.fulfill({ json: {} });
	});
}

test.describe("SkeletonLoader", () => {
	test("Agents page shows card-grid skeleton while loading", async ({ page }) => {
		await setupRoutesWithDelay(page, {
			delayPath: "/api/agents",
			delayMs: 1000,
			delayJson: [],
		});
		await page.goto("/agents");

		const skeletonLines = page.locator(".skeleton-line");
		await expect(skeletonLines.first()).toBeVisible();
		// card-grid with count=6 produces 6 cards with 3 skeleton lines each
		expect(await skeletonLines.count()).toBeGreaterThanOrEqual(6);
	});

	test("Agents page hides skeleton after data loads", async ({ page }) => {
		await setupRoutesWithDelay(page, {
			delayPath: "/api/agents",
			delayMs: 500,
			delayJson: [makeAgent({ name: "test-agent" })],
		});
		await page.goto("/agents");

		// Skeleton visible during loading
		await expect(page.locator(".skeleton-line").first()).toBeVisible();

		// After data loads, skeleton disappears and content appears
		await expect(page.getByText("test-agent")).toBeVisible({ timeout: 5000 });
		await expect(page.locator(".skeleton-line")).toHaveCount(0);
	});

	test("Settings page shows form skeleton while loading", async ({ page }) => {
		await setupRoutesWithDelay(page, {
			delayPath: "/api/auth/me",
			delayMs: 1000,
			delayJson: { user: { id: "u1", email: "a@b.com", name: "Test", role: "member" } },
		});
		await page.goto("/settings");

		const skeletonLines = page.locator(".skeleton-line");
		await expect(skeletonLines.first()).toBeVisible();
		// form type renders 4 groups with 2 lines each
		expect(await skeletonLines.count()).toBeGreaterThanOrEqual(4);
	});

	test("Extensions page shows card-grid skeleton while loading", async ({ page }) => {
		await setupRoutesWithDelay(page, {
			delayPath: "/api/extensions",
			delayMs: 1000,
			delayJson: [],
		});
		await page.goto("/extensions");

		const skeletonLines = page.locator(".skeleton-line");
		await expect(skeletonLines.first()).toBeVisible();
		expect(await skeletonLines.count()).toBeGreaterThanOrEqual(6);
	});

	test("Account page shows form skeleton while loading", async ({ page }) => {
		await setupRoutesWithDelay(page, {
			delayPath: "/api/account",
			delayMs: 1000,
			delayJson: { id: "u1", email: "a@b.com", name: "Test", role: "member", createdAt: "2026-01-01T00:00:00.000Z" },
		});
		await page.goto("/account");

		const skeletonLines = page.locator(".skeleton-line");
		await expect(skeletonLines.first()).toBeVisible();
		expect(await skeletonLines.count()).toBeGreaterThanOrEqual(4);
	});
});
