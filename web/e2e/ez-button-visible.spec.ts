/**
 * Phase 48 Wave 4 — Ez button visibility across the app shell.
 *
 * The floating "Ez" button is mounted in `(app)/+layout.svelte`, so it
 * appears on every authenticated route by construction. `/login` lives
 * under the `(auth)` group and lacks the layout — the button must NOT
 * appear there. We assert both directions.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation } from "./fixtures/data.js";

test.describe("Ez button — visibility on (app) routes", () => {
	const proj = makeProject({ id: "proj-1", name: "Demo" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Hello" });

	test("button is visible on /agents", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.goto("/agents");
		await expect(page.getByTestId("ez-button")).toBeVisible();
	});

	test("button is visible on /new-project", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.goto("/new-project");
		await expect(page.getByTestId("ez-button")).toBeVisible();
	});

	test("button is visible on /agents/new", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.goto("/agents/new");
		await expect(page.getByTestId("ez-button")).toBeVisible();
	});

	test("button is visible on a chat route", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByTestId("ez-button")).toBeVisible();
	});

	test("button is hidden on /login (auth group, no app layout)", async ({ page, mockApi }) => {
		await mockApi();
		// /login lives outside the (app) layout. Whatever shell renders
		// here, the EzButton must NOT be present.
		await page.goto("/login");
		await expect(page.getByTestId("ez-button")).toHaveCount(0);
	});
});
