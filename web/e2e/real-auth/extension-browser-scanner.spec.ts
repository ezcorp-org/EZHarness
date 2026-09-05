import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { test, expect } from "../fixtures/hydration.js";
import { captureEvidence } from "../fixtures/evidence";
import { extensionClient, buildWorkspace, requestRelease, type CreatedWorkspace } from "../fixtures/extension-v4";
import type { WorkspaceFiles, WorkspaceRecord } from "@ezcorp/extension-contract";
import { chromium, devices, type Page } from "@playwright/test";

test.use({ actionTimeout: 15000, navigationTimeout: 30000, launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] } });

test("real sealed scanner uses approved tools and explicit host camera without session access @evidence", async ({ page, request, baseURL }, testInfo) => {
  test.setTimeout(360000);
  const { client } = await extensionClient(request, baseURL!);
  const root = resolve(import.meta.dirname, "../../..");
  const snapshot = JSON.parse(execFileSync("bun", ["-e", "const {snapshotFirstPartyExtension}=await import('./scripts/migrate-extension-v4.ts');console.log(JSON.stringify(await snapshotFirstPartyExtension(process.cwd(),'graded-card-scanner')));"], { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })) as { files: WorkspaceFiles };
  const name = "graded-card-scanner";
  const waitForScanner = (target: Page) => target.waitForResponse(response => new URL(response.url()).pathname === `/api/extensions/${name}/preview` && response.request().postDataJSON()?.method === "tool.invoke" && response.request().postDataJSON()?.toolName === "scanner_saved_list");
  const created = await client.extensionControl<CreatedWorkspace>("extensions_workspace", { action: "create", name });
  try {
    const original = await client.extensionControl<{ files: WorkspaceFiles }>("extensions_workspace", { action: "read", installationId: created.installation.id, workspaceId: created.workspace.id });
    created.workspace = await client.extensionControl<WorkspaceRecord>("extensions_workspace", { action: "edit", installationId: created.installation.id, workspaceId: created.workspace.id, expectedRevision: created.workspace.revision, writes: snapshot.files, deletes: Object.keys(original.files).filter(path => !(path in snapshot.files)) });
    const state = await buildWorkspace(client, created);
    const approval = await requestRelease(client, state);
    const approved = await request.post(`/api/extensions/releases/${created.installation.id}/approve`, { data: { approvalId: approval.id, decision: true } });
    expect(approved.status(), await approved.text()).toBe(200);
    await client.extensionControl("extensions_release", { action: "activate", installationId: created.installation.id, approvalId: approval.id, idempotencyKey: crypto.randomUUID() });
    await page.goto(`/extensions/${name}/preview`);
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    const project = page.getByLabel("New conversation project");
    const projectId = await project.locator("option:not([disabled])").first().getAttribute("value");
    expect(projectId).toBeTruthy();
    await project.selectOption(projectId!);
    const ready = waitForScanner(page);
    await page.getByRole("button", { name: "Create preview conversation", exact: true }).click();
    await expect(page).toHaveURL(/conversationId=/);
    const frame = page.frameLocator("iframe");
    await expect(frame.getByRole("heading", { name: "Graded Card Scanner" })).toBeVisible();
    await expect(frame.getByTestId("gcs-empty")).toBeVisible();
    expect((await (await ready).json()).success).toBe(true);
    await expect(frame.getByRole("main")).toHaveAttribute("aria-busy", "false");
    const security = await frame.locator("body").evaluate(() => {
      let parentDenied = false;
      let cookieDenied = false;
      try { void parent.document.body; } catch { parentDenied = true; }
      try { void document.cookie; } catch { cookieDenied = true; }
      return { parentDenied, cookieDenied };
    });
    expect(security).toEqual({ parentDenied: true, cookieDenied: true });
    await page.getByRole("heading", { name, exact: true }).hover();
    await page.mouse.wheel(0, 400);
    await expect(frame.getByTestId("gcs-pause")).toBeInViewport({ ratio: 1 });
    await frame.getByTestId("gcs-pause").click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("button", { name: "Start camera", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Start camera", exact: true }).click();
    await expect(page.getByRole("button", { name: "Stop camera", exact: true }).first()).toBeVisible();
    await expect.poll(() => frame.getByTestId("gcs-video").getAttribute("src")).toMatch(/^data:image\/jpeg;base64,/);
    await captureEvidence(page, testInfo, "extension-scanner-trusted-camera", { fullPage: true });
    await page.getByRole("button", { name: "Stop camera", exact: true }).first().click();
    await expect(frame.getByTestId("gcs-pause")).toHaveText("Start scanning");
    const mobileBrowser = await chromium.launch({ channel: "chromium-headless-shell", args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
    let mobile: Page | undefined;
    try {
      mobile = await mobileBrowser.newPage({ ...devices["Pixel 5"], storageState: await page.context().storageState() });
      const mobileReady = waitForScanner(mobile);
      await mobile.goto(page.url());
      const mobileFrame = mobile.frameLocator("iframe");
      expect((await (await mobileReady).json()).success).toBe(true);
      await expect(mobileFrame.getByRole("main")).toHaveAttribute("aria-busy", "false");
      expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const viewport = mobile.viewportSize()!;
      const browserBox = await mobile.locator(".extension-browser").boundingBox();
      expect(browserBox?.x).toBe(24);
      expect(viewport.width - browserBox!.x - browserBox!.width).toBe(24);
      const swipeTarget = await mobile.getByText("Isolated preview", { exact: true }).boundingBox();
      expect(swipeTarget).toBeTruthy();
      const touch = await mobile.context().newCDPSession(mobile);
      const scrollEnded = mobile.locator("main").first().evaluate(element => new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Touch scroll did not end")), 10000);
        element.addEventListener("scrollend", () => { clearTimeout(timeout); resolve(); }, { once: true });
      }));
      try {
        const position = { x: swipeTarget!.x + swipeTarget!.width / 2, y: swipeTarget!.y + swipeTarget!.height / 2 };
        await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [position] });
        for (let step = 1; step <= 10; step++) {
          await new Promise(resolve => setTimeout(resolve, 20));
          await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: position.x, y: position.y - step * 30 }] });
        }
        await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      }
      finally { await touch.detach(); }
      await scrollEnded;
      await expect(mobileFrame.getByTestId("gcs-pause")).toBeInViewport({ ratio: 1 });
      await mobileFrame.getByTestId("gcs-pause").tap();
      await expect(mobile.getByRole("dialog")).toBeVisible();
      await mobile.getByRole("button", { name: "Start camera", exact: true }).tap();
      await expect.poll(() => mobileFrame.getByTestId("gcs-video").getAttribute("src")).toMatch(/^data:image\/jpeg;base64,/);
      await mobile.getByRole("button", { name: "Stop camera", exact: true }).first().tap();
      await expect(mobileFrame.getByTestId("gcs-pause")).toHaveText("Start scanning");
      await captureEvidence(mobile, testInfo, "extension-scanner-protected-mobile", { fullPage: true });
    } finally {
      if (mobile) {
        await captureEvidence(mobile, testInfo, "extension-scanner-mobile-final", { fullPage: true });
        const trace = testInfo.outputPath("mobile-trace.zip");
        await mobile.context().tracing.stop({ path: trace });
        await testInfo.attach("mobile-input-trace", { path: trace, contentType: "application/zip" });
      }
      await mobileBrowser.close();
    }
    await client.extensionControl("extensions_release", { action: "disable", installationId: created.installation.id, idempotencyKey: crypto.randomUUID() });
    await frame.getByTestId("gcs-pause").click();
    await expect(page.getByText("Preview closed because access changed or its document navigated. Reopen it to continue.", { exact: true })).toBeVisible();
  } finally {
    await client.extensionControl("extensions_release", { action: "uninstall", installationId: created.installation.id, idempotencyKey: crypto.randomUUID() });
  }
});
