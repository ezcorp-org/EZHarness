/**
 * Global setup for Docker Compose E2E tests.
 * Authenticates once and saves the session cookie to a storage state file
 * that all tests reuse, avoiding rate limit issues from per-test auth.
 */
import { chromium } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const STORAGE_STATE_PATH = path.join(__dirname, ".docker-auth.json");

export default async function globalSetup() {
  const baseURL = process.env.DOCKER_TEST_URL ?? "http://localhost:3000";

  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();

  // Login via the real API
  const res = await page.request.post("/api/auth/login", {
    data: { email: "test@test.com", password: "Test123!" },
  });
  if (!res.ok()) {
    const body = await res.text();
    await browser.close();
    throw new Error(`Docker auth setup failed (${res.status()}): ${body}`);
  }

  // Save the authenticated state (cookies)
  await context.storageState({ path: STORAGE_STATE_PATH });
  await browser.close();
}
