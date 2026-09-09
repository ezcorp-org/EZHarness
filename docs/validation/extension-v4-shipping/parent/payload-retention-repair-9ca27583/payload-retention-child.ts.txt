import { AsyncLocalStorage } from "node:async_hooks";
import * as jsc from "bun:jsc";
import { admitRequestPayload, readBoundedBody } from "../payload";
import { readBoundedJson } from "../bounded-json";

type Mode = "native" | "stream";
type RequestEvent = { request: Request; platform: { server: unknown; request: Request } };

const mode = process.env.EZ_PAYLOAD_RETENTION_MODE as Mode;
if (mode !== "native" && mode !== "stream") throw new Error("Expected EZ_PAYLOAD_RETENTION_MODE to be native or stream");

const events = new AsyncLocalStorage<RequestEvent>();
const text = `payload-${"😀".repeat(1024)}`;
const body = JSON.stringify({ text });
const maxBytes = 128 * 1024 * 1024;

async function legacyNativeAdmission(request: Request): Promise<Request> {
  const bytes = await readBoundedBody(request, maxBytes);
  const headers = new Headers(request.headers);
  headers.set("content-length", String(bytes.byteLength));
  return new Request(request, { headers, body: new Uint8Array(bytes).buffer });
}

async function settle(): Promise<number> {
  jsc.fullGC();
  await Bun.sleep(100);
  jsc.fullGC();
  return jsc.heapStats().objectTypeCounts.Request ?? 0;
}

let server: ReturnType<typeof Bun.serve>;
server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(rawRequest) {
    const url = new URL(rawRequest.url);
    if (url.pathname !== "/api/extensions/control") return new Response("not found", { status: 404 });
    // Match the adapter: clone before the event is stored in AsyncLocalStorage.
    const event: RequestEvent = {
      request: new Request(url.origin + url.pathname + url.search, rawRequest),
      platform: { server, request: rawRequest },
    };
    return events.run(event, async () => {
      event.request = mode === "stream"
        ? await admitRequestPayload(event.request, url.pathname)
        : await legacyNativeAdmission(event.request);
      const parsed = await readBoundedJson(event.request, maxBytes);
      if (typeof parsed !== "object" || parsed === null || (parsed as { text?: unknown }).text !== text) {
        return new Response("invalid payload", { status: 400 });
      }
      return Response.json({ text: (parsed as { text: string }).text, preserved: events.getStore() === event });
    });
  },
});

async function send(count: number): Promise<void> {
  for (let index = 0; index < count; index++) {
    const response = await fetch(new URL("/api/extensions/control", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", connection: "close" },
      body,
    });
    if (!response.ok) throw new Error(`Request ${index} returned ${response.status}`);
    const result = await response.json() as { text?: unknown; preserved?: unknown };
    if (result.text !== text || result.preserved !== true) throw new Error(`Request ${index} returned an invalid body`);
  }
}

try {
  await send(10);
  const warm = await settle();
  await send(500);
  const first = await settle();
  await send(500);
  const second = await settle();
  console.log(JSON.stringify({ mode, warm, first, second }));
} finally {
  server.stop(true);
}
