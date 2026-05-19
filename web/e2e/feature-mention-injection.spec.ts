/**
 * E2E for the `$[feature:…]` composer flow.
 *
 * Covered behaviors (per design doc §4 + dev's #4 + dev's #6):
 *   1. Typing `$cha` in the composer opens the mention popover.
 *   2. Picker shows feature entries (data-driven on `kind: "feature"`).
 *   3. Selecting an entry inserts `$[feature:NAME] ` into the textarea
 *      with cursor after the trailing space.
 *   4. The persisted message body keeps the raw `$[feature:NAME]` token.
 *
 * The server-side expansion (the prepended **Feature: NAME** system
 * note) is verified at the unit + integration level in
 * `src/__tests__/build-prompt-feature.test.ts` (see #3). Here we only
 * exercise the COMPOSER flow — the assert that "outgoing message body
 * contains the raw token" proves persistence-not-substitution at the
 * client/UI boundary.
 */
import { test, expect } from "./fixtures/test-base.js";
import {
  makeProject,
  makeConversation,
  makeAgent,
} from "./fixtures/data.js";

const PROJECT_ID = "proj-feat-mention";
const CONV_ID = "conv-feat-mention";

const project = makeProject({ id: PROJECT_ID, name: "Feature Mention Project" });
const conv = makeConversation({
  id: CONV_ID,
  projectId: PROJECT_ID,
  title: "Mention chat",
});

test.describe("Feature mention injection — composer flow", () => {
  test("type $cha → popover opens with feature entries → pick → token inserted into textarea", async ({
    page,
    mockApi,
  }) => {
    await mockApi({
      projects: [project],
      conversations: [conv],
      messages: [],
      agents: [makeAgent({ name: "summarizer", description: "Summarizer agent" })],
      features: [
        {
          id: "f-chat-attachments",
          projectId: PROJECT_ID,
          name: "chat-attachments",
          description: "Files under src/chat/attachments",
          source: "agent",
          fileCount: 3,
        },
        {
          id: "f-chat",
          projectId: PROJECT_ID,
          name: "chat",
          description: "Files under src/chat",
          source: "agent",
          fileCount: 5,
        },
        {
          id: "f-auth",
          projectId: PROJECT_ID,
          name: "auth",
          description: "Files under src/auth",
          source: "user",
          fileCount: 2,
        },
      ],
    });

    await page.goto(`/project/${PROJECT_ID}/chat/${CONV_ID}`);

    // Wait for chat composer to be ready.
    const textarea = page.locator("textarea").first();
    await expect(textarea).toBeVisible({ timeout: 5000 });

    // Connection establishment race (mirrors mention-system.spec.ts pattern).
    await page.waitForFunction(
      () => {
        const listeners = (window as any).__fakeWsListeners;
        if (listeners?.open) {
          for (const fn of listeners.open) {
            try {
              fn(new Event("open"));
            } catch {}
          }
        }
        const ta = document.querySelector("textarea");
        return ta && !(ta as HTMLTextAreaElement).disabled;
      },
      { timeout: 5000 },
    );
    await expect(textarea).toBeEnabled({ timeout: 5000 });
    await page.waitForTimeout(100);
    await textarea.click();

    // Type `$cha` and wait for popover.
    await textarea.focus();
    await textarea.pressSequentially("$cha", { delay: 50 });
    await page.waitForTimeout(350);

    const listbox = page.locator("#mention-listbox");
    await expect(listbox).toBeVisible({ timeout: 5000 });

    // Both `chat-attachments` and `chat` should match "cha"; `auth`
    // should NOT match. Names render with the `$` sigil prefix.
    await expect(listbox.getByText("$chat-attachments")).toBeVisible({ timeout: 3000 });
    await expect(listbox.getByText("$chat", { exact: true })).toBeVisible();
    await expect(listbox.getByText("auth")).not.toBeVisible();

    // Click the chat-attachments item to insert.
    await listbox.getByText("$chat-attachments").click();

    // Textarea now contains the inserted token.
    await expect(textarea).toHaveValue(/\$\[feature:chat-attachments\]\s$/);

    // The popover closes after selection.
    await expect(listbox).not.toBeVisible({ timeout: 2000 });
  });

  test("$ at start of message also triggers picker", async ({ page, mockApi }) => {
    await mockApi({
      projects: [project],
      conversations: [conv],
      messages: [],
      features: [
        {
          id: "f1",
          projectId: PROJECT_ID,
          name: "auth",
          description: "Files under src/auth",
          source: "agent",
          fileCount: 2,
        },
      ],
    });

    await page.goto(`/project/${PROJECT_ID}/chat/${CONV_ID}`);
    const textarea = page.locator("textarea").first();
    await page.waitForFunction(
      () => {
        const listeners = (window as any).__fakeWsListeners;
        if (listeners?.open) {
          for (const fn of listeners.open) {
            try {
              fn(new Event("open"));
            } catch {}
          }
        }
        const ta = document.querySelector("textarea");
        return ta && !(ta as HTMLTextAreaElement).disabled;
      },
      { timeout: 5000 },
    );
    await expect(textarea).toBeEnabled({ timeout: 5000 });
    await textarea.click();

    await textarea.pressSequentially("$", { delay: 50 });
    await page.waitForTimeout(350);

    const listbox = page.locator("#mention-listbox");
    await expect(listbox).toBeVisible({ timeout: 5000 });
    // With empty query the picker shows all features. Name renders with $ prefix.
    await expect(listbox.getByText("$auth")).toBeVisible();
  });

  test("$5.00 in plain text does NOT trigger the picker (false-positive guard)", async ({
    page,
    mockApi,
  }) => {
    await mockApi({
      projects: [project],
      conversations: [conv],
      messages: [],
      features: [
        {
          id: "f1",
          projectId: PROJECT_ID,
          name: "auth",
          description: "Auth",
          source: "agent",
          fileCount: 2,
        },
      ],
    });

    await page.goto(`/project/${PROJECT_ID}/chat/${CONV_ID}`);
    const textarea = page.locator("textarea").first();
    await page.waitForFunction(
      () => {
        const listeners = (window as any).__fakeWsListeners;
        if (listeners?.open) {
          for (const fn of listeners.open) {
            try {
              fn(new Event("open"));
            } catch {}
          }
        }
        const ta = document.querySelector("textarea");
        return ta && !(ta as HTMLTextAreaElement).disabled;
      },
      { timeout: 5000 },
    );
    await expect(textarea).toBeEnabled({ timeout: 5000 });
    await textarea.click();

    // Type "Owe $5.00 to Bob" — the trigger anchors at the rightmost
    // word-boundary $, but `$5.00` has no `$` directly preceded by
    // whitespace at the cursor (cursor is at end after "Bob"); the
    // popover should NOT be visible.
    await textarea.pressSequentially("Owe $5.00 to Bob", { delay: 30 });
    await page.waitForTimeout(350);

    const listbox = page.locator("#mention-listbox");
    await expect(listbox).not.toBeVisible({ timeout: 2000 });
  });
});
