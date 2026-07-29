// re-evidence 2026-07-22: a covered surface changed in feat/hub-project-pages
// (per-project hub pages + ECF control plane); this touch triggers the visual
// evidence pipeline to re-capture this spec's screenshots for PR review.
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

const STORAGE_KEY = "ezcorp-last-path";
const THEME_KEY = "ezcorp-theme";

const proj = makeProject({ id: "proj-1", name: "Resume Project" });
const conv1 = makeConversation({ id: "conv-1", projectId: "proj-1", title: "First Chat" });
const msg = makeMessage({ id: "msg-1", conversationId: "conv-1", role: "user", content: "Hello" });

/** Set a localStorage value from the current page. The origin is stable across
 *  the root redirect, so this works even after `/` has navigated away. */
async function setLs(page: import("@playwright/test").Page, key: string, value: string) {
	await page.evaluate(([k, v]) => localStorage.setItem(k, v), [key, value] as const);
}

test.describe("Resume last path", () => {
	test("saves the last path to localStorage on navigation", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.goto(`/project/${proj.id}/chat`);

		// `afterNavigate` fires after hydration — poll until the save lands.
		await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), STORAGE_KEY)).toBe(`/project/${proj.id}/chat`);
	});

	test("never saves the root path", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.goto(`/project/${proj.id}/chat`);
		await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), STORAGE_KEY)).toBe(`/project/${proj.id}/chat`);

		await page.goto("/");
		await page.waitForTimeout(300);
		const saved = await page.evaluate((k) => localStorage.getItem(k), STORAGE_KEY);
		expect(saved).not.toBe("/");
	});

	test("opening / resumes directly to the exact last conversation (one hop)", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj], conversations: [conv1], messages: [msg] });
		await page.goto("/");
		await setLs(page, STORAGE_KEY, `/project/${proj.id}/chat/conv-1`);

		await page.goto("/");
		await page.waitForURL("**/chat/conv-1", { timeout: 7000 });
		await expect(page).toHaveURL(/\/project\/proj-1\/chat\/conv-1/);
	});

	test("resumes to a non-project route too (e.g. /hub)", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.route("**/api/hub/pages", (route) => route.fulfill({ json: { pages: [] } }));
		await page.goto("/");
		await setLs(page, STORAGE_KEY, "/hub");

		await page.goto("/");
		await page.waitForURL("**/hub", { timeout: 7000 });
		await expect(page).toHaveURL(/\/hub$/);
	});

	test("falls back to global chat when the saved project no longer exists", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj], conversations: [] });
		await page.goto("/");
		await setLs(page, STORAGE_KEY, "/project/deleted-proj/chat/conv-x");

		await page.goto("/");
		await page.waitForURL("**/project/global/chat", { timeout: 7000 });
		await expect(page).toHaveURL(/\/project\/global\/chat/);
	});

	test("mobile: / resumes to the conversation, not the list", async ({ page, mockApi }) => {
		await page.setViewportSize({ width: 375, height: 667 });
		await mockApi({ projects: [proj], conversations: [conv1], messages: [msg] });
		await page.goto("/");
		await setLs(page, STORAGE_KEY, `/project/${proj.id}/chat/conv-1`);

		await page.goto("/");
		await page.waitForURL("**/chat/conv-1", { timeout: 7000 });
		await expect(page).toHaveURL(/\/chat\/conv-1/);
	});

	test("splash background is theme-aware on reopen @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({ projects: [proj], conversations: [conv1], messages: [msg] });

		// Light theme → white splash background.
		await page.goto("/");
		await setLs(page, STORAGE_KEY, `/project/${proj.id}/chat/conv-1`);
		await setLs(page, THEME_KEY, "light");
		await page.goto("/");
		await page.waitForURL("**/chat/conv-1", { timeout: 7000 });
		const lightBg = await page.evaluate(() =>
			getComputedStyle(document.documentElement).getPropertyValue("--splash-bg").trim(),
		);
		expect(lightBg).toBe("#ffffff");
		await captureEvidence(page, testInfo, "resume-light");

		// Dark theme → dark splash background.
		await setLs(page, THEME_KEY, "dark");
		await page.goto("/");
		await page.waitForURL("**/chat/conv-1", { timeout: 7000 });
		const darkBg = await page.evaluate(() =>
			getComputedStyle(document.documentElement).getPropertyValue("--splash-bg").trim(),
		);
		expect(darkBg).toBe("#111827");
		await captureEvidence(page, testInfo, "resume-dark");

		// captureEvidence is a hard no-op unless EZCORP_E2E_EVIDENCE=1.
		if (process.env.EZCORP_E2E_EVIDENCE === "1") {
			expect(
				testInfo.attachments.some(
					(a) => a.name === "resume-dark" && a.contentType === "image/png",
				),
			).toBe(true);
		} else {
			expect(testInfo.attachments.some((a) => a.name === "resume-dark")).toBe(false);
		}
	});
});
