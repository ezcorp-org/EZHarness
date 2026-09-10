import { test, expect } from "./fixtures/hydration.js";

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
 * The real-auth harness supplies the authenticated user, a real PGlite DB,
 * and the intentionally gated static-preview fixture. It runs this whole
 * file so denial and successful handoff exercise one configured origin.
 */

const VALID_ID = "abcdefghjkmnpqrstvwxyz0123";
const APP = process.env.PI_E2E_REAL_BASE_URL ?? "http://localhost:4173";
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

test.describe("secure preview origin — static happy path", () => {
  test("access denied: an invalid __ezpreview cookie is 404 (verify needs the JWT secret -> DB)", async ({ request }) => {
    const res = await request.get(`${APP}/`, {
      headers: { host: PREVIEW_HOST, cookie: "__ezpreview=garbage.jwt.value" },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(404);
  });

  test("authorized owner is served the static index.html", async ({ request }) => {
    const seeded = await request.post("/api/__test/seed-static-preview");
    expect(seeded.ok(), await seeded.text()).toBeTruthy();
    const { previewId, code } = await seeded.json();
    try {
      const host = `${previewId}.preview.localhost`;
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
      expect(await served.text()).toContain("E2E static preview");
    } finally {
      const cleanup = await request.delete("/api/__test/seed-static-preview", { data: { previewId } });
      expect(cleanup.ok(), await cleanup.text()).toBeTruthy();
    }
  });
});
