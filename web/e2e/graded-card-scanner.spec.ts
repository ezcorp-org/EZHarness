/**
 * Graded Card Scanner — e2e for the extension-served scanner SPA.
 *
 * The SPA ships as static files served by the extension data route
 * (`/api/extensions/graded-card-scanner/data/app/…`). The route handler
 * itself is covered by its own suite; this spec fulfills those URLs from
 * the checked-in `docs/extensions/examples/graded-card-scanner/app/`
 * files, so it drives the REAL page a phone gets, deterministically:
 *
 *   - the CDN (ZXing) and backend (`/api/tool-invoke`) are blocked, so
 *     the spec exercises the spec-mandated zero-network mock mode;
 *   - scans are driven through the page's deterministic simulate hook
 *     (`window.__gcsSimulateScan`), the same path the Simulate button uses;
 *   - IndexedDB persistence is asserted across a reload.
 *
 * The `@evidence` test satisfies the Visual evidence gate; captures are
 * a hard no-op unless EZCORP_E2E_EVIDENCE=1 (mirrors extensions-sort.spec).
 */
import { readFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { test, expect, captureEvidence } from "./fixtures/test-base.js";

const APP_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"docs",
	"extensions",
	"examples",
	"graded-card-scanner",
	"app",
);
const BASE = "/api/extensions/graded-card-scanner/data/app";

const MIME: Record<string, string> = {
	html: "text/html; charset=utf-8",
	js: "application/javascript; charset=utf-8",
	css: "text/css; charset=utf-8",
};

/** Serve the SPA from disk; make the backend unreachable (mock mode). */
async function serveApp(page: Page): Promise<void> {
	await page.route(`**${BASE}/**`, async (route) => {
		const { pathname } = new URL(route.request().url());
		const rel = pathname.slice(pathname.indexOf(BASE) + BASE.length + 1);
		const target = normalize(join(APP_DIR, rel));
		if (!target.startsWith(APP_DIR + sep)) return route.fulfill({ status: 404 });
		try {
			const body = await readFile(target);
			const ext = target.slice(target.lastIndexOf(".") + 1);
			return route.fulfill({
				status: 200,
				contentType: MIME[ext] ?? "application/octet-stream",
				body,
			});
		} catch {
			return route.fulfill({ status: 404 });
		}
	});
	// Backend absent → the app must fall back to mock mode.
	await page.route("**/api/conversations", (route) =>
		route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
	);
	await page.route("**/api/tool-invoke", (route) =>
		route.fulfill({
			status: 503,
			contentType: "application/json",
			body: JSON.stringify({ success: false, error: "backend down" }),
		}),
	);
	// No CDN in CI — ZXing load fails fast; camera is an enhancement only.
	await page.route("https://cdn.jsdelivr.net/**", (route) => route.abort());
}

/** Drive a scan through the page's deterministic hook. */
function simulate(page: Page, text: string): Promise<void> {
	return page.evaluate(
		(t) => (window as unknown as { __gcsSimulateScan: (s: string) => Promise<void> }).__gcsSimulateScan(t),
		text,
	);
}

test.describe("Graded Card Scanner SPA", () => {
	test.beforeEach(async ({ page }) => {
		await serveApp(page);
		await page.goto(`${BASE}/index.html`);
	});

	test("scan → list → detail → chart works with zero network, and captures evidence @evidence", async ({
		page,
	}, testInfo) => {
		await simulate(page, "49392223");

		// One capture: pending row lands, resolves to done via mock fallback.
		await expect(page.getByTestId("gcs-row")).toHaveCount(1);
		await expect(page.getByTestId("gcs-status-chip")).toHaveText("done");
		await expect(page.getByTestId("gcs-mock-banner")).toBeVisible();
		await expect(page.getByTestId("gcs-count")).toHaveText("1");
		await expect(page.getByTestId("gcs-row")).toContainText("Charizard");
		await captureEvidence(page, testInfo, "graded-card-scanner-list");

		// Detail view.
		await page.getByTestId("gcs-row").click();
		await expect(page.getByTestId("gcs-detail")).toBeVisible();
		await expect(page.getByTestId("gcs-detail-title")).toHaveText(
			"1999 Pokemon Base Set Charizard #4",
		);
		const rows = page.getByTestId("gcs-grade-table").locator("tbody tr");
		await expect(rows).toHaveCount(10);
		// Scanned grade highlighted; lowest priced grade has no lower comparator.
		await expect(page.locator(".gcs-tr-scanned")).toContainText("PSA 9");
		await expect(rows.first()).toContainText("—");
		// Chart renders both panels with the scanned bar marked.
		const chart = page.getByTestId("gcs-chart").locator("svg");
		await expect(chart).toBeVisible();
		await expect(chart.locator("rect.gcs-bar")).toHaveCount(10);
		await expect(chart.locator(".gcs-bar-scanned")).toHaveCount(1);
		// Source + fetch time per value, mock-stamped.
		await expect(page.getByTestId("gcs-sources")).toContainText("identity: mock");
		await captureEvidence(page, testInfo, "graded-card-scanner-detail");

		// Fetch fresh is briefly disabled after use (anti-spam).
		await page.getByTestId("gcs-fetch-fresh").click();
		await expect(page.getByTestId("gcs-fetch-fresh")).toBeDisabled();

		// Capture contract (mirrors visual-evidence.spec) — meaningful in
		// both modes rather than a bare screenshot call.
		if (process.env.EZCORP_E2E_EVIDENCE === "1") {
			expect(
				testInfo.attachments.some(
					(a) => a.name === "graded-card-scanner-list" && a.contentType === "image/png",
				),
			).toBe(true);
		} else {
			expect(
				testInfo.attachments.some((a) => a.name === "graded-card-scanner-list"),
			).toBe(false);
		}
	});

	test("dedupes repeat scans, parses QR URLs, and persists across reload", async ({
		page,
	}) => {
		await simulate(page, "49392223");
		await expect(page.getByTestId("gcs-row")).toHaveCount(1);

		// Same cert inside the ~8s cooldown window → silently ignored (the
		// per-frame dedupe gate; a slab in frame decodes many times a second).
		await simulate(page, "49392223");
		await expect(page.getByTestId("gcs-row")).toHaveCount(1);
		await expect(page.getByTestId("gcs-count")).toHaveText("1");

		// A modern slab's QR payload (psacard.com URL) via manual entry.
		await page.getByTestId("gcs-manual-input").fill("https://www.psacard.com/cert/12345678");
		await page.getByTestId("gcs-manual-add").click();
		await expect(page.getByTestId("gcs-row")).toHaveCount(2);

		// Garbage input is rejected with a message, not saved.
		await page.getByTestId("gcs-manual-input").fill("not-a-cert");
		await page.getByTestId("gcs-manual-add").click();
		await expect(page.getByTestId("gcs-status")).toContainText("Not a PSA cert");
		await expect(page.getByTestId("gcs-row")).toHaveCount(2);

		// Saved list survives reload (IndexedDB).
		await page.goto(`${BASE}/index.html`);
		await expect(page.getByTestId("gcs-row")).toHaveCount(2);

		// Post-reload the in-page gate is fresh but the DB still knows the
		// cert → the "already scanned" path: no new row, no lookup, count 0.
		await simulate(page, "49392223");
		await expect(page.getByTestId("gcs-status")).toContainText("already scanned");
		await expect(page.getByTestId("gcs-row")).toHaveCount(2);
		await expect(page.getByTestId("gcs-count")).toHaveText("0");

		// Search filters the list.
		await page.getByTestId("gcs-search").fill("12345678");
		await expect(page.getByTestId("gcs-row")).toHaveCount(1);
		await page.getByTestId("gcs-search").fill("zzz-no-match");
		await expect(page.getByTestId("gcs-row")).toHaveCount(0);
		await expect(page.getByTestId("gcs-empty")).toBeVisible();
	});

	test("delete one card, then clear all with confirm", async ({ page }) => {
		await simulate(page, "49392223");
		await simulate(page, "87654321");
		await expect(page.getByTestId("gcs-row")).toHaveCount(2);

		await page.getByTestId("gcs-delete").first().click();
		await expect(page.getByTestId("gcs-row")).toHaveCount(1);

		page.on("dialog", (dialog) => dialog.accept());
		await page.getByTestId("gcs-clear-all").click();
		await expect(page.getByTestId("gcs-row")).toHaveCount(0);
		await expect(page.getByTestId("gcs-empty")).toBeVisible();
	});
});
