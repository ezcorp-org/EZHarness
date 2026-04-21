import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const ACTIVE_PROJECT_KEY = "activeProjectId";

test.describe("Landing page", () => {
	test("renders at / with a chat input and project picker", async ({
		page,
		mockApi,
	}) => {
		const proj = makeProject({ id: "proj-1", name: "Landing Project" });
		await mockApi({ projects: [proj] });

		await page.goto("/");

		// Brand visible
		await expect(page.getByText("EZCorp").first()).toBeVisible();

		// Chat input (textarea) visible
		await expect(page.locator("textarea")).toBeVisible();

		// Project picker trigger visible (in the controls row below the input)
		await expect(page.getByTestId("project-picker-trigger")).toBeVisible();
	});

	test("selected project persists to localStorage and survives reload", async ({
		page,
		mockApi,
	}) => {
		const projA = makeProject({ id: "proj-a", name: "Project A" });
		const projB = makeProject({ id: "proj-b", name: "Project B" });
		await mockApi({ projects: [projA, projB] });

		await page.goto("/");
		await expect(page.getByTestId("project-picker-trigger")).toBeVisible();

		// The landing page auto-selects the first project when none is saved.
		// Wait for that to settle so the subsequent click isn't overwritten.
		await expect(page.getByTestId("project-picker-trigger")).toContainText(
			"Project A",
		);

		// Pick Project B explicitly via the picker.
		await page.getByTestId("project-picker-trigger").click();
		await page.getByTestId("project-picker-item-proj-b").click();

		// localStorage now carries the selected id.
		await expect
			.poll(async () =>
				await page.evaluate((k) => localStorage.getItem(k), ACTIVE_PROJECT_KEY),
			)
			.toBe("proj-b");

		// Trigger label reflects the selection.
		await expect(page.getByTestId("project-picker-trigger")).toContainText(
			"Project B",
		);

		// Full reload — store is re-initialized from localStorage. Selection must stick.
		await page.reload();
		await expect(page.getByTestId("project-picker-trigger")).toContainText(
			"Project B",
		);
		const stillSaved = await page.evaluate(
			(k) => localStorage.getItem(k),
			ACTIVE_PROJECT_KEY,
		);
		expect(stillSaved).toBe("proj-b");
	});

	test("submitting with a project selected creates a conversation and navigates to chat", async ({
		page,
		mockApi,
	}) => {
		const proj = makeProject({ id: "proj-1", name: "Submit Project" });
		await mockApi({ projects: [proj] });

		// Pre-seed selection so the landing page doesn't race with auto-select.
		await page.addInitScript(
			({ key, value }) => {
				try { localStorage.setItem(key, value); } catch { /* ignore */ }
			},
			{ key: ACTIVE_PROJECT_KEY, value: "proj-1" },
		);

		// Observe the POST /api/conversations call triggered by submit.
		const createConvRequest = page.waitForRequest(
			(req) =>
				req.url().includes("/api/conversations") &&
				!req.url().includes("/api/conversations/") &&
				req.method() === "POST",
		);

		await page.goto("/");

		// Model auto-selects from /api/models once loaded — that enables the send button.
		const textarea = page.locator("textarea");
		await expect(textarea).toBeVisible();
		await textarea.fill("hello landing");

		// Submit via Enter (simpler than hunting the send button with no testid).
		await textarea.press("Enter");

		const request = await createConvRequest;
		expect(request.postDataJSON()).toMatchObject({ projectId: "proj-1" });

		// Navigates to the new conversation. The chat page strips ?initial= via
		// replaceState, so match the pathname only.
		await page.waitForURL(/\/project\/proj-1\/chat\/new-conv/);
	});

	test("submitting with Global selected creates a global conversation", async ({
		page,
		mockApi,
	}) => {
		// Seed the global project alongside a real one so Global is selectable.
		const globalProj = makeProject({ id: "global", name: "Global" });
		const realProj = makeProject({ id: "proj-1", name: "Real Project" });
		await mockApi({ projects: [globalProj, realProj] });

		// Force activeProjectId to "global" before load.
		await page.addInitScript(
			({ key, value }) => {
				try { localStorage.setItem(key, value); } catch { /* ignore */ }
			},
			{ key: ACTIVE_PROJECT_KEY, value: "global" },
		);

		const createConvRequest = page.waitForRequest(
			(req) =>
				req.url().includes("/api/conversations") &&
				!req.url().includes("/api/conversations/") &&
				req.method() === "POST",
		);

		await page.goto("/");

		const textarea = page.locator("textarea");
		await expect(textarea).toBeVisible();
		await textarea.fill("hello global");
		await textarea.press("Enter");

		const request = await createConvRequest;
		expect(request.postDataJSON()).toMatchObject({ projectId: "global" });

		await page.waitForURL(/\/project\/global\/chat\/new-conv/);
	});

	test("ChatInput toolbar is hidden; external controls row renders instead", async ({
		page,
		mockApi,
	}) => {
		const proj = makeProject({ id: "proj-1", name: "Toolbar Project" });
		await mockApi({ projects: [proj] });

		await page.goto("/");

		// External controls row is present.
		const controls = page.getByTestId("landing-controls");
		await expect(controls).toBeVisible();

		// Project picker is inside the external row.
		await expect(controls.getByTestId("project-picker-trigger")).toBeVisible();

		// The in-composer toolbar labels ("Model", "Thinking", "Mode") live under the
		// `.toolbar-label` class inside ChatInput. With toolbarPosition="hidden" they
		// should not render at all.
		const inputContainer = page.locator(".chat-input-container");
		await expect(inputContainer).toBeVisible();
		await expect(inputContainer.locator(".toolbar-label")).toHaveCount(0);

		// External row shows the Model + Mode labels (Thinking only appears when the
		// selected model supports reasoning — skip asserting it here).
		await expect(controls.getByText("Model", { exact: true })).toBeVisible();
		await expect(controls.getByText("Mode", { exact: true })).toBeVisible();
		await expect(controls.getByText("Project", { exact: true })).toBeVisible();
	});

	test("ProjectPicker single mode: clicking a project closes dropdown and hides Org-wide option", async ({
		page,
		mockApi,
	}) => {
		const projA = makeProject({ id: "proj-a", name: "Project A" });
		const projB = makeProject({ id: "proj-b", name: "Project B" });
		await mockApi({ projects: [projA, projB] });

		await page.goto("/");
		const trigger = page.getByTestId("project-picker-trigger");
		await expect(trigger).toBeVisible();

		// Open the dropdown.
		await trigger.click();
		const dropdown = page.getByTestId("project-picker-dropdown");
		await expect(dropdown).toBeVisible();

		// In single mode the standalone "Org-wide (Global)" row is hidden
		// (Global is still in the project list if the API returns it).
		await expect(page.getByTestId("project-picker-global")).toHaveCount(0);

		// Click Project B — single mode should replace selection and auto-close.
		await page.getByTestId("project-picker-item-proj-b").click();
		await expect(dropdown).toBeHidden();
		await expect(trigger).toContainText("Project B");
	});

	test("/agents and /pipelines still load without console errors", async ({
		page,
		mockApi,
	}) => {
		const proj = makeProject({ id: "proj-1", name: "Smoke Project" });
		await mockApi({ projects: [proj] });

		for (const path of ["/agents", "/pipelines"]) {
			const errors: string[] = [];
			page.on("console", (msg) => {
				if (msg.type() === "error") errors.push(msg.text());
			});
			page.on("pageerror", (err) => errors.push(err.message));

			await page.goto(path);
			await expect(page.locator("body")).toBeVisible();

			const realErrors = errors.filter(
				(e) => !e.includes("WebSocket") && !e.includes("ERR_CONNECTION_REFUSED"),
			);
			expect(realErrors, `Console errors on ${path}: ${realErrors.join("\n")}`).toEqual([]);
		}
	});
});
