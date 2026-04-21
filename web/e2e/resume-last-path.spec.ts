import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const STORAGE_KEY = "ezcorp-last-path";

test.describe("Resume last path", () => {
  test("saves last path to localStorage on navigation", async ({
    page,
    mockApi,
  }) => {
    const proj = makeProject();
    await mockApi({ projects: [proj] });
    await page.goto(`/project/${proj.id}/chat`);

    // `afterNavigate` fires asynchronously after initial hydration — poll
    // until the save lands rather than snapshotting immediately.
    await expect
      .poll(
        async () =>
          await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY),
      )
      .toBe(`/project/${proj.id}/chat`);
  });

  test("root path is always the landing page — no auto-resume even with saved path", async ({
    page,
    mockApi,
  }) => {
    const proj = makeProject();
    await mockApi({ projects: [proj] });

    // Pre-seed the saved path that would previously have triggered a resume.
    await page.goto("/");
    await page.evaluate(
      ({ key, value }) => localStorage.setItem(key, value),
      { key: STORAGE_KEY, value: `/project/${proj.id}/settings` },
    );

    await page.goto("/");
    // Give any (now-removed) redirect logic time to fire. URL must still be root.
    await page.waitForTimeout(500);
    expect(page.url()).toMatch(/\/$/);
  });

  test("does not save root path to localStorage", async ({
    page,
    mockApi,
  }) => {
    const proj = makeProject();
    await mockApi({ projects: [proj] });

    // First navigate somewhere valid to set a value — wait for the save.
    await page.goto(`/project/${proj.id}/chat`);
    await expect
      .poll(
        async () =>
          await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY),
      )
      .toBe(`/project/${proj.id}/chat`);

    // Now navigate to root (landing page)
    await page.goto("/");
    await page.waitForTimeout(500);

    const savedAfter = await page.evaluate(
      (key) => localStorage.getItem(key),
      STORAGE_KEY,
    );
    // Root path must NOT overwrite the previously saved path
    expect(savedAfter).not.toBe("/");
  });
});
