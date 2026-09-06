/**
 * A browser-owned extension lifecycle.
 *
 * Test-only calls create the owner conversation and choose a deterministic
 * mock LLM for normal chat. Every lifecycle transition, conversation add,
 * invocation, and tool selection uses a human browser session.
 */
import type { Page } from "@playwright/test";
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

async function waitForVisibleBuild(page: Page): Promise<void> {
  await expect.poll(async () => {
    await page.getByRole("button", { name: "Refresh status", exact: true }).click();
    return (await page.locator(".operation strong").allTextContents())[0] ?? "";
  }, {
    timeout: 240_000,
    intervals: [1_000],
    message: "The browser-visible candidate build must finish after Refresh status.",
  }).toBe("verified");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function expectInlineToolOutput(page: Page, output: string): Promise<void> {
  // A second invocation appears after re-enable. The last matching card is
  // the one just submitted from the visible composer. The collapsed card
  // labels tool name and a truncated output preview, not its extension name.
  const completedCall = page.getByRole("button", {
    name: new RegExp(`echo \\{\\"text\\":\\"${escapeRegex(output.slice(0, 32))}`),
  }).last();
  await expect(completedCall).toBeVisible({ timeout: 90_000 });
  await completedCall.click();
  await expect(completedCall).toHaveAttribute("aria-expanded", "true");
  await expect(threadMessages(page).getByText(output, { exact: false })).toBeVisible();
}

test("human UI creates, approves, uses, scopes, disables, re-enables, and uninstalls an extension @evidence", async ({ page, request, baseURL }, testInfo) => {
  test.setTimeout(360_000);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const failedApiResponses: Array<{ method: string; status: number; path: string }> = [];
  const ignoredApiResponses: Array<{ method: string; status: number; path: string }> = [];
  let serverState: unknown = null;
  const appOrigin = new URL(baseURL!).origin;
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("response", response => {
    const url = new URL(response.url());
    if (url.origin === appOrigin && url.pathname.startsWith("/api/") && response.status() >= 400) {
      const record = { method: response.request().method(), status: response.status(), path: url.pathname };
      if (/^\/api\/(extensions|conversations|tools|tool-calls|chat)(?:\/|$)/.test(url.pathname)) failedApiResponses.push(record);
      else ignoredApiResponses.push(record);
    }
  });

	const name = `ui-lifecycle-${Date.now().toString(36)}`;
	const expected = `browser-owned output ${crypto.randomUUID()}`;
	const reenabledExpected = `reenabled output ${crypto.randomUUID()}`;
	const mockScriptKey = `ui-lifecycle-${crypto.randomUUID()}`;
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
    await waitForVisibleBuild(page);

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

    // Test-only deterministic model setup. It replaces only the LLM HTTP
    // boundary; the following browser mention/send still enters the real
    // chat, mention-wiring, and extension runtime paths without a paid model.
    const scripted = await request.post("/api/__test/mock-llm/script", {
      data: { scriptKey: mockScriptKey, turns: [{ text: "Mention wiring complete." }] },
    });
    expect(scripted.status(), await scripted.text()).toBe(201);
    const mockPinned = await request.put(`/api/conversations/${conversationId}`, {
      data: { provider: "ezcorp-mock", model: `mock:${mockScriptKey}` },
    });
    expect(mockPinned.status(), await mockPinned.text()).toBe(200);

    await page.goto(`/project/${projectId}/chat/${conversationId}`);
    // Select through the normal mention UI, close its immediate tool form,
    // then send the committed token. The server-side message path creates the
    // conversation wiring; this is the user-facing add path.
    await selectExtensionMention(page, name);
    await page.locator("#field-text").press("Escape");
    await expect(page.locator("#field-text")).not.toBeVisible();
    await sendComposerMessage(page, " wire this extension", { append: true });
    await expect.poll(async () => {
      const wiring = await request.get(`/api/conversations/${conversationId}/extensions`);
      if (!wiring.ok()) return [];
      return (await wiring.json()).extensions as Array<{ id: string; name: string }>;
    }, { timeout: 30_000 }).toContainEqual({ id: installationId, name });
    await expect(threadMessages(page).getByText("Mention wiring complete.", { exact: true })).toBeVisible({ timeout: 30_000 });

    await invokeExtensionToolFromComposer(page, name, { text: expected });
    await expectInlineToolOutput(page, `UI lifecycle: ${expected}`);
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

    // Exercise the normal browser entry point after selection is revoked. A
    // user cannot reach the Add form because the extension is absent from the
    // live mention choices for this conversation.
    const composer = page.getByRole("group", { name: "Chat input with file drop zone" });
    const composerInput = composer.locator("textarea.chat-textarea");
    await composerInput.fill(`!${name}`);
    const suggestions = page.locator("#mention-listbox");
    await expect(suggestions).toBeHidden();
    await expect(suggestions.getByText(name, { exact: false })).toHaveCount(0);
    await composerInput.press("Escape");

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
    await invokeExtensionToolFromComposer(page, name, { text: reenabledExpected });
    await expectInlineToolOutput(page, `UI lifecycle: ${reenabledExpected}`);

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
      const inspected = await request.post("/api/extensions/control", {
        data: { tool: "extensions_inspect", input: { installationId } },
      });
      const inspectText = await inspected.text();
      try {
        serverState = { status: inspected.status(), value: JSON.parse(inspectText) };
      } catch {
        serverState = { status: inspected.status(), value: inspectText };
      }
      if (!inspected.ok()) {
        failedApiResponses.push({ method: "POST", status: inspected.status(), path: "/api/extensions/control" });
      }
      const cleanup = await request.delete(`/api/extensions/${installationId}`);
      if (![204, 404].includes(cleanup.status())) {
        failedApiResponses.push({ method: "DELETE", status: cleanup.status(), path: `/api/extensions/${installationId}` });
      }
    }
    await testInfo.attach("extension-lifecycle-client-diagnostics", {
      body: JSON.stringify({ pageErrors, consoleErrors, failedApiResponses, ignoredApiResponses }, null, 2),
      contentType: "application/json",
    });
    await testInfo.attach("extension-lifecycle-server-state", {
      body: JSON.stringify(serverState, null, 2),
      contentType: "application/json",
    });
  }

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(failedApiResponses).toEqual([]);
  expect(ignoredApiResponses).toEqual([]);
});
