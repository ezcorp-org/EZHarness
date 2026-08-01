/**
 * Settings left-nav: STICKY while the settings content scrolls, and its OWN
 * scroll container once the menu outgrows the viewport.
 *
 * The nav column lives inside the app shell's scroll container
 * (`<main class="overflow-y-auto">` in `(app)/+layout.svelte`), so "sticky"
 * here means pinned to the top of THAT element, not the window. The two
 * behaviours are asserted separately:
 *
 *   1. Page scrolls → the "Settings" heading leaves the shell viewport while
 *      the nav column stays on screen, parked at the shell's 24px `p-6` gutter.
 *   2. Menu too tall → the nav LIST scrolls internally (its own scrollbar),
 *      the column never grows past the shell viewport, and the search box
 *      above the list does not move when the list scrolls.
 *
 * The viewport is deliberately SHORT (420px) and the user is an ADMIN (all ten
 * nav entries render): both make the overflow real rather than dependent on
 * how tall a given settings page happens to be.
 */
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "Test Project" });

const adminMe = {
	user: { id: "admin-1", email: "admin@test.local", name: "Admin", role: "admin" },
};

/** Admin sees every nav entry, and `/settings/admin` is a tall page to scroll. */
const adminRoutes = {
	"/api/auth/me": () => adminMe,
	"/api/users": () => ({
		users: [
			{ id: "member-1", email: "member@test.local", name: "Member", role: "member", status: "active" },
		],
	}),
	"/api/admin/sessions": () => ({ sessions: [] }),
	"/api/teams": () => ({ teams: [] }),
	"/api/auth/invite": () => ({ invites: [] }),
	"/api/audit-log": () => ({ entries: [], total: 0 }),
	"/api/health": () => ({
		status: "healthy",
		db: { status: "up" },
		embeddings: { status: "ready" },
		providers: {},
	}),
};

test.describe("settings nav — sticky + self-scrolling", () => {
	// Short enough that ten nav entries cannot fit — forces both scrolls.
	test.use({ viewport: { width: 1280, height: 420 } });

	test("nav column stays pinned while the settings content scrolls past it", async ({
		page,
		mockApi,
		isMobile,
	}) => {
		test.skip(isMobile, "the sticky column is the md+ two-column layout");
		await mockApi({ projects: [proj], routes: adminRoutes });
		await page.goto("/settings/admin");

		const main = page.locator("main");
		const column = page.getByTestId("settings-nav-column");
		const heading = page.getByRole("heading", { name: "Settings", level: 1 });

		await expect(column).toBeVisible();
		await expect(heading).toBeVisible();
		expect(await column.evaluate((el) => getComputedStyle(el).position)).toBe("sticky");

		const mainBox = (await main.boundingBox())!;

		// Scroll the shell container to the bottom — and prove it really moved,
		// so the assertions below can't pass on an unscrolled page.
		await main.evaluate((el) => {
			el.scrollTop = el.scrollHeight;
		});
		expect(await main.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

		// The page heading scrolled up and out of the shell viewport...
		const headingBox = (await heading.boundingBox())!;
		expect(headingBox.y).toBeLessThan(mainBox.y);

		// ...while the nav column stayed on screen, pinned at the 24px gutter.
		const columnBox = (await column.boundingBox())!;
		expect(columnBox.y).toBeGreaterThan(mainBox.y + 20);
		expect(columnBox.y).toBeLessThan(mainBox.y + 28);
		await expect(page.getByTestId("settings-nav-models")).toBeVisible();
	});

	test("nav list scrolls in its own container; the search box above it stays put", async ({
		page,
		mockApi,
		isMobile,
	}) => {
		test.skip(isMobile, "the sticky column is the md+ two-column layout");
		await mockApi({ projects: [proj], routes: adminRoutes });
		await page.goto("/settings/admin");

		const main = page.locator("main");
		const column = page.getByTestId("settings-nav-column");
		const nav = page.getByTestId("settings-nav");
		const search = page.getByTestId("settings-nav-search");

		await expect(nav).toBeVisible();

		// Pin the column before measuring. At scroll 0 the shell's breadcrumb
		// bar still occupies the top of the container, so the column starts
		// that much lower; one scroll tick in — where a sticky column actually
		// lives — it sits at the 24px gutter. The viewport-fit contract is
		// about that pinned state.
		await main.evaluate((el) => {
			el.scrollTop = el.scrollHeight;
		});
		expect(await main.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

		// The list is its own scroller and the menu genuinely overflows it.
		const metrics = await nav.evaluate((el) => ({
			overflowY: getComputedStyle(el).overflowY,
			scrollHeight: el.scrollHeight,
			clientHeight: el.clientHeight,
		}));
		expect(metrics.overflowY).toBe("auto");
		expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);

		// The column is capped to the shell viewport rather than overflowing it.
		const mainBox = (await main.boundingBox())!;
		const columnBox = (await column.boundingBox())!;
		expect(columnBox.height).toBeLessThan(mainBox.height);
		expect(columnBox.y + columnBox.height).toBeLessThanOrEqual(mainBox.y + mainBox.height + 1);

		// Scrolling the list moves the LIST only: the search box is unmoved and
		// the last entry becomes reachable.
		const searchBefore = (await search.boundingBox())!;
		await nav.evaluate((el) => {
			el.scrollTop = el.scrollHeight;
		});
		expect(await nav.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
		const searchAfter = (await search.boundingBox())!;
		expect(Math.abs(searchAfter.y - searchBefore.y)).toBeLessThanOrEqual(1);
		await expect(page.getByTestId("settings-nav-moderation")).toBeInViewport();
	});

	test("pinned nav and its inner scroll render for visual evidence @evidence", async ({
		page,
		mockApi,
		isMobile,
	}, testInfo) => {
		test.skip(isMobile, "the sticky column is the md+ two-column layout");
		await mockApi({ projects: [proj], routes: adminRoutes });
		await page.goto("/settings/admin");

		const main = page.locator("main");
		const nav = page.getByTestId("settings-nav");
		await expect(page.getByTestId("settings-nav-column")).toBeVisible();

		await main.evaluate((el) => {
			el.scrollTop = el.scrollHeight;
		});
		expect(await main.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
		await captureEvidence(page, testInfo, "settings-nav-pinned-after-scroll");

		await nav.evaluate((el) => {
			el.scrollTop = el.scrollHeight;
		});
		expect(await nav.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
		await captureEvidence(page, testInfo, "settings-nav-inner-scroll");

		if (process.env.EZCORP_E2E_EVIDENCE === "1") {
			expect(
				testInfo.attachments.some(
					(a) => a.name === "settings-nav-pinned-after-scroll" && a.contentType === "image/png",
				),
			).toBe(true);
			expect(
				testInfo.attachments.some(
					(a) => a.name === "settings-nav-inner-scroll" && a.contentType === "image/png",
				),
			).toBe(true);
		} else {
			expect(
				testInfo.attachments.some((a) => a.name === "settings-nav-pinned-after-scroll"),
			).toBe(false);
		}
	});
});

test.describe("settings nav — everyday viewport", () => {
	// A normal laptop viewport: the menu fits, so the only visible behaviour is
	// the column holding its place while a long settings page scrolls past.
	test.use({ viewport: { width: 1280, height: 800 } });

	test("nav holds its place on a full-height window @evidence", async ({
		page,
		mockApi,
		isMobile,
	}, testInfo) => {
		test.skip(isMobile, "the sticky column is the md+ two-column layout");
		await mockApi({ projects: [proj], routes: adminRoutes });
		await page.goto("/settings/admin");

		const main = page.locator("main");
		const column = page.getByTestId("settings-nav-column");
		await expect(column).toBeVisible();
		await captureEvidence(page, testInfo, "settings-nav-top-of-page");

		await main.evaluate((el) => {
			el.scrollTop = el.scrollHeight;
		});
		expect(await main.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

		// Menu fits, so nothing inside it scrolls — it simply stayed put.
		const navMetrics = await page.getByTestId("settings-nav").evaluate((el) => ({
			scrollHeight: el.scrollHeight,
			clientHeight: el.clientHeight,
		}));
		expect(navMetrics.scrollHeight).toBeLessThanOrEqual(navMetrics.clientHeight);

		const mainBox = (await main.boundingBox())!;
		const columnBox = (await column.boundingBox())!;
		expect(columnBox.y).toBeGreaterThan(mainBox.y + 20);
		expect(columnBox.y).toBeLessThan(mainBox.y + 28);
		expect(columnBox.y + columnBox.height).toBeLessThanOrEqual(mainBox.y + mainBox.height + 1);
		await captureEvidence(page, testInfo, "settings-nav-pinned-full-height");

		if (process.env.EZCORP_E2E_EVIDENCE === "1") {
			expect(
				testInfo.attachments.some(
					(a) => a.name === "settings-nav-pinned-full-height" && a.contentType === "image/png",
				),
			).toBe(true);
		} else {
			expect(testInfo.attachments.some((a) => a.name === "settings-nav-top-of-page")).toBe(false);
		}
	});
});
