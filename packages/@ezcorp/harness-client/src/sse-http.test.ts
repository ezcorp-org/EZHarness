import { describe, expect, test } from "bun:test";
import { HarnessClient, SseDataBuffer } from "./index";
import { HarnessClient as BuiltHarnessClient } from "../dist/index.js";

const first = 'id: 1\ndata: {"type":"run:token","data":{"token":"one"}}\n\n';
const second = 'id: 2\ndata: {"type":"run:token","data":{"token":"two"}}\n\n';
type ClientFactory = (baseUrl: string) => Pick<HarnessClient, "streamEvents">;
const clients = [
  { name: "source", create: (baseUrl: string) => new HarnessClient({ baseUrl }) },
  { name: "compiled four-file SDK", create: (baseUrl: string) => new BuiltHarnessClient({ baseUrl }) },
];

async function observeHttp(create: ClientFactory, chunks: string[], lastEventId?: string) {
  const encoder = new TextEncoder();
  const requestHeaders: Headers[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      requestHeaders.push(new Headers(request.headers));
      return new Response(new ReadableStream<Uint8Array>({
        async start(controller) {
          for (let index = 0; index < chunks.length; index++) {
            if (index > 0) await Bun.sleep(2);
            controller.enqueue(encoder.encode(chunks[index]));
          }
          controller.close();
        },
      }), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  try {
    const client = create(server.url.href);
    let cursor = lastEventId ?? "";
    const ids: string[] = [];
    const received: Array<{ cursor: string; event: unknown }> = [];
    for await (const event of client.streamEvents({ lastEventId, onEventId: id => { ids.push(id); cursor = id; } })) received.push({ cursor, event });
    return { received, ids, resumeHeader: requestHeaders[0]?.get("Last-Event-ID") ?? null };
  } finally { await server.stop(true); }
}

describe.each(clients)("$name per-record HTTP SSE cursors", ({ create }) => {
  test.each([
    ["coalesced", [first + second]],
    ["fragmented", [first.slice(0, 5), first.slice(5) + second.slice(0, 9), second.slice(9)]],
  ])("associates each %s payload with its own cursor", async (_name, chunks) => {
    expect((await observeHttp(create, chunks)).received).toEqual([
      { cursor: "1", event: { type: "run:token", data: { token: "one" } } },
      { cursor: "2", event: { type: "run:token", data: { token: "two" } } },
    ]);
  });

  test("reports id-only/reset records, advances before malformed JSON, and ignores an incomplete final record", async () => {
    const stream = 'id: 7\n\ndata: {"type":"first"}\n\nid: 8\ndata: malformed\n\nid:\n\ndata: {"type":"reset"}\n\nid: 99\ndata: {"type":"unfinished"}';
    const result = await observeHttp(create, [stream]);
    expect(result.received).toEqual([
      { cursor: "7", event: { type: "first" } },
      { cursor: "", event: { type: "reset" } },
    ]);
    expect(result.ids).toEqual(["7", "7", "8", ""]);
  });

  test("an initial no-id record preserves the caller's resume cursor", async () => {
    const result = await observeHttp(create, [': heartbeat\n\ndata: {"type":"no-id"}\n\n'], "seed");
    expect(result.resumeHeader).toBe("seed");
    expect(result.ids).toEqual([]);
    expect(result.received).toEqual([{ cursor: "seed", event: { type: "no-id" } }]);
  });

  test("aborting a real open HTTP stream exits and cancels the owned reader", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
      fetch: () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(first)); } }),
        { headers: { "Content-Type": "text/event-stream" } }),
    });
    const controller = new AbortController();
    try {
      const received = [];
      for await (const event of create(server.url.href).streamEvents({ signal: controller.signal })) {
        received.push(event);
        controller.abort();
      }
      expect(received).toEqual([{ type: "run:token", data: { token: "one" } }]);
    } finally { await server.stop(true); }
  });
});

test("public push keeps its string-array contract and complete-record cursor state", () => {
  const buffer = new SseDataBuffer();
  expect(buffer.push('id: 7\n\ndata: one\n\nid:\n\ndata: two\n\nid: partial')).toEqual(["one", "two"]);
  expect(buffer.lastEventId).toBe("");
  expect(buffer.push("\n\n")).toEqual([]);
  expect(buffer.lastEventId).toBe("partial");
});
