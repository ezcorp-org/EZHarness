/**
 * Standalone worker spawned by oauth-callback-server.ts to catch the OAuth
 * provider's 302 on a fixed, pre-registered callback port and forward the
 * browser to the main app's /auth/callback page.
 *
 * sec-L5: this file replaces the former inline `bun -e <template-string>`
 * script. Configuration is passed via environment variables, so no
 * user-influenced value is ever interpolated into source code. This
 * removes the "future dropped JSON.stringify yields RCE" footgun.
 *
 * Expected env vars:
 *   EZCORP_OAUTH_CB_PORT   — integer port to bind (127.0.0.1)
 *   EZCORP_OAUTH_CB_URL    — absolute http(s) URL to 302 to with ?code&state
 *
 * The worker validates both values, listens for exactly one OAuth callback
 * request, issues a 302, and exits. It also has a 5 min hard timeout in
 * case the user abandons the flow.
 */

const rawPort = process.env.EZCORP_OAUTH_CB_PORT;
const rawUrl = process.env.EZCORP_OAUTH_CB_URL;

if (!rawPort || !rawUrl) {
  console.error("[oauth-callback-worker] missing EZCORP_OAUTH_CB_PORT or EZCORP_OAUTH_CB_URL");
  process.exit(1);
}

const port = Number(rawPort);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`[oauth-callback-worker] invalid port: ${rawPort}`);
  process.exit(1);
}

let appCallbackUrl: URL;
try {
  appCallbackUrl = new URL(rawUrl);
} catch {
  console.error(`[oauth-callback-worker] invalid EZCORP_OAUTH_CB_URL: ${rawUrl}`);
  process.exit(1);
}
if (appCallbackUrl.protocol !== "http:" && appCallbackUrl.protocol !== "https:") {
  console.error(`[oauth-callback-worker] invalid protocol: ${appCallbackUrl.protocol}`);
  process.exit(1);
}

const baseRedirect = appCallbackUrl.toString();

const server = Bun.serve({
  port,
  hostname: "localhost",
  fetch(req) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/auth/callback")) {
      return new Response("Not found", { status: 404 });
    }
    const params = url.searchParams.toString();
    const redirectTo = params ? `${baseRedirect}?${params}` : baseRedirect;
    setTimeout(() => {
      server.stop(true);
      process.exit(0);
    }, 1000);
    return new Response(null, { status: 302, headers: { Location: redirectTo } });
  },
});

// Hard timeout: never leak a listener for longer than 5 min.
setTimeout(
  () => {
    server.stop(true);
    process.exit(0);
  },
  5 * 60 * 1000,
);
