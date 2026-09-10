/**
 * External ONNX browser contract. Run only through
 * `EZCORP_E2E_KOKORO_REAL=1 bun scripts/run-kokoro-realmodel-e2e.sh`.
 *
 * The standard Kokoro suite uses a deterministic Worker bridge. This lane
 * keeps the supported model download and real browser Worker execution
 * observable without making every mock CI run download model weights.
 */
import { expect, test } from "./fixtures/test-base.js";
import { makeConversation, makeMessage, makeProject } from "./fixtures/data.js";

const REAL_MODEL_ENABLED = process.env.EZCORP_E2E_KOKORO_REAL === "1";

test.describe("Kokoro-TTS external ONNX model", () => {
  test("synthesizes a real WAV in the browser Worker and saves it", async ({ page, mockApi }) => {
    expect(REAL_MODEL_ENABLED, "run through scripts/run-kokoro-realmodel-e2e.sh with explicit opt-in").toBe(true);

    const project = makeProject({ id: "kokoro-real-project", name: "Kokoro real model" });
    const conversation = makeConversation({ id: "kokoro-real-conversation", projectId: project.id });
    const source = makeMessage({
      id: "kokoro-source",
      conversationId: conversation.id,
      role: "assistant",
      content: "Hello from the real Kokoro model.",
    });
    const ttsTurn = makeMessage({
      id: "kokoro-turn",
      conversationId: conversation.id,
      role: "extension",
      excluded: true,
      parentMessageId: source.id,
      content: "Kokoro synthesis in progress",
      createdAt: "2026-01-01T00:01:00.000Z",
    });
    const modelRequests: string[] = [];
    const uploads: Array<{ body: Buffer | null; contentType: string | undefined }> = [];
    const saveBodies: unknown[] = [];
    page.on("request", (request) => {
      if (/huggingface\.co|cdn-lfs\.huggingface\.co/.test(request.url())) modelRequests.push(request.url());
    });

    await mockApi({
      projects: [project],
      conversations: [conversation],
      messages: [source, ttsTurn],
      messageToolCalls: {
        [ttsTurn.id]: [{
          id: "kokoro-real-tool-call",
          extensionId: "kokoro-tts",
          toolName: "kokoro-tts.synthesize",
          cardType: "kokoro-tts-player",
          input: { text: source.content },
          outputSummary: null,
          fullOutput: null,
          status: "success",
          success: true,
          durationMs: 0,
          messageId: ttsTurn.id,
        }],
      },
    });
    await page.route("**/api/extensions/kokoro-tts/uploads", async (route) => {
      uploads.push({
        body: route.request().postDataBuffer(),
        contentType: route.request().headers()["content-type"],
      });
      await route.fulfill({ json: { attachmentId: "kokoro-real-audio" } });
    });
    await page.route("**/api/extensions/kokoro-tts/events/save", async (route) => {
      saveBodies.push(route.request().postDataJSON());
      await route.fulfill({ json: { ok: true } });
    });

    await page.goto(`/project/${project.id}/chat/${conversation.id}`);
    await expect(page.getByTestId("kokoro-tts-synthesizing")).toBeVisible();
    const audio = page.getByTestId("kokoro-tts-audio-blob");
    await expect(audio).toBeVisible({ timeout: 600_000 });
    const src = await audio.getAttribute("src");
    expect(src).toMatch(/^blob:/);
    const header = await page.evaluate(async (audioSrc) => {
      const bytes = new Uint8Array(await (await fetch(audioSrc)).arrayBuffer());
      return String.fromCharCode(...bytes.slice(0, 4), ...bytes.slice(8, 12));
    }, src!);
    expect(header).toBe("RIFFWAVE");
    await expect.poll(() => uploads.length, { timeout: 30_000 }).toBe(1);
    await expect.poll(() => saveBodies.length, { timeout: 30_000 }).toBe(1);
    expect(modelRequests.length).toBeGreaterThan(0);
    expect(uploads[0]!.contentType).toContain("multipart/form-data");
    expect(uploads[0]!.body?.toString("latin1")).toContain("kokoro-tts.wav");
    expect(uploads[0]!.body?.length).toBeGreaterThan(44);
    expect(saveBodies[0]).toEqual({
      conversationId: conversation.id,
      messageId: ttsTurn.id,
      toolCallId: "kokoro-real-tool-call",
      attachmentId: "kokoro-real-audio",
    });
  });
});
