/**
 * Real-auth Playwright globalSetup.
 *
 * Runs once per `playwright test` invocation, AFTER the webServer is
 * accepting traffic but BEFORE any spec executes. Bootstraps the
 * first-boot admin via `POST /api/auth/setup`, then logs in via
 * `POST /api/auth/login`, and persists the resulting session cookie
 * to `e2e/.real-auth.json` for every spec to reuse via
 * `use.storageState`.
 *
 * Idempotency: a per-run fresh `EZCORP_DB_PATH` (see
 * `playwright.real.config.ts`) means the DB is empty on every
 * invocation, so `/setup` ALWAYS returns 201. If you ever reuse a DB
 * dir across runs (e.g. via `PI_E2E_REAL_DB_PATH` override), setup
 * will return 403 ("setup already completed") and we fall back to
 * direct login.
 *
 * Open-question resolution (see brief): this project has NO
 * `/api/auth/register` endpoint. The first-boot bootstrap path is
 * `POST /api/auth/setup` (gated on `getUserCount() === 0`). It
 * accepts { name, email, password } and creates an admin user. We
 * use that path; subsequent runs against the same DB fall back to
 * `/api/auth/login` (idempotent contract).
 */
import { chromium, type APIRequestContext } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const STORAGE_STATE_PATH = path.join(__dirname, ".real-auth.json");

/** Single source of truth for test creds — also imported by specs. */
export const TEST_USER = {
  name: "E2E Tester",
  email: "e2e-real@test.local",
  password: "GoodPass1!",
} as const;

async function setupAdmin(request: APIRequestContext, baseURL: string): Promise<void> {
  const setupRes = await request.post(`${baseURL}/api/auth/setup`, {
    data: { name: TEST_USER.name, email: TEST_USER.email, password: TEST_USER.password },
  });
  if (setupRes.ok()) return;
  if (setupRes.status() === 403) {
    // "Setup already completed" — the DB was reused. Fall through to
    // the login step below; the user must exist with these creds.
    return;
  }
  const body = await setupRes.text();
  throw new Error(`setup failed (${setupRes.status()}): ${body}`);
}

async function login(request: APIRequestContext, baseURL: string): Promise<void> {
  const loginRes = await request.post(`${baseURL}/api/auth/login`, {
    data: { email: TEST_USER.email, password: TEST_USER.password },
  });
  if (!loginRes.ok()) {
    const body = await loginRes.text();
    throw new Error(`login failed (${loginRes.status()}): ${body}`);
  }
}

/**
 * The first-boot admin created via `/api/auth/setup` has
 * `onboardedAt === null`, which `hooks.server.ts:517` turns into a
 * 302 → `/onboarding` redirect for every page-nav (API routes bypass
 * via the `/api/` prefix check, which is why the line-18
 * `/api/auth/me` sanity test passes but anything that navigates a
 * real page would land on the onboarding wizard).
 *
 * The harness contract is "authenticated admin who is already past
 * setup" — onboarding wizard UX is out of scope. POST
 * `/api/onboarding/complete` marks the user onboarded server-side
 * and unblocks page nav. 204 = success; any other status fails fast.
 */
async function markOnboarded(request: APIRequestContext, baseURL: string): Promise<void> {
  const res = await request.post(`${baseURL}/api/onboarding/complete`);
  if (res.status() !== 204) {
    const body = await res.text();
    throw new Error(`onboarding/complete failed (${res.status()}): ${body}`);
  }
}

export default async function globalSetup(): Promise<void> {
  const baseURL = process.env.PI_E2E_REAL_BASE_URL ?? "http://localhost:4173";

  // Launch a real browser context. We use it for two reasons:
  //  (1) `context.storageState()` captures the cookies set on the
  //      context, which Playwright's spec runner then replays via
  //      `use.storageState`.
  //  (2) The `setSessionCookie()` helper writes an HttpOnly cookie
  //      with the JWT — `request.post` from `chromium.launch()`'s
  //      context honours `Set-Cookie` and stores it for us.
  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL });
  const apiRequest = context.request;

  try {
    await setupAdmin(apiRequest, baseURL);
    await login(apiRequest, baseURL);
    await markOnboarded(apiRequest, baseURL);

    // Sanity: hitting `/api/auth/me` must succeed with our user.
    const me = await apiRequest.get(`${baseURL}/api/auth/me`);
    if (!me.ok()) {
      const body = await me.text();
      throw new Error(`/api/auth/me failed after login (${me.status()}): ${body}`);
    }

    await context.storageState({ path: STORAGE_STATE_PATH });
  } finally {
    await browser.close();
  }
}
