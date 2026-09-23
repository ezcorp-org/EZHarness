/// <reference path="../../../worker/github-connect/worker-configuration.d.ts" />

const RESPONSE_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

type PublicApp = {
  appId: number;
  appSlug: string;
  clientId: string;
};

function readPublicApp(env: Env): PublicApp | null {
  const appId = env.APP_ID ?? "";
  const appSlug = env.APP_SLUG ?? "";
  const clientId = env.APP_CLIENT_ID ?? "";
  if (!/^[1-9]\d{0,15}$/.test(appId) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(appSlug)) return null;
  if (appSlug.length > 100 || !/^Iv[A-Za-z0-9]{8,80}$/.test(clientId)) return null;
  const numericId = Number(appId);
  return Number.isSafeInteger(numericId) ? { appId: numericId, appSlug, clientId } : null;
}

function response(body: string, status: number, contentType: string, head: boolean, allow?: string): Response {
  const headers = new Headers(RESPONSE_HEADERS);
  headers.set("content-type", contentType);
  if (allow) headers.set("allow", allow);
  return new Response(head ? null : body, { status, headers });
}

function landing(app: PublicApp): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect GitHub to EZCorp</title>
</head>
<body>
  <main>
    <h1>Connect GitHub to EZCorp</h1>
    <p>Start the connection in your own EZCorp installation. It will show a short code and a link to GitHub. Enter only a code you just requested there.</p>
    <ol>
      <li>Open Settings in your EZCorp installation and select Connect GitHub.</li>
      <li>Open <a href="https://github.com/login/device" rel="noreferrer">GitHub's device page</a> and enter the code shown in EZCorp.</li>
      <li>Return to EZCorp to finish connecting and choose repository access.</li>
    </ol>
    <p>GitHub App: <a href="https://github.com/apps/${app.appSlug}" rel="noreferrer">${app.appSlug}</a>.</p>
    <p>This page does not handle connection codes, tokens, or repository data.</p>
  </main>
</body>
</html>`;
}

export default {
  fetch(request: Request, env: Env): Response {
    const head = request.method === "HEAD";
    if (request.method !== "GET" && !head) {
      return response("Method Not Allowed", 405, "text/plain; charset=utf-8", false, "GET, HEAD");
    }
    // There is no callback or session surface on this service. Reject input without inspecting its value.
    if (request.url.includes("?") || request.headers.has("cookie") || request.headers.has("authorization")) {
      return response("Bad Request", 400, "text/plain; charset=utf-8", head);
    }
    const app = readPublicApp(env);
    if (!app) return response("Service Unavailable", 503, "text/plain; charset=utf-8", head);

    const pathname = new URL(request.url).pathname;
    if (pathname === "/") return response(landing(app), 200, "text/html; charset=utf-8", head);
    if (pathname === "/.well-known/ezcorp-github.json") {
      return response(JSON.stringify({ schemaVersion: 1, flow: "device", ...app }), 200, "application/json; charset=utf-8", head);
    }
    if (pathname === "/health") return response("ok", 200, "text/plain; charset=utf-8", head);
    return response("Not Found", 404, "text/plain; charset=utf-8", head);
  },
};
