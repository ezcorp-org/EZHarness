/**
 * Browser proof for context compaction on the real auth/DB/backend lane.
 * The provider is deterministic, but this test captures its HTTP request only
 * after the real runtime applies `transformContext`.
 */
import { test, expect } from "./fixtures/hydration.js";
import { sendComposerMessage, threadMessages } from "./fixtures/composer.js";
import type { APIRequestContext } from "@playwright/test";

interface SeededConversation {
  projectId: string;
  conversationId: string;
  history: { firstContent: string; lastContent: string; count: number };
}

interface CapturedRequest {
  model: unknown;
  messages: unknown;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } =>
      typeof part === "object" && part !== null &&
      (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("");
}

async function seedLongConversation(request: APIRequestContext, scriptKey: string) {
  const seeded = await request.post("/api/__test/seed", {
    data: {
      title: `context compaction ${scriptKey}`,
      provider: "ezcorp-mock",
      model: `mock:${scriptKey}`,
      history: { turns: 80, charsPerTurn: 8_000 },
    },
  });
  expect(seeded.status(), await seeded.text()).toBe(201);
  return (await seeded.json()) as SeededConversation;
}

async function scriptProvider(
  request: APIRequestContext,
  scriptKey: string,
  turns: Array<Record<string, unknown>>,
) {
  const scripted = await request.post("/api/__test/mock-llm/script", { data: { scriptKey, turns } });
  expect(scripted.status(), await scripted.text()).toBe(201);
}

async function capturedProviderRequests(request: APIRequestContext, scriptKey: string): Promise<CapturedRequest[]> {
  const captured = await request.get(`/api/__test/mock-llm/script?scriptKey=${encodeURIComponent(scriptKey)}`);
  expect(captured.status(), await captured.text()).toBe(200);
  const body = (await captured.json()) as { requests: CapturedRequest[] };
  return body.requests;
}

test.describe("real browser context compaction", () => {
  test("trims only the provider request while the browser can load persisted early history", async ({ page, request }) => {
    const scriptKey = "context-compaction-success";
    const prompt = "ACTIVE_COMPACTION_PROMPT summarize the retained context.";
    const answer = "COMPACTION_PROVIDER_SUCCESS";
    const seeded = await seedLongConversation(request, scriptKey);
    await scriptProvider(request, scriptKey, [{ text: answer }]);

    await page.goto(`/project/${seeded.projectId}/chat/${seeded.conversationId}`);
    await expect(threadMessages(page).getByText(seeded.history.lastContent.slice(0, 64))).toBeVisible();
    await sendComposerMessage(page, prompt);
    await expect(threadMessages(page).getByText(answer, { exact: true })).toBeVisible({ timeout: 30_000 });

    const [captured] = await capturedProviderRequests(request, scriptKey);
    expect(captured).toBeDefined();
    expect(captured.model).toBe(`mock:${scriptKey}`);
    expect(Array.isArray(captured.messages)).toBe(true);
    const messages = captured.messages as Array<{ role?: unknown; content?: unknown }>;
    const texts = messages.map(({ content }) => messageText(content));
    expect(messages.length).toBeLessThan(seeded.history.count + 1);
    expect(texts.some((text) => text.startsWith("[Context note:"))).toBe(true);
    expect(texts.some((text) => text.includes(seeded.history.firstContent.slice(0, 64)))).toBe(false);
    expect(texts.some((text) => text.includes(prompt))).toBe(true);

    const earliest = threadMessages(page).getByText(seeded.history.firstContent.slice(0, 64));
    for (let pageNumber = 0; pageNumber < 4 && await earliest.count() === 0; pageNumber++) {
      const loadOlder = page.getByRole("button", { name: /load older messages/i });
      await loadOlder.focus();
      await page.keyboard.press("Enter");
    }
    await expect(earliest).toBeVisible();
    await expect(page.getByRole("button", { name: "Send message" })).toHaveAttribute("title", "Send message");
    await expect(page.locator("textarea")).toBeEnabled();
  });

  test("a real provider overflow renders an error and leaves the composer usable", async ({ page, request }) => {
    const scriptKey = "context-compaction-overflow";
    const seeded = await seedLongConversation(request, scriptKey);
    const recovery = "OVERFLOW_RECOVERY_PROVIDER_SUCCESS";
    await scriptProvider(request, scriptKey, [
      { fault: { status: 400, message: "context_length_exceeded" } },
      { text: recovery },
    ]);

    // A hydrated composer must still wait for its persisted model. Hold the
    // real conversation response to reproduce a slow first load deterministically.
    let releaseConversation!: () => void;
    const conversationReady = new Promise<void>((resolve) => { releaseConversation = resolve; });
    let observedConversation!: () => void;
    const conversationRequested = new Promise<void>((resolve) => { observedConversation = resolve; });
    await page.route(`**/api/conversations/${seeded.conversationId}`, async (route) => {
      const response = await route.fetch();
      observedConversation();
      await conversationReady;
      await route.fulfill({ response });
    });
    try {
      await page.goto(`/project/${seeded.projectId}/chat/${seeded.conversationId}`);
      await conversationRequested;
      await expect(page.locator("textarea")).toBeDisabled();
      await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
    } finally {
      releaseConversation();
    }
    const sent = page.waitForRequest((request) => request.method() === "POST"
      && new URL(request.url()).pathname === `/api/conversations/${seeded.conversationId}/messages`);
    await sendComposerMessage(page, "ACTIVE_OVERFLOW_PROMPT");
    expect((await sent).postDataJSON()).toMatchObject({ provider: "ezcorp-mock", model: `mock:${scriptKey}` });
    // A 400 context error is a caller error, so it must be shown unchanged;
    // it must not silently complete the run or route to another provider.
    await expect(threadMessages(page).getByText(/context_length_exceeded/i)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Send message" })).toHaveAttribute("title", "Send message");
    await expect(page.locator("textarea")).toBeEnabled();

    await sendComposerMessage(page, "ACTIVE_RECOVERY_PROMPT");
    await expect(threadMessages(page).getByText(recovery, { exact: true })).toBeVisible({ timeout: 30_000 });

    const captured = await capturedProviderRequests(request, scriptKey);
    expect(captured).toHaveLength(2);
    expect(captured.map(({ model }) => model)).toEqual([`mock:${scriptKey}`, `mock:${scriptKey}`]);
    const requests = captured.map(({ messages }) => messages as Array<{ content?: unknown }>);
    expect(requests[1]!.some(({ content }) => messageText(content).includes("ACTIVE_RECOVERY_PROMPT"))).toBe(true);
  });
});
