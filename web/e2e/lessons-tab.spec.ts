/**
 * Playwright E2E for the v1.5 lessons curation tab on `/memories`.
 *
 * Runs against the dev server with `mockApi` providing the route layer
 * (no real DB or auth). The mock state is mutable in-process, so a
 * DELETE on the tab propagates to the next `/api/mentions/search?type=
 * lesson` call — letting us assert the post-mutation popover behavior
 * without spinning up Postgres.
 *
 * Pattern mirrors `web/e2e/knowledge-base.spec.ts` for the
 * `localStorage.activeProjectId` + reload dance, and
 * `web/e2e/memories.spec.ts` for the tab-switch interaction.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeLesson } from "./fixtures/data.js";

test.describe("Lessons Tab", () => {
	const proj = makeProject({ id: "proj-1", name: "Lessons Project" });

	/** Navigate to /memories with active project set, then click "Lessons". */
	async function goToLessonsTab(page: any) {
		await page.goto("/memories");
		await page.evaluate((projId: string) => {
			localStorage.setItem("activeProjectId", projId);
		}, proj.id);
		await page.reload();
		await page.getByRole("button", { name: "Lessons" }).click();
	}

	test("renders empty state when no lessons exist", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], lessons: [] });
		await goToLessonsTab(page);

		await expect(page.getByTestId("lessons-empty")).toBeVisible();
		await expect(page.getByTestId("lessons-empty")).toContainText(/No lessons yet/);
	});

	test("renders rows with slug chip + title + visibility badge + body + meta", async ({
		page,
		mockApi,
	}) => {
		const lesson = makeLesson({
			id: "l-display",
			slug: "use-bun-not-node",
			title: "Use Bun, not Node",
			body: "Always invoke `bun <file>` instead of `node <file>`.",
			visibility: "user",
			ownedByMe: true,
			firedCount: 7,
		});
		await mockApi({ projects: [proj], lessons: [lesson] });
		await goToLessonsTab(page);

		const row = page.getByTestId("lesson-row");
		await expect(row).toBeVisible();
		await expect(row.getByTestId("lesson-slug")).toHaveText("%use-bun-not-node");
		await expect(row.getByText("Use Bun, not Node")).toBeVisible();
		await expect(row.getByTestId("lesson-visibility-badge")).toHaveText(/user/i);
		await expect(row.getByTestId("lesson-body")).toContainText("bun <file>");
		await expect(row.getByTestId("lesson-meta")).toContainText("fired: 7");
	});

	test("delete + promote affordances are gated on ownedByMe", async ({
		page,
		mockApi,
	}) => {
		await mockApi({
			projects: [proj],
			lessons: [
				makeLesson({ id: "mine", slug: "mine", title: "My lesson", ownedByMe: true }),
				makeLesson({
					id: "theirs",
					slug: "their-share",
					title: "Their shared lesson",
					ownedByMe: false,
					visibility: "project",
				}),
			],
		});
		await goToLessonsTab(page);

		const myRow = page.locator('[data-lesson-id="mine"]');
		const theirRow = page.locator('[data-lesson-id="theirs"]');

		// Mine: delete + promote present.
		await expect(myRow.getByTestId("lesson-delete")).toBeVisible();
		await expect(myRow.getByTestId("lesson-promote")).toBeVisible();

		// Theirs: read-only chrome — no delete, no promote, has shared badge.
		await expect(theirRow.getByTestId("lesson-delete")).toHaveCount(0);
		await expect(theirRow.getByTestId("lesson-promote")).toHaveCount(0);
		await expect(theirRow.getByTestId("lesson-shared-badge")).toBeVisible();
	});

	test("promotes user → project; visibility badge updates immediately", async ({
		page,
		mockApi,
	}) => {
		await mockApi({
			projects: [proj],
			lessons: [
				makeLesson({
					id: "to-promote",
					slug: "to-promote",
					visibility: "user",
					ownedByMe: true,
				}),
			],
		});
		await goToLessonsTab(page);

		const row = page.locator('[data-lesson-id="to-promote"]');
		await expect(row.getByTestId("lesson-visibility-badge")).toHaveText(/user/i);

		await row.getByTestId("lesson-promote").selectOption("project");

		await expect(row.getByTestId("lesson-visibility-badge")).toHaveText(/project/i);
		await expect(row).toHaveAttribute("data-visibility", "project");
	});

	test("promote dropdown disables backward options", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			lessons: [
				makeLesson({
					id: "mid-tier",
					slug: "mid",
					visibility: "project",
					ownedByMe: true,
				}),
			],
		});
		await goToLessonsTab(page);

		const promote = page.locator('[data-lesson-id="mid-tier"]').getByTestId("lesson-promote");
		// Backward option (user) is disabled at the option level so the
		// browser's native select can't pick it.
		const userOption = promote.locator('option[value="user"]');
		await expect(userOption).toBeDisabled();
		// Current + forward options are open.
		const projectOption = promote.locator('option[value="project"]');
		const globalOption = promote.locator('option[value="global"]');
		await expect(projectOption).toBeEnabled();
		await expect(globalOption).toBeEnabled();
	});

	test("promote dropdown disabled entirely at global (terminal tier)", async ({
		page,
		mockApi,
	}) => {
		await mockApi({
			projects: [proj],
			lessons: [
				makeLesson({
					id: "topmost",
					slug: "top",
					visibility: "global",
					ownedByMe: true,
				}),
			],
		});
		await goToLessonsTab(page);
		const promote = page.locator('[data-lesson-id="topmost"]').getByTestId("lesson-promote");
		await expect(promote).toBeDisabled();
	});

	test("delete: first click confirms; second click removes the row AND the popover entry", async ({
		page,
		mockApi,
	}) => {
		await mockApi({
			projects: [proj],
			lessons: [
				makeLesson({
					id: "doomed",
					slug: "doomed-lesson",
					title: "Doomed Lesson",
					body: "I will be deleted.",
					ownedByMe: true,
				}),
			],
		});
		await goToLessonsTab(page);

		const row = page.locator('[data-lesson-id="doomed"]');
		await expect(row).toBeVisible();

		const deleteBtn = row.getByTestId("lesson-delete");
		await deleteBtn.click();
		await expect(deleteBtn).toHaveText("Confirm?");
		await deleteBtn.click();
		await expect(row).toHaveCount(0);

		// Direct API check — the mock state should reflect the delete and
		// the mention-search route should NOT surface the deleted lesson.
		// Hitting the API directly via page.evaluate is the cleanest
		// assertion (the real composer + popover are out of scope for
		// this spec; the wiring tests live elsewhere).
		const popoverResults = await page.evaluate(async () => {
			const res = await fetch(
				"/api/mentions/search?type=lesson&projectId=proj-1&q=doomed",
			);
			return res.json();
		});
		expect(popoverResults).toEqual([]);
	});

	test("delete cancellation: confirm state auto-reverts after timeout, no API call", async ({
		page,
		mockApi,
	}) => {
		const lesson = makeLesson({
			id: "patient",
			slug: "patient-lesson",
			ownedByMe: true,
		});
		await mockApi({ projects: [proj], lessons: [lesson] });
		await goToLessonsTab(page);

		const row = page.locator('[data-lesson-id="patient"]');
		const deleteBtn = row.getByTestId("lesson-delete");

		// Track whether the DELETE endpoint is hit during the cancel window.
		let deleteFired = false;
		await page.route("**/api/lessons/patient", (route) => {
			if (route.request().method() === "DELETE") deleteFired = true;
			route.fallback();
		});

		await deleteBtn.click();
		await expect(deleteBtn).toHaveText("Confirm?");

		// Wait past the 3-second auto-revert.
		await page.waitForTimeout(3500);
		await expect(deleteBtn).toHaveText("Delete");
		await expect(row).toBeVisible();
		expect(deleteFired).toBe(false);
	});

	test("renders multiple lessons and preserves server-side ordering", async ({
		page,
		mockApi,
	}) => {
		await mockApi({
			projects: [proj],
			lessons: [
				makeLesson({ id: "a", slug: "alpha", title: "Alpha", ownedByMe: true }),
				makeLesson({
					id: "b",
					slug: "beta",
					title: "Beta",
					ownedByMe: false,
					visibility: "project",
				}),
				makeLesson({
					id: "c",
					slug: "gamma",
					title: "Gamma",
					ownedByMe: true,
					visibility: "global",
				}),
			],
		});
		await goToLessonsTab(page);

		const slugs = page.getByTestId("lesson-slug");
		await expect(slugs).toHaveCount(3);
		await expect(slugs.nth(0)).toHaveText("%alpha");
		await expect(slugs.nth(1)).toHaveText("%beta");
		await expect(slugs.nth(2)).toHaveText("%gamma");
	});

});
