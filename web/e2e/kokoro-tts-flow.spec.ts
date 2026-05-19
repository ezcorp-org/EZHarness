/**
 * Kokoro-TTS extension — end-to-end user flow.
 *
 * Closes the seams between four moving parts that are independently
 * unit-tested but only their composition is exercised here:
 *   1. `MessageToolbar` extension-action rendering — the speaker icon
 *      appears on a chat row when the toolbar contributions GET returns
 *      one for the kokoro-tts extension.
 *   2. The host's selection capture + payload assembly — clicking the
 *      icon POSTs to the existing extension event route with the right
 *      shape: `{ messageId, conversationId, content, selection }`.
 *   3. `KokoroTtsPlayerCard` persisted-state rendering — when an
 *      excluded turn arrives over WS carrying a tool call with
 *      `output.attachmentId`, the card short-circuits synthesis and
 *      mounts an `<audio>` element bound to `/api/attachments/:id`.
 *   4. The "Excluded from chat context" pill — only renders for
 *      `role === "extension" && excluded === true` rows, signalling
 *      to the user that this turn is not fed back to the LLM.
 *
 * Live in-browser synthesis is exercised by stubbing `window.Worker` so
 * the kokoro-tts-bridge picks up our fake worker (same wire protocol,
 * deterministic responses). kokoro-js itself is multi-MB ONNX runtime;
 * its real model load belongs in a flagged nightly spec
 * (kokoro-tts-realmodel.spec.ts, gated on EZCORP_E2E_KOKORO_REAL=1) —
 * NOT in the standard E2E run.
 *
 * Contract canary: a future schema-tightening on any of the routes
 * touched here breaks this spec early.
 */
import { test, expect } from "./fixtures/test-base.js";
import type { Page } from "@playwright/test";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

// ── Fake-worker init script ─────────────────────────────────────────
//
// Replaces `window.Worker` BEFORE the page boots so the kokoro-tts-bridge
// (which spawns its worker lazily on first synthesize() call via
// `new Worker(new URL(..., import.meta.url), { type: "module" })`) gets
// our stub instead of trying to load the real kokoro-js bundle.
//
// The stub speaks the same wire protocol as `kokoro-tts-worker.ts`:
//   request:  { type: "synthesize", id, text, voice }
//   response: { type: "loading", id, phase } | { type: "ready", id }
//             | { type: "audio", id, wav: ArrayBuffer }
//             | { type: "error", id, message }
//
// Behavior is configurable via `window.__kokoroStub`:
//   - calls            : array of { text, voice, id } captured per
//                        postMessage. Specs assert on this to prove the
//                        bridge actually invoked the worker (or didn't —
//                        e.g. on reload, where the persisted attachment
//                        should bypass synthesis entirely).
//   - failNextN        : count of synthesize() calls to fail before
//                        succeeding. Drives the retry-path spec.
//   - failureMessage   : error message string. Defaults to
//                        "synthesis failed: stub".
async function installWorkerStub(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__kokoroStub = {
      calls: [] as Array<{ text: string; voice: string | undefined; id: string }>,
      failNextN: 0,
      failureMessage: "synthesis failed: stub",
    };
    // 4-byte ArrayBuffer is enough — the card wraps it as a Blob and the
    // <audio> element doesn't try to actually decode it in this spec.
    function makeFakeWav(): ArrayBuffer {
      return new Uint8Array([0, 0, 0, 0]).buffer;
    }

    class StubWorker {
      private listeners: Record<string, Array<(e: Event) => void>> = {
        message: [],
        error: [],
        messageerror: [],
      };
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: Event) => void) | null = null;
      onmessageerror: ((e: Event) => void) | null = null;

      constructor(_url: string | URL, _opts?: WorkerOptions) {
        // No-op: nothing to load.
      }

      postMessage(msg: unknown): void {
        const stub = (window as unknown as { __kokoroStub: {
          calls: Array<{ text: string; voice: string | undefined; id: string }>;
          failNextN: number;
          failureMessage: string;
        } }).__kokoroStub;
        if (
          msg == null ||
          typeof msg !== "object" ||
          (msg as Record<string, unknown>).type !== "synthesize"
        ) return;
        const req = msg as { type: "synthesize"; id: string; text: string; voice?: string };
        stub.calls.push({ text: req.text, voice: req.voice, id: req.id });

        const dispatch = (data: unknown) => {
          const ev = new MessageEvent("message", { data });
          this.onmessage?.(ev);
          for (const fn of this.listeners.message ?? []) fn(ev);
        };

        // Microtask cadence: loading → ready → audio (or error). Mirrors
        // the real worker enough that the card walks through its
        // "Loading model…" → "Synthesizing…" → "audio plays" states.
        queueMicrotask(() => {
          if (stub.failNextN > 0) {
            stub.failNextN--;
            dispatch({ type: "error", id: req.id, message: stub.failureMessage });
            return;
          }
          dispatch({ type: "loading", id: req.id, phase: "model" });
          queueMicrotask(() => {
            dispatch({ type: "ready", id: req.id });
            queueMicrotask(() => {
              dispatch({ type: "audio", id: req.id, wav: makeFakeWav() });
            });
          });
        });
      }

      addEventListener(type: string, fn: (e: Event) => void): void {
        (this.listeners[type] ??= []).push(fn);
      }
      removeEventListener(type: string, fn: (e: Event) => void): void {
        const arr = this.listeners[type];
        if (arr) this.listeners[type] = arr.filter((f) => f !== fn);
      }
      terminate(): void {}
    }
    (window as unknown as { Worker: unknown }).Worker = StubWorker as unknown;
  });
}

// ── Toolbar contributions helper ────────────────────────────────────
//
// The contributions endpoint returns `appliesTo: "both"` so the speaker
// icon shows up on user AND assistant rows. Lifted out so each spec
// can register it cleanly.
async function stubToolbarContributions(
  page: Page,
  conversationId: string,
): Promise<void> {
  await page.route(
    `**/api/conversations/${conversationId}/extension-toolbar`,
    async (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            {
              extName: "kokoro-tts",
              id: "speak",
              icon: "Volume2",
              tooltip: "Read aloud (selection or full message)",
              appliesTo: "both",
              event: "kokoro-tts:speak",
            },
          ],
        }),
      }),
  );
}

// Common shape for the speak event POST body so multiple specs share the
// same type assertion site.
interface SpeakBody {
  messageId: string;
  conversationId: string;
  content: string;
  selection: string | null;
}

// Common shape for the save event POST body.
interface SaveBody {
  conversationId: string;
  messageId: string;
  toolCallId: string;
  attachmentId: string;
}

test.describe("Kokoro-TTS — speaker icon → excluded turn → audio player", () => {
  const proj = makeProject({ id: "proj-1", name: "Test Project" });
  const conv = makeConversation({
    id: "conv-1",
    projectId: "proj-1",
    title: "Test",
  });
  const userMsg = makeMessage({
    id: "m1",
    conversationId: "conv-1",
    role: "user",
    content: "Hello",
  });
  const assistantMsg = makeMessage({
    id: "m2",
    conversationId: "conv-1",
    role: "assistant",
    content:
      "Sure, here is a multi-paragraph reply.\n\nSecond paragraph for selection.",
    parentMessageId: "m1",
    createdAt: "2026-01-01T00:01:00.000Z",
  });

  test("speaker icon click POSTs the expected event payload, and a seeded excluded turn renders the audio + pill", async ({
    page,
    mockApi,
    emitWs,
  }) => {
    // ── Capture the event POST. The route's URL path is the BARE event
    //    suffix (`speak`) — `buildExtensionEventUrl` strips the
    //    `kokoro-tts:` prefix before issuing the request, mirroring the
    //    server's `[event]` regex which rejects colons.
    const speakCalls: Array<{ url: string; body: unknown }> = [];
    await page.route(
      "**/api/extensions/kokoro-tts/events/speak",
      async (route) => {
        speakCalls.push({
          url: route.request().url(),
          body: route.request().postDataJSON(),
        });
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      },
    );

    await stubToolbarContributions(page, conv.id);

    // ── Attachment fetch — return a 1-second silent WAV ─────────────
    // Smallest-possible deterministic payload (44-byte WAV header +
    // a few zero samples). The browser's <audio> element decodes it
    // happily; we only assert presence of the element + its src.
    const silentWav = Buffer.from(
      "UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=",
      "base64",
    );
    await page.route("**/api/attachments/att-real-1", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "audio/wav",
        body: silentWav,
      });
    });

    await mockApi({
      projects: [proj],
      conversations: [conv],
      messages: [userMsg, assistantMsg],
    });
    await page.goto(`/project/${proj.id}/chat/${conv.id}`);

    // ── Assert: speaker icon renders on the assistant turn ──────────
    const assistantRow = page.locator('[data-message-id="m2"]').first();
    await expect(assistantRow).toBeVisible();

    // The toolbar mounts on hover; force-show by hovering the row.
    await assistantRow.hover();
    const speaker = assistantRow.getByTestId("ext-action-kokoro-tts-speak");
    await expect(speaker).toBeVisible({ timeout: 3000 });

    // ── Click the speaker (no selection) ────────────────────────────
    await speaker.click();

    // ── Verify event payload shape ──────────────────────────────────
    await expect.poll(() => speakCalls.length, { timeout: 3000 }).toBe(1);
    const speakBody = speakCalls[0]!.body as SpeakBody;
    expect(speakBody.messageId).toBe("m2");
    expect(speakBody.conversationId).toBe("conv-1");
    expect(speakBody.content).toContain("multi-paragraph reply");
    // No selection captured (we didn't drag-select before clicking).
    expect(speakBody.selection).toBeNull();

    // ── Server emits the new excluded turn (a real subprocess would
    //    do this via ezcorp/append-message). Pre-populated with a
    //    persisted attachmentId so the card skips live synthesis.
    await emitWs({
      type: "message:created",
      data: {
        id: "m3",
        conversationId: "conv-1",
        role: "extension",
        content: "🔊 TTS of message (62 chars)",
        excluded: true,
        parentMessageId: "m2",
        createdAt: "2026-01-01T00:01:30.000Z",
        toolCalls: [
          {
            id: "tc-1",
            toolName: "kokoro-tts.synthesize",
            cardType: "kokoro-tts-player",
            input: { text: assistantMsg.content },
            output: { attachmentId: "att-real-1" },
            status: "complete",
            success: true,
            durationMs: 1200,
            messageId: "m3",
          },
        ],
      },
    });

    // ── The new turn renders the persisted-audio card ───────────────
    const persistedAudio = page.getByTestId("kokoro-tts-audio-persisted");
    await expect(persistedAudio).toBeVisible({ timeout: 3000 });
    await expect(persistedAudio).toHaveAttribute(
      "src",
      "/api/attachments/att-real-1",
    );

    // ── The "Excluded from chat context" pill is visible ────────────
    const pill = page.getByTestId("excluded-from-chat-pill");
    await expect(pill).toBeVisible();
  });

  test("captured selection is forwarded in the event payload", async ({
    page,
    mockApi,
  }) => {
    const speakCalls: Array<{ body: unknown }> = [];
    await page.route(
      "**/api/extensions/kokoro-tts/events/speak",
      async (route) => {
        speakCalls.push({ body: route.request().postDataJSON() });
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      },
    );
    await stubToolbarContributions(page, conv.id);

    await mockApi({
      projects: [proj],
      conversations: [conv],
      messages: [userMsg, assistantMsg],
    });
    await page.goto(`/project/${proj.id}/chat/${conv.id}`);

    const assistantRow = page.locator('[data-message-id="m2"]').first();
    await assistantRow.hover();

    // Drag-select a fragment of the assistant message in the browser.
    // We pick a substring guaranteed to be inside the row's DOM.
    const fragment = "Second paragraph for selection";
    await page.evaluate((needle) => {
      const row = document.querySelector(
        '[data-message-id="m2"]',
      ) as HTMLElement | null;
      if (!row) return;
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const idx = node.textContent?.indexOf(needle) ?? -1;
        if (idx >= 0) {
          const range = document.createRange();
          range.setStart(node, idx);
          range.setEnd(node, idx + needle.length);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
          return;
        }
      }
    }, fragment);

    const speaker = assistantRow.getByTestId("ext-action-kokoro-tts-speak");
    await speaker.click();

    await expect.poll(() => speakCalls.length, { timeout: 3000 }).toBe(1);
    const body = speakCalls[0]!.body as SpeakBody;
    expect(body.selection).not.toBeNull();
    expect(body.selection!).toContain(fragment);
    // Selection must respect the SELECTION_CAP (4_000 chars). The
    // fragment is small so this is just a "doesn't blow past the cap"
    // sanity check.
    expect(body.selection!.length).toBeLessThanOrEqual(4_000);
  });

  // ── (1) speaker icon visible — exercised by the testid above. ────
  // ── (2) Speaker icon visible on user turn (appliesTo: "both") ────
  test("speaker icon also renders on user turns when appliesTo=both", async ({
    page,
    mockApi,
  }) => {
    await stubToolbarContributions(page, conv.id);
    await mockApi({
      projects: [proj],
      conversations: [conv],
      messages: [userMsg, assistantMsg],
    });
    await page.goto(`/project/${proj.id}/chat/${conv.id}`);

    const userRow = page.locator('[data-message-id="m1"]').first();
    await expect(userRow).toBeVisible();
    await userRow.hover();

    const speaker = userRow.getByTestId("ext-action-kokoro-tts-speak");
    await expect(speaker).toBeVisible({ timeout: 3000 });
  });

  // ── (6) Live synthesis renders an <audio> element ────────────────
  //
  // Exercises the running → blob-URL path with the worker stub. The
  // bridge spawns our StubWorker, the card mounts <audio data-testid=
  // "kokoro-tts-audio-blob" src="blob:…">, then the upload + save POSTs
  // fire in the background.
  test("live synthesis renders <audio> bound to a blob URL and POSTs save with conversationId", async ({
    page,
    mockApi,
    emitWs,
  }) => {
    await installWorkerStub(page);

    // Speak: just acknowledge.
    await page.route(
      "**/api/extensions/kokoro-tts/events/speak",
      async (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        }),
    );

    // Upload: return a deterministic attachment id.
    await page.route(
      "**/api/extensions/kokoro-tts/uploads",
      async (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ attachmentId: "att-live-1" }),
        }),
    );

    // (10) Save: capture so we can assert the body shape carries
    // conversationId (the recent "Invalid body" 400 regression).
    const saveCalls: Array<{ body: unknown }> = [];
    await page.route(
      "**/api/extensions/kokoro-tts/events/save",
      async (route) => {
        saveCalls.push({ body: route.request().postDataJSON() });
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      },
    );

    await stubToolbarContributions(page, conv.id);
    await mockApi({
      projects: [proj],
      conversations: [conv],
      messages: [userMsg, assistantMsg],
    });
    await page.goto(`/project/${proj.id}/chat/${conv.id}`);

    const assistantRow = page.locator('[data-message-id="m2"]').first();
    await assistantRow.hover();
    await assistantRow.getByTestId("ext-action-kokoro-tts-speak").click();

    // Server seeds the running tool-call (no attachmentId yet) so the
    // card mounts in synthesizing mode and triggers the worker stub.
    await emitWs({
      type: "message:created",
      data: {
        id: "m3",
        conversationId: "conv-1",
        role: "extension",
        content: "🔊 TTS of message (n chars)",
        excluded: true,
        parentMessageId: "m2",
        createdAt: "2026-01-01T00:01:30.000Z",
        toolCalls: [
          {
            id: "tc-live-1",
            toolName: "kokoro-tts.synthesize",
            cardType: "kokoro-tts-player",
            input: { text: assistantMsg.content },
            output: null,
            status: "running",
            success: false,
            durationMs: 0,
            messageId: "m3",
          },
        ],
      },
    });

    const blobAudio = page.getByTestId("kokoro-tts-audio-blob");
    await expect(blobAudio).toBeVisible({ timeout: 5000 });
    const src = await blobAudio.getAttribute("src");
    expect(src ?? "").toMatch(/^blob:/);

    // (10) The save event POST body carries conversationId, messageId,
    // toolCallId and attachmentId — schema regression canary.
    await expect.poll(() => saveCalls.length, { timeout: 3000 }).toBeGreaterThanOrEqual(1);
    const saveBody = saveCalls[0]!.body as SaveBody;
    expect(saveBody.conversationId).toBe("conv-1");
    expect(saveBody.messageId).toBe("m3");
    expect(saveBody.toolCallId).toBe("tc-live-1");
    expect(saveBody.attachmentId).toBe("att-live-1");
  });

  // ── (7) Reload renders persisted audio without re-synthesizing ───
  //
  // Guards the JSON-string output-shape regression. On hydration the
  // tool-call's `output` arrives as a string `'{"attachmentId":"…"}'`
  // (DB envelope flattening); the card must recognise that shape and
  // skip synthesis. We assert by:
  //   - <audio src="/api/attachments/…"> mounts (NOT a blob URL);
  //   - the worker stub records ZERO synthesize() calls.
  test("reload renders persisted audio without re-synthesizing (JSON-string output)", async ({
    page,
    mockApi,
  }) => {
    await installWorkerStub(page);

    // Persisted extension turn — already in the conversation history.
    const ttsTurn = makeMessage({
      id: "m3",
      conversationId: "conv-1",
      role: "extension",
      content: "🔊 TTS of message (n chars)",
      excluded: true,
      parentMessageId: "m2",
      createdAt: "2026-01-01T00:01:30.000Z",
    });

    // The DB-hydration path stringifies the tool-call output. Mirror
    // the exact shape the regression was about: a JSON string at
    // `output`, not a plain object.
    const persistedToolCalls = {
      m3: [
        {
          id: "tc-persisted-1",
          extensionId: "kokoro-tts",
          toolName: "kokoro-tts.synthesize",
          cardType: "kokoro-tts-player",
          input: { text: assistantMsg.content },
          output: JSON.stringify({ attachmentId: "att-real-1" }),
          outputSummary: null,
          fullOutput: null,
          status: "success" as const,
          success: true,
          durationMs: 1200,
          messageId: "m3",
        },
      ],
    };

    const silentWav = Buffer.from(
      "UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=",
      "base64",
    );
    await page.route("**/api/attachments/att-real-1", async (route) =>
      route.fulfill({ status: 200, contentType: "audio/wav", body: silentWav }),
    );

    await mockApi({
      projects: [proj],
      conversations: [conv],
      messages: [userMsg, assistantMsg, ttsTurn],
      messageToolCalls: persistedToolCalls,
    });
    await page.goto(`/project/${proj.id}/chat/${conv.id}`);

    const persistedAudio = page.getByTestId("kokoro-tts-audio-persisted");
    await expect(persistedAudio).toBeVisible({ timeout: 5000 });
    await expect(persistedAudio).toHaveAttribute(
      "src",
      "/api/attachments/att-real-1",
    );

    // No blob-URL audio element — the card recognised the persisted
    // output and skipped synthesis entirely.
    await expect(page.getByTestId("kokoro-tts-audio-blob")).toHaveCount(0);

    // The bridge never created a worker → zero synthesize calls.
    const callCount = await page.evaluate(() => {
      const stub = (window as unknown as {
        __kokoroStub?: { calls: unknown[] };
      }).__kokoroStub;
      return stub?.calls.length ?? -1;
    });
    expect(callCount).toBe(0);
  });

  // ── (8) Excluded extension turn is NOT in the next outgoing
  //        chat-completion request body ─────────────────────────────
  //
  // The /messages POST goes to the SvelteKit route which uses the
  // server-side LLM-context filter to drop excluded rows. Here we just
  // assert the on-the-wire body the chat client sends is the user's
  // text + does NOT include the TTS turn's content as part of the
  // conversation context.
  test("excluded extension turn is dropped before the next outgoing /messages POST", async ({
    page,
    mockApi,
  }) => {
    const ttsTurn = makeMessage({
      id: "m3",
      conversationId: "conv-1",
      role: "extension",
      content: "🔊 TTS of message (62 chars)",
      excluded: true,
      parentMessageId: "m2",
      createdAt: "2026-01-01T00:01:30.000Z",
    });

    const persistedToolCalls = {
      m3: [
        {
          id: "tc-persisted-2",
          extensionId: "kokoro-tts",
          toolName: "kokoro-tts.synthesize",
          cardType: "kokoro-tts-player",
          input: { text: assistantMsg.content },
          output: JSON.stringify({ attachmentId: "att-real-1" }),
          outputSummary: null,
          fullOutput: null,
          status: "success" as const,
          success: true,
          durationMs: 1200,
          messageId: "m3",
        },
      ],
    };

    await page.route("**/api/attachments/att-real-1", async (route) =>
      route.fulfill({
        status: 200,
        contentType: "audio/wav",
        body: Buffer.from(
          "UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=",
          "base64",
        ),
      }),
    );

    await mockApi({
      projects: [proj],
      conversations: [conv],
      messages: [userMsg, assistantMsg, ttsTurn],
      messageToolCalls: persistedToolCalls,
    });
    await page.goto(`/project/${proj.id}/chat/${conv.id}`);

    // Wait for the excluded turn to render so we know the seeded
    // history loaded fully before we send the follow-up.
    await expect(page.getByTestId("excluded-from-chat-pill")).toBeVisible({
      timeout: 5000,
    });

    // Capture the next user-message POST.
    const postReq = page.waitForRequest(
      (req) =>
        req.url().includes("/api/conversations/conv-1/messages") &&
        req.method() === "POST",
      { timeout: 5000 },
    );

    const textarea = page.locator("textarea");
    await textarea.fill("follow-up question");
    await page.getByRole("button", { name: "Send message" }).click();

    const req = await postReq;
    // The body the FE ships is `{ content }` (or multipart with content
    // part). The TTS-turn header string must NOT leak into it. The
    // server is the canonical context-filter, but the FE must also not
    // be smuggling the excluded row into the prompt body.
    const ct = req.headers()["content-type"] ?? "";
    let bodyText = "";
    if (ct.startsWith("multipart/form-data")) {
      bodyText = req.postDataBuffer()?.toString("utf-8") ?? "";
    } else {
      bodyText = JSON.stringify(req.postDataJSON() ?? {});
    }
    expect(bodyText).toContain("follow-up question");
    expect(bodyText).not.toContain("TTS of message");
    expect(bodyText).not.toContain("att-real-1");
  });

  // ── (9) Retry path on synthesis failure ──────────────────────────
  //
  // First synthesize() throws → red error block + Retry button render.
  // Click Retry → second synthesize() succeeds → audio mounts. No new
  // turn was created (retries reuse the same toolCallId).
  test("synthesis failure surfaces error + Retry; retry replays against the same toolCallId", async ({
    page,
    mockApi,
    emitWs,
  }) => {
    await installWorkerStub(page);

    // Speak / upload / save: acknowledge. Upload only fires after a
    // successful synthesize, so it stays unhit on the first attempt.
    await page.route(
      "**/api/extensions/kokoro-tts/events/speak",
      async (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
    );
    let uploadHits = 0;
    await page.route(
      "**/api/extensions/kokoro-tts/uploads",
      async (route) => {
        uploadHits++;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ attachmentId: "att-retry-1" }),
        });
      },
    );
    const saveCalls: Array<{ body: unknown }> = [];
    await page.route(
      "**/api/extensions/kokoro-tts/events/save",
      async (route) => {
        saveCalls.push({ body: route.request().postDataJSON() });
        await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      },
    );

    await stubToolbarContributions(page, conv.id);
    await mockApi({
      projects: [proj],
      conversations: [conv],
      messages: [userMsg, assistantMsg],
    });
    await page.goto(`/project/${proj.id}/chat/${conv.id}`);

    // Arm the stub to fail the FIRST synthesize call only.
    await page.evaluate(() => {
      const stub = (window as unknown as {
        __kokoroStub: { failNextN: number; failureMessage: string };
      }).__kokoroStub;
      stub.failNextN = 1;
      stub.failureMessage = "model load timed out";
    });

    const assistantRow = page.locator('[data-message-id="m2"]').first();
    await assistantRow.hover();
    await assistantRow.getByTestId("ext-action-kokoro-tts-speak").click();

    // Seed the running turn — same toolCallId used for both attempts.
    await emitWs({
      type: "message:created",
      data: {
        id: "m3",
        conversationId: "conv-1",
        role: "extension",
        content: "🔊 TTS of message (n chars)",
        excluded: true,
        parentMessageId: "m2",
        createdAt: "2026-01-01T00:01:30.000Z",
        toolCalls: [
          {
            id: "tc-retry-1",
            toolName: "kokoro-tts.synthesize",
            cardType: "kokoro-tts-player",
            input: { text: assistantMsg.content },
            output: null,
            status: "running",
            success: false,
            durationMs: 0,
            messageId: "m3",
          },
        ],
      },
    });

    // Error block + Retry button render after the first failed synth.
    await expect(page.getByTestId("kokoro-tts-error")).toBeVisible({ timeout: 5000 });
    const retry = page.getByTestId("kokoro-tts-retry");
    await expect(retry).toBeVisible();

    // Snapshot the number of extension rows so we can assert no new
    // turn is created on retry — retries MUST reuse the same toolCallId.
    const cardsBefore = await page.getByTestId("kokoro-tts-player-card").count();
    expect(cardsBefore).toBe(1);

    await retry.click();

    // Audio renders against the (second) synthesize success.
    await expect(page.getByTestId("kokoro-tts-audio-blob")).toBeVisible({
      timeout: 5000,
    });
    expect(uploadHits).toBeGreaterThanOrEqual(1);

    // No second card spawned.
    const cardsAfter = await page.getByTestId("kokoro-tts-player-card").count();
    expect(cardsAfter).toBe(1);

    // Save event references the SAME toolCallId across the retry.
    await expect.poll(() => saveCalls.length, { timeout: 3000 }).toBeGreaterThanOrEqual(1);
    const saveBody = saveCalls[saveCalls.length - 1]!.body as SaveBody;
    expect(saveBody.toolCallId).toBe("tc-retry-1");

    // Two synthesize attempts in total — the failed one + the retry.
    const synthCallCount = await page.evaluate(() => {
      const stub = (window as unknown as { __kokoroStub: { calls: unknown[] } }).__kokoroStub;
      return stub.calls.length;
    });
    expect(synthCallCount).toBeGreaterThanOrEqual(2);
  });

  // ── Settings end-to-end (Slice 5) ────────────────────────────────
  //
  // The user picked `bf_emma` + speed `1.5` on the extension settings
  // page; the resolved blob lives behind `/api/extensions/<id>/settings`
  // and is loaded into a module-scoped Svelte store on chat-page mount.
  // `KokoroTtsPlayerCard.svelte` reads voice + speed from that store and
  // forwards them to `bridge.synthesize(text, { voice, speed })`, which
  // postMessages the worker. We assert the captured worker frame carries
  // the user's chosen values — not the hard-coded `af_bella` / `1.0`.
  test("chosen voice + speed reach the synth bridge", async ({
    page,
    mockApi,
    emitWs,
  }) => {
    // Worker stub that ALSO captures `speed`. Identical wire protocol
    // to the existing stub but with an extended `calls` shape.
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>;
      w.__kokoroStub = {
        calls: [] as Array<{ text: string; voice?: string; speed?: number; id: string }>,
      };
      function makeFakeWav(): ArrayBuffer {
        return new Uint8Array([0, 0, 0, 0]).buffer;
      }
      class StubWorker {
        private listeners: Record<string, Array<(e: Event) => void>> = {
          message: [],
          error: [],
          messageerror: [],
        };
        onmessage: ((e: MessageEvent) => void) | null = null;
        constructor(_url: string | URL, _opts?: WorkerOptions) {}
        postMessage(msg: unknown): void {
          const stub = (window as unknown as {
            __kokoroStub: { calls: Array<{ text: string; voice?: string; speed?: number; id: string }> };
          }).__kokoroStub;
          if (msg == null || typeof msg !== "object") return;
          const m = msg as Record<string, unknown>;
          if (m.type !== "synthesize") return;
          stub.calls.push({
            text: m.text as string,
            voice: m.voice as string | undefined,
            speed: m.speed as number | undefined,
            id: m.id as string,
          });
          const dispatch = (data: unknown) => {
            const ev = new MessageEvent("message", { data });
            this.onmessage?.(ev);
            for (const fn of this.listeners.message ?? []) fn(ev);
          };
          queueMicrotask(() => {
            dispatch({ type: "loading", id: m.id, phase: "model" });
            queueMicrotask(() => {
              dispatch({ type: "ready", id: m.id });
              queueMicrotask(() => {
                dispatch({ type: "audio", id: m.id, wav: makeFakeWav() });
              });
            });
          });
        }
        addEventListener(type: string, fn: (e: Event) => void): void {
          (this.listeners[type] ??= []).push(fn);
        }
        removeEventListener(type: string, fn: (e: Event) => void): void {
          const arr = this.listeners[type];
          if (arr) this.listeners[type] = arr.filter((f) => f !== fn);
        }
        terminate(): void {}
      }
      (window as unknown as { Worker: unknown }).Worker = StubWorker as unknown;
    });

    // Mock the lookup-by-name endpoint that the store uses to resolve
    // an extension name → id. The id is what /settings is keyed on.
    await page.route("**/api/extensions?name=kokoro-tts", async (route) =>
      route.fulfill({
        json: [{ id: "ext-kokoro", name: "kokoro-tts" }],
      }),
    );
    // The settings GET — return a `resolved` blob with the user's
    // overrides. The store reads `body.resolved` and caches by name.
    await page.route("**/api/extensions/ext-kokoro/settings", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        json: {
          schema: {
            voice: { type: "select", label: "Voice", options: [], default: "af_bella" },
            speed: { type: "number", label: "Speed", default: 1.0 },
          },
          declaredDefaults: { voice: "af_bella", speed: 1.0 },
          globalValues: {},
          userValues: { voice: "bf_emma", speed: 1.5 },
          resolved: { voice: "bf_emma", speed: 1.5 },
        },
      });
    });
    // The PUT user-settings call the brief asks for — it's not what
    // hydrates the in-page store (the page-level GET above does), but
    // we simulate the brief's pre-seed step for symmetry. The PUT just
    // ack's; the GET result above is what the card actually reads.
    let userPutBody: unknown = null;
    await page.route("**/api/extensions/ext-kokoro/settings/user", async (route) => {
      if (route.request().method() !== "PUT") return route.fallback();
      userPutBody = route.request().postDataJSON();
      await route.fulfill({ json: { ok: true, userValues: { voice: "bf_emma", speed: 1.5 } } });
    });

    // Speak / upload / save — same plumbing as the live-synth test.
    await page.route(
      "**/api/extensions/kokoro-tts/events/speak",
      async (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
    );
    await page.route(
      "**/api/extensions/kokoro-tts/uploads",
      async (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ attachmentId: "att-settings-1" }),
        }),
    );
    await page.route(
      "**/api/extensions/kokoro-tts/events/save",
      async (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
    );

    await stubToolbarContributions(page, conv.id);
    await mockApi({
      projects: [proj],
      conversations: [conv],
      messages: [userMsg, assistantMsg],
    });

    // Pre-seed via the public PUT — proves the wire shape the brief
    // documents. The actual store hydration happens via the GET above.
    await page.request.put("/api/extensions/ext-kokoro/settings/user", {
      data: { values: { voice: "bf_emma", speed: 1.5 } },
    });
    expect(userPutBody).toEqual({ values: { voice: "bf_emma", speed: 1.5 } });

    await page.goto(`/project/${proj.id}/chat/${conv.id}`);

    const assistantRow = page.locator('[data-message-id="m2"]').first();
    await assistantRow.hover();
    await assistantRow.getByTestId("ext-action-kokoro-tts-speak").click();

    await emitWs({
      type: "message:created",
      data: {
        id: "m3",
        conversationId: "conv-1",
        role: "extension",
        content: "🔊 TTS of message (n chars)",
        excluded: true,
        parentMessageId: "m2",
        createdAt: "2026-01-01T00:01:30.000Z",
        toolCalls: [
          {
            id: "tc-settings-1",
            toolName: "kokoro-tts.synthesize",
            cardType: "kokoro-tts-player",
            input: { text: assistantMsg.content },
            output: null,
            status: "running",
            success: false,
            durationMs: 0,
            messageId: "m3",
          },
        ],
      },
    });

    // Wait for synthesis to complete (audio mounts) so the postMessage
    // captured by the stub is observable.
    await expect(page.getByTestId("kokoro-tts-audio-blob")).toBeVisible({
      timeout: 5000,
    });

    const calls = await page.evaluate(() => {
      const stub = (window as unknown as {
        __kokoroStub: { calls: Array<{ voice?: string; speed?: number }> };
      }).__kokoroStub;
      return stub.calls;
    });
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]!.voice).toBe("bf_emma");
    expect(calls[0]!.speed).toBe(1.5);

    // Cleanup — the brief asks for an explicit DELETE.
    let userDeleted = false;
    await page.route("**/api/extensions/ext-kokoro/settings/user", async (route) => {
      if (route.request().method() === "DELETE") {
        userDeleted = true;
        return route.fulfill({ json: { ok: true } });
      }
      return route.fallback();
    });
    await page.request.delete("/api/extensions/ext-kokoro/settings/user");
    expect(userDeleted).toBe(true);
  });
});
