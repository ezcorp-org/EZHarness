import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const proj = makeProject({ id: "imp-proj", name: "Import Proj" });

const PREVIEW_OK = {
	sessionId: "11111111-1111-1111-1111-111111111111",
	fileCount: 3,
	commands: [
		{
			id: "project:claude-commands|foo",
			name: "foo",
			description: "Foo command",
			source: "project:claude-commands",
		},
	],
	skills: [
		{
			id: "baz",
			name: "baz",
			rawName: "Baz",
			description: "Baz skill",
			scriptCount: 1,
		},
	],
};

const COMMIT_OK = {
	results: [
		{ kind: "command", requested: "foo", finalName: "foo", status: "ok" },
		{
			kind: "skill",
			requested: "Baz",
			finalName: "baz",
			extId: "ext-1",
			status: "ok",
		},
	],
};

async function mockImport(
	page: import("@playwright/test").Page,
	opts: {
		preview?: unknown;
		previewStatus?: number;
		commit?: unknown;
		commitStatus?: number;
		hits?: Record<string, boolean>;
	} = {},
) {
	await page.route("**/api/import/preview", (route) =>
		route.fulfill({
			status: opts.previewStatus ?? 200,
			json: opts.preview ?? PREVIEW_OK,
		}),
	);
	await page.route("**/api/import/commit", (route) =>
		route.fulfill({
			status: opts.commitStatus ?? 200,
			json: opts.commit ?? COMMIT_OK,
		}),
	);
	await page.route("**/api/user-commands/foo", (route) => {
		if (opts.hits) opts.hits.deleteCommand = true;
		return route.fulfill({ status: 204, body: "" });
	});
	await page.route("**/api/extensions/ext-1", (route) => {
		if (opts.hits) opts.hits.deleteExt = true;
		return route.fulfill({ status: 204, body: "" });
	});
}

// A webkitdirectory <input> requires a real directory PATH (Playwright
// rejects in-memory file payloads for it). Build a throwaway fixture
// tree on disk; the preview API is mocked so only "files were picked"
// matters.
const fixtureDirs: string[] = [];
async function makeFixtureDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "e2e-imp-"));
	await mkdir(join(dir, ".claude", "commands"), { recursive: true });
	await writeFile(join(dir, ".claude", "commands", "foo.md"), "body", "utf8");
	fixtureDirs.push(dir);
	return dir;
}
test.afterAll(async () => {
	for (const d of fixtureDirs) await rm(d, { recursive: true, force: true });
});

test.describe("Import wizard", () => {
	test("directory upload → select → import → remove + undo", async ({
		page,
		mockApi,
	}) => {
		const hits: Record<string, boolean> = {};
		await mockApi({ projects: [proj] });
		await mockImport(page, { hits });
		await page.goto("/import", { waitUntil: "networkidle" });

		const wiz = page.locator('[data-testid="import-wizard"]');
		await expect(wiz).toBeVisible();
		await expect(page.locator('[data-testid="import-project"]')).toContainText(
			"Import Proj",
		);

		await page
			.locator('[data-testid="import-dir-input"]')
			.setInputFiles(await makeFixtureDir());

		await expect(wiz).toHaveAttribute("data-step", "2");
		await expect(page.locator('[data-testid="imp-cmd-foo"]')).toBeVisible();
		await expect(page.locator('[data-testid="imp-skill-baz"]')).toBeVisible();
		await expect(page.locator('[data-testid="import-skills"]')).toContainText(
			"disabled",
		);

		await page.locator('[data-testid="import-submit"]').click();

		await expect(wiz).toHaveAttribute("data-step", "3");
		const rows = page.locator('[data-testid="import-result-row"]');
		await expect(rows).toHaveCount(2);
		await expect(rows.nth(0)).toContainText("command: foo");
		await expect(rows.nth(1)).toContainText("skill: baz");

		// Remove the command via the inline button.
		await rows
			.nth(0)
			.locator('[data-testid="import-remove"]')
			.click();
		await expect.poll(() => hits.deleteCommand ?? false).toBe(true);
		await expect(rows.nth(0)).toContainText("removed");

		// Undo the rest (the skill) → extension uninstall fires.
		await page.locator('[data-testid="import-undo"]').click();
		await expect.poll(() => hits.deleteExt ?? false).toBe(true);
	});

	test("archive upload reaches the select step", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await mockImport(page);
		await page.goto("/import", { waitUntil: "networkidle" });

		await page
			.locator('[data-testid="import-archive-input"]')
			.setInputFiles([
				{ name: "u.zip", mimeType: "application/zip", buffer: Buffer.from("PK") },
			]);

		await expect(
			page.locator('[data-testid="import-wizard"]'),
		).toHaveAttribute("data-step", "2");
	});

	test("an empty result keeps step 1 and explains why", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj] });
		await mockImport(page, {
			preview: {
				sessionId: "x",
				fileCount: 0,
				commands: [],
				skills: [],
			},
		});
		await page.goto("/import", { waitUntil: "networkidle" });

		await page
			.locator('[data-testid="import-dir-input"]')
			.setInputFiles(await makeFixtureDir());

		await expect(page.locator('[data-testid="import-error"]')).toBeVisible();
		await expect(
			page.locator('[data-testid="import-wizard"]'),
		).toHaveAttribute("data-step", "1");
	});

	test("a commit failure surfaces an error", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await mockImport(page, {
			commitStatus: 500,
			commit: { error: "boom" },
		});
		await page.goto("/import", { waitUntil: "networkidle" });

		await page
			.locator('[data-testid="import-dir-input"]')
			.setInputFiles(await makeFixtureDir());
		await page.locator('[data-testid="import-submit"]').click();

		await expect(page.locator('[data-testid="import-error"]')).toBeVisible();
		await expect(
			page.locator('[data-testid="import-wizard"]'),
		).toHaveAttribute("data-step", "2");
	});

	test("launch links route to the wizard", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.goto("/commands", { waitUntil: "networkidle" });
		await page.locator('[data-testid="commands-import-link"]').click();
		await expect(page).toHaveURL(/\/import$/);

		await page.goto("/extensions", { waitUntil: "networkidle" });
		await page.locator('[data-testid="extensions-import-link"]').click();
		await expect(page).toHaveURL(/\/import$/);
	});
});
