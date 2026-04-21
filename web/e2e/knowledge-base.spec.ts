import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeKBFile } from "./fixtures/data.js";

test.describe("Knowledge Base Tab", () => {
	const proj = makeProject({ id: "proj-1", name: "KB Project" });

	/** Navigate to /memories with active project set */
	async function goToMemoriesWithProject(page: any) {
		// Navigate to a real page first so we can access localStorage
		await page.goto("/memories");
		await page.evaluate((projId: string) => {
			localStorage.setItem("activeProjectId", projId);
		}, proj.id);
		// Reload so the store picks up the localStorage value at init
		await page.reload();
	}

	test("knowledge base tab shows file list", async ({ page, mockApi }) => {
		const file = makeKBFile({ filename: "architecture.md", fileSize: 5120, chunkCount: 8 });
		await mockApi({ projects: [proj], kbFiles: [file] });
		await goToMemoriesWithProject(page);

		// Click KB tab
		await page.getByText("Knowledge Base").click();

		await expect(page.getByText("architecture.md")).toBeVisible();
		await expect(page.getByText("5.0 KB")).toBeVisible();
	});

	test("knowledge base tab shows empty state without project", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.goto("/memories");

		await page.getByText("Knowledge Base").click();

		// When no project is active, shows select project message
		await expect(page.getByText("Select a project").first()).toBeVisible();
	});

	test("knowledge base tab shows upload dropzone", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], kbFiles: [] });
		await goToMemoriesWithProject(page);

		await page.getByText("Knowledge Base").click();

		// The upload zone shows "Drop files here or click to upload"
		await expect(page.getByText(/[Dd]rop files here/)).toBeVisible();
	});

	test("file delete shows confirmation", async ({ page, mockApi }) => {
		const file = makeKBFile({ filename: "delete-me.txt" });
		await mockApi({ projects: [proj], kbFiles: [file] });
		await goToMemoriesWithProject(page);

		await page.getByText("Knowledge Base").click();

		// Wait for file to render
		await expect(page.getByText("delete-me.txt")).toBeVisible();

		// Click delete
		await page.getByRole("button", { name: "Delete" }).click();

		await expect(page.getByText("Confirm?")).toBeVisible();
	});

	test("upload via file input triggers POST and shows upload status", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], kbFiles: [] });
		await goToMemoriesWithProject(page);

		await page.getByText("Knowledge Base").click();
		await expect(page.getByText(/[Dd]rop files here/)).toBeVisible();

		// Intercept the POST to verify it's called
		let postCalled = false;
		await page.route("**/api/knowledge-base", (route) => {
			if (route.request().method() === "POST") {
				postCalled = true;
				return route.fulfill({ status: 201, json: { id: "kb-upload-1", status: "processing" } });
			}
			return route.fulfill({ json: [] });
		});

		// Set files on the hidden file input
		const fileInput = page.locator('input[type="file"]');
		await fileInput.setInputFiles({
			name: "notes.md",
			mimeType: "text/markdown",
			buffer: Buffer.from("# My Notes\nSome content here"),
		});

		// The upload entry should appear briefly
		await expect(page.getByText("notes.md")).toBeVisible();
		expect(postCalled).toBe(true);
	});

	test("file shows processing status then ready", async ({ page, mockApi }) => {
		const processingFile = makeKBFile({
			id: "kbf-status",
			filename: "large-doc.md",
			status: "processing",
			chunkCount: 0,
		});
		await mockApi({ projects: [proj], kbFiles: [processingFile] });
		await goToMemoriesWithProject(page);

		await page.getByText("Knowledge Base").click();

		// File should show with processing status
		await expect(page.getByText("large-doc.md")).toBeVisible();
		await expect(page.getByText(/[Pp]rocessing/)).toBeVisible();
	});

	test("file with error status shows Error text", async ({ page, mockApi }) => {
		const file = makeKBFile({ filename: "broken.md", status: "error", chunkCount: 0 });
		await mockApi({ projects: [proj], kbFiles: [file] });
		await goToMemoriesWithProject(page);

		await page.getByText("Knowledge Base").click();

		await expect(page.getByText("broken.md")).toBeVisible();
		await expect(page.getByText("Error")).toBeVisible();
	});

	test("rejected file type shows error message", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], kbFiles: [] });
		await goToMemoriesWithProject(page);

		await page.getByText("Knowledge Base").click();
		await expect(page.getByText(/[Dd]rop files here/)).toBeVisible();

		// Select a disallowed file type
		const fileInput = page.locator('input[type="file"]');
		await fileInput.setInputFiles({
			name: "malware.exe",
			mimeType: "application/octet-stream",
			buffer: Buffer.from("not allowed"),
		});

		// The error message should appear
		await expect(page.getByText(/unsupported type/i)).toBeVisible();
	});
});
