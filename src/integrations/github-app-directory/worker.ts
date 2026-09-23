/// <reference path="../../../worker/github-connect/worker-configuration.d.ts" />

const RESPONSE_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
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

const STYLES = `:root{color-scheme:light;--ink:#15302b;--muted:#526962;--line:#ccd9d1;--paper:#f5f6ef;--accent:#d8fa85}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font-family:Verdana,Geneva,sans-serif;line-height:1.55}
a{color:inherit}a:focus-visible{outline:3px solid #538b26;outline-offset:4px;border-radius:3px}.shell{width:min(1160px,calc(100% - 48px));margin-inline:auto}
.site-header{border-bottom:1px solid var(--line)}.header-inner{min-height:82px;display:flex;align-items:center;justify-content:space-between;gap:20px}
.wordmark{text-decoration:none;font-weight:800;letter-spacing:-.06em;font-size:1.45rem}.wordmark-mark{display:inline-grid;place-items:center;width:36px;height:36px;margin-right:10px;background:var(--ink);color:var(--accent);font-size:.82rem;letter-spacing:-.08em;border-radius:8px;vertical-align:middle}
.header-note,.eyebrow,.section-label,.panel-kicker,.meta-label{font-size:.72rem;font-weight:700;letter-spacing:.16em;text-transform:uppercase}.header-note{color:var(--muted)}
.hero{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(300px,.8fr);gap:clamp(32px,6vw,90px);align-items:center;padding:clamp(70px,10vw,132px) 0 92px}
.eyebrow{display:flex;align-items:center;gap:10px;color:#386a4d;margin:0 0 25px}.eyebrow::before{content:"";width:9px;height:9px;border-radius:50%;background:#62a257;box-shadow:0 0 0 5px #dcecd6}
h1,h2,h3,p{margin-top:0}h1,h2,.step-number{font-family:Georgia,'Times New Roman',serif}h1{font-size:clamp(3.4rem,6.2vw,6.4rem);line-height:1.02;letter-spacing:-.055em;margin-bottom:31px;font-weight:500}h1 em{font-style:normal;color:#51815b}
.lede{max-width:580px;font-size:clamp(1.06rem,1.5vw,1.24rem);line-height:1.72;color:var(--muted);margin-bottom:0}
.panel{position:relative;overflow:hidden;border-radius:24px;background:#17322e;color:#f3faee;padding:34px;min-height:400px;box-shadow:0 25px 55px #17322e26}
.panel::after{content:"";position:absolute;width:330px;height:330px;border:1px solid #ffffff24;border-radius:50%;right:-130px;bottom:-175px;box-shadow:0 0 0 42px #ffffff08,0 0 0 85px #ffffff06;pointer-events:none}
.panel-kicker{color:#c8f286;margin-bottom:64px}.panel h2{font-size:clamp(1.85rem,3vw,2.5rem);line-height:1.18;letter-spacing:-.035em;max-width:350px;margin-bottom:20px;font-weight:500}.panel p:not(.panel-kicker){color:#d6e3d9;max-width:340px;margin-bottom:32px}
.panel-link{position:relative;z-index:1;display:inline-flex;align-items:center;gap:9px;padding:12px 18px;border:1px solid #adcf9b;border-radius:999px;text-decoration:none;font-size:.86rem;font-weight:700}.panel-link:hover{background:#d8fa85;color:#17322e}
.steps-section{border-top:1px solid var(--line);padding:44px 0 90px}.section-top{display:flex;align-items:end;justify-content:space-between;gap:24px;margin-bottom:42px}.section-label{color:#568063;margin:0 0 10px}.section-top h2{font-size:clamp(2rem,3vw,3.1rem);font-weight:500;letter-spacing:-.04em;line-height:1.1;margin:0}.section-note{max-width:300px;color:var(--muted);font-size:.88rem;margin:0}
.steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px;list-style:none;margin:0;padding:0}.step{border-top:2px solid var(--ink);padding:22px 5px 0 0}.step-number{display:block;color:#7e9a88;font-size:2.15rem;line-height:1;margin-bottom:27px}.step h3{font-size:1.08rem;margin-bottom:10px}.step p{font-size:.9rem;color:var(--muted);max-width:315px;margin-bottom:0}
.action{display:inline-block;margin-top:18px;color:#1c6144;text-decoration-thickness:1px;text-underline-offset:4px;font-weight:700;font-size:.85rem}.action:hover{color:#0d3927}
.notice{display:flex;align-items:flex-start;gap:22px;background:#e7ecdf;border:1px solid #cedac9;border-radius:18px;padding:27px 31px;margin-bottom:72px}.notice-icon{display:grid;place-items:center;flex:none;width:36px;height:36px;border-radius:10px;background:#cce3b4;font-weight:700}.notice strong{display:block;margin-bottom:5px}.notice p{margin:0;color:var(--muted);font-size:.88rem}
.site-footer{border-top:1px solid var(--line);padding:28px 0 38px}.footer-inner{display:flex;align-items:center;justify-content:space-between;gap:20px;color:var(--muted);font-size:.78rem}.footer-inner p{margin:0}.footer-inner a{text-underline-offset:3px}
@media(max-width:800px){.hero{grid-template-columns:1fr;padding:62px 0 72px}.panel{min-height:330px}.panel-kicker{margin-bottom:45px}.section-top{display:block}.section-note{margin-top:16px}.steps{grid-template-columns:1fr;gap:30px}.step-number{margin-bottom:14px}.notice{margin-bottom:55px}}
@media(max-width:540px){.shell{width:min(100% - 36px,1160px)}.header-inner{min-height:70px}.header-note{display:none}.hero{padding-top:52px}.panel{padding:28px;min-height:350px}.steps-section{padding-bottom:62px}.notice{padding:22px;gap:15px}.footer-inner{align-items:flex-start;flex-direction:column}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}`;

function landing(app: PublicApp): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect GitHub to EZCorp</title>
  <meta name="description" content="Connect GitHub to your own EZCorp installation using GitHub's device flow.">
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <header class="site-header">
    <div class="shell header-inner">
      <a class="wordmark" href="/" aria-label="EZCorp home"><span class="wordmark-mark">EZ</span>EZCorp</a>
      <span class="header-note">Public GitHub App directory</span>
    </div>
  </header>
  <main class="shell">
    <section class="hero" aria-labelledby="hero-title">
      <div>
        <p class="eyebrow">GitHub connection</p>
        <h1 id="hero-title">Connect GitHub.<br><em>Keep the keys local.</em></h1>
        <p class="lede">Start in your own EZCorp installation. It guides you through GitHub's device flow while your connection stays with your installation.</p>
      </div>
      <aside class="panel" aria-labelledby="panel-title">
        <p class="panel-kicker">01 / Start here</p>
        <h2 id="panel-title">Your installation starts the connection.</h2>
        <p>Open EZCorp Settings and select <strong>Connect GitHub</strong>. You'll get a short code to enter on GitHub.</p>
        <a class="panel-link" href="https://github.com/login/device" rel="noreferrer">GitHub device page <span aria-hidden="true">↗</span></a>
      </aside>
    </section>
    <section class="steps-section" aria-labelledby="steps-title">
      <div class="section-top">
        <div><p class="section-label">A short, direct path</p><h2 id="steps-title">Three steps to connect</h2></div>
        <p class="section-note">Only enter a code you just requested in your own EZCorp installation.</p>
      </div>
      <ol class="steps">
        <li class="step"><span class="step-number" aria-hidden="true">01</span><h3>Open EZCorp Settings</h3><p>Select Connect GitHub. Keep the tab open so you can return after approval.</p></li>
        <li class="step"><span class="step-number" aria-hidden="true">02</span><h3>Enter your code on GitHub</h3><p>GitHub will ask you to confirm the account. Check that the code matches the one in EZCorp.</p><a class="action" href="https://github.com/login/device" rel="noreferrer">Open GitHub's device page <span aria-hidden="true">↗</span></a></li>
        <li class="step"><span class="step-number" aria-hidden="true">03</span><h3>Return to EZCorp</h3><p>Finish the connection in your original tab, then choose which repositories the App can access.</p></li>
      </ol>
    </section>
    <aside class="notice" aria-label="Privacy note"><span class="notice-icon" aria-hidden="true">✓</span><div><strong>This page only explains the connection.</strong><p>It does not handle your code, tokens, session, installation URL, or repository data.</p></div></aside>
  </main>
  <footer class="site-footer"><div class="shell footer-inner"><p>EZCorp GitHub App · ID ${app.appId} · Client ${app.clientId}</p><a href="https://github.com/apps/${app.appSlug}" rel="noreferrer">View ${app.appSlug} on GitHub <span aria-hidden="true">↗</span></a></div></footer>
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
    if (pathname === "/style.css") return response(STYLES, 200, "text/css; charset=utf-8", head);
    if (pathname === "/.well-known/ezcorp-github.json") {
      return response(JSON.stringify({ schemaVersion: 1, flow: "device", ...app }), 200, "application/json; charset=utf-8", head);
    }
    if (pathname === "/health") return response("ok", 200, "text/plain; charset=utf-8", head);
    return response("Not Found", 404, "text/plain; charset=utf-8", head);
  },
};
