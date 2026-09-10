/**
 * Permission backbone at the live extension boundary.
 *
 * The browser Worker is a deterministic audio encoder only. Extension
 * activation, the toolbar event, PDP audit, upload, and tool-call finalization
 * all use the real PGlite-backed application.
 */
import { test, expect } from "../fixtures/hydration.js";
import { importAndActivateBundledExtension } from "../fixtures/extension-v4.js";
import { createMemberSession } from "../fixtures/member-session.js";
import { installKokoroWorkerStub } from "../fixtures/kokoro-worker.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

type ToolCall = {
  id: string;
  toolName: string;
  cardType: string | null;
  status: string;
  output: string | null;
};

type StoredMessage = {
  id: string;
  role: string;
  content: string;
  toolCalls?: ToolCall[];
};

type AuditEntry = {
  action: string;
  metadata: Record<string, unknown> | null;
};

test.describe("permission backbone — native toolbar and retired reapproval", () => {
  test("anonymous audit navigation is redirected to sign in", async ({ browser, baseURL }) => {
    const anonymous = await browser.newContext({ baseURL });
    try {
      const page = await anonymous.newPage();
      await page.goto("/audit");
      await expect(page).toHaveURL(/\/login(?:[?#]|$)/, { timeout: 10_000 });
      await page.goto("/admin/moderation");
      await expect(page).toHaveURL(/\/login(?:[?#]|$)/, { timeout: 10_000 });
    } finally {
      await anonymous.close();
    }
  });

  test("an invited member cannot load audit or moderation", async ({ request, baseURL }) => {
    const member = await createMemberSession(request, baseURL!, "Permission audit member");
    try {
      // Invited members start in onboarding. Complete that real authenticated
      // transition before exercising the protected loaders themselves.
      const onboarded = await member.post("/api/onboarding/complete");
      expect(onboarded.status(), await onboarded.text()).toBe(200);
      const page = await member.get("/audit");
      expect(page.status(), await page.text()).toBe(403);
      const api = await member.get("/api/audit");
      expect(api.status(), await api.text()).toBe(403);
      const moderation = await member.get("/admin/moderation", { maxRedirects: 0 });
      expect(moderation.status(), await moderation.text()).toBe(302);
      expect(moderation.headers()["location"]).toBe("/");
    } finally {
      await member.dispose();
    }
  });
  test("toolbar click records an allowed append decision and durable tool output", async ({ page, request, baseURL }) => {
    test.setTimeout(300_000);
    await installKokoroWorkerStub(page);

    const { state } = await importAndActivateBundledExtension({
      page,
      request,
      baseURL: baseURL!,
      name: "kokoro-tts",
    });
    const installationId = state.installation.id;

    const seeded = await request.post("/api/__test/seed", {
      data: {
        title: `permission-toolbar-${crypto.randomUUID()}`,
        history: { turns: 1, charsPerTurn: 64 },
      },
    });
    expect(seeded.status(), await seeded.text()).toBe(201);
    const { projectId, conversationId, history } = (await seeded.json()) as {
      projectId: string;
      conversationId: string;
      history: { firstContent: string };
    };

    const initialMessages = await request.get(`/api/conversations/${conversationId}/messages?all=true`);
    expect(initialMessages.status(), await initialMessages.text()).toBe(200);
    const source = ((await initialMessages.json()) as StoredMessage[]).find(
      message => message.role === "user" && message.content === history.firstContent,
    );
    expect(source).toBeDefined();

    await page.goto(`/project/${projectId}/chat/${conversationId}`);
    const row = page.locator(`[data-message-id="${source!.id}"]`);
    await expect(row).toBeVisible();
    await row.hover();

    const toolbar = row.getByTestId("ext-action-kokoro-tts-speak");
    await expect(toolbar).toBeVisible();

    const speakResponse = page.waitForResponse(response =>
      response.request().method() === "POST"
      && response.url().endsWith("/api/extensions/kokoro-tts/events/speak"),
    );
    const saveResponse = page.waitForResponse(response =>
      response.request().method() === "POST"
      && response.url().endsWith("/api/extensions/kokoro-tts/events/save"),
    );
    await toolbar.click();

    const speak = await speakResponse;
    expect(speak.status(), await speak.text()).toBe(200);
    const speakBody = (await speak.json()) as { ok: boolean; messageId: string; toolCallIds: string[] };
    expect(speakBody).toMatchObject({ ok: true });
    expect(speakBody.messageId).not.toBe("");
    expect(speakBody.toolCallIds).toHaveLength(1);

    const save = await saveResponse;
    expect(save.status(), await save.text()).toBe(200);

    const persisted = await request.get(`/api/conversations/${conversationId}/messages?withToolCalls=true`);
    expect(persisted.status(), await persisted.text()).toBe(200);
    const stored = (await persisted.json()) as { messages: StoredMessage[] };
    const extensionTurn = stored.messages.find(message => message.id === speakBody.messageId);
    expect(extensionTurn).toMatchObject({
      role: "extension",
      content: `🔊 TTS of message (${history.firstContent.length} chars)`,
    });
    const toolCall = extensionTurn?.toolCalls?.find(call => call.id === speakBody.toolCallIds[0]);
    expect(toolCall).toMatchObject({
      toolName: "kokoro-tts.synthesize",
      cardType: "kokoro-tts-player",
      status: "success",
    });
    expect(toolCall?.output).toMatch(/"attachmentId":"[^"]+"/);

    const audit = await request.get(`/api/extensions/${installationId}/audit?legacy=1&limit=100`);
    expect(audit.status(), await audit.text()).toBe(200);
    const entries = ((await audit.json()) as { entries: AuditEntry[] }).entries;
    expect(entries.some(entry =>
      entry.action === "ext:perm:allowed"
      && entry.metadata?.toolName === "ezcorp/append-message"
      && entry.metadata?.capabilityKind === "ezcorp:chat:append"
      && entry.metadata?.conversationId === conversationId,
    )).toBe(true);
  });

  test("legacy reapprove TTL request directs the user to v4 review", async ({ request }) => {
    const installationId = crypto.randomUUID();
    const response = await request.post(`/api/extensions/${installationId}/reapprove`, {
      data: { capability: "appendMessages", ttlOverrideMs: WEEK_MS },
    });
    expect(response.status(), await response.text()).toBe(410);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      code: "extension_v4_required",
      reviewUrl: `/extensions/author?installation=${installationId}`,
    });
  });
});

