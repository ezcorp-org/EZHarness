import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { mockCard } from "../../docs/extensions/examples/graded-card-scanner/app/lib/mock-card.js";
import { renderItfRgba, rgbaToJpeg, rgbaToPng } from "../../docs/extensions/examples/graded-card-scanner/__tests__/helpers/barcode-render";

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs/extensions/examples/graded-card-scanner");
const FIXTURE_URL = "/scanner-bridge-fixture";
const PREVIEW_URL = "/api/extensions/graded-card-scanner/preview";
const configuration = JSON.parse(readFileSync(join(SOURCE, "ezcorp.browser.json"), "utf8"));
const builderModule = join(SOURCE, "../../../../packages/@ezcorp/extension-runner/src/browser.ts");
const builderCommand = `import { browserBuilderProgram } from ${JSON.stringify(builderModule)}; await import("data:text/javascript;base64," + Buffer.from(browserBuilderProgram).toString("base64"));`;
const compiled = JSON.parse(execFileSync("bun", ["-e", builderCommand, JSON.stringify(configuration)], { cwd: SOURCE, encoding: "utf8", maxBuffer: 12 * 1024 * 1024 })).html as string;
const cameraFrame = "data:image/jpeg;base64," + Buffer.from(rgbaToJpeg(renderItfRgba("87654321"))).toString("base64");

function app(page: Page) { return page.frameLocator('iframe[title="Scanner fixture"]'); }

async function serveApp(page: Page, options: { beforeInitialList?: () => Promise<void>; initialListError?: string } = {}): Promise<void> {
  const saved = new Map<string, Record<string, unknown>>();
  let initialList = true;
  await page.exposeFunction("__scannerFixtureRequest", async (request: { method: string; params: { toolName: string; input: Record<string, unknown> } }) => {
    expect(request.method).toBe("tool.invoke");
    const { toolName, input } = request.params;
    expect(configuration.tools).toContain(toolName);
    expect(input).not.toHaveProperty("conversationId");
    let result: unknown;
    switch (toolName) {
      case "lookup_card":
        if (input.cert === "99999999") return { success: false, error: "Lookup unavailable." };
        result = mockCard(String(input.cert));
        break;
      case "scanner_saved_get": result = saved.get(String(input.cert)) ?? null; break;
      case "scanner_saved_upsert": {
        const card = input.card as Record<string, unknown>;
        saved.set(String(card.cert), structuredClone(card)); result = { saved: true }; break;
      }
      case "scanner_saved_list": {
        if (initialList) {
          initialList = false;
          await options.beforeInitialList?.();
          if (options.initialListError) return { success: false, error: options.initialListError };
        }
        result = { cards: [...saved.values()], nextCursor: null }; break;
      }
      case "scanner_saved_delete": result = { deleted: saved.delete(String(input.cert)) }; break;
      case "scanner_saved_clear": saved.clear(); result = { deleted: true }; break;
      default: throw new Error("Unexpected scanner fixture tool.");
    }
    return { success: true, output: JSON.stringify(result) };
  });
  await page.route("**" + PREVIEW_URL + "**", route => {
    const nonce = new URL(route.request().url()).searchParams.get("nonce");
    return route.fulfill({ contentType: "text/html; charset=utf-8", headers: { "Content-Security-Policy": "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'" }, body: '<script>Object.defineProperty(window,"__EZCORP_CANVAS_NONCE__",{value:' + JSON.stringify(nonce) + '});</script>' + compiled });
  });
  await page.route("**" + FIXTURE_URL, route => route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#0f172a;color:#f8fafc;font:14px system-ui}header{padding:12px}button{padding:10px}iframe{border:0;width:100%;height:calc(100vh - 52px)}</style></head><body><header>Controlled scanner bridge · Selected conversation: fixture-owned <button id="start" hidden>Start camera</button><button id="stop" hidden>Stop camera</button></header><iframe title="Scanner fixture" sandbox="allow-scripts"></iframe><script>
      const frame=document.querySelector('iframe'), nonce=crypto.randomUUID();
      frame.src=${JSON.stringify(PREVIEW_URL)}+'?nonce='+nonce;
      let pendingCamera,sessionId,port;
      const reply=(request,result)=>port.postMessage({type:'ezcorp.canvas.response',nonce,id:request.id,result});
      window.addEventListener('message',event=>{
        if(port||event.source!==frame.contentWindow||event.origin!=='null'||event.data?.nonce!==nonce||event.data.type!=='ezcorp.canvas.connect'||event.ports.length!==1)return;
        port=event.ports[0];
        port.onmessage=async message=>{
        const request=message.data;
        if(request?.nonce!==nonce||request.type!=='ezcorp.canvas.request')return;
        if(request.method==='camera.start'){pendingCamera=request;document.querySelector('#start').hidden=false;return;}
        if(request.method==='camera.stop'){sessionId=null;document.querySelector('#stop').hidden=true;reply(request,{stopped:true});return;}
        reply(request,await window.__scannerFixtureRequest(request));
        };
        port.start();
      });
      document.querySelector('#start').onclick=()=>{
        sessionId=crypto.randomUUID();reply(pendingCamera,{sessionId});
        document.querySelector('#start').hidden=true;document.querySelector('#stop').hidden=false;
        setTimeout(()=>{if(sessionId)port.postMessage({type:'ezcorp.canvas.camera',nonce,sessionId,dataUrl:${JSON.stringify(cameraFrame)}});},50);
      };
      document.querySelector('#stop').onclick=()=>{
        port.postMessage({type:'ezcorp.canvas.camera-stopped',nonce,sessionId,reason:'User stopped camera.'});
        sessionId=null;document.querySelector('#stop').hidden=true;
      };
    </script></body></html>`,
  }));
}

async function simulate(page: Page, text: string): Promise<void> {
  await expect(app(page).getByRole("main")).toHaveAttribute("aria-busy", "false");
  return app(page).locator("body").evaluate((_element, cert) => (window as unknown as { __gcsSimulateScan: (value: string) => Promise<void> }).__gcsSimulateScan(cert), text);
}

for (const fails of [false, true]) test(`scanner actions wait for saved-list ${fails ? "visible failure" : "success"} without moving`, async ({ page }) => {
  const waiting = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await serveApp(page, { beforeInitialList: async () => { waiting.resolve(); await release.promise; }, ...(fails ? { initialListError: "Saved-card service unavailable." } : {}) });
  await page.goto(FIXTURE_URL);
  await waiting.promise;
  try {
    const scanner = app(page);
    const main = scanner.getByRole("main");
    await expect(main).toHaveAttribute("aria-busy", "true");
    for (const name of ["gcs-pause", "gcs-upload", "gcs-manual-input", "gcs-manual-add", "gcs-simulate", "gcs-search", "gcs-clear-all"]) await expect(scanner.getByTestId(name)).toBeDisabled();
    const before = await scanner.getByTestId("gcs-pause").boundingBox();
    expect(before).not.toBeNull();
    await page.mouse.click(before!.x + before!.width / 2, before!.y + before!.height / 2);
    await expect(page.getByRole("button", { name: "Start camera", exact: true })).toBeHidden();
    release.resolve();
    await expect(main).toHaveAttribute("aria-busy", "false");
    await expect(scanner.getByTestId("gcs-pause")).toBeEnabled();
    await expect(scanner.getByTestId("gcs-status")).toContainText(fails ? "Reload this page" : "Start scanning");
    const after = await scanner.getByTestId("gcs-pause").boundingBox();
    expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1);
    await scanner.getByTestId("gcs-pause").click();
    await expect(page.getByRole("button", { name: "Start camera", exact: true })).toBeVisible();
  } finally { release.resolve(); }
});

test.describe("Graded Card Scanner opaque app with controlled host bridge", () => {
	test.beforeEach(async ({ page }) => {
		await serveApp(page);
		await page.goto(FIXTURE_URL);
	});

	test("scan → list → detail → chart works with zero network, and captures evidence @evidence", async ({
		page,
	}, testInfo) => {
		await simulate(page, "49392223");

		// One capture: pending row lands, resolves to done via explicit sample mode.
		await expect(app(page).getByTestId("gcs-row")).toHaveCount(1);
		await expect(app(page).getByTestId("gcs-status-chip")).toHaveText("done");
		await expect(app(page).getByTestId("gcs-mock-banner")).toBeVisible();
		await expect(app(page).getByTestId("gcs-count")).toHaveText("1");
		await expect(app(page).getByTestId("gcs-row")).toContainText("Charizard");
		await captureEvidence(page, testInfo, "graded-card-scanner-list");

		// Detail view.
		await app(page).getByTestId("gcs-row").click();
		await expect(app(page).getByTestId("gcs-detail")).toBeVisible();
		await expect(app(page).getByTestId("gcs-detail-title")).toHaveText(
			"1999 Pokemon Base Set Charizard #4",
		);
		const rows = app(page).getByTestId("gcs-grade-table").locator("tbody tr");
		await expect(rows).toHaveCount(10);
		// Scanned grade highlighted; lowest priced grade has no lower comparator.
		await expect(app(page).locator(".gcs-tr-scanned")).toContainText("PSA 9");
		await expect(rows.first()).toContainText("—");
		// Chart renders both panels with the scanned bar marked.
		const chart = app(page).getByTestId("gcs-chart").locator("svg");
		await expect(chart).toBeVisible();
		await expect(chart.locator("rect.gcs-bar")).toHaveCount(10);
		await expect(chart.locator(".gcs-bar-scanned")).toHaveCount(1);
		// Source + fetch time per value, mock-stamped.
		await expect(app(page).getByTestId("gcs-sources")).toContainText("identity: mock");
		await captureEvidence(page, testInfo, "graded-card-scanner-detail");

		// Fetch fresh is briefly disabled after use (anti-spam).
		await app(page).getByTestId("gcs-fetch-fresh").click();
		await expect(app(page).getByTestId("gcs-fetch-fresh")).toBeDisabled();

		// Capture contract (mirrors visual-evidence.spec) — meaningful in
		// both modes rather than a bare screenshot call.
		if (process.env.EZCORP_E2E_EVIDENCE === "1") {
			expect(
				testInfo.attachments.some(
					(a) => a.name === "graded-card-scanner-list" && a.contentType === "image/png",
				),
			).toBe(true);
		} else {
			expect(
				testInfo.attachments.some((a) => a.name === "graded-card-scanner-list"),
			).toBe(false);
		}
	});

	test("dedupes repeat scans, parses QR URLs, and persists across reload", async ({
		page,
	}) => {
		await simulate(page, "49392223");
		await expect(app(page).getByTestId("gcs-row")).toHaveCount(1);

		// Same cert inside the ~8s cooldown window → silently ignored (the
		// per-frame dedupe gate; a slab in frame decodes many times a second).
		await simulate(page, "49392223");
		await expect(app(page).getByTestId("gcs-row")).toHaveCount(1);
		await expect(app(page).getByTestId("gcs-count")).toHaveText("1");

		// A modern slab's QR payload (psacard.com URL) via manual entry.
		await app(page).getByTestId("gcs-manual-input").fill("https://www.psacard.com/cert/12345678");
		await app(page).getByTestId("gcs-manual-add").click();
		await expect(app(page).getByTestId("gcs-row")).toHaveCount(2);

		// Garbage input is rejected with a message, not saved.
		await app(page).getByTestId("gcs-manual-input").fill("not-a-cert");
		await app(page).getByTestId("gcs-manual-add").click();
		await expect(app(page).getByTestId("gcs-status")).toContainText("Not a PSA cert");
		await expect(app(page).getByTestId("gcs-row")).toHaveCount(2);

		// Saved list survives reload through the scoped host tool fixture.
		await page.reload();
		await expect(app(page).getByTestId("gcs-row")).toHaveCount(2);

		// Post-reload the in-page gate is fresh but the DB still knows the
		// cert → the "already scanned" path: no new row, no lookup, count 0.
		await simulate(page, "49392223");
		await expect(app(page).getByTestId("gcs-status")).toContainText("already scanned");
		await expect(app(page).getByTestId("gcs-row")).toHaveCount(2);
		await expect(app(page).getByTestId("gcs-count")).toHaveText("0");

		// Search filters the list.
		await app(page).getByTestId("gcs-search").fill("12345678");
		await expect(app(page).getByTestId("gcs-row")).toHaveCount(1);
		await app(page).getByTestId("gcs-search").fill("zzz-no-match");
		await expect(app(page).getByTestId("gcs-row")).toHaveCount(0);
		await expect(app(page).getByTestId("gcs-empty")).toBeVisible();
	});

	test("upload and explicit host camera start decode real barcode pixels; stop and tool failures remain visible", async ({ page }) => {
    await expect(page.getByRole("button", { name: "Start camera", exact: true })).toBeHidden();
    await expect(app(page).getByTestId("gcs-video")).not.toHaveAttribute("src");
    await app(page).getByTestId("gcs-upload").setInputFiles({ name: "slab.png", mimeType: "image/png", buffer: Buffer.from(rgbaToPng(renderItfRgba("12345678"))) });
    await expect(app(page).getByTestId("gcs-row")).toHaveCount(1);
    await expect(app(page).getByTestId("gcs-status-chip")).toHaveText("done");
    await app(page).getByTestId("gcs-pause").click();
    await expect(page.getByRole("button", { name: "Start camera", exact: true })).toBeVisible();
    await expect(app(page).getByTestId("gcs-video")).not.toHaveAttribute("src");
    await page.getByRole("button", { name: "Start camera", exact: true }).click();
    await expect(app(page).getByTestId("gcs-row")).toHaveCount(2);
    await expect(app(page).getByTestId("gcs-video")).toHaveAttribute("src", /^data:image\/jpeg/);
    await page.getByRole("button", { name: "Stop camera", exact: true }).click();
    await expect(app(page).getByTestId("gcs-video")).not.toHaveAttribute("src");
    await expect(app(page).getByTestId("gcs-pause")).toHaveText("Start scanning");
    await app(page).getByTestId("gcs-manual-input").fill("99999999");
    await app(page).getByTestId("gcs-manual-add").click();
    await expect(app(page).getByTestId("gcs-status")).toContainText("Lookup unavailable.");
    await expect(app(page).getByTestId("gcs-status-chip").filter({ hasText: "error" })).toHaveCount(1);
    await expect(app(page).getByTestId("gcs-mock-banner")).toBeHidden();
  });

	test("delete one card, then clear all with confirm", async ({ page }) => {
		await simulate(page, "49392223");
		await simulate(page, "87654321");
		await expect(app(page).getByTestId("gcs-row")).toHaveCount(2);

		await app(page).getByTestId("gcs-delete").first().click();
		await expect(app(page).getByTestId("gcs-row")).toHaveCount(1);


		await app(page).getByTestId("gcs-clear-all").click();
		await expect(app(page).getByTestId("gcs-clear-dialog")).toBeVisible();
		await app(page).getByTestId("gcs-clear-cancel").click();
		await expect(app(page).getByTestId("gcs-row")).toHaveCount(1);
		await app(page).getByTestId("gcs-clear-all").click();
		await app(page).getByTestId("gcs-clear-confirm").click();
		await expect(app(page).getByTestId("gcs-row")).toHaveCount(0);
		await expect(app(page).getByTestId("gcs-empty")).toBeVisible();
	});
});
