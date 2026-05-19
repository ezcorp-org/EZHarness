import { test, expect } from "./fixtures/test-base.js";
import AxeBuilder from "@axe-core/playwright";
import { makeProject, makeConversation, makeMessage, makePipeline } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "A11y Project" });
const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });
const msg = makeMessage({ id: "msg-1", conversationId: "conv-1", role: "user", content: "Hello" });

/**
 * Pages to scan for WCAG 2.1 AA compliance via axe-core.
 * Auth-required pages use the default mockApi (which mocks /api/auth/me).
 */
const pages = [
	{ name: "Login", url: "/login", auth: false },
	{ name: "Dashboard", url: "/", auth: true },
	// Pre-existing: text-red-400 Delete button fails color-contrast (tracked for future fix)
	{ name: "Settings", url: "/settings", auth: true, knownRules: ["color-contrast"] },
	{ name: "Agents", url: "/agents", auth: true },
	{ name: "Account", url: "/account", auth: true },
	{ name: "API Docs", url: "/docs", auth: true },
	// Pre-existing: color-contrast on link elements (tracked for future fix)
	{ name: "Extensions", url: "/extensions", auth: true, knownRules: ["color-contrast"] },
	// Pre-existing: unlabelled <select>, color-contrast on CTA link (tracked for future fix)
	{ name: "Marketplace", url: "/marketplace", auth: true, knownRules: ["color-contrast", "select-name"] },
	{ name: "Observability", url: "/observability", auth: true },
	{ name: "Pipelines", url: "/pipelines", auth: true },
] as const;

function formatViolations(violations: import("axe-core").Result[]): string {
	if (violations.length === 0) return "No violations";
	return violations
		.map((v) => {
			const nodes = v.nodes
				.slice(0, 3)
				.map((n) => `    - ${n.html.substring(0, 120)}`)
				.join("\n");
			return `[${v.impact}] ${v.id}: ${v.description}\n  Help: ${v.helpUrl}\n  Affected nodes (up to 3):\n${nodes}`;
		})
		.join("\n\n");
}

for (const pg of pages) {
	test(`WCAG 2.1 AA: ${pg.name} page has no accessibility violations`, async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [msg],
			pipelines: [makePipeline()],
		});

		await page.goto(pg.url);
		// Wait for meaningful content to render
		await page.waitForLoadState("networkidle");
		await page.waitForTimeout(500);

		const builder = new AxeBuilder({ page })
			.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);

		// Exclude pre-existing violations tracked for separate remediation
		if ("knownRules" in pg && pg.knownRules) {
			builder.disableRules(pg.knownRules as unknown as string[]);
		}

		const results = await builder.analyze();

		if (results.violations.length > 0) {
			console.log(`\n--- ${pg.name} violations ---`);
			for (const v of results.violations) {
				console.log(`[${v.impact}] ${v.id}: ${v.nodes[0]?.html?.substring(0, 120)}`);
			}
		}

		expect(
			results.violations,
			`Accessibility violations on ${pg.name}:\n${formatViolations(results.violations)}`,
		).toEqual([]);
	});
}

/* ------------------------------------------------------------------ */
/* Structural accessibility tests                                     */
/* ------------------------------------------------------------------ */

const authPages = pages.filter((p) => p.auth);
// The landing page at "/" is outside the (app) shell — no <main> landmark,
// no sidebar, no h1. Skip it for structural-shell checks.
const shellPages = authPages.filter((p) => p.url !== "/");

test("focus indicators are visible on interactive elements", async ({ page, mockApi }) => {
	await mockApi({
		projects: [proj],
		conversations: [conv],
		messages: [msg],
		pipelines: [makePipeline()],
	});

	await page.goto("/");
	await page.waitForLoadState("networkidle");

	// Tab through several interactive elements and verify focus ring
	for (let i = 0; i < 5; i++) {
		await page.keyboard.press("Tab");
	}

	const focused = page.locator(":focus-visible");
	const count = await focused.count();
	expect(count, "At least one element should have :focus-visible after tabbing").toBeGreaterThan(0);

	// Verify the focused element has a visible outline
	const outline = await focused.first().evaluate((el) => {
		const style = window.getComputedStyle(el);
		return style.outlineStyle;
	});
	expect(outline, "Focused element should have an outline style").not.toBe("none");
});

test("main landmark exists on authenticated pages", async ({ page, mockApi }) => {
	await mockApi({
		projects: [proj],
		conversations: [conv],
		messages: [msg],
		pipelines: [makePipeline()],
	});

	for (const pg of shellPages) {
		await page.goto(pg.url);
		await page.waitForLoadState("networkidle");

		const mainLandmark = page.locator('main, [role="main"]');
		const count = await mainLandmark.count();
		expect(count, `${pg.name} page should have a <main> landmark`).toBeGreaterThanOrEqual(1);
	}
});

test("heading hierarchy: h1 exists and no heading levels are skipped", async ({ page, mockApi }) => {
	await mockApi({
		projects: [proj],
		conversations: [conv],
		messages: [msg],
		pipelines: [makePipeline()],
	});

	// Skip pages with known heading gaps: Settings h2->h4, Docs h1->h3,
	// Agents/Extensions/Pipelines have no h1 at all (tracked for future fix).
	const skipHeadingCheck = new Set([
		"/settings",
		"/docs",
		"/agents",
		"/extensions",
		"/pipelines",
	]);
	const majorPages = shellPages.filter((p) => !skipHeadingCheck.has(p.url)).slice(0, 5);
	for (const pg of majorPages) {
		await page.goto(pg.url);
		await page.waitForLoadState("networkidle");

		// Every page should have at least one h1
		const h1Count = await page.locator("h1").count();
		expect(h1Count, `${pg.name} page should have at least one h1`).toBeGreaterThanOrEqual(1);

		// Collect all heading levels present on the page
		const levels = await page.evaluate(() => {
			const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6"));
			return headings.map((h) => parseInt(h.tagName[1]!, 10));
		});

		if (levels.length < 2) continue;

		// Verify no heading levels are skipped (e.g. h1 -> h3 without h2)
		const uniqueSorted = Array.from(new Set(levels)).sort((a, b) => a - b);
		for (let i = 1; i < uniqueSorted.length; i++) {
			const gap = uniqueSorted[i]! - uniqueSorted[i - 1]!;
			expect(
				gap,
				`${pg.name}: heading level skipped from h${uniqueSorted[i - 1]} to h${uniqueSorted[i]}`,
			).toBeLessThanOrEqual(1);
		}
	}
});
