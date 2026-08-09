import type { Page } from "@playwright/test";
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { setupApiMocks } from "./fixtures/api-mocks.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

/**
 * Arrow-key prompt navigation AROUND THE UI COMPONENTS the thread renders —
 * tool cards, and the image lightbox a card opens.
 *
 * The plain-text walk is covered by `chat-prompt-arrow-nav.spec.ts`. This spec
 * pins the two ways cards used to break it:
 *
 *  1. A card that gets taller after it mounts (images arriving late) pushes
 *     the prompt we parked off the fold line. The nav used to decide its
 *     pointer was stale, re-derive the current prompt from the fold, and hand
 *     back a prompt the user had already been to — arrows stopped walking.
 *  2. The lightbox a card opens listens for arrows on `window`, and so does
 *     the thread. One press flipped the image AND scrolled the conversation
 *     the user was reading out from under the overlay.
 *
 * Backed by `web/src/lib/chat-prompt-nav.ts` (pointer liveness +
 * `isNavBlockedByOverlay`).
 */

// ── Fake EventSource / WebSocket so the streaming/active-run wiring doesn't
//    error in a static mock harness. Mirrors chat-prompt-arrow-nav.spec.ts. ──
async function installFakeTransports(page: Page) {
  await page.addInitScript(() => {
    class FakeEventSource {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 2;
      readyState = 1;
      url: string;
      onopen: ((e: Event) => void) | null = null;
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: Event) => void) | null = null;
      constructor(url: string) {
        this.url = url;
        queueMicrotask(() => {
          this.readyState = 1;
          this.onopen?.(new Event("open"));
        });
      }
      addEventListener() {}
      removeEventListener() {}
      close() {
        this.readyState = 2;
      }
    }
    (window as any).EventSource = FakeEventSource;
    class FakeWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = 1;
      send() {}
      close() {}
      addEventListener() {}
      removeEventListener() {}
    }
    (window as any).WebSocket = FakeWebSocket;
  });
}

function containerScrollTop(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.querySelector(
      '[data-testid="chat-messages-container"]',
    ) as HTMLElement | null;
    return el ? el.scrollTop : -1;
  });
}

/** The message whose top sits closest to the navigation fold line (~80px) —
 *  i.e. the prompt the navigation just parked there. */
function nearestToFold(
  page: Page,
  target = 80,
): Promise<{ id: string | null; offset: number; dist: number }> {
  return page.evaluate((t) => {
    const el = document.querySelector(
      '[data-testid="chat-messages-container"]',
    ) as HTMLElement | null;
    if (!el) return { id: null as string | null, offset: -1, dist: Infinity };
    const ctop = el.getBoundingClientRect().top;
    let best = { id: null as string | null, offset: -1, dist: Infinity };
    for (const n of Array.from(el.querySelectorAll("[data-message-id]")) as HTMLElement[]) {
      const offset = n.getBoundingClientRect().top - ctop;
      const dist = Math.abs(offset - t);
      if (dist < best.dist) {
        best = { id: n.getAttribute("data-message-id"), offset, dist };
      }
    }
    return best;
  }, target);
}

/** Drop focus from the composer so the window keydown handler (not the
 *  textarea) receives the arrow keys. */
async function blurComposer(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
}

// `m-N`: odd N → user prompt, even N → assistant (see the chain below).
function promptNumber(id: string | null): number {
  const m = id?.match(/^m-(\d+)$/);
  return m ? Number(m[1]) : NaN;
}
function isUserPrompt(id: string | null): boolean {
  const n = promptNumber(id);
  return Number.isFinite(n) && n % 2 === 1;
}

const proj = makeProject({ id: "proj-cards", name: "Card Nav Project" });
const conv = makeConversation({
  id: "conv-cards",
  projectId: proj.id,
  title: "Card Nav",
  updatedAt: "2026-01-01T00:02:00.000Z",
});

// A linear branch of 15 messages — odd ids are user prompts, even ids are
// assistant turns, and every assistant turn carries a tool card, so a UI
// component sits between every pair of prompts. 15 is exactly
// INITIAL_MESSAGE_WINDOW, so every row is rendered from the start and the
// load-older sentinel (which reflows the thread when it scrolls into view)
// never appears.
const COUNT = 15;
const history = Array.from({ length: COUNT }, (_, i) =>
  makeMessage({
    id: `m-${i + 1}`,
    conversationId: conv.id,
    role: i % 2 === 0 ? "user" : "assistant",
    content: `Message #${i + 1} — padding text so the bubble is tall enough that the thread has to scroll.`,
    parentMessageId: i === 0 ? null : `m-${i}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  }),
);

const toolOutput = Array.from({ length: 30 }, (_, i) => `line ${i} of tool output`).join("\n");

/** The assistant turn whose card is an image grid (three images served from a
 *  route we can hold open) — the "gets taller later" UI component. */
const IMAGE_CARD_MESSAGE_ID = "m-6";

/** One card per assistant turn; all but the image turn are terminal output. */
function buildToolCalls(): Record<string, any[]> {
  const calls: Record<string, any[]> = {};
  for (let i = 1; i < COUNT; i += 2) {
    const messageId = `m-${i + 1}`;
    const isImageTurn = messageId === IMAGE_CARD_MESSAGE_ID;
    calls[messageId] = [
      {
        id: `tc-${i + 1}`,
        extensionId: isImageTurn ? "openai-image-gen-2" : "builtin",
        toolName: isImageTurn ? "generate" : "Bash",
        input: isImageTurn ? { prompt: "a cat" } : { command: "ls -la" },
        outputSummary: isImageTurn ? IMAGE_MARKDOWN : toolOutput,
        fullOutput: isImageTurn ? IMAGE_MARKDOWN : toolOutput,
        success: true,
        durationMs: 42,
        status: "success" as const,
        messageId,
        cardType: isImageTurn ? "image-gen-grid" : null,
      },
    ];
  }
  return calls;
}

const IMAGE_URLS = [
  "https://cards.example.test/one.png",
  "https://cards.example.test/two.png",
  "https://cards.example.test/three.png",
];
const IMAGE_MARKDOWN = IMAGE_URLS.map((u, i) => `![img${i}](${u})`).join("\n");

// A 2×3-ratio PNG scaled by the grid — big enough that three of them landing
// at once visibly grows the assistant turn that holds them.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * Serve the card's images only once `release()` is called, so a spec can park
 * the nav BEFORE the images land and then let them reflow the thread.
 */
async function holdCardImages(page: Page): Promise<() => Promise<void>> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("https://cards.example.test/**", async (route) => {
    await gate;
    await route.fulfill({ contentType: "image/png", body: PNG_BYTES });
  });
  return async () => {
    release();
    await page.waitForTimeout(250);
  };
}

async function openThread(page: Page): Promise<void> {
  await installFakeTransports(page);
  await setupApiMocks(page, {
    projects: [proj],
    conversations: [conv],
    messages: history,
    messageToolCalls: buildToolCalls(),
    routes: { "active-run": () => ({ runId: null }) },
  });
  await page.goto(`/project/${proj.id}/chat/${conv.id}`);
  await expect(page.getByText(new RegExp(`Message #${COUNT} `))).toBeVisible({
    timeout: 10_000,
  });
  // Cards hydrate from the withToolCalls GET after the rows render.
  await expect(page.getByTestId("image-gen-grid")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(250);
}

test.describe("chat prompt arrow-key navigation around cards", () => {
  test("a card growing after the nav parked a prompt does not strand the walk", async ({
    page,
  }) => {
    const releaseImages = await holdCardImages(page);
    await openThread(page);
    await blurComposer(page);

    // Walk UP past the image card so it (and its pending images) sit ABOVE
    // the fold — when they land, everything below shifts down. Two steps
    // leaves prompts above us to walk on to after the reflow.
    const seen: Array<number> = [];
    for (let i = 0; i < 2; i++) {
      await page.keyboard.press("ArrowLeft");
      await page.waitForTimeout(120);
      const near = await nearestToFold(page);
      expect(isUserPrompt(near.id), `ArrowLeft #${i + 1} parks a user prompt, got ${near.id}`).toBe(
        true,
      );
      seen.push(promptNumber(near.id));
    }
    // Strictly one prompt per press, walking up.
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i], `press ${i + 1} steps exactly one prompt up`).toBe(seen[i - 1]! - 2);
    }

    // The images land: the card grows and pushes the parked prompt off the
    // fold line. Chrome may or may not also shift `scrollTop` to hold the
    // view steady (scroll anchoring, depending on how the three images land
    // across frames) — the walk has to survive both.
    await releaseImages();
    const parked = await nearestToFold(page);
    const before = seen[seen.length - 1]!;

    // The next press must still step ONE prompt up from where we were —
    // the reflow must not make the nav forget where it is.
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(150);
    const after = await nearestToFold(page);
    expect(
      isUserPrompt(after.id),
      `after the reflow a user prompt is parked, got ${after.id} (parked was ${parked.id})`,
    ).toBe(true);
    expect(
      promptNumber(after.id),
      "the press after the reflow steps exactly one prompt up (no skip, no repeat)",
    ).toBe(before - 2);
  });

  test("every ArrowRight parks the next prompt or reaches the bottom — never freezes", async ({
    page,
  }) => {
    await openThread(page);
    await blurComposer(page);

    const distanceFromBottom = (): Promise<number> =>
      page.evaluate(() => {
        const el = document.querySelector('[data-testid="chat-messages-container"]') as HTMLElement;
        return el.scrollHeight - el.clientHeight - el.scrollTop;
      });

    // Walk up the thread (staying clear of the very top) so there is a way
    // back down.
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("ArrowLeft");
      await page.waitForTimeout(120);
    }
    const start = await nearestToFold(page);
    expect(isUserPrompt(start.id), `walked up to a user prompt, got ${start.id}`).toBe(true);
    let current = promptNumber(start.id);

    // Now walk back down. Every press either parks the NEXT prompt at the
    // fold or ends at the bottom of the thread. A press that does neither
    // is the freeze this spec exists for.
    let reachedBottom = false;
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(120);
      if ((await distanceFromBottom()) < 5) {
        reachedBottom = true;
        break;
      }
      const near = await nearestToFold(page);
      expect(
        isUserPrompt(near.id),
        `ArrowRight #${i + 1} parks a user prompt, got ${near.id}`,
      ).toBe(true);
      expect(near.dist, `ArrowRight #${i + 1} parks it AT the fold`).toBeLessThan(16);
      expect(
        promptNumber(near.id),
        `ArrowRight #${i + 1} steps exactly one prompt down (was #${current})`,
      ).toBe(current + 2);
      current = promptNumber(near.id);
    }
    expect(reachedBottom, "walking right always reaches the bottom of the thread").toBe(true);
  });

  test("the lightbox a card opens owns the arrows — the thread stays put @evidence", async ({
    page,
  }, testInfo) => {
    const releaseImages = await holdCardImages(page);
    await openThread(page);
    await releaseImages();
    await blurComposer(page);

    // Park somewhere mid-thread so any stray scroll is visible.
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(150);

    await page.getByTestId("image-gen-thumb-0").click();
    const lightbox = page.getByTestId("image-gen-lightbox");
    await expect(lightbox).toBeVisible();
    await expect(lightbox).toHaveAttribute("data-active-index", "0");

    await captureEvidence(page, testInfo, "chat-card-lightbox-owns-arrows");

    const before = await containerScrollTop(page);
    // Three presses the same way: the lightbox walks its images and the
    // conversation behind it must not move a pixel.
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(80);
    await expect(lightbox).toHaveAttribute("data-active-index", "1");
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(80);
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(120);
    expect(
      await containerScrollTop(page),
      "the thread must not scroll behind an open lightbox",
    ).toBe(before);

    // Closing it hands the arrows back to the thread.
    await page.getByTestId("image-gen-lightbox-close").click();
    await expect(lightbox).toBeHidden();
    await blurComposer(page);
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(150);
    expect(
      await containerScrollTop(page),
      "with the lightbox closed the arrows navigate again",
    ).not.toBe(before);
  });
});
