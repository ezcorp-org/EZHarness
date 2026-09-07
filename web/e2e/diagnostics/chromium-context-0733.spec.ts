import { expect, test, waitForHydration } from "../fixtures/hydration.js";
import type { Browser, Page } from "@playwright/test";

const PAIRS = 10;

type CaseName = "form" | "invalid-password";

async function withCleanup(action: () => Promise<void>, cleanup: () => Promise<void>): Promise<void> {
  const errors: unknown[] = [];
  try { await action(); } catch (error) { errors.push(error); }
  try { await cleanup(); } catch (error) { errors.push(error); }
  if (errors.length > 0) throw new AggregateError(errors, "context diagnostic or cleanup failed");
}

async function inFreshSetupContext(browser: Browser, baseURL: string | undefined, caseName: CaseName): Promise<void> {
  const context = await browser.newContext({ baseURL });
  await withCleanup(async () => {
    const page = await context.newPage();
    await page.goto("/setup");
    await waitForHydration(page);
    if (caseName === "form") await assertSetupForm(page);
    else await assertInvalidPasswordIsClientOnly(page);
  }, () => context.close());
}

async function assertSetupForm(page: Page): Promise<void> {
  await expect(page).toHaveTitle("EZCorp | Setup");
  await expect(page.getByRole("heading", { name: "Welcome to EZCorp" })).toBeVisible();
  const name = page.getByLabel("Name");
  const email = page.getByLabel("Email");
  const password = page.getByLabel("Password", { exact: true });
  const confirmation = page.getByLabel("Confirm password");
  await expect(name).toHaveAttribute("type", "text");
  await expect(email).toHaveAttribute("type", "email");
  await expect(password).toHaveAttribute("minlength", "8");
  await expect(confirmation).toHaveAttribute("autocomplete", "new-password");
  await email.fill("not-an-email");
  await password.fill("Short1");
  expect(await name.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(false);
  expect(await email.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(false);
  expect(await password.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(false);
}

async function assertInvalidPasswordIsClientOnly(page: Page): Promise<void> {
  const setupCalls: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/auth/setup" && request.method() === "POST") setupCalls.push(request.url());
  });
  await page.getByLabel("Name").fill("First Admin");
  await page.getByLabel("Email").fill("first-admin@example.test");
  await page.getByLabel("Password", { exact: true }).fill("GoodPass");
  await page.getByLabel("Confirm password").fill("GoodPass");
  await page.getByRole("button", { name: "Create Admin Account" }).click();
  await expect(page.getByText("Password must contain a digit")).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("aria-invalid", "true");
  expect(setupCalls).toEqual([]);
}

test("serially closes hydrated first-run contexts in one worker browser", async ({ browser, baseURL }, testInfo) => {
  const completed: string[] = [];
  await withCleanup(async () => {
    for (let cycle = 1; cycle <= PAIRS; cycle++) {
      for (const caseName of ["form", "invalid-password"] as const) {
        await inFreshSetupContext(browser, baseURL, caseName);
        completed.push(`${cycle}:${caseName}`);
        console.log(JSON.stringify({ phase: "context-closed", cycle, caseName, completed: completed.length }));
      }
    }
    const finalContext = await browser.newContext({ baseURL });
    await finalContext.close();
  }, () => testInfo.attach("completed-context-phases", {
    body: JSON.stringify({ pairs: PAIRS, completed }),
    contentType: "application/json",
  }));
});
