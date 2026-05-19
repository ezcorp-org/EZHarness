/**
 * E2E coverage for the favicon + document.title unread badge.
 *
 * Companion to the pure-logic tests in `web/src/lib/favicon-badge.test.ts`
 * and the jsdom DOM tests in
 * `web/src/lib/__tests__/favicon-badge.component.test.ts`. Those verify the
 * title transform and the canvas/observer wiring in isolation; this spec
 * verifies the end-to-end behaviour in a real browser: the badge reflects the
 * shared `unreadStore`, the favicon becomes a canvas data URL when there are
 * unread completed chats, and opening a chat (markRead) decrements it.
 *
 * Strategy mirrors `project-rail-unread-badge.spec.ts`: seed the unread
 * store's localStorage key before navigation, land on a neutral conversation
 * that is NOT in the seed (so its markRead-on-mount doesn't perturb counts),
 * and assert on the document title + the managed `#ez-favicon` link.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation } from "./fixtures/data.js";

const STORAGE_KEY = "ez-unread-conversations";
const NEUTRAL_CONV_ID = "neutral-conv";

// Robust to the dev-indicator "DEV " prefix — assert the count token appears,
// not that the title starts with it.
const countToken = (n: number) => new RegExp(`\\(${n}\\) `);

test.describe("favicon + title unread badge", () => {
	test("title shows the unread count and the favicon becomes a data URL", async ({
		page,
		mockApi,
	}) => {
		await page.addInitScript(({ key }) => {
			localStorage.setItem(
				key,
				JSON.stringify({
					"conv-a1": "proj-a",
					"conv-a2": "proj-a",
					"conv-a3": "proj-a",
				}),
			);
		}, { key: STORAGE_KEY });

		await mockApi({
			projects: [makeProject({ id: "proj-a", name: "Alpha" })],
			conversations: [
				makeConversation({
					id: NEUTRAL_CONV_ID,
					projectId: "proj-a",
					title: "Neutral",
				}),
			],
		});
		await page.goto(`/project/proj-a/chat/${NEUTRAL_CONV_ID}`);

		// Anchor: the rail badge proves the store loaded + layout mounted.
		await expect(
			page.locator(
				'[data-testid="project-unread-badge"][data-project-id="proj-a"]',
			),
		).toHaveText("3");

		await expect.poll(async () => await page.title()).toMatch(countToken(3));
		await expect(page.locator("#ez-favicon")).toHaveAttribute(
			"href",
			/^data:image\/png/,
		);

		// The visible-favicon guarantee: app.html's competing static icon
		// links must be gone, leaving ours as the only one the browser can
		// render (a 3rd appended link does NOT override Chrome otherwise).
		await expect.poll(async () =>
			page.evaluate(
				() => document.querySelectorAll('link[rel~="icon"]').length,
			),
		).toBe(1);
		await expect.poll(async () =>
			page.evaluate(() => {
				const l = document.querySelector('link[rel~="icon"]');
				return l ? l.id : null;
			}),
		).toBe("ez-favicon");
	});

	test("no unread → no count in the title and the plain favicon", async ({
		page,
		mockApi,
	}) => {
		await mockApi({
			projects: [makeProject({ id: "proj-a", name: "Alpha" })],
			conversations: [
				makeConversation({
					id: NEUTRAL_CONV_ID,
					projectId: "proj-a",
					title: "Neutral",
				}),
			],
		});
		await page.goto(`/project/proj-a/chat/${NEUTRAL_CONV_ID}`);

		// No global unread → no Home badge (confirms app mounted, store empty).
		await expect(
			page.locator('[data-testid="project-unread-badge-home"]'),
		).toHaveCount(0);

		expect(await page.title()).not.toMatch(/\(\d+\) /);
		await expect(page.locator("#ez-favicon")).toHaveAttribute(
			"href",
			/\/favicon(-dev)?-192\.png$/,
		);
	});

	test("opening an unread chat decrements the title count", async ({
		page,
		mockApi,
	}) => {
		// addInitScript runs on every navigation — guard so only the first
		// seeds, otherwise markRead progress would be masked.
		await page.addInitScript(({ key, payload }) => {
			if (localStorage.getItem(key) === null) {
				localStorage.setItem(key, payload);
			}
		}, {
			key: STORAGE_KEY,
			payload: JSON.stringify({
				"conv-a1": "proj-a",
				"conv-a2": "proj-a",
			}),
		});

		await mockApi({
			projects: [makeProject({ id: "proj-a", name: "Alpha" })],
			conversations: [
				makeConversation({
					id: "conv-a1",
					projectId: "proj-a",
					title: "First",
				}),
				makeConversation({
					id: "conv-a2",
					projectId: "proj-a",
					title: "Second",
				}),
				makeConversation({
					id: NEUTRAL_CONV_ID,
					projectId: "proj-a",
					title: "Neutral",
				}),
			],
		});

		await page.goto(`/project/proj-a/chat/${NEUTRAL_CONV_ID}`);
		await expect.poll(async () => await page.title()).toMatch(countToken(2));

		// Opening conv-a1 calls markRead → store shrinks → badge re-decorates.
		await page.goto("/project/proj-a/chat/conv-a1");
		await expect.poll(async () => await page.title()).toMatch(countToken(1));

		await page.goto("/project/proj-a/chat/conv-a2");
		await expect.poll(async () => await page.title()).not.toMatch(/\(\d+\) /);
	});
});
