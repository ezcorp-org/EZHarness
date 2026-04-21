import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation } from "./fixtures/data.js";

const ACTIVE_PROJECT_KEY = "activeProjectId";

test.describe("Global chat + handoff", () => {
	test("ProjectRail home button navigates to /project/global/chat", async ({
		page,
		mockApi,
	}) => {
		const globalProj = makeProject({ id: "global", name: "Global" });
		const realProj = makeProject({ id: "proj-1", name: "Real Project" });
		await mockApi({ projects: [globalProj, realProj] });

		// Start on a real project so the rail is visible and "global" is not active.
		await page.goto(`/project/${realProj.id}`);
		await expect(page.locator("aside")).toBeVisible();

		// Click the Home button in the ProjectRail.
		await page.getByRole("button", { name: "Home" }).first().click();

		await page.waitForURL(/\/project\/global\/chat/);

		// activeProjectId was also updated to "global".
		const active = await page.evaluate((k) => localStorage.getItem(k), ACTIVE_PROJECT_KEY);
		expect(active).toBe("global");
	});

	test("Landing top-left wordmark links to /project/global/chat", async ({
		page,
		mockApi,
	}) => {
		const globalProj = makeProject({ id: "global", name: "Global" });
		await mockApi({ projects: [globalProj] });

		await page.goto("/");

		const wordmark = page.getByLabel("Go to Global chat");
		await expect(wordmark).toBeVisible();
		await expect(wordmark).toHaveAttribute("href", "/project/global/chat");

		await wordmark.click();
		await page.waitForURL(/\/project\/global\/chat/);
	});

	test("Sidebar shows Chat link on Global and navigates to /project/global/chat", async ({
		page,
		mockApi,
	}) => {
		const globalProj = makeProject({ id: "global", name: "Global" });
		await mockApi({ projects: [globalProj] });

		await page.goto("/project/global");
		const sidebar = page.locator("aside");
		await expect(sidebar).toBeVisible();

		// Chat link renders in the sidebar for Global mode.
		const chatLink = sidebar.getByRole("link", { name: "Chat", exact: true });
		await expect(chatLink).toBeVisible();
		await expect(chatLink).toHaveAttribute("href", "/project/global/chat");

		// Clicking it navigates correctly.
		await chatLink.click();
		await page.waitForURL(/\/project\/global\/chat/);
	});

	test("Chat page strips ?initial= and auto-sends the initial message", async ({
		page,
		mockApi,
	}) => {
		const proj = makeProject({ id: "proj-1", name: "Handoff Project" });
		const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "New Chat" });
		await mockApi({ projects: [proj], conversations: [conv] });

		const messagePost = page.waitForRequest(
			(req) =>
				/\/api\/conversations\/conv-1\/messages$/.test(req.url()) &&
				req.method() === "POST",
		);

		await page.goto(`/project/proj-1/chat/conv-1?initial=${encodeURIComponent("hello handoff")}`);

		// POST /messages fires with the initial content.
		const req = await messagePost;
		const body = req.postDataJSON();
		if (body && typeof body === "object") {
			expect(body.content).toBe("hello handoff");
		} else {
			// Multipart form (attachments path) — fall back to raw scan.
			const raw = req.postDataBuffer()?.toString("binary") ?? "";
			expect(raw).toContain("hello handoff");
		}

		// ?initial= is stripped from the URL (replaceState keeps the pathname only).
		await expect.poll(() => page.url(), { timeout: 5000 }).not.toContain("initial=");
		expect(page.url()).toMatch(/\/project\/proj-1\/chat\/conv-1(\?.*)?$/);
	});

	test("Global conversation creation from landing hits POST /api/conversations with projectId 'global'", async ({
		page,
		mockApi,
	}) => {
		// Regression guard for the backend Zod schema change: the client submits
		// projectId: "global" and the backend must accept it (union of UUID + literal).
		const globalProj = makeProject({ id: "global", name: "Global" });
		await mockApi({ projects: [globalProj] });

		await page.addInitScript(
			({ key, value }) => {
				try { localStorage.setItem(key, value); } catch { /* ignore */ }
			},
			{ key: ACTIVE_PROJECT_KEY, value: "global" },
		);

		const createReq = page.waitForRequest(
			(req) =>
				req.url().endsWith("/api/conversations") && req.method() === "POST",
		);

		await page.goto("/");
		const textarea = page.locator("textarea");
		await textarea.fill("hello global");
		await textarea.press("Enter");

		const body = (await createReq).postDataJSON();
		expect(body).toMatchObject({ projectId: "global" });
		await page.waitForURL(/\/project\/global\/chat\/new-conv/);
	});
});
