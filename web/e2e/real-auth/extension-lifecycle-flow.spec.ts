/**
 * A browser-owned extension lifecycle.
 *
 * The only test-surface call creates a deterministic owner conversation. Every
 * lifecycle transition is clicked in a human session. The production
 * conversation-wiring endpoint is used once because the product currently
 * has no visible "attach to this conversation" control; the following
 * composer action and scoped-tool selection are both browser UI actions.
 */
import { test, expect } from "../fixtures/hydration.js";
import { captureEvidence } from "../fixtures/evidence";
import {
  invokeExtensionToolFromComposer,
  selectExtensionMention,
  sendComposerMessage,
  threadMessages,
} from "../fixtures/composer";

function echoSource(prefix: string): string {
  return `export function echo(input: Record<string, unknown>) { return { text: ${JSON.stringify(prefix)} + input.text }; }\n`;
}

test("human UI creates, approves, uses, scopes, disables, re-enables, and uninstalls an extension @evidence", async ({ page, request, baseURL }, testInfo) => {
  test.setTimeout(360_000);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const failedApiResponses: Array<{ method: string; status: number; path: string }> = [];
  const appOrigin = new URL(baseURL!).origin;
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("response", response => {
    const url = new URL(response.url());
    if (url.origin === appOrigin && url.pathname.startsWith("/api/") && response.status() >= 400) {
      failedApiResponses.push({ method: response.request().method(), status: response.status(), path: url.pathname });
    }
  });

  const name = `ui-lifecycle-${Date.now().toString(36)}`;
  const expected = `browser-owned output ${crypto.randomUUID()}`;
  let installationId = "";

  try {
    // Create + author source entirely through the visible workspace.
    await page.goto("/extensions/author");
    await page.getByLabel("Extension name").fill(name);
    await page.getByRole("button", { name: "Create workspace", exact: true }).click();
    await page.waitForURL(/\/extensions\/author\?installation=[^&]+&workspace=[^&]+/);
    await expect(page.getByRole("heading", { name: "Extension workspace", exact: true })).toBeVisible();
    const location = new URL(page.url());
    installationId = location.searchParams.get("installation") ?? "";
    expect(installationId, "UI creation must navigate to the created installation").not.toBe("");

    await page.getByRole("button", { name: "src/echo.ts", exact: true }).click();
    await page.getByRole("textbox", { name: "Source: src/echo.ts", exact: true }).fill(echoSource("UI lifecycle: "));
    await page.getByRole("button", { name: "src/echo.test.ts", exact: true }).click();
    await page.getByRole("textbox", { name: "Source: src/echo.test.ts", exact: true }).fill(
      `import { expect, test } from "bun:test"; import { echo } from "./echo"; test("echoes", () => expect(echo({ text: "value" })).toEqual({ text: "UI lifecycle: value" }));\n`,
    );
    await page.getByRole("button", { name: "Save revision", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Saved revision");
    await page.getByRole("button", { name: "Save and build", exact: true }).click();
    await expect(page.locator(".operation strong").filter({ hasText: "verified" })).toBeVisible({ timeout: 240_000 });

    // A human sees the review screen, acknowledges the exact release, then
    // explicitly activates it. No API key can perform this approval.
    await page.getByRole("button", { name: "Request approval", exact: true }).click();
    const approve = page.getByRole("button", { name: "Approve exact release", exact: true });
    await expect(approve).toBeDisabled();
    await page.getByText("Permissions and test evidence", { exact: true }).click();
    await captureEvidence(page, testInfo, "extension-lifecycle-review-desktop", { fullPage: true });
    await page.getByLabel("I reviewed this release and its permissions.").check();
    await approve.click();
    await page.getByRole("button", { name: "Activate approved release", exact: true }).click();
    await expect(page.getByRole("button", { name: "Disable installation", exact: true })).toBeEnabled();

    // This is deterministic test setup only. It creates an owned empty chat;
    // extension creation, source editing, build, approval, activation, and
    // invocation above/below all use normal product surfaces.
    const seeded = await request.post("/api/__test/seed", { data: { title: "UI extension lifecycle" } });
    expect(seeded.status(), await seeded.text()).toBe(201);
    const { conversationId, projectId } = (await seeded.json()) as { conversationId: string; projectId: string };

    await page.goto(`/project/${projectId}/chat/${conversationId}`);
    // Select through the normal mention UI, close its immediate tool form,
    // then send the committed token. The server-side message path creates the
    // conversation wiring; this is the user-facing add path.
    await selectExtensionMention(page, name);
    await page.locator("#field-text").press("Escape");
    await expect(page.locator("#field-text")).not.toBeVisible();
    await sendComposerMessage(page, " wire this extension", { append: true });
    await expect(threadMessages(page).getByText("wire this extension", { exact: false })).toBeVisible({ timeout: 90_000 });
    const wiring = await request.get(`/api/conversations/${conversationId}/extensions`);
    expect(wiring.status(), await wiring.text()).toBe(200);
    expect((await wiring.json()).extensions).toContainEqual({ id: installationId, name });

    await invokeExtensionToolFromComposer(page, name, { text: expected });
    await expect(threadMessages(page).getByText(`UI lifecycle: ${expected}`, { exact: false })).toBeVisible({ timeout: 90_000 });
    await captureEvidence(page, testInfo, "extension-lifecycle-live-output", { fullPage: true });

    // This visible control is a persisted per-conversation tool selection,
    // not removal of the conversation_extensions wiring row. It must hide the
    // actual extension tool from the same scoped listing used by chat.
    await page.getByTestId("conversation-tools-trigger").click();
    const scopedTools = page.getByTestId("conversation-tools-popover");
    await expect(scopedTools).toBeVisible();
    const extensionToggle = page.getByTestId(`conv-ext-toggle-${installationId}`);
    await expect(extensionToggle).toBeChecked();
    const selectionSaved = page.waitForResponse(response => response.request().method() === "PUT" && response.url().endsWith(`/api/conversations/${conversationId}`) && response.ok());
    await extensionToggle.uncheck();
    await selectionSaved;
    await expect(extensionToggle).not.toBeChecked();
    const scopedOff = await request.get(`/api/tools?conversationId=${conversationId}`);
    expect(scopedOff.status(), await scopedOff.text()).toBe(200);
    expect(((await scopedOff.json()).tools as Array<{ extension: string }>).some(tool => tool.extension === name)).toBe(false);

    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await captureEvidence(page, testInfo, "extension-lifecycle-tool-selection-mobile", { fullPage: true });
    const selectionReset = page.waitForResponse(response => response.request().method() === "PUT" && response.url().endsWith(`/api/conversations/${conversationId}`) && response.ok());
    await page.getByTestId("conversation-tools-reset").click();
    await selectionReset;
    const scopedOn = await request.get(`/api/tools?conversationId=${conversationId}`);
    expect(scopedOn.status(), await scopedOn.text()).toBe(200);
    expect(((await scopedOn.json()).tools as Array<{ extension: string }>).some(tool => tool.extension === name)).toBe(true);

    // Re-enable is intentionally a fresh review of the exact retained
    // release. The card's Enable action routes here; it never silently flips
    // a previously approved installation back on.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/extensions");
    const card = page.locator(`[data-testid="ext-card"][data-ext-id="${installationId}"]`);
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Disable", exact: true }).click();
    await expect(card.getByText("Disabled", { exact: true })).toBeVisible();
    const disabledTools = await request.get(`/api/tools?conversationId=${conversationId}`);
    expect(disabledTools.status(), await disabledTools.text()).toBe(200);
    expect(((await disabledTools.json()).tools as Array<{ extension: string }>).some(tool => tool.extension === name)).toBe(false);
    await card.getByRole("button", { name: "Enable", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/extensions/author\\?installation=${installationId}`));
    await page.getByRole("button", { name: "Request approval", exact: true }).click();
    await page.getByLabel("I reviewed this release and its permissions.").check();
    await page.getByRole("button", { name: "Approve exact release", exact: true }).click();
    await page.getByRole("button", { name: "Activate approved release", exact: true }).click();
    await expect(page.getByRole("button", { name: "Disable installation", exact: true })).toBeEnabled();

    await page.goto(`/project/${projectId}/chat/${conversationId}`);
    await invokeExtensionToolFromComposer(page, name, { text: `${expected}-reenabled` });
    await expect(threadMessages(page).getByText(`UI lifecycle: ${expected}-reenabled`, { exact: false })).toBeVisible({ timeout: 90_000 });

    await page.goto("/extensions");
    await card.getByTestId("ext-card-uninstall").click();
    const uninstall = page.getByTestId("uninstall-dialog");
    await expect(uninstall).toContainText("release history, settings, secrets, stored data and files are kept");
    await uninstall.getByTestId("uninstall-confirm").click();
    await expect(card).toHaveCount(0);
    const missingTools = await request.get(`/api/extensions/${encodeURIComponent(name)}/tools`);
    expect(missingTools.status()).toBe(404);
  } finally {
    if (installationId) {
      const cleanup = await request.delete(`/api/extensions/${installationId}`);
      if (![204, 404].includes(cleanup.status())) {
        failedApiResponses.push({ method: "DELETE", status: cleanup.status(), path: `/api/extensions/${installationId}` });
      }
    }
    await testInfo.attach("extension-lifecycle-client-diagnostics", {
      body: JSON.stringify({ pageErrors, consoleErrors, failedApiResponses }, null, 2),
      contentType: "application/json",
    });
  }

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(failedApiResponses).toEqual([]);
});
