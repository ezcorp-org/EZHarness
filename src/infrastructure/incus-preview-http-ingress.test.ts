import { expect, test } from "bun:test";
import { servePreviewRequest } from "../../web/src/lib/server/preview/dispatch";

const previewId = "abcdefghjkmnpqrstvwxyz0123";

test("production preview dispatch extends only its HTTP response on the live Bun raw request", async () => {
  const oldHost = process.env.EZCORP_PREVIEW_APP_HOST;
  process.env.EZCORP_PREVIEW_APP_HOST = "localhost";
  const budgets: Array<{ path: string; seconds: number }> = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 10, async fetch(raw, bunServer) {
    if (new URL(raw.url).pathname === "/ordinary") return new Response("ordinary");
    // The pinned adapter clones the raw request for SvelteKit and passes both
    // the raw request and live Bun server through event.platform.
    const request = new Request(raw.url, raw);
    const response = await servePreviewRequest(request, { previewId }, {
      request: raw, server: {
        upgrade: () => false,
        timeout: (same, seconds) => {
          expect(same).toBe(raw);
          budgets.push({ path: new URL(raw.url).pathname, seconds });
          bunServer.timeout(same, seconds);
        },
      },
    });
    if (new URL(raw.url).pathname === "/proof") await Bun.sleep(10_500);
    return response;
  } });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    expect((await fetch(base + "/ordinary")).status).toBe(200);
    expect((await fetch(base + "/__open?c=invalid")).status).toBe(404);
    expect(budgets).toEqual([]);
    const response = await fetch(base + "/proof");
    expect(response.status).toBe(404);
    expect(budgets).toEqual([{ path: "/proof", seconds: 60 }]);
  } finally {
    server.stop(true);
    if (oldHost === undefined) delete process.env.EZCORP_PREVIEW_APP_HOST;
    else process.env.EZCORP_PREVIEW_APP_HOST = oldHost;
  }
}, 15_000);
