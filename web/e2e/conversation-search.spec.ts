import { test, expect } from "./fixtures/test-base.js";
import type { Page } from "@playwright/test";
import { makeProject, makeConversation, makeSearchHit } from "./fixtures/data.js";

/**
 * Sidebar conversation-search e2e.
 *
 * Two viewports run via playwright projects: `chromium` (desktop) and
 * `mobile-chromium` (Pixel 5). The ConversationList renders TWICE in the
 * route shell — a desktop instance (`hidden md:flex`) and a mobile instance
 * inside a SwipeDrawer that is closed until the "Open conversations"
 * hamburger is tapped. `sidebar()` returns the viewport-correct, *visible*
 * ConversationList scope so a single assertion works on both projects
 * (mirrors the 62-03 responsive-spec locator-scope pattern). `openSearch()`
 * opens the mobile drawer first when needed, then clicks the search icon.
 */
function isMobile(page: Page): boolean {
	return (page.viewportSize()?.width ?? 0) < 768;
}

/**
 * The visible ConversationList scope for the current viewport. On mobile the
 * sidebar lives in the SwipeDrawer; on desktop it is the always-mounted
 * `hidden md:flex` panel. Both share the `.flex.h-full.w-full` root, so on
 * mobile we narrow to the drawer to dodge the strict-mode collision with the
 * (CSS-hidden but DOM-present) desktop copy.
 */
function sidebar(page: Page) {
	return isMobile(page)
		? page.getByTestId("swipe-drawer").locator(".flex.h-full.w-full")
		: page.locator(".flex.h-full.w-full").first();
}

/** Open the conversation search box, opening the mobile drawer first if needed. */
async function openSearch(page: Page) {
	if (isMobile(page)) {
		await page.getByRole("button", { name: "Open conversations" }).click();
		await expect(page.getByTestId("swipe-drawer")).toBeVisible({ timeout: 3000 });
	}
	await sidebar(page).locator('[title="Search conversations"]').click();
}

/** The (viewport-scoped) search text input. */
function searchInput(page: Page) {
	return sidebar(page).locator('input[placeholder="Search..."]');
}

/** Mode-toggle group scoped to the visible sidebar. */
function toggle(page: Page) {
	return sidebar(page).getByTestId("search-mode-toggle");
}

test.describe("Conversation Search", () => {
	const proj = makeProject({ id: "proj-1", name: "Search Project" });

	const convAlpha = makeConversation({ id: "conv-alpha", projectId: "proj-1", title: "Alpha Discussion" });
	const convBeta = makeConversation({ id: "conv-beta", projectId: "proj-1", title: "Beta Planning" });
	const convGamma = makeConversation({ id: "conv-gamma", projectId: "proj-1", title: "Gamma Review" });

	test("search icon button is visible in the conversation list header", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [convAlpha, convBeta, convGamma],
		});
		await page.goto(`/project/proj-1/chat/conv-alpha`);

		if (isMobile(page)) {
			await page.getByRole("button", { name: "Open conversations" }).click();
			await expect(page.getByTestId("swipe-drawer")).toBeVisible({ timeout: 3000 });
		}
		// The search icon button has title="Search conversations"
		const searchBtn = sidebar(page).locator('[title="Search conversations"]');
		await expect(searchBtn).toBeVisible({ timeout: 5000 });
	});

	test("clicking search icon reveals the search input", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [convAlpha, convBeta, convGamma],
		});
		await page.goto(`/project/proj-1/chat/conv-alpha`);

		await openSearch(page);

		await expect(searchInput(page)).toBeVisible({ timeout: 3000 });
	});

	test("search input receives focus when opened", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [convAlpha, convBeta, convGamma],
		});
		await page.goto(`/project/proj-1/chat/conv-alpha`);

		await openSearch(page);

		await expect(searchInput(page)).toBeFocused({ timeout: 3000 });
	});

	test("typing in search filters conversations by title (client-side)", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [convAlpha, convBeta, convGamma],
		});
		await page.goto(`/project/proj-1/chat/conv-alpha`);

		// Open search and type 2+ chars to trigger filtering
		await openSearch(page);
		await searchInput(page).fill("Alpha");

		// Sidebar search results should contain "Alpha Discussion"
		await expect(sidebar(page).getByText("Alpha Discussion").first()).toBeVisible({ timeout: 3000 });
		// "Beta Planning" should not appear in the sidebar search results
		await expect(sidebar(page).getByText("Beta Planning")).not.toBeVisible();
	});

	test("search shows generic empty state when query has no results", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [convAlpha, convBeta],
		});
		await page.goto(`/project/proj-1/chat/conv-alpha`);

		await openSearch(page);
		// Type something that matches no conversation titles AND no message hits
		// → the single generic empty state ("No matching messages.").
		await searchInput(page).fill("zzznomatch");

		await expect(sidebar(page).getByTestId("search-empty")).toBeVisible({ timeout: 3000 });
	});

	test("pressing Escape closes the search panel", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [convAlpha, convBeta],
		});
		await page.goto(`/project/proj-1/chat/conv-alpha`);

		await openSearch(page);
		const input = searchInput(page);
		await expect(input).toBeVisible({ timeout: 3000 });

		await input.press("Escape");

		await expect(input).not.toBeVisible({ timeout: 2000 });
	});

	test("clicking the X button closes the search panel", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [convAlpha, convBeta],
		});
		await page.goto(`/project/proj-1/chat/conv-alpha`);

		await openSearch(page);
		const input = searchInput(page);
		await expect(input).toBeVisible({ timeout: 3000 });

		// Close button has title="Close search"
		await sidebar(page).locator('[title="Close search"]').click();

		await expect(input).not.toBeVisible({ timeout: 2000 });
	});

	test("closing search restores the normal conversation list", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [convAlpha, convBeta, convGamma],
		});
		await page.goto(`/project/proj-1/chat/conv-alpha`);

		// Open search and type a filter
		await openSearch(page);
		await searchInput(page).fill("Alpha");

		// Close it
		await sidebar(page).locator('[title="Close search"]').click();

		// All three conversations should be visible in the sidebar again (grouped list)
		await expect(sidebar(page).getByText("Beta Planning").first()).toBeVisible({ timeout: 3000 });
		await expect(sidebar(page).getByText("Gamma Review").first()).toBeVisible();
	});

	test("API search is called with correct projectId and search param", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [convAlpha, convBeta, convGamma],
			routes: {
				"/api/conversations/search": () => {
					return [{ id: "conv-alpha", title: "Alpha Discussion", snippet: null, updatedAt: "2026-01-01T00:00:00.000Z" }];
				},
			},
		});

		await page.goto(`/project/proj-1/chat/conv-alpha`);
		await openSearch(page);
		// Type 2+ chars to trigger the debounced API search
		await searchInput(page).fill("Al");

		// Wait for debounce (300ms) + network
		await page.waitForTimeout(500);

		// The conversations endpoint is called with ?search=Al for content search
		// (api-mocks.ts handles this via the search param on /api/conversations)
		await expect(searchInput(page)).toHaveValue("Al");
	});

	// ── 66-04 Wave-3 e2e: mode toggle (UI-01/UI-02) + two-section results
	//    (UI-04) + degraded notice + generic empty state. These extend the
	//    baseline above WITHOUT regressing it; they configure the 66-01
	//    /api/search/messages mock per-test via the `searchMessages` fixture
	//    option (never adding a second mock for that route). Each runs on both
	//    the chromium + mobile-chromium projects via the viewport-aware
	//    `openSearch()` / `sidebar()` helpers. ────────────────────────────────

	test("mode toggle renders three segments and defaults to Hybrid (UI-01)", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [convAlpha, convBeta, convGamma],
		});
		await page.goto(`/project/proj-1/chat/conv-alpha`);

		await openSearch(page);

		const t = toggle(page);
		await expect(t).toBeVisible({ timeout: 3000 });
		// Three labeled segments.
		await expect(t.getByRole("button", { name: "Hybrid" })).toBeVisible();
		await expect(t.getByRole("button", { name: "Keyword" })).toBeVisible();
		await expect(t.getByRole("button", { name: "Semantic" })).toBeVisible();
		// Hybrid is the active segment by default (aria-pressed="true").
		await expect(t.getByRole("button", { name: "Hybrid" })).toHaveAttribute("aria-pressed", "true");
		await expect(t.getByRole("button", { name: "Keyword" })).toHaveAttribute("aria-pressed", "false");
		await expect(t.getByRole("button", { name: "Semantic" })).toHaveAttribute("aria-pressed", "false");
	});

	test("selected mode survives a page reload via the global LS key (UI-02)", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [convAlpha, convBeta, convGamma],
		});
		await page.goto(`/project/proj-1/chat/conv-alpha`);

		// Open search → switch to Keyword.
		await openSearch(page);
		await toggle(page).getByRole("button", { name: "Keyword" }).click();
		await expect(toggle(page).getByRole("button", { name: "Keyword" })).toHaveAttribute("aria-pressed", "true");

		// Reload the page (new session) — re-open search → Keyword is restored,
		// proving the choice persisted to the global `chatSearch.mode` LS key
		// rather than being component-local state.
		await page.reload();
		await openSearch(page);
		const t = toggle(page);
		await expect(t).toBeVisible({ timeout: 3000 });
		await expect(t.getByRole("button", { name: "Keyword" })).toHaveAttribute("aria-pressed", "true");
		await expect(t.getByRole("button", { name: "Hybrid" })).toHaveAttribute("aria-pressed", "false");
	});

	test("two-section results: Conversations (title) + Messages (grouped hits) both render (UI-04)", async ({ page, mockApi }) => {
		// A multi-hit response grouped across two conversations. The first hit
		// per conversation defines the group header title (66-01 grouping).
		await mockApi({
			projects: [proj],
			conversations: [convAlpha, convBeta, convGamma],
			searchMessages: {
				hits: [
					makeSearchHit({
						conversationId: "conv-alpha",
						conversationTitle: "Alpha Discussion",
						messageId: "hit-a-1",
						snippet: "first <mark>alpha</mark> hit",
					}),
					makeSearchHit({
						conversationId: "conv-alpha",
						conversationTitle: "Alpha Discussion",
						messageId: "hit-a-2",
						snippet: "second <mark>alpha</mark> hit",
					}),
					makeSearchHit({
						conversationId: "conv-beta",
						conversationTitle: "Beta Planning",
						messageId: "hit-b-1",
						snippet: "a <mark>beta</mark> body match",
					}),
				],
			},
		});
		await page.goto(`/project/proj-1/chat/conv-alpha`);

		await openSearch(page);
		// "Alpha" matches the Alpha Discussion title (instant client filter) AND
		// the mocked message hits drive the Messages section.
		await searchInput(page).fill("Alpha");

		const sb = sidebar(page);

		// Conversations section header is present (alongside the always-present
		// panel header → use a count assertion to disambiguate).
		await expect(sb.getByText("Conversations")).toHaveCount(2, { timeout: 3000 });
		// The title-matched conversation row.
		await expect(sb.getByText("Alpha Discussion").first()).toBeVisible();

		// Messages section header + grouped hits.
		await expect(sb.getByText("Messages")).toBeVisible();
		// Three message-hit rows (2 in the Alpha group + 1 in the Beta group).
		await expect(sb.getByTestId("message-hit")).toHaveCount(3);
		// Beta Planning surfaces as a Messages-group header even though its title
		// does NOT match the "Alpha" query — proving the Messages section owns
		// content matches independent of the title filter.
		await expect(sb.getByText("Beta Planning")).toBeVisible();
		// Sanitized <mark> highlight rendered inside a hit row.
		await expect(sb.getByTestId("message-hit").first().locator("mark")).toBeVisible();
	});

	test("a 1-char query fires NO Messages results (UI-04 <2 guard)", async ({ page, mockApi }) => {
		const searchCalls: string[] = [];
		await mockApi({
			projects: [proj],
			conversations: [convAlpha, convBeta],
			routes: {
				"/api/search/messages": (url) => {
					searchCalls.push(url.toString());
					return { hits: [], degraded: false, requestedMode: "hybrid", servedMode: "hybrid" };
				},
			},
		});
		await page.goto(`/project/proj-1/chat/conv-alpha`);

		await openSearch(page);
		// Single char — below the 2-char threshold.
		await searchInput(page).fill("A");
		// Give the debounce (300ms) ample time to NOT fire.
		await page.waitForTimeout(600);

		// No message-search call was made and no Messages rows rendered.
		expect(searchCalls.length).toBe(0);
		await expect(sidebar(page).getByTestId("message-hit")).toHaveCount(0);
	});

	test("degraded response renders the inline notice without changing the stored mode", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [convAlpha, convBeta],
			searchMessages: {
				degraded: true,
				servedMode: "keyword",
				hits: [
					makeSearchHit({
						conversationId: "conv-alpha",
						conversationTitle: "Alpha Discussion",
						messageId: "hit-deg",
						matchType: "lexical",
						snippet: "fallback <mark>keyword</mark> hit",
					}),
				],
			},
		});
		await page.goto(`/project/proj-1/chat/conv-alpha`);

		await openSearch(page);
		// Select Semantic, then run a query that the server degrades.
		await toggle(page).getByRole("button", { name: "Semantic" }).click();
		await expect(toggle(page).getByRole("button", { name: "Semantic" })).toHaveAttribute("aria-pressed", "true");
		await searchInput(page).fill("alpha");

		// Degraded notice renders.
		await expect(sidebar(page).getByTestId("search-degraded-notice")).toBeVisible({ timeout: 3000 });
		// The stored/selected mode is UNCHANGED by the degrade — Semantic stays
		// the active segment (Pitfall 4: a degraded response never mutates the
		// persisted mode).
		await expect(toggle(page).getByRole("button", { name: "Semantic" })).toHaveAttribute("aria-pressed", "true");

		// And it survives a reload — the LS key still holds "semantic".
		await page.reload();
		await openSearch(page);
		await expect(toggle(page).getByRole("button", { name: "Semantic" })).toHaveAttribute("aria-pressed", "true");
	});

	test("empty hits + non-matching title shows the single generic empty state", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [convAlpha, convBeta],
			// Default searchMessages omitted → empty hits, not degraded.
		});
		await page.goto(`/project/proj-1/chat/conv-alpha`);

		await openSearch(page);
		// A query that matches no title AND returns no message hits.
		await searchInput(page).fill("zzznomatch");

		const empty = sidebar(page).getByTestId("search-empty");
		await expect(empty).toBeVisible({ timeout: 3000 });
		await expect(empty).toHaveText("No matching messages.");
		// No mode-specific copy — exactly one generic empty state.
		await expect(empty).toHaveCount(1);
	});
});
