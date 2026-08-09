import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { filePickerValue, openFilePickerInput } from "./fixtures/picker-helpers.js";

/**
 * New-project form — the Working Directory field defaults to the bind that
 * is actually persisted to the host (`./.ezcorp/projects` →
 * `/app/web/.ezcorp/projects`).
 *
 * The old default was `/app/projects/`, which sits OUTSIDE the fs-API
 * sandbox root (`EZCORP_PROJECT_ROOT ?? process.cwd()` = `/app/web`), so
 * "Create Folder" answered 403 on the very value the form suggested. Users
 * worked around it by typing `~/projects/<name>` — which nothing expands,
 * so it resolved under the cwd as a directory literally named `~` on the
 * container's throwaway overlay, invisible on the host.
 *
 * Frontend-visual change → `@evidence`-tagged so the visual gate captures
 * the rendered field. src/__tests__/compose-projects-root.test.ts holds the
 * same default against the compose bind; this spec proves it reaches the
 * DOM — in BOTH FilePicker variants (inline at lg+, trigger + BottomSheet
 * below lg), which is why the value goes through `filePickerValue`.
 */

const PROJECTS_BIND = "/app/web/.ezcorp/projects";
const PATH_PLACEHOLDER = `${PROJECTS_BIND}/my-project`;

test("new-project form defaults the working directory to the persisted bind @evidence", async ({
  page,
  mockApi,
}, testInfo) => {
  await mockApi();
  await page.goto("/new-project");

  await expect(page.getByRole("heading", { name: "Create Project" })).toBeVisible();
  await expect(page.getByTestId("open-file-picker")).toBeVisible();

  // The regression guard: the pre-fix default sat outside the sandbox root,
  // so "Create Folder" 403'd on the form's own suggestion.
  expect(await filePickerValue(page)).toBe(`${PROJECTS_BIND}/`);

  await captureEvidence(page, testInfo, "project-form-default-path");
});

test("typing a project name under the default keeps it inside the bind", async ({
  page,
  mockApi,
}) => {
  await mockApi();
  await page.goto("/new-project");

  await page.locator("#proj-name").fill("herdr-overlay");

  const pathInput = await openFilePickerInput(page, PATH_PLACEHOLDER);
  await pathInput.fill(`${PROJECTS_BIND}/herdr-overlay`);

  await expect(pathInput).toHaveValue(`${PROJECTS_BIND}/herdr-overlay`);
  expect(await filePickerValue(page)).toBe(`${PROJECTS_BIND}/herdr-overlay`);
});
