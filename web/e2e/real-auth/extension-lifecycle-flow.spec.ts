/**
 * A browser-owned extension lifecycle.
 *
 * Test-only calls create the owner conversation and choose a deterministic
 * mock LLM for normal chat. Every lifecycle transition, conversation add,
 * invocation, and tool selection uses a human browser session.
 */
import type { Page, Request, TestInfo } from "@playwright/test";
import { test, expect, waitForHydration } from "../fixtures/hydration.js";
import { captureEvidence } from "../fixtures/evidence";
import { buildWorkspace, extensionClient, requestRelease, waitForExtensionBuild, type CreatedWorkspace } from "../fixtures/extension-v4";
import {
  invokeExtensionToolFromComposer,
  selectExtensionMention,
  sendComposerMessage,
  threadMessages,
} from "../fixtures/composer";

type FailedApiResponse = { method: string; status: number; path: string };

type BrowserDiagnostics = {
  pageErrors: string[];
  consoleErrors: string[];
  failedApiResponses: FailedApiResponse[];
  failedApiRequests: Array<FailedApiResponse & { error: string }>;
  ignoredApiResponses: FailedApiResponse[];
  expectedRuntimeEventCancellations: Array<FailedApiResponse & { error: string }>;
  expectedRuntimeEventTeardownMarks: number;
};

type BrowserDiagnosticsObserver = {
  diagnostics: BrowserDiagnostics;
  markRuntimeEventTeardown(): void;
};

const WEBKIT_VIEWPORT_WARNING = 'Viewport argument key "interactive-widget" not recognized and ignored.';

function isIgnoredBrowserConsoleError(text: string): boolean {
  return text === WEBKIT_VIEWPORT_WARNING;
}

function observeBrowserDiagnostics(page: Page, baseURL: string): BrowserDiagnosticsObserver {
  const diagnostics: BrowserDiagnostics = {
    pageErrors: [], consoleErrors: [], failedApiResponses: [], failedApiRequests: [], ignoredApiResponses: [],
    expectedRuntimeEventCancellations: [], expectedRuntimeEventTeardownMarks: 0,
  };
  const appOrigin = new URL(baseURL).origin;
  const completedExtensionDeletes = new WeakSet<Request>();
  const activeRuntimeEventRequests = new Set<Request>();
  const expectedRuntimeEventTeardowns = new WeakSet<Request>();
  const isRuntimeEventRequest = (request: Request): boolean => {
    const url = new URL(request.url());
    return url.origin === appOrigin && request.method() === "GET" && url.pathname === "/api/runtime-events";
  };
  const markRuntimeEventTeardown = (): void => {
    diagnostics.expectedRuntimeEventTeardownMarks += 1;
    for (const runtimeEventRequest of activeRuntimeEventRequests) expectedRuntimeEventTeardowns.add(runtimeEventRequest);
  };
  page.on("pageerror", error => diagnostics.pageErrors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !isIgnoredBrowserConsoleError(message.text())) diagnostics.consoleErrors.push(message.text());
  });
  page.on("request", request => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) markRuntimeEventTeardown();
    if (isRuntimeEventRequest(request)) activeRuntimeEventRequests.add(request);
  });
  // EventSource can emit requestfinished once response headers arrive while its
  // stream remains open. Keep its identity until a failure or teardown.
  page.on("requestfinished", request => {
    if (!isRuntimeEventRequest(request)) activeRuntimeEventRequests.delete(request);
  });
  page.on("response", response => {
    const url = new URL(response.url());
    if (url.origin === appOrigin && url.pathname.startsWith("/api/extensions/") && response.request().method() === "DELETE" && response.status() === 204) {
      completedExtensionDeletes.add(response.request());
    }
    if (url.origin !== appOrigin || !url.pathname.startsWith("/api/") || response.status() < 400) return;
    const record = { method: response.request().method(), status: response.status(), path: url.pathname };
    if (/^\/api\/(extensions|conversations|tools|tool-calls|chat)(?:\/|$)/.test(url.pathname)) diagnostics.failedApiResponses.push(record);
    else diagnostics.ignoredApiResponses.push(record);
  });
  page.on("requestfailed", request => {
    // Chromium reports this exact completed 204 DELETE as ERR_ABORTED after
    // its response event. Every other transport failure remains strict.
    if (completedExtensionDeletes.has(request) && request.failure()?.errorText === "net::ERR_ABORTED") return;
    const url = new URL(request.url());
    const error = request.failure()?.errorText ?? "unknown transport failure";
    // WebKit reports a live EventSource as cancelled when an observed main
    // frame navigation tears it down. Any other stream failure stays strict.
    if (expectedRuntimeEventTeardowns.has(request) && error === "Load request cancelled") {
      diagnostics.expectedRuntimeEventCancellations.push({ method: request.method(), path: url.pathname, status: 0, error });
      activeRuntimeEventRequests.delete(request);
      return;
    }
    activeRuntimeEventRequests.delete(request);
    if (url.origin === appOrigin && url.pathname.startsWith("/api/")) {
      diagnostics.failedApiRequests.push({ method: request.method(), path: url.pathname, status: 0, error });
    }
  });
  page.on("close", markRuntimeEventTeardown);
  return { diagnostics, markRuntimeEventTeardown };
}

async function navigateWithRuntimeEventTeardown(page: Page, observer: BrowserDiagnosticsObserver, url: string): Promise<void> {
  observer.markRuntimeEventTeardown();
  await page.goto(url);
}

async function reloadWithRuntimeEventTeardown(page: Page, observer: BrowserDiagnosticsObserver): Promise<void> {
  observer.markRuntimeEventTeardown();
  await page.reload();
}

async function attachBrowserDiagnostics(testInfo: TestInfo, name: string, diagnostics: BrowserDiagnostics): Promise<void> {
  await testInfo.attach(name, { body: JSON.stringify(diagnostics, null, 2), contentType: "application/json" });
}

function expectCleanBrowserDiagnostics(
  diagnostics: BrowserDiagnostics,
  allowed: { consoleErrorVariants?: string[][]; apiFailures?: FailedApiResponse[] } = {},
): void {
  expect(diagnostics.pageErrors).toEqual([]);
  expect(allowed.consoleErrorVariants ?? [[]]).toContainEqual(diagnostics.consoleErrors);
  expect(diagnostics.failedApiResponses).toEqual(allowed.apiFailures ?? []);
  expect(diagnostics.failedApiRequests).toEqual([]);
  expect(diagnostics.ignoredApiResponses).toEqual([]);
}

function echoSource(prefix: string): string {
  return `export function echo(input: Record<string, unknown>) { return { text: ${JSON.stringify(prefix)} + input.text }; }\n`;
}

async function waitForVisibleOperationState(page: Page, expected: "verified" | "failed"): Promise<void> {
  await expect.poll(async () => {
    await page.getByRole("button", { name: "Refresh status", exact: true }).click();
    return (await page.locator(".operation strong").allTextContents())[0] ?? "";
  }, {
    timeout: 240_000,
    intervals: [1_000],
    message: `The browser-visible build must become ${expected} after Refresh status.`,
  }).toBe(expected);
}

async function observePendingBuild(page: Page): Promise<string> {
  // The async build must still be pending when the reload occurs. This is a
  // causal UI barrier, not a delay: the current operation state is rendered
  // by the same Refresh status control a person uses to recover a closed tab.
  await expect.poll(async () => {
    await page.getByRole("button", { name: "Refresh status", exact: true }).click();
    const row = page.locator(".operation").first();
    return { id: (await row.locator("code").textContent())?.trim() ?? "", state: (await row.locator("strong").textContent())?.trim() ?? "" };
  }, {
    timeout: 30_000,
    intervals: [100],
    message: "A new browser-started build must visibly enter a pending state before reload.",
  }).toMatchObject({ id: expect.any(String), state: expect.stringMatching(/^(queued|building|verifying)$/) });
  const operationId = (await page.locator(".operation").first().locator("code").textContent())?.trim() ?? "";
  expect(operationId).not.toBe("");
  return operationId;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function expectInlineToolOutput(page: Page, output: string): Promise<void> {
  // A second invocation appears after re-enable. The last matching card is
  // the one just submitted from the visible composer. The collapsed card
  // labels tool name and a truncated output preview, not its extension name.
  const completedCall = page.getByRole("button", {
    name: new RegExp(`echo\\s*(?:--\\s*)?\\{\\"text\\":\\"${escapeRegex(output.slice(0, 32))}`),
  }).last();
  await expect(completedCall).toBeVisible({ timeout: 90_000 });
  await completedCall.click();
  await expect(completedCall).toHaveAttribute("aria-expanded", "true");
	await expect(threadMessages(page).getByText(output, { exact: false }).last()).toBeVisible();
}

async function expectDesktopSidebarRowsDoNotShrink(page: Page): Promise<void> {
	const sidebar = page.getByTestId("desktop-sidebar");
	await expect(sidebar).toBeVisible();
	const labels = ["Agents", "Commands", "Workflows", "Extensions"];
	const boxes = await Promise.all(labels.map(async label => {
		const row = sidebar.getByRole("link", { name: label, exact: true });
		await expect(row).toBeVisible();
		const box = await row.boundingBox();
		expect(box, `${label} must have a visible click target`).not.toBeNull();
		return box!;
	}));
	for (let index = 0; index < boxes.length; index += 1) {
		expect(boxes[index]!.height, `${labels[index]} must retain a readable 30px click target`).toBeGreaterThanOrEqual(30);
		if (index > 0) {
			expect(boxes[index]!.y, `${labels[index]} must not overlap ${labels[index - 1]}`).toBeGreaterThanOrEqual(
				boxes[index - 1]!.y + boxes[index - 1]!.height,
			);
		}
	}
}

async function expectDesktopSidebarCanReachLastRow(page: Page): Promise<void> {
	const sidebar = page.getByTestId("desktop-sidebar");
	const lastRow = sidebar.getByRole("link", { name: "Moderation", exact: true });
	await lastRow.scrollIntoViewIfNeeded();
	await expect(lastRow).toBeVisible();
	const lastBox = await lastRow.boundingBox();
	expect(lastBox, "The last sidebar item must have a visible click target").not.toBeNull();
	expect(lastBox!.height, "The last sidebar item must retain a readable 30px click target").toBeGreaterThanOrEqual(30);
	await lastRow.click();
	await page.waitForURL("/admin/moderation");
	await page.goBack();
	await expect(page).toHaveURL(/\/extensions\/author$/);
	await sidebar.getByRole("link", { name: "Agents", exact: true }).scrollIntoViewIfNeeded();
}

test("human UI creates, approves, uses, scopes, disables, re-enables, and uninstalls an extension @evidence", async ({ page, request, baseURL }, testInfo) => {
  test.setTimeout(360_000);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const runtimeEventConnections: string[] = [];
  const failedApiResponses: Array<{ method: string; status: number; path: string }> = [];
  const ignoredApiResponses: Array<{ method: string; status: number; path: string }> = [];
  let serverState: unknown = null;
  const appOrigin = new URL(baseURL!).origin;
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !isIgnoredBrowserConsoleError(message.text())) consoleErrors.push(message.text());
  });
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.origin === appOrigin && url.pathname === "/api/runtime-events") {
      runtimeEventConnections.push(url.href);
    }
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
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/extensions/author");
    // The production Bun adapter defaults idle streaming responses to 10s.
    // Observe beyond that boundary. The controlled reproduction also sets
    // `IDLE_TIMEOUT=8` to cross two windows. One EventSource must stay live:
    // a second request means
    // the browser had to reconnect after a transport failure.
    await page.waitForTimeout(17_000);
    expect(consoleErrors).toEqual([]);
    expect(runtimeEventConnections).toHaveLength(1);
		await expectDesktopSidebarRowsDoNotShrink(page);
		await expectDesktopSidebarCanReachLastRow(page);
		await expectDesktopSidebarRowsDoNotShrink(page);
		await captureEvidence(page, testInfo, "extension-lifecycle-sidebar-720", { fullPage: false });
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
    await waitForVisibleOperationState(page, "verified");

    // A human sees the review screen, acknowledges the exact release, then
    // explicitly activates it. No API key can perform this approval.
    const requestApprovalAfterEnable = page.getByRole("button", { name: "Request approval", exact: true });
    await expect(requestApprovalAfterEnable).toBeEnabled();
    await requestApprovalAfterEnable.click();
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
    const expectToolsPopoverInViewport = async (width: number) => {
      await page.setViewportSize({ width, height: 844 });
      await expect(scopedTools.getByText("Conversation tools", { exact: true })).toBeVisible();
      await expect(extensionToggle).toBeVisible();
      await expect(page.getByTestId("conversation-tools-reset")).toBeVisible();
      const triggerBox = await page.getByTestId("conversation-tools-trigger").boundingBox();
      expect(triggerBox).not.toBeNull();
      expect(triggerBox!.x).toBeGreaterThanOrEqual(0);
      expect(triggerBox!.x + triggerBox!.width).toBeLessThanOrEqual(width);
      expect(triggerBox!.y).toBeGreaterThanOrEqual(0);
      expect(triggerBox!.y + triggerBox!.height).toBeLessThanOrEqual(844);
      const popoverBox = await scopedTools.boundingBox();
      expect(popoverBox).not.toBeNull();
      expect(popoverBox!.x).toBeGreaterThanOrEqual(0);
      expect(popoverBox!.x + popoverBox!.width).toBeLessThanOrEqual(width);
      expect(popoverBox!.y).toBeGreaterThanOrEqual(0);
      expect(popoverBox!.y + popoverBox!.height).toBeLessThanOrEqual(844);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    };
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
    // Firefox keeps an empty mention list open while Chromium closes it. The
    // author-facing invariant is that the revoked extension cannot be chosen.
    await expect(suggestions.getByText(name, { exact: false })).toHaveCount(0);
    await captureEvidence(page, testInfo, "extension-lifecycle-revoked-mention-list");
    await composerInput.press("Escape");

    await expectToolsPopoverInViewport(390);
    await captureEvidence(page, testInfo, "extension-lifecycle-tool-selection-mobile", { fullPage: true });
    await expectToolsPopoverInViewport(320);
    await captureEvidence(page, testInfo, "extension-lifecycle-tool-selection-mobile-narrow", { fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    const desktopTriggerBox = await page.getByTestId("conversation-tools-trigger").boundingBox();
    const desktopPopoverBox = await scopedTools.boundingBox();
    expect(desktopTriggerBox).not.toBeNull();
    expect(desktopPopoverBox).not.toBeNull();
    expect(Math.abs(desktopPopoverBox!.x - desktopTriggerBox!.x)).toBeLessThanOrEqual(1);
    await captureEvidence(page, testInfo, "extension-lifecycle-tool-selection-desktop-after-mobile", { fullPage: true });
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
    const requestApprovalAfterReload = page.getByRole("button", { name: "Request approval", exact: true });
    await expect(requestApprovalAfterReload).toBeEnabled();
    await requestApprovalAfterReload.click();
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

test("reloads an observed pending browser build, shows diagnostics, repairs source, and keeps the active release usable @evidence", async ({ page, request, baseURL }, testInfo) => {
  test.setTimeout(360_000);
  const browserObserver = observeBrowserDiagnostics(page, baseURL!);
  const browserDiagnostics = browserObserver.diagnostics;
  const name = `ui-recovery-${Date.now().toString(36)}`;
  const firstOutput = `before repair ${crypto.randomUUID()}`;
  const retainedOutput = `retained after failed update ${crypto.randomUUID()}`;
  const repairedOutput = `after repair ${crypto.randomUUID()}`;
  let installationId = "";

  try {
    await navigateWithRuntimeEventTeardown(page, browserObserver, "/extensions/author");
    await page.getByLabel("Extension name").fill(name);
    await page.getByRole("button", { name: "Create workspace", exact: true }).click();
    await page.waitForURL(/\/extensions\/author\?installation=[^&]+&workspace=[^&]+/);
    installationId = new URL(page.url()).searchParams.get("installation") ?? "";
    expect(installationId).not.toBe("");

    await page.getByRole("button", { name: "src/echo.ts", exact: true }).click();
    await page.getByRole("textbox", { name: "Source: src/echo.ts", exact: true }).fill(echoSource("Recovery v1: "));
    await page.getByRole("button", { name: "src/echo.test.ts", exact: true }).click();
    await page.getByRole("textbox", { name: "Source: src/echo.test.ts", exact: true }).fill(
      `import { expect, test } from "bun:test"; import { echo } from "./echo"; test("echoes", () => expect(echo({ text: "value" })).toEqual({ text: "Recovery v1: value" }));\n`,
    );
    await page.getByRole("button", { name: "Save and build", exact: true }).click();
    const pendingOperationId = await observePendingBuild(page);
    const operationsBeforeReload = await page.locator(".operation").count();

    await reloadWithRuntimeEventTeardown(page, browserObserver);
    await waitForHydration(page);
    await expect(page.locator(".operation").filter({ hasText: pendingOperationId })).toBeVisible();
    await expect(page.locator(".operation")).toHaveCount(operationsBeforeReload);
    await waitForVisibleOperationState(page, "verified");
    const requestApproval = page.getByRole("button", { name: "Request approval", exact: true });
    await expect(requestApproval).toBeEnabled();
    await requestApproval.click();
    await page.getByLabel("I reviewed this release and its permissions.").check();
    await page.getByRole("button", { name: "Approve exact release", exact: true }).click();
    await page.getByRole("button", { name: "Activate approved release", exact: true }).click();
    await expect(page.getByRole("button", { name: "Disable installation", exact: true })).toBeEnabled();

    const seeded = await request.post("/api/__test/seed", { data: { title: "Browser build recovery" } });
    expect(seeded.status(), await seeded.text()).toBe(201);
    const { conversationId, projectId } = (await seeded.json()) as { conversationId: string; projectId: string };
    const wired = await request.post(`/api/conversations/${conversationId}/extensions`, { data: { names: [name] } });
    expect(wired.status(), await wired.text()).toBe(200);
    await navigateWithRuntimeEventTeardown(page, browserObserver, `/project/${projectId}/chat/${conversationId}`);
    await invokeExtensionToolFromComposer(page, name, { text: retainedOutput });
    await expectInlineToolOutput(page, `Recovery v1: ${retainedOutput}`);

    await navigateWithRuntimeEventTeardown(page, browserObserver, `/extensions/author?installation=${installationId}`);
    await page.getByRole("button", { name: "src/echo.ts", exact: true }).click();
    await page.getByRole("textbox", { name: "Source: src/echo.ts", exact: true }).fill("export function echo( {");
    await page.getByRole("button", { name: "Save and build", exact: true }).click();
    await waitForVisibleOperationState(page, "failed");
    const diagnostics = page.locator(".operation").first().locator(".diagnostic");
    await expect(diagnostics).not.toHaveCount(0);
    await captureEvidence(page, testInfo, "extension-browser-build-diagnostics", { fullPage: true });

    await navigateWithRuntimeEventTeardown(page, browserObserver, `/project/${projectId}/chat/${conversationId}`);
    await invokeExtensionToolFromComposer(page, name, { text: firstOutput });
    await expectInlineToolOutput(page, `Recovery v1: ${firstOutput}`);

    await navigateWithRuntimeEventTeardown(page, browserObserver, `/extensions/author?installation=${installationId}`);
    await page.getByRole("button", { name: "src/echo.ts", exact: true }).click();
    await page.getByRole("textbox", { name: "Source: src/echo.ts", exact: true }).fill(echoSource("Recovery v2: "));
    await page.getByRole("button", { name: "src/echo.test.ts", exact: true }).click();
    await page.getByRole("textbox", { name: "Source: src/echo.test.ts", exact: true }).fill(
      `import { expect, test } from "bun:test"; import { echo } from "./echo"; test("echoes", () => expect(echo({ text: "value" })).toEqual({ text: "Recovery v2: value" }));\n`,
    );
    await page.getByRole("button", { name: "Save and build", exact: true }).click();
    await waitForVisibleOperationState(page, "verified");
    const repairedRelease = page.locator(".release").filter({ hasText: "Verified" }).first();
    const repairedRequestApproval = repairedRelease.getByRole("button", { name: "Request approval", exact: true });
    await expect(repairedRequestApproval).toBeEnabled();
    await repairedRequestApproval.click();
    const repairedDigest = (await repairedRelease.locator("dd code").first().textContent())!.trim();
    const repairedApproval = page.locator(".approval").filter({ hasText: repairedDigest });
    await repairedApproval.getByLabel("I reviewed this release and its permissions.").check();
    await repairedApproval.getByRole("button", { name: "Approve exact release", exact: true }).click();
    await repairedApproval.getByRole("button", { name: "Activate approved release", exact: true }).click();
    await expect(page.getByRole("button", { name: "Disable installation", exact: true })).toBeEnabled();

    await navigateWithRuntimeEventTeardown(page, browserObserver, `/project/${projectId}/chat/${conversationId}`);
    await invokeExtensionToolFromComposer(page, name, { text: repairedOutput });
    await expectInlineToolOutput(page, `Recovery v2: ${repairedOutput}`);
    await captureEvidence(page, testInfo, "extension-browser-repaired-output", { fullPage: true });
  } finally {
    await attachBrowserDiagnostics(testInfo, "extension-browser-recovery-client-diagnostics", browserDiagnostics);
    if (installationId) {
      const cleanup = await request.delete(`/api/extensions/${installationId}`);
      expect([204, 404]).toContain(cleanup.status());
    }
  }
  expectCleanBrowserDiagnostics(browserDiagnostics);
});

test("same-session stale tabs cannot replace a new active release or restore an uninstall", async ({ page, request, baseURL }, testInfo) => {
  test.setTimeout(360_000);
  const pageObserver = observeBrowserDiagnostics(page, baseURL!);
  const pageDiagnostics = pageObserver.diagnostics;
  const name = `ui-stale-${Date.now().toString(36)}`;
  const { client } = await extensionClient(request, baseURL!);
  const created = await client.extensionControl<CreatedWorkspace>("extensions_workspace", { action: "create", name });
  const first = await buildWorkspace(client, created);
  const releaseOne = Object.values(first.releases)[0]!;
  const installationId = created.installation.id;
  const stalePage = await page.context().newPage();
  const stalePageObserver = observeBrowserDiagnostics(stalePage, baseURL!);
  const stalePageDiagnostics = stalePageObserver.diagnostics;

  try {
    await requestRelease(client, first, releaseOne.id);
    await navigateWithRuntimeEventTeardown(page, pageObserver, created.openUrl);
    await page.getByLabel("I reviewed this release and its permissions.").check();
    await page.getByRole("button", { name: "Approve exact release", exact: true }).click();
    await page.getByRole("button", { name: "Activate approved release", exact: true }).click();
    await expect(page.getByRole("button", { name: "Disable installation", exact: true })).toBeEnabled();

    // B approves R2 while R1 is active and retains the rendered R2 activation.
    // A then activates separately-approved R3, so B's R2 action is stale.
    const fork = await client.extensionControl<CreatedWorkspace>("extensions_workspace", { action: "fork", installationId, releaseId: releaseOne.id });
    const edited = await client.extensionControl<CreatedWorkspace["workspace"]>("extensions_workspace", {
      action: "edit", installationId, workspaceId: fork.workspace.id, expectedRevision: fork.workspace.revision,
      writes: { "src/echo.ts": echoSource("Stale tab v2: "), "src/echo.test.ts": `import { expect, test } from "bun:test"; import { echo } from "./echo"; test("echoes", () => expect(echo({ text: "value" })).toEqual({ text: "Stale tab v2: value" }));\n` },
    });
    const operation = await client.extensionControl<{ id: string }>("extensions_build", {
      installationId, workspaceId: edited.id, expectedRevision: edited.revision, idempotencyKey: crypto.randomUUID(),
    });
    const second = await waitForExtensionBuild(client, installationId, operation.id);
    const releaseTwo = second.releases[second.operations[operation.id]!.releaseId!]!;
    await requestRelease(client, second, releaseTwo.id);
    await navigateWithRuntimeEventTeardown(stalePage, stalePageObserver, `/extensions/author?installation=${installationId}&workspace=${edited.id}`);
    await waitForHydration(stalePage);
    const secondApproval = stalePage.locator(".approval").filter({ hasText: releaseTwo.releaseDigest });
    await secondApproval.getByLabel("I reviewed this release and its permissions.").check();
    await secondApproval.getByRole("button", { name: "Approve exact release", exact: true }).click();
    await expect(secondApproval.getByRole("button", { name: "Activate approved release", exact: true })).toBeVisible();

    const forkThree = await client.extensionControl<CreatedWorkspace>("extensions_workspace", { action: "fork", installationId, releaseId: releaseOne.id });
    const editedThree = await client.extensionControl<CreatedWorkspace["workspace"]>("extensions_workspace", {
      action: "edit", installationId, workspaceId: forkThree.workspace.id, expectedRevision: forkThree.workspace.revision,
      writes: { "src/echo.ts": echoSource("Stale tab v3: "), "src/echo.test.ts": `import { expect, test } from "bun:test"; import { echo } from "./echo"; test("echoes", () => expect(echo({ text: "value" })).toEqual({ text: "Stale tab v3: value" }));\n` },
    });
    const operationThree = await client.extensionControl<{ id: string }>("extensions_build", {
      installationId, workspaceId: editedThree.id, expectedRevision: editedThree.revision, idempotencyKey: crypto.randomUUID(),
    });
    const third = await waitForExtensionBuild(client, installationId, operationThree.id);
    const releaseThree = third.releases[third.operations[operationThree.id]!.releaseId!]!;
    await requestRelease(client, third, releaseThree.id);

    await navigateWithRuntimeEventTeardown(page, pageObserver, `/extensions/author?installation=${installationId}&workspace=${editedThree.id}`);
    const thirdApproval = page.locator(".approval").filter({ hasText: releaseThree.releaseDigest });
    await thirdApproval.getByLabel("I reviewed this release and its permissions.").check();
    await thirdApproval.getByRole("button", { name: "Approve exact release", exact: true }).click();
    await thirdApproval.getByRole("button", { name: "Activate approved release", exact: true }).click();
    await expect.poll(async () => {
      const current = await client.extensionControl<{ installation: { activeReleaseId: string } }>("extensions_inspect", { installationId });
      return current.installation.activeReleaseId;
    }, { timeout: 30_000, intervals: [250] }).toBe(releaseThree.id);

    await secondApproval.getByRole("button", { name: "Activate approved release", exact: true }).click();
    const staleDenial = stalePage.getByRole("alert");
    await expect(staleDenial).toContainText(/stale|no longer matches/i);
    await staleDenial.scrollIntoViewIfNeeded();
    await captureEvidence(stalePage, testInfo, "extension-stale-tab-denial", { fullPage: true });
    const unchanged = await client.extensionControl<{ installation: { activeReleaseId: string } }>("extensions_inspect", { installationId });
    expect(unchanged.installation.activeReleaseId).toBe(releaseThree.id);
    await navigateWithRuntimeEventTeardown(page, pageObserver, "/extensions");
    const card = page.locator(`[data-testid="ext-card"][data-ext-id="${installationId}"]`);
    await card.getByTestId("ext-card-uninstall").click();
    const uninstallResponse = page.waitForResponse(response =>
      response.request().method() === "DELETE"
      && new URL(response.url()).pathname === `/api/extensions/${installationId}`,
    );
    await page.getByTestId("uninstall-dialog").getByTestId("uninstall-confirm").click();
    expect((await uninstallResponse).status()).toBe(204);
    await expect(card).toHaveCount(0);

    // B still has the pre-uninstall DOM. Its action must fail and reload must
    // show removal; retained history/data are intentionally not treated as a
    // restored installation.
    await secondApproval.getByRole("button", { name: "Activate approved release", exact: true }).click();
    await expect(stalePage.getByRole("alert")).toContainText(/stale|missing|uninstall/i);
    await reloadWithRuntimeEventTeardown(stalePage, stalePageObserver);
    await waitForHydration(stalePage);
    // Retained author history is projected as disabled after uninstall; the
    // removed card and 404 tool lookup below prove it is not reactivated.
    await expect(stalePage.locator(".state-badge")).toContainText("Uninstalled");
    await expect(stalePage.getByRole("status")).toContainText("was uninstalled");
    await expect(stalePage.getByText("Previously active", { exact: true })).toBeVisible();
    await expect(stalePage.getByRole("button", { name: "Activate approved release", exact: true })).toHaveCount(0);
    await expect(stalePage.getByRole("button", { name: "Request approval", exact: true }).first()).toBeDisabled();
    const removed = await client.extensionControl<{ installation: { status: string; enabled: boolean; uninstalled: boolean; activeReleaseId: string; grants: unknown[] } }>("extensions_inspect", { installationId });
    expect(removed.installation).toMatchObject({
      status: "disabled",
      enabled: false,
      uninstalled: true,
      activeReleaseId: releaseThree.id,
      grants: [],
    });
    const tools = await request.get(`/api/extensions/${encodeURIComponent(name)}/tools`);
    expect(tools.status()).toBe(404);
    await stalePage.locator(".state-badge").scrollIntoViewIfNeeded();
    await captureEvidence(stalePage, testInfo, "extension-stale-tab-uninstall", { fullPage: false });
    await stalePage.getByText("Previously active", { exact: true }).scrollIntoViewIfNeeded();
    await captureEvidence(stalePage, testInfo, "extension-stale-tab-uninstall-release", { fullPage: false });
  } finally {
    await attachBrowserDiagnostics(testInfo, "extension-stale-tab-primary-client-diagnostics", pageDiagnostics);
    await attachBrowserDiagnostics(testInfo, "extension-stale-tab-secondary-client-diagnostics", stalePageDiagnostics);
    await stalePage.close();
    if (installationId) await request.delete(`/api/extensions/${installationId}`);
  }
  expectCleanBrowserDiagnostics(pageDiagnostics);
  // Both denied clicks are intentional stale mutations. The UI displays each
  // 409 as an alert, and no other browser errors or failed API calls are valid.
  expectCleanBrowserDiagnostics(stalePageDiagnostics, {
    // Chromium logs rejected fetches; Firefox does not. Both paths send the
    // same two browser-visible 409 denial responses asserted below.
    consoleErrorVariants: [
      [],
      [
        "Failed to load resource: the server responded with a status of 409 (Conflict)",
        "Failed to load resource: the server responded with a status of 409 (Conflict)",
      ],
    ],
    apiFailures: [
      { method: "POST", status: 409, path: "/api/extensions/control" },
      { method: "POST", status: 409, path: "/api/extensions/control" },
    ],
  });
});
