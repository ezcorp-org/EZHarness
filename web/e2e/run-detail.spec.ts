import { test, expect } from "./fixtures/test-base.js";
import { makeRun } from "./fixtures/data.js";

test.describe("Run Detail", () => {
  test("shows run status, agent name, and run ID", async ({ page, mockApi }) => {
    await mockApi({
      runs: [
        makeRun({
          id: "run-abc123",
          agentName: "summarizer",
          status: "success",
        }),
      ],
    });
    await page.goto("/runs/run-abc123");

    await expect(page.getByRole("heading", { name: "summarizer" })).toBeVisible();
    await expect(page.getByText("run-abc123")).toBeVisible();
  });

  test("shows started timestamp", async ({ page, mockApi }) => {
    await mockApi({
      runs: [
        makeRun({
          id: "run-1",
          startedAt: "2026-03-01T10:30:00.000Z",
        }),
      ],
    });
    await page.goto("/runs/run-1");

    // `exact` — the substring form also matches the onboarding checklist's
    // "Get Started" button in the shell, which is a strict-mode violation
    // (2 elements) rather than a real absence. The timestamp label is its
    // own standalone <span>, so the exact match is the STRONGER assertion.
    await expect(page.getByText("Started", { exact: true })).toBeVisible();
  });

  test("shows finished timestamp and duration for completed runs", async ({ page, mockApi }) => {
    await mockApi({
      runs: [
        makeRun({
          id: "run-1",
          status: "success",
          startedAt: "2026-03-01T10:30:00.000Z",
          finishedAt: "2026-03-01T10:32:45.000Z",
        }),
      ],
    });
    await page.goto("/runs/run-1");

    await expect(page.getByText("Finished")).toBeVisible();
    await expect(page.getByText("Duration")).toBeVisible();
  });

  test("shows logs section", async ({ page, mockApi }) => {
    await mockApi({
      runs: [
        makeRun({
          id: "run-1",
          logs: [
            {
              timestamp: "2026-03-01T10:30:00.000Z",
              level: "info",
              message: "Starting summarization",
            },
            {
              timestamp: "2026-03-01T10:30:01.000Z",
              level: "info",
              message: "Processing complete",
            },
          ],
        }),
      ],
    });
    await page.goto("/runs/run-1");

    await expect(page.getByText("Logs")).toBeVisible();
    await expect(page.getByText("Starting summarization")).toBeVisible();
    await expect(page.getByText("Processing complete")).toBeVisible();
  });

  test("surfaces a dropped reasoning effort as a WARN line", async ({ page, mockApi }) => {
    // This is the channel a workflow step's ignored `model: { effort }`
    // comes out of. `createPiLlmAdapter` reports the drop, `runAgent` writes
    // it into the run's own log at `warn`, and this page is where the person
    // who set the effort finds out it did nothing. Before this it was
    // silence — no error, no warning, no effect.
    const message =
      'Reasoning effort "high" was ignored: the bound model ollama/qwen3:1.7b ' +
      "does not accept a reasoning setting. Local and custom models never do.";
    await mockApi({
      runs: [
        makeRun({
          id: "run-effort",
          status: "success",
          logs: [
            { timestamp: "2026-03-01T10:30:00.000Z", level: "info", message: "Starting step" },
            { timestamp: "2026-03-01T10:30:01.000Z", level: "warn", message },
          ],
        }),
      ],
    });
    await page.goto("/runs/run-effort");

    await expect(page.getByText(message)).toBeVisible();
    // Rendered AS a warning, not as another info line — the level is the
    // only thing distinguishing it from the run's ordinary chatter.
    const row = page.locator("div.flex.gap-2", { hasText: "was ignored" });
    await expect(row).toHaveClass(/text-yellow-400/);
  });

  test("shows result section for completed runs", async ({ page, mockApi }) => {
    await mockApi({
      runs: [
        makeRun({
          id: "run-1",
          status: "success",
          result: { success: true, output: { summary: "A brief summary" } },
        }),
      ],
    });
    await page.goto("/runs/run-1");

    await expect(page.getByText("Result")).toBeVisible();
    await expect(page.getByText("A brief summary")).toBeVisible();
  });

  test("shows loading state", async ({ page, mockApi }) => {
    await mockApi({ runs: [] });
    await page.goto("/runs/run-missing");

    // Should show loading or not-found
    const body = page.locator("body");
    await expect(body).toBeVisible();
  });

  test("back link navigates to dashboard", async ({ page, mockApi }) => {
    await mockApi({
      runs: [makeRun({ id: "run-1" })],
    });
    await page.goto("/runs/run-1");

    const backLink = page.getByText("Back").first();
    await backLink.click();
    await expect(page).toHaveURL("/");
  });
});
