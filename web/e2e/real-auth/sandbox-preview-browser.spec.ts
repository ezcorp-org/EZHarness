import { expect, test } from "../fixtures/hydration.js";

const APP = process.env.PI_E2E_REAL_BASE_URL ?? "http://localhost:4173";

test("a browser uses the sandbox preview HTTP and WebSocket routes, then loses access on revoke", async ({ page, request }) => {
  const seeded = await request.post("/api/__test/seed-sandbox-preview");
  expect(seeded.ok(), await seeded.text()).toBeTruthy();
  const { previewId, code } = await seeded.json() as { previewId: string; code: string };
  const app = new URL(APP);
  const origin = `${app.protocol}//${previewId}.preview.localhost:${app.port}`;
  try {
    const opened = await page.goto(`${origin}/__open?c=${encodeURIComponent(code)}`);
    expect(opened?.status()).toBe(200);
    expect(page.url()).toBe(`${origin}/`);
    await expect(page.getByRole("heading", { name: "Sandbox preview browser proof" })).toBeVisible();
    await expect(page.locator("#ws-state")).toHaveText("guest:browser-proof");

    const pageResponse = await page.goto(`${origin}/page`);
    expect(pageResponse?.status()).toBe(200);
    await expect(page.locator("#ws-state")).toHaveText("guest:browser-proof");

    const cleanup = await request.delete("/api/__test/seed-sandbox-preview", { data: { previewId } });
    expect(cleanup.ok(), await cleanup.text()).toBeTruthy();
    await expect(page.locator("#ws-state")).toHaveText("closed");

    const denied = await page.goto(`${origin}/page`);
    expect(denied?.status()).toBe(404);
    const deniedSocket = await page.evaluate(async () => {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${location.host}/hmr`, "vite-hmr");
      return await new Promise<string>(resolve => {
        socket.addEventListener("open", () => resolve("open"), { once: true });
        socket.addEventListener("error", () => resolve("denied"), { once: true });
        socket.addEventListener("close", () => resolve("denied"), { once: true });
      });
    });
    expect(deniedSocket).toBe("denied");
  } finally {
    // The test route is owner-scoped. A second cleanup is harmless for a
    // completed test, and releases an active fixture after an earlier failure.
    await request.delete("/api/__test/seed-sandbox-preview", { data: { previewId } });
  }
});
