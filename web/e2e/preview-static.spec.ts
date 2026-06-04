import { test, expect } from "@playwright/test";

/**
 * E2E for the secure-preview origin (Secure User-Site Preview / Port
 * Exposure, Phase 1).
 *
 * These drive the REAL SvelteKit server (preview webServer sets
 * EZCORP_PREVIEW_APP_HOST=localhost, so `<id>.preview.localhost` requests
 * route through the preview dispatch in hooks.server.ts). We use the
 * APIRequestContext with a spoofed `Host` header rather than a browser
 * navigation, because the preview origin is server-side routing.
 *
 * The access-denied + bad-code + non-preview-host paths return BEFORE any
 * DB access, so they run in plain preview (no DB). The full static
 * happy-path (handoff with a seeded preview_sessions row) needs the
 * Docker harness + a seeded row and is Docker-gated below.
 */

const VALID_ID = "abcdefghjkmnpqrstvwxyz0123";
const APP = "http://localhost:4173";
const PREVIEW_HOST = `${VALID_ID}.preview.localhost`;

test.describe("secure preview origin — access layer", () => {
  test("access denied: a preview request with no __ezpreview cookie is 404", async ({ request }) => {
    const res = await request.get(`${APP}/index.html`, {
      headers: { host: PREVIEW_HOST },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(404);
    // Opaque + safe headers (no referer leak).
    expect(res.headers()["referrer-policy"]).toBe("no-referrer");
  });

  test("/__open with a bad one-time code is 404 (no cookie set)", async ({ request }) => {
    const res = await request.get(`${APP}/__open?c=not-a-real-code`, {
      headers: { host: PREVIEW_HOST },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(404);
    expect(res.headers()["set-cookie"]).toBeFalsy();
  });

  test("a malformed preview-host label does NOT route to the preview origin", async ({ request }) => {
    // 'short' is not a valid 26-char preview id -> parse returns null ->
    // falls through to the normal app (which redirects unauth to /login).
    const res = await request.get(`${APP}/`, {
      headers: { host: "short.preview.localhost" },
      maxRedirects: 0,
    });
    // NOT a 404-from-preview; the app handled it (redirect or page).
    expect(res.status()).not.toBe(404);
  });
});

test.describe("secure preview origin — static happy path (Docker-gated)", () => {
  // Full handoff requires a seeded preview_sessions row + DB + the
  // /api/preview/:id/token mint behind a real session. That lives in the
  // Docker harness (DOCKER_TEST=1 + seed). In plain preview there is no
  // DB so getServablePreview cannot return a row. Skipped, not deleted,
  // so the Docker job picks it up.
  test.skip(!process.env.DOCKER_TEST, "requires Docker harness + seeded preview row");

  test("access denied: an invalid __ezpreview cookie is 404 (verify needs the JWT secret -> DB)", async ({ request }) => {
    const res = await request.get(`${APP}/`, {
      headers: { host: PREVIEW_HOST, cookie: "__ezpreview=garbage.jwt.value" },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(404);
  });

  test("authorized owner is served the static index.html", async ({ request }) => {
    // In the Docker harness: mint a code via POST /api/preview/:id/token
    // (authed app origin), redeem at /__open to get the __ezpreview cookie,
    // then GET / on the preview host and assert the served site body.
    // The seed fixture provisions the row + on-disk .ezcorp/sites/<id>/.
    const seededId = process.env.PREVIEW_SEED_ID ?? VALID_ID;
    const host = `${seededId}.preview.localhost`;
    const mint = await request.post(`${APP}/api/preview/${seededId}/token`);
    expect(mint.ok()).toBeTruthy();
    const { code } = await mint.json();
    const open = await request.get(`${APP}/__open?c=${code}`, {
      headers: { host },
      maxRedirects: 0,
    });
    expect(open.status()).toBe(302);
    const setCookie = open.headers()["set-cookie"] ?? "";
    expect(setCookie).toContain("__ezpreview=");
    const cookieVal = /__ezpreview=([^;]+)/.exec(setCookie)?.[1] ?? "";
    const served = await request.get(`${APP}/`, {
      headers: { host, cookie: `__ezpreview=${cookieVal}` },
    });
    expect(served.status()).toBe(200);
    expect(served.headers()["content-type"]).toContain("text/html");
  });
});
