// Regression tests for sec-SB4: `JsonRpcTransport.processBuffer()` in
// `src/extensions/json-rpc.ts` is the first line of defense against a
// hostile extension subprocess. It reads newline-delimited JSON from the
// subprocess stdout, and every crafted message an extension might emit
// has to land in exactly one of three buckets:
//
//   1. Malformed / non-JSON → silently dropped (the subprocess is
//      sandboxed, so dropping is the right call; crashing the transport
//      would take down every other extension sharing the loop);
//   2. Request (has method + id) → forwarded to `onRequest`;
//   3. Notification (has method, no id) → forwarded to `onNotification`;
//   4. Response (has id, no method) → matched against a pending send()
//      via `responseCallbacks`, or silently dropped if unknown.
//
// The pre-fix code had NO tests exercising crafted inputs — the contract
// above was documented only in code comments. These tests lock the
// contract in so future refactors can't quietly drop frames or, worse,
// crash the read loop on a bad byte.
//
// Strategy: build a `JsonRpcTransport` whose `stdout` is a real
// `ReadableStream<Uint8Array>` we control. We push chunks into it via a
// closed-over enqueue fn, assert on the resulting onRequest /
// onNotification / pending-send callbacks, and verify the transport
// keeps running after each bad input.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { JsonRpcTransport } from "../../extensions/json-rpc";
import type {
  JsonRpcRequest,
  JsonRpcNotification,
} from "../../extensions/types";

// ── Harness ────────────────────────────────────────────────────────

interface Harness {
  transport: JsonRpcTransport;
  /** Push a raw string chunk into the transport's stdout stream. */
  push: (chunk: string) => void;
  /** Push raw bytes (for unicode / null-byte / binary-garbage cases). */
  pushBytes: (bytes: Uint8Array) => void;
  /** Close the stream and wait for the read loop to drain. */
  close: () => Promise<void>;
  /** Writes captured from `transport.send()` — one string per outbound message. */
  writes: string[];
  /** Incoming requests observed via onRequest. */
  requests: JsonRpcRequest[];
  /** Incoming notifications observed via onNotification. */
  notifications: JsonRpcNotification[];
}

function makeHarness(): Harness {
  const writes: string[] = [];
  const requests: JsonRpcRequest[] = [];
  const notifications: JsonRpcNotification[] = [];
  let enqueue!: (chunk: Uint8Array) => void;
  let closeStream!: () => void;

  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      enqueue = (chunk: Uint8Array) => controller.enqueue(chunk);
      closeStream = () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
    },
  });

  const stdin = {
    write(data: string | Uint8Array): number {
      writes.push(typeof data === "string" ? data : new TextDecoder().decode(data));
      return typeof data === "string" ? data.length : data.byteLength;
    },
  };

  const transport = new JsonRpcTransport(stdin, stdout);
  transport.onRequest = (req) => requests.push(req);
  transport.onNotification = (n) => notifications.push(n);
  transport.startReading();

  const encoder = new TextEncoder();

  return {
    transport,
    push: (chunk: string) => enqueue(encoder.encode(chunk)),
    pushBytes: (bytes: Uint8Array) => enqueue(bytes),
    close: async () => {
      closeStream();
      // Give the read loop a couple of ticks to settle.
      await Promise.resolve();
      await Promise.resolve();
    },
    writes,
    requests,
    notifications,
  };
}

/** Wait one macrotask so the transport's read loop picks up queued chunks. */
async function tick(times = 2): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

// ── Tests ──────────────────────────────────────────────────────────

describe("sec-SB4: JsonRpcTransport silently drops malformed input", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  test("plain non-JSON garbage is dropped without crashing the read loop", async () => {
    h.push("this is not json at all\n");
    await tick();
    expect(h.requests.length).toBe(0);
    expect(h.notifications.length).toBe(0);

    // Transport still processes valid frames after the garbage.
    h.push(JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }) + "\n");
    await tick();
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.method).toBe("ping");
  });

  test("truncated JSON (partial line) is buffered, not parsed prematurely", async () => {
    // The transport splits on "\n" and keeps the last (possibly partial)
    // segment in its buffer. A partial line must not be parsed.
    h.push('{"jsonrpc":"2.0","meth');
    await tick();
    expect(h.requests.length).toBe(0);
    expect(h.notifications.length).toBe(0);

    // Finish the line — now it parses.
    h.push('od":"finish","id":7}\n');
    await tick();
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.id).toBe(7);
    expect(h.requests[0]!.method).toBe("finish");
  });

  test("empty lines and whitespace-only lines are skipped", async () => {
    h.push("\n   \n\t\n\n");
    await tick();
    expect(h.requests.length).toBe(0);
    expect(h.notifications.length).toBe(0);
    // Still functional afterwards.
    h.push(JSON.stringify({ jsonrpc: "2.0", method: "after", id: 2 }) + "\n");
    await tick();
    expect(h.requests).toHaveLength(1);
  });

  test("mixed good + bad lines: bad lines dropped, good lines delivered", async () => {
    const chunk = [
      "{not json}",
      JSON.stringify({ jsonrpc: "2.0", method: "one", id: 1 }),
      "another garbage line }}}",
      JSON.stringify({ jsonrpc: "2.0", method: "two", id: 2 }),
      "trailing garbage",
      JSON.stringify({ jsonrpc: "2.0", method: "three", id: 3 }),
    ].join("\n") + "\n";
    h.push(chunk);
    await tick();
    expect(h.requests.map((r) => r.method)).toEqual(["one", "two", "three"]);
  });
});

describe("sec-SB4: JsonRpcTransport handles pathological valid JSON", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  test("very large payload (~1 MB) parses and delivers without crashing", async () => {
    const big = "x".repeat(1_000_000);
    const msg = { jsonrpc: "2.0", method: "large", id: 1, params: { blob: big } };
    h.push(JSON.stringify(msg) + "\n");
    await tick();
    expect(h.requests).toHaveLength(1);
    expect((h.requests[0]!.params!.blob as string).length).toBe(1_000_000);
  });

  test("deeply nested object (500 levels) parses without stack overflow", async () => {
    // JSON.parse has plenty of headroom at 500 levels, but this is the
    // property the transport has to forward unchanged.
    let nested: any = "leaf";
    for (let i = 0; i < 500; i++) nested = { inner: nested };
    const msg = { jsonrpc: "2.0", method: "deep", id: 1, params: { nested } };
    h.push(JSON.stringify(msg) + "\n");
    await tick();
    expect(h.requests).toHaveLength(1);
    // Walk down 500 levels to confirm.
    let cursor: any = h.requests[0]!.params!.nested;
    for (let i = 0; i < 500; i++) cursor = cursor.inner;
    expect(cursor).toBe("leaf");
  });

  test("message with method AND numeric id is classified as a request", async () => {
    h.push(JSON.stringify({ jsonrpc: "2.0", method: "m", id: 42 }) + "\n");
    await tick();
    expect(h.requests).toHaveLength(1);
    expect(h.notifications.length).toBe(0);
  });

  test("message with method and NO id is classified as a notification", async () => {
    h.push(JSON.stringify({ jsonrpc: "2.0", method: "notice" }) + "\n");
    await tick();
    expect(h.requests.length).toBe(0);
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0]!.method).toBe("notice");
  });

  test("message with id but NO method is treated as a response (and dropped if no pending send)", async () => {
    // An unsolicited response — the transport has no callback for id 999,
    // so it must silently drop rather than route to onRequest.
    h.push(JSON.stringify({ jsonrpc: "2.0", id: 999, result: "orphan" }) + "\n");
    await tick();
    expect(h.requests.length).toBe(0);
    expect(h.notifications.length).toBe(0);
  });

  test("unknown method is forwarded to onRequest — the transport does not gate methods", async () => {
    // The transport is method-agnostic. Gating happens in the handler
    // layer; our contract here is that the frame is delivered intact.
    h.push(JSON.stringify({ jsonrpc: "2.0", method: "system/rm-rf", id: 1 }) + "\n");
    await tick();
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.method).toBe("system/rm-rf");
  });

  test("null-byte inside a string is preserved across parse + delivery", async () => {
    const msg = { jsonrpc: "2.0", method: "nul", id: 1, params: { s: "a\u0000b" } };
    h.push(JSON.stringify(msg) + "\n");
    await tick();
    expect(h.requests).toHaveLength(1);
    expect((h.requests[0]!.params!.s as string)).toBe("a\u0000b");
  });

  test("lone null byte on its own line is dropped (not valid JSON)", async () => {
    h.pushBytes(new Uint8Array([0x00, 0x0a])); // NUL + LF
    await tick();
    expect(h.requests.length).toBe(0);
    expect(h.notifications.length).toBe(0);
    // Transport still alive.
    h.push(JSON.stringify({ jsonrpc: "2.0", method: "alive", id: 1 }) + "\n");
    await tick();
    expect(h.requests).toHaveLength(1);
  });

  test("unicode / non-ASCII method and params survive a round trip", async () => {
    const msg = {
      jsonrpc: "2.0",
      method: "emoji-🚀",
      id: 1,
      params: { greeting: "日本語 — café — Ω", hearts: "♡♥❤" },
    };
    h.push(JSON.stringify(msg) + "\n");
    await tick();
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.method).toBe("emoji-🚀");
    expect((h.requests[0]!.params!.greeting as string)).toBe("日本語 — café — Ω");
  });

  test("reentrant onRequest: a handler that pushes more frames is serviced normally", async () => {
    // The read loop runs a processBuffer sweep per chunk. If an onRequest
    // handler turns around and writes a new request via send() (which
    // only touches stdin / responseCallbacks — not stdout), and then the
    // subprocess responds, the transport must still be in a state that
    // can match the response by id. We stub send()'s side effect by
    // pushing the "response" back through stdout after the handler runs.
    h.transport.onRequest = (req) => {
      h.requests.push(req);
      // Pretend the handler sends and immediately receives a reply.
      // Since send() is not wired to a real subprocess, we route the
      // reply by pushing it back ourselves.
      h.push(
        JSON.stringify({ jsonrpc: "2.0", id: `reply-${req.id}`, result: "ok" }) + "\n",
      );
    };

    h.push(JSON.stringify({ jsonrpc: "2.0", method: "reentrant", id: 1 }) + "\n");
    await tick(3);
    // The original request plus (optionally) nothing from the reply line
    // because no pending callback is registered for "reply-1" — but the
    // critical property is that the transport did not crash and still
    // delivers subsequent messages.
    expect(h.requests.length).toBeGreaterThanOrEqual(1);
    h.push(JSON.stringify({ jsonrpc: "2.0", method: "after-reentrant", id: 2 }) + "\n");
    await tick();
    expect(h.requests.map((r) => r.method)).toContain("after-reentrant");
  });
});
