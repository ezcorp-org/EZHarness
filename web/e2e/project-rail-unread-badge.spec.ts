/**
 * E2E coverage for the per-project unread badge in `ProjectRail.svelte`.
 *
 * Companion to the unit tests in `web/src/lib/unread.test.ts` and the
 * routing test in `stores-run-complete-unread.test.ts`. Those verify the
 * store API and the run:complete → markUnread wiring; this spec verifies
 * the rendering side: that ProjectRail reads the store correctly, the
 * Home badge counts only the `global` project (the regression we just
 * fixed), and that opening a conversation (which calls markRead) updates
 * the badge.
 *
 * Strategy:
 *   - Seed localStorage with the unread store's persistence format
 *     before navigation. The store reads from that key on init.
 *   - Land on a chat-detail URL pointing at a "neutral" conversation that
 *     is NOT in the unread seed — opening it triggers markRead for that
 *     id, but doesn't perturb the counts we're asserting on.
 *   - The chat-LIST URL `/project/[id]/chat` auto-redirects to the most
 *     recent conv (calling markRead on it), so we avoid that path for
 *     the rendering checks. Test #4 uses it intentionally to verify the
 *     markRead-on-mount behavior end-to-end.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation } from "./fixtures/data.js";

const STORAGE_KEY = "ez-unread-conversations";

// A conversation that is never in any seed — used as a neutral landing target
// so the chat page mounts and renders the rail without altering unread counts.
const NEUTRAL_CONV_ID = "neutral-conv";

test.describe("ProjectRail unread badges", () => {
	test("each project icon shows its own unread count and Home shows only global", async ({ page, mockApi }) => {
		// Seed unread state before the page loads — the store reads
		// localStorage on module init.
		await page.addInitScript(({ key }) => {
			localStorage.setItem(key, JSON.stringify({
				"conv-a1": "proj-a",
				"conv-a2": "proj-a",
				"conv-b1": "proj-b",
				"conv-home": "global",
			}));
		}, { key: STORAGE_KEY });

		await mockApi({
			projects: [
				makeProject({ id: "proj-a", name: "Alpha" }),
				makeProject({ id: "proj-b", name: "Beta" }),
			],
			conversations: [makeConversation({ id: NEUTRAL_CONV_ID, projectId: "proj-a", title: "Neutral" })],
		});
		await page.goto(`/project/proj-a/chat/${NEUTRAL_CONV_ID}`);

		// Per-project badges
		const badgeA = page.locator('[data-testid="project-unread-badge"][data-project-id="proj-a"]');
		const badgeB = page.locator('[data-testid="project-unread-badge"][data-project-id="proj-b"]');
		await expect(badgeA).toHaveText("2");
		await expect(badgeB).toHaveText("1");

		// Home badge counts ONLY conversations whose projectId is "global" — not the total.
		// Regression: previously this used getTotalUnreadCount() and showed 4.
		const homeBadge = page.locator('[data-testid="project-unread-badge-home"]');
		await expect(homeBadge).toHaveText("1");
	});

	test("project with zero unread conversations renders no badge", async ({ page, mockApi }) => {
		await page.addInitScript(({ key }) => {
			localStorage.setItem(key, JSON.stringify({
				"conv-a1": "proj-a",
			}));
		}, { key: STORAGE_KEY });

		await mockApi({
			projects: [
				makeProject({ id: "proj-a", name: "Alpha" }),
				makeProject({ id: "proj-b", name: "Beta" }),
			],
			conversations: [makeConversation({ id: NEUTRAL_CONV_ID, projectId: "proj-a", title: "Neutral" })],
		});
		await page.goto(`/project/proj-a/chat/${NEUTRAL_CONV_ID}`);

		// proj-a shows badge
		await expect(page.locator('[data-testid="project-unread-badge"][data-project-id="proj-a"]')).toHaveText("1");
		// proj-b has no unread → no badge
		await expect(page.locator('[data-testid="project-unread-badge"][data-project-id="proj-b"]')).toHaveCount(0);
		// No global unread → no Home badge
		await expect(page.locator('[data-testid="project-unread-badge-home"]')).toHaveCount(0);
	});

	test("counts above 99 render as '99+'", async ({ page, mockApi }) => {
		// Generate 150 unread convs all under proj-a
		const big: Record<string, string> = {};
		for (let i = 0; i < 150; i++) big[`conv-${i}`] = "proj-a";

		await page.addInitScript(({ key, payload }) => {
			localStorage.setItem(key, payload);
		}, { key: STORAGE_KEY, payload: JSON.stringify(big) });

		await mockApi({
			projects: [makeProject({ id: "proj-a", name: "Alpha" })],
			conversations: [makeConversation({ id: NEUTRAL_CONV_ID, projectId: "proj-a", title: "Neutral" })],
		});
		await page.goto(`/project/proj-a/chat/${NEUTRAL_CONV_ID}`);

		await expect(page.locator('[data-testid="project-unread-badge"][data-project-id="proj-a"]')).toHaveText("99+");
	});

	test("landing on a conversation decrements that project's badge (markRead on mount)", async ({ page, mockApi }) => {
		await page.addInitScript(({ key }) => {
			localStorage.setItem(key, JSON.stringify({
				"conv-a1": "proj-a",
				"conv-a2": "proj-a",
			}));
		}, { key: STORAGE_KEY });

		await mockApi({
			projects: [makeProject({ id: "proj-a", name: "Alpha" })],
			conversations: [
				makeConversation({ id: "conv-a1", projectId: "proj-a", title: "First" }),
				makeConversation({ id: "conv-a2", projectId: "proj-a", title: "Second" }),
			],
		});

		// Direct landing on conv-a1 — mount effect calls markRead("conv-a1")
		await page.goto("/project/proj-a/chat/conv-a1");
		await expect(page.locator('[data-testid="project-unread-badge"][data-project-id="proj-a"]')).toHaveText("1");
	});

	test("landing on the only unread conversation clears the badge entirely", async ({ page, mockApi }) => {
		await page.addInitScript(({ key }) => {
			localStorage.setItem(key, JSON.stringify({
				"conv-a1": "proj-a",
			}));
		}, { key: STORAGE_KEY });

		await mockApi({
			projects: [makeProject({ id: "proj-a", name: "Alpha" })],
			conversations: [makeConversation({ id: "conv-a1", projectId: "proj-a", title: "First" })],
		});

		await page.goto("/project/proj-a/chat/conv-a1");
		// Badge gone — only entry was just markRead'd on mount.
		await expect(page.locator('[data-testid="project-unread-badge"][data-project-id="proj-a"]')).toHaveCount(0);
	});

	test("opening multiple conversations in sequence each decrement the badge", async ({ page, mockApi }) => {
		// `addInitScript` runs on EVERY navigation, so a naive
		// `localStorage.setItem(...)` would re-seed on every goto and mask
		// markRead progress. Guard with a presence check so only the first
		// navigation seeds, and subsequent navigations leave the state alone.
		await page.addInitScript(({ key, payload }) => {
			if (localStorage.getItem(key) === null) {
				localStorage.setItem(key, payload);
			}
		}, {
			key: STORAGE_KEY,
			payload: JSON.stringify({
				"conv-a1": "proj-a",
				"conv-a2": "proj-a",
				"conv-a3": "proj-a",
			}),
		});

		await mockApi({
			projects: [makeProject({ id: "proj-a", name: "Alpha" })],
			conversations: [
				makeConversation({ id: "conv-a1", projectId: "proj-a", title: "First" }),
				makeConversation({ id: "conv-a2", projectId: "proj-a", title: "Second" }),
				makeConversation({ id: "conv-a3", projectId: "proj-a", title: "Third" }),
				makeConversation({ id: NEUTRAL_CONV_ID, projectId: "proj-a", title: "Neutral" }),
			],
		});

		const badge = page.locator('[data-testid="project-unread-badge"][data-project-id="proj-a"]');

		await page.goto(`/project/proj-a/chat/${NEUTRAL_CONV_ID}`);
		await expect(badge).toHaveText("3");

		await page.goto("/project/proj-a/chat/conv-a1");
		await expect(badge).toHaveText("2");

		await page.goto("/project/proj-a/chat/conv-a2");
		await expect(badge).toHaveText("1");

		await page.goto("/project/proj-a/chat/conv-a3");
		await expect(badge).toHaveCount(0);
	});

	test("legacy localStorage format (string array) still loads as unattributed unread", async ({ page, mockApi }) => {
		// Pre-feature builds wrote `string[]`. The store's loader migrates these
		// to projectId=null entries — counted in total but not under any project.
		await page.addInitScript(({ key }) => {
			localStorage.setItem(key, JSON.stringify(["conv-legacy-1", "conv-legacy-2"]));
		}, { key: STORAGE_KEY });

		await mockApi({
			projects: [makeProject({ id: "proj-a", name: "Alpha" })],
			conversations: [makeConversation({ id: NEUTRAL_CONV_ID, projectId: "proj-a", title: "Neutral" })],
		});
		await page.goto(`/project/proj-a/chat/${NEUTRAL_CONV_ID}`);

		// No project badge (entries have null projectId)
		await expect(page.locator('[data-testid="project-unread-badge"][data-project-id="proj-a"]')).toHaveCount(0);
		// Home badge also zero (those entries aren't attributed to "global")
		await expect(page.locator('[data-testid="project-unread-badge-home"]')).toHaveCount(0);
	});
});
