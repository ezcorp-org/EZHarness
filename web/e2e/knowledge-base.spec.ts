import { test, expect, captureEvidence } from "./fixtures/test-base.js";
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
    // `store.activeProjectId` falls back to the "global" literal when the key
    // is ABSENT (`localStorage.getItem(...) ?? "global"`), which is truthy and
    // renders the tab normally. An empty string is the one value that reaches
    // the no-project branch — so it has to be written explicitly. Without
    // this the test asserted a message the page could never show and had been
    // failing red; `?? ` does not coalesce `""`.
    await page.evaluate(() => localStorage.setItem("activeProjectId", ""));
    await page.reload();

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

  // ── Sharing a file with the project ──────────────────────────────────
  //
  // `user_id IS NULL` has always been the knowledge base's one sharing
  // mechanism; until now nothing in the product could produce such a row, so
  // a member's upload reached nobody else. These cover the verb that closes
  // that gap, and — just as importantly — that the buttons are drawn from the
  // SERVER's `canShare` / `canUnshare` rather than guessed at client-side.

  test("share button posts and the row flips to Shared", async ({ page, mockApi }) => {
    const file = makeKBFile({ filename: "handbook.md", canShare: true });
    await mockApi({ projects: [proj], kbFiles: [file] });
    await goToMemoriesWithProject(page);
    await page.getByText("Knowledge Base").click();

    await expect(page.getByText("handbook.md")).toBeVisible();
    await expect(page.getByRole("button", { name: "Share", exact: true })).toBeVisible();
    // Not shared yet, so no badge.
    await expect(page.getByText("Shared by you")).toHaveCount(0);

    const shareRequest = page.waitForRequest(
      (r) => r.url().includes("/share") && r.method() === "POST",
    );
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await shareRequest;

    // The badge and the inverse action both appear off the re-fetch.
    await expect(page.getByText("Shared by you")).toBeVisible();
    await expect(page.getByRole("button", { name: "Unshare" })).toBeVisible();
  });

  test("unshare takes the file back out of the project", async ({ page, mockApi }) => {
    const file = makeKBFile({
      filename: "handbook.md",
      shared: true,
      sharedByYou: true,
      canShare: false,
      canUnshare: true,
    });
    await mockApi({ projects: [proj], kbFiles: [file] });
    await goToMemoriesWithProject(page);
    await page.getByText("Knowledge Base").click();

    await expect(page.getByText("Shared by you")).toBeVisible();

    const unshareRequest = page.waitForRequest(
      (r) => r.url().includes("/share") && r.method() === "DELETE",
    );
    await page.getByRole("button", { name: "Unshare" }).click();
    await unshareRequest;

    await expect(page.getByText("Shared by you")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Share", exact: true })).toBeVisible();
  });

  test("a file shared by someone else shows the badge but offers no button", async ({
    page,
    mockApi,
  }) => {
    // The authorization rule, as the UI must render it: sharing is the
    // owner's call and un-sharing is the sharer's, so a bystander gets the
    // information without the verb. A visible-but-403 button would be the
    // bug here.
    const file = makeKBFile({
      filename: "team-handbook.md",
      shared: true,
      sharedByYou: false,
      canShare: false,
      canUnshare: false,
    });
    await mockApi({ projects: [proj], kbFiles: [file] });
    await goToMemoriesWithProject(page);
    await page.getByText("Knowledge Base").click();

    await expect(page.getByText("team-handbook.md")).toBeVisible();
    await expect(page.getByText("Shared", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Share", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Unshare" })).toHaveCount(0);
    // Delete is untouched by sharing and stays where it was.
    await expect(page.getByRole("button", { name: "Delete" })).toBeVisible();
  });

  test("a refused share surfaces the server's reason instead of failing silently", async ({
    page,
    mockApi,
  }) => {
    const file = makeKBFile({ filename: "handbook.md", canShare: true });
    await mockApi({ projects: [proj], kbFiles: [file] });
    await goToMemoriesWithProject(page);
    await page.getByText("Knowledge Base").click();
    await expect(page.getByText("handbook.md")).toBeVisible();

    await page.route("**/api/knowledge-base/*/share", (route) =>
      route.fulfill({ status: 403, json: { error: "Forbidden" } }),
    );
    await page.getByRole("button", { name: "Share", exact: true }).click();

    await expect(page.getByTestId("kb-share-error")).toHaveText("Forbidden");
    // …and the row did NOT optimistically claim to be shared.
    await expect(page.getByText("Shared by you")).toHaveCount(0);
  });

  test("@evidence knowledge base sharing controls", async ({ page, mockApi }, testInfo) => {
    // One frame covering all three states the sharing UI can be in, so a
    // reviewer can see the badge/button pairing without running the app.
    await mockApi({
      projects: [proj],
      kbFiles: [
        makeKBFile({ id: "kb-mine", filename: "my-notes.md", fileSize: 2048, chunkCount: 3 }),
        makeKBFile({
          id: "kb-shared-by-me",
          filename: "handbook.md",
          fileSize: 8192,
          chunkCount: 12,
          shared: true,
          sharedByYou: true,
          canShare: false,
          canUnshare: true,
        }),
        makeKBFile({
          id: "kb-shared-by-them",
          filename: "team-standards.md",
          fileSize: 4096,
          chunkCount: 7,
          shared: true,
          sharedByYou: false,
          canShare: false,
          canUnshare: false,
        }),
      ],
    });
    await goToMemoriesWithProject(page);
    await page.getByText("Knowledge Base").click();

    await expect(page.getByText("my-notes.md")).toBeVisible();
    await expect(page.getByText("Shared by you")).toBeVisible();
    await expect(page.getByText("Shared", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Share", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Unshare" })).toBeVisible();

    await captureEvidence(page, testInfo, "kb-sharing-controls");
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
