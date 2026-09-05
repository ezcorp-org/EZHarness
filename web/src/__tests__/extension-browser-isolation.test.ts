import { afterAll, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { SANDBOX_FLAGS_STRICT } from "../lib/components/tool-cards/iframe-card-logic";
import { restoreModuleMocks } from "../../../src/__tests__/helpers/mock-cleanup";

const directory = await mkdtemp(join(tmpdir(), "ez-browser-boundary-"));
const rateLimiterExports = await import("../lib/server/security/rate-limiter");
mock.module("$server/auth/middleware", () => ({ requireAuth: (locals: { user?: unknown }) => { if (!locals.user) throw new Error("Unauthenticated"); return locals.user; } }));
mock.module("$lib/server/security/api-keys", () => ({ requireScope: () => null }));
mock.module("$lib/server/http-errors", () => ({ errorJson: (status: number, error: string) => Response.json({ error }, { status }) }));
mock.module("$server/chat/attachments/ext-files-resolver", () => ({ extensionDataRoot: () => directory }));
mock.module("$server/db/queries/extensions", () => ({ getExtensionByName: async () => ({ enabled: true }) }));
mock.module("$lib/server/security/rate-limiter", () => rateLimiterExports);
const { GET } = await import("../routes/api/extensions/[name]/data/[...path]/+server");
afterAll(async () => { restoreModuleMocks(); await rm(directory, { recursive: true, force: true }); });

test("served extension HTML cannot read its authenticated parent or use app session APIs", async () => {
  const session = randomUUID();
  let apiRequests = 0;
  const script = `window.report={};
    try { window.report.parentText=parent.document.body.dataset.secret; } catch { window.report.parentDenied=true; }
    try { window.report.cookie=document.cookie; } catch { window.report.cookieDenied=true; }
    try { window.report.storage=localStorage.getItem('secret'); } catch { window.report.storageDenied=true; }
    Promise.all([
      (async()=>{try { window.report.api=await (await fetch('/api/private',{credentials:'include'})).text(); } catch { window.report.apiDenied=true; }})(),
      (async()=>{try { await parent.fetch('/api/private',{method:'POST',credentials:'include'}); window.report.parentApi=true; } catch { window.report.parentApiDenied=true; }})()
    ]).then(()=>window.report.done=true);
    if(document.querySelector('button'))document.querySelector('button').onclick=()=>document.querySelector('output').textContent='1';`;
  await writeFile(join(directory, "probe.html"), `<button>Increment</button><output>0</output><script>${script}</script>`);
  await writeFile(join(directory, "probe.svg"), `<svg xmlns="http://www.w3.org/2000/svg"><script><![CDATA[${script}]]></script></svg>`);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.headers.get("cookie") !== `session=${session}`) return new Response("Denied", { status: 401 });
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response(`<body data-secret="parent-private"><iframe title="Extension" src="/api/extensions/probe/data/probe.html" sandbox="${SANDBOX_FLAGS_STRICT}"></iframe></body>`, { headers: { "content-type": "text/html" } });
    if (url.pathname === "/api/private") { apiRequests++; return new Response("session-private"); }
    return await GET({ params: { name: "probe", path: url.pathname.split("/").at(-1) }, locals: { user: { id: "owner" } } } as never);
  } });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  try {
    const context = await browser.newContext();
    await context.addCookies([{ name: "session", value: session, url: server.url.toString(), httpOnly: true, sameSite: "Strict" }]);
    const page = await context.newPage();
    await page.goto(server.url.toString());
    const frame = page.frames().find(candidate => candidate !== page.mainFrame())!;
    await frame.waitForFunction(() => (window as any).report?.done);
    const report = await frame.evaluate(() => (window as any).report);
    expect(report).toMatchObject({ parentDenied: true, cookieDenied: true, storageDenied: true, apiDenied: true, parentApiDenied: true });
    expect(apiRequests).toBe(0);
    await frame.getByRole("button", { name: "Increment" }).click();
    expect(await frame.locator("output").textContent()).toBe("1");
    for (const file of ["probe.html", "probe.svg"]) {
      await page.goto(new URL(`/api/extensions/probe/data/${file}`, server.url).toString());
      await page.waitForFunction(() => (window as any).report?.done);
      expect(await page.evaluate(() => (window as any).report)).toMatchObject({ cookieDenied: true, storageDenied: true, apiDenied: true });
      expect(apiRequests).toBe(0);
    }
  } finally { await browser.close(); await server.stop(true); }
}, 60_000);
