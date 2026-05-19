import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "Test Project" });
const conv = makeConversation({
  id: "conv-1",
  projectId: "proj-1",
  title: "Attach Chat",
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
});

// 1×1 transparent PNG.
const PNG_1x1 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

test("paperclip stages an image, chip renders, send posts multipart", async ({ page, mockApi }) => {
  // Replace EventSource with a no-op fake that immediately fires onopen.
  // Without this, the real EventSource can't reach /api/runtime-events in e2e,
  // the connection state stays "reconnecting", and the textarea is disabled.
  await page.addInitScript(() => {
    class FakeEventSource {
      onopen: ((e: Event) => void) | null = null;
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: Event) => void) | null = null;
      readyState = 1;
      url: string;
      constructor(url: string) {
        this.url = url;
        queueMicrotask(() => this.onopen?.(new Event("open")));
      }
      close() {}
      addEventListener() {}
      removeEventListener() {}
    }
    (window as any).EventSource = FakeEventSource;
  });

  await mockApi({ projects: [proj], conversations: [conv] });
  await page.goto("/project/proj-1/chat/conv-1");
  // Wait for the composer to finish hydrating (the textarea becomes enabled).
  await page.waitForLoadState("networkidle");
  const textarea = page.locator("textarea").first();
  await expect(textarea).toBeEnabled({ timeout: 10_000 });

  // Paperclip appears once capabilities load.
  const paperclip = page.getByTestId("attachment-button");
  await expect(paperclip).toBeVisible({ timeout: 5_000 });

  // Stage the PNG via the hidden file input.
  const fileInput = page.getByTestId("attachment-file-input");
  await fileInput.setInputFiles({ name: "cat.png", mimeType: "image/png", buffer: PNG_1x1 });

  const chip = page.getByTestId("attachment-chip");
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("cat.png");

  await textarea.fill("look at this");

  // Capture the outgoing POST — then click send and verify it's multipart + carries the file.
  const sendRequest = page.waitForRequest(
    (req) => req.method() === "POST" && /\/api\/conversations\/[^/]+\/messages$/.test(req.url()),
    { timeout: 5_000 },
  );
  await page.getByRole("button", { name: "Send message" }).click();
  const req = await sendRequest;
  const ct = req.headers()["content-type"] ?? "";
  expect(ct.startsWith("multipart/form-data")).toBe(true);
  const raw = req.postDataBuffer()?.toString("binary") ?? "";
  expect(raw).toContain("cat.png");

  // Tray is cleared after send.
  await expect(page.getByTestId("attachment-chip")).toHaveCount(0);
});
