/**
 * Permission browser contracts retained through the v4 release transition.
 * The retired detail-page TTL picker is replaced by exact release review;
 * legacy TTL values remain visible as audit history. Actual authorization,
 * append-message audit persistence, and retired-API rejection belong to
 * real-auth/permission-backbone.spec.ts, not this controlled transport lane.
 */
import type { Page } from "@playwright/test";
import type { MockOverrides } from "./fixtures/api-mocks.js";
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { sendComposerMessage, threadMessages } from "./fixtures/composer.js";
import { setupAuthorReviewMock } from "./fixtures/extension-source-import.js";
import { makeProject, makeConversation, makeMessage, makeExtension } from "./fixtures/data.js";
import type { ExpiredGrant } from "../src/lib/components/permissions/expired-grant.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const project = makeProject({ id: "proj-1", name: "Test Project" });
const conversation = makeConversation({ id: "conv-1", projectId: project.id, title: "Permission backbone" });
const userMessage = makeMessage({ id: "m1", conversationId: conversation.id, role: "user", content: "Trigger the test extension" });
const assistantMessage = makeMessage({ id: "m2", conversationId: conversation.id, role: "assistant", content: "Calling test-extension.echo...", parentMessageId: userMessage.id });
const extension = makeExtension({ id: "ext-test-1", name: "test-extension", grantedPermissions: { grantedAt: {} } });
type BrowserFixtures = {
  page: Page;
  mockApi: (overrides?: MockOverrides) => Promise<void>;
};
type StreamingFixtures = BrowserFixtures & { emitSse: (event: { type: string; data: unknown }) => Promise<void> };

async function openPermissionGate({ page, mockApi, emitSse }: StreamingFixtures) {
  await mockApi({ projects: [project], conversations: [conversation], messages: [userMessage, assistantMessage], extensions: [extension] });
  await page.goto(`/project/${project.id}/chat/${conversation.id}`);
  const [started] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === `/api/conversations/${conversation.id}/messages` && response.request().method() === "POST"),
    sendComposerMessage(page, "Echo hello"),
  ]);
  expect(started.status()).toBe(200);
  const { runId } = await started.json();
  expect(runId).toEqual(expect.any(String));
  await expect(threadMessages(page).getByText("Echo hello", { exact: true })).toBeVisible();
  await emitSse({ type: "run:token", data: { runId, token: "..." } });
  await emitSse({ type: "tool:start", data: {
    conversationId: conversation.id, toolName: "test-extension__echo", input: { text: "hello" }, timestamp: Date.now(), cardType: "terminal",
  } });
  await expect(page.getByTestId("permission-scope-chooser")).toHaveCount(0);
  await emitSse({ type: "tool:permission_request", data: {
    conversationId: conversation.id, toolCallId: "tc-permission", toolName: "test-extension__echo", input: { text: "hello" },
    extensionId: extension.name, capabilityKind: "shell", cardType: "terminal",
  } });
  await expect(page.getByTestId("permission-scope-chooser")).toBeVisible();
}

function expiredGrant(overrides: Partial<ExpiredGrant> = {}): ExpiredGrant {
  return { auditId: "audit-expired", extensionId: extension.id, capability: "network", ageMs: 3 * DAY_MS, expiredAt: Date.now() - 3 * DAY_MS, ...overrides };
}

async function openExpiredGrants({ page, mockApi }: BrowserFixtures, grants: ExpiredGrant[]) {
  const mutations: string[] = [];
  await mockApi({ projects: [project], extensions: [extension], routes: {
    [`/api/extensions/${extension.id}`]: () => extension,
    [`/api/extensions/${extension.id}/violations`]: () => ({ violations: [] }),
    [`/api/extensions/${extension.id}/settings`]: () => ({ schema: null, values: {} }),
  } });
  await page.route(`**/api/extensions/${extension.id}/expired-grants`, route => route.fulfill({ json: { grants } }));
  page.on("request", request => {
    if (new URL(request.url()).pathname.startsWith("/api/extensions/") && request.method() !== "GET") mutations.push(request.url());
  });
  const [loaded] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === `/api/extensions/${extension.id}/expired-grants`),
    page.goto(`/extensions/${extension.id}`),
  ]);
  expect(loaded.status()).toBe(200);
  await expect(page.getByRole("heading", { name: extension.name, exact: true })).toBeVisible();
  return mutations;
}

test.describe("In-chat permission chooser", () => {
  test("renders all four scopes, deny, and the requesting extension", async ({ page, mockApi, emitSse }) => {
    await openPermissionGate({ page, mockApi, emitSse });
    for (const scope of ["session", "conversation", "project", "forever"]) {
      await expect(page.getByTestId(`permission-allow-${scope}`)).toBeVisible();
    }
    await expect(page.getByTestId("permission-deny")).toBeVisible();
    await expect(page.getByTestId("permission-extension-badge")).toHaveText(extension.name);
  });

  test("forever is reachable in the install chooser", async ({ page, mockApi, emitSse }) => {
    await openPermissionGate({ page, mockApi, emitSse });
    // This is the UI affordance. The server remains the grant authority.
    await expect(page.getByTestId("permission-allow-forever")).toBeEnabled();
  });

  test("conversation approval targets the requesting tool call", async ({ page, mockApi, emitSse }) => {
    await openPermissionGate({ page, mockApi, emitSse });
    await page.route("**/api/tool-calls/tc-permission/permission", route => route.fulfill({ json: { ok: true } }));
    const [approval] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === "/api/tool-calls/tc-permission/permission" && response.request().method() === "POST"),
      page.getByTestId("permission-allow-conversation").click(),
    ]);
    expect(approval.status()).toBe(200);
    expect(approval.request().postDataJSON()).toEqual({ approved: true, scope: "conversation" });
    // The runtime completion ends the pending card after the approval POST.
    await emitSse({ type: "tool:complete", data: { conversationId: conversation.id, toolName: "test-extension__echo", output: "Permission granted: hello", success: true, duration: 25 } });
    await expect(page.getByTestId("permission-scope-chooser")).toHaveCount(0);
    await threadMessages(page).getByRole("button", { name: "test-extension__echo 0.0s", exact: true }).click();
    await expect(threadMessages(page).getByText("Permission granted: hello", { exact: true })).toBeVisible();
  });
});

test.describe("Expired permission history and current release review", () => {
  test("shows the expired capability, age, and review action", async ({ page, mockApi }) => {
    await openExpiredGrants({ page, mockApi }, [expiredGrant()]);
    await expect(page.getByTestId("expired-grants-row")).toHaveCount(1);
    await expect(page.getByTestId("expired-grants-row-capability")).toHaveText("network");
    await expect(page.getByTestId("expired-grants-row-age")).toHaveText("expired 3 days ago");
    await expect(page.getByTestId("expired-grants-row-reapprove")).toBeVisible();
    await expect(page.getByTestId("expired-grants-row-ttl")).toHaveCount(0);
  });

  test("shows no expiry banner when there are no expired grants", async ({ page, mockApi }) => {
    await openExpiredGrants({ page, mockApi }, []);
    await expect(page.getByTestId("expired-grants-banner")).toHaveCount(0);
  });

  test("Re-approve opens the exact installation release review without granting permissions", async ({ page, mockApi }, testInfo) => {
    const mutations = await openExpiredGrants({ page, mockApi }, [expiredGrant()]);
    await captureEvidence(page, testInfo, "expired-grant-history");
    const review = await setupAuthorReviewMock(page, { installationId: extension.id });
    await page.getByTestId("expired-grants-row-reapprove").click();
    await review.expectReview();
    await captureEvidence(page, testInfo, "expired-grant-release-review");
    expect(mutations).toEqual([]);
    await review.close();
  });

  test("leaving release review keeps the expired grant unchanged", async ({ page, mockApi }) => {
    const mutations = await openExpiredGrants({ page, mockApi }, [expiredGrant()]);
    const review = await setupAuthorReviewMock(page, { installationId: extension.id });
    await page.getByTestId("expired-grants-row-reapprove").click();
    await review.expectReview();
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/extensions/${extension.id}$`));
    await expect(page.getByTestId("expired-grants-row-capability")).toHaveText("network");
    await expect(page.getByTestId("expired-grants-row-reapprove")).toBeEnabled();
    expect(mutations).toEqual([]);
    await review.close();
  });

  test("retains the historical seven-day grant after reload", async ({ page, mockApi }) => {
    await openExpiredGrants({ page, mockApi }, [expiredGrant({ ttlOverrideMs: 7 * DAY_MS, stickyTtlMs: 7 * DAY_MS })]);
    await expect(page.getByTestId("expired-grants-row-ttl")).toHaveText("Approved for 7 days");
    await page.reload();
    await expect(page.getByTestId("expired-grants-row-ttl")).toHaveText("Approved for 7 days");
    await expect(page.getByTestId("expired-grants-row-reapprove")).toBeEnabled();
  });

  test("keeps forever history distinct from an absent TTL", async ({ page, mockApi }) => {
    await openExpiredGrants({ page, mockApi }, [expiredGrant({ ttlOverrideMs: null }), expiredGrant({ auditId: "legacy-row", capability: "shell" })]);
    const rows = page.getByTestId("expired-grants-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: "network" }).getByTestId("expired-grants-row-ttl")).toHaveText("Approved forever");
    await expect(rows.filter({ hasText: "shell" }).getByTestId("expired-grants-row-ttl")).toHaveCount(0);
  });
});

test("message toolbar sends the selected assistant message to its declared event", async ({ page, mockApi }) => {
  await mockApi({ projects: [project], conversations: [conversation], messages: [userMessage, assistantMessage], extensions: [makeExtension({ name: "kokoro-tts" })] });
  await page.route(`**/api/conversations/${conversation.id}/extension-toolbar`, route => route.fulfill({ json: { items: [{ extName: "kokoro-tts", id: "speak", icon: "Volume2", tooltip: "Speak this message", event: "speak", appliesTo: "assistant" }] } }));
  await page.route("**/api/extensions/kokoro-tts/events/speak", route => route.fulfill({ json: { ok: true } }));
  await page.goto(`/project/${project.id}/chat/${conversation.id}`);
  const message = threadMessages(page).locator(`[data-message-id="${assistantMessage.id}"]`);
  await message.hover();
  const [event] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === "/api/extensions/kokoro-tts/events/speak" && response.request().method() === "POST"),
    message.getByTestId("ext-action-kokoro-tts-speak").click(),
  ]);
  expect(event.status()).toBe(200);
  expect(event.request().postDataJSON()).toMatchObject({ conversationId: conversation.id, messageId: assistantMessage.id, content: assistantMessage.content });
});
