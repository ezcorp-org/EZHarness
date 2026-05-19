/**
 * Phase 3 — JSON-RPC transport extension regression + chunked-frame tests.
 *
 * Day-1 contract (the orchestrator's "single point of failure"): the
 * existing line-delimited transport at `src/extensions/json-rpc.ts:32-83`
 * must keep round-tripping `{"jsonrpc":"2.0",...}\n` frames identically
 * to before. Every reverse-RPC (`ezcorp/storage`, `ezcorp/invoke`,
 * `ezcorp/network.internal`, etc.) flows through this transport, so a
 * back-compat regression here breaks all of Phase 1 + 2.
 *
 * This file is split into two `describe` blocks:
 *   1. "back-compat" — runs against the unmodified transport BEFORE the
 *      chunked-frame extension lands. Locks current behavior.
 *   2. "chunked-frame" — exercises the new sentinel-byte protocol. Added
 *      after the transport is extended.
 *
 * Both blocks share the same `makeMockStdio()` factory so the
 * post-extension transport is verified to handle BOTH formats — the
 * whole point of back-compat is that small responses keep using the
 * existing wire shape.
 */

import { test, expect, describe } from "bun:test";
import { JsonRpcTransport } from "../extensions/json-rpc";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
} from "../extensions/types";

// ── Test rig: in-memory stdio pipe ─────────────────────────────────

interface MockStdio {
  /** Stdin stub the transport writes outbound frames to. */
  stdin: {
    write(data: string | Uint8Array): number;
    flush?(): void;
    /** Captured outbound bytes as a UTF-8 string. */
    captured: string;
  };
  /** Readable stream the transport reads inbound frames from. */
  stdout: ReadableStream<Uint8Array>;
  /** Push a chunk into the inbound stream. Each call emits one chunk. */
  pushInbound(chunk: string | Uint8Array): void;
  /** Close the inbound stream (causes readLoop to exit cleanly). */
  closeInbound(): void;
}

function makeMockStdio(): MockStdio {
  let captured = "";
  const stdin = {
    write(data: string | Uint8Array): number {
      const s =
        typeof data === "string"
          ? data
          : new TextDecoder().decode(data);
      captured += s;
      return s.length;
    },
    flush(): void {},
    get captured(): string {
      return captured;
    },
  } as MockStdio["stdin"];

  // Build an inbound stream whose controller we can drive externally.
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });

  const encoder = new TextEncoder();
  return {
    stdin,
    stdout,
    pushInbound(chunk) {
      const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
      controller?.enqueue(bytes);
    },
    closeInbound() {
      try { controller?.close(); } catch { /* already closed */ }
    },
  };
}

// ── Day-1 back-compat: existing line-delimited frames unchanged ────

describe("json-rpc transport — back-compat (Day-1 sanity)", () => {
  test("send writes a single line-delimited JSON frame to stdin", async () => {
    const io = makeMockStdio();
    const transport = new JsonRpcTransport(io.stdin, io.stdout);
    transport.startReading();

    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "ezcorp/storage",
      params: { action: "get", key: "k" },
    };
    // Attach a no-op rejection handler so the readLoop's "Transport
    // closed" reject (fired by closeInbound below) doesn't surface as
    // an unhandled rejection in the test runner.
    transport.send(req).catch(() => {});

    // The captured bytes are exactly `JSON.stringify(req) + "\n"`.
    expect(io.stdin.captured).toBe(JSON.stringify(req) + "\n");

    io.closeInbound();
  });

  test("inbound response (line-delimited) resolves the matching pending request", async () => {
    const io = makeMockStdio();
    const transport = new JsonRpcTransport(io.stdin, io.stdout);
    transport.startReading();

    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 7,
      method: "noop",
    };
    const pending = transport.send(req);

    const resp: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true, value: 42 },
    };
    io.pushInbound(JSON.stringify(resp) + "\n");

    const got = await pending;
    expect(got).toEqual(resp);

    io.closeInbound();
  });

  test("inbound request (with id+method) reaches onRequest", async () => {
    const io = makeMockStdio();
    const transport = new JsonRpcTransport(io.stdin, io.stdout);
    let received: JsonRpcRequest | null = null;
    transport.onRequest = (r) => {
      received = r;
    };
    transport.startReading();

    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 99,
      method: "ezcorp/fs",
      params: { operation: "read", path: "/tmp/x" },
    };
    io.pushInbound(JSON.stringify(req) + "\n");

    // Allow the readLoop microtask to drain.
    await Promise.resolve();
    await Promise.resolve();

    expect(received).toEqual(req);

    io.closeInbound();
  });

  test("inbound notification (no id) reaches onNotification", async () => {
    const io = makeMockStdio();
    const transport = new JsonRpcTransport(io.stdin, io.stdout);
    let received: JsonRpcNotification | null = null;
    transport.onNotification = (n) => {
      received = n;
    };
    transport.startReading();

    const note: JsonRpcNotification = {
      jsonrpc: "2.0",
      method: "ezcorp/state-update",
      params: { v: 1 },
    };
    io.pushInbound(JSON.stringify(note) + "\n");
    await Promise.resolve();
    await Promise.resolve();

    expect(received).toEqual(note);

    io.closeInbound();
  });

  test("multiple frames in one chunk all dispatch", async () => {
    const io = makeMockStdio();
    const transport = new JsonRpcTransport(io.stdin, io.stdout);
    transport.startReading();

    const p1 = transport.send({ jsonrpc: "2.0", id: 1, method: "a" });
    const p2 = transport.send({ jsonrpc: "2.0", id: 2, method: "b" });

    const r1: JsonRpcResponse = { jsonrpc: "2.0", id: 1, result: "r1" };
    const r2: JsonRpcResponse = { jsonrpc: "2.0", id: 2, result: "r2" };
    io.pushInbound(JSON.stringify(r1) + "\n" + JSON.stringify(r2) + "\n");

    expect(await p1).toEqual(r1);
    expect(await p2).toEqual(r2);

    io.closeInbound();
  });

  test("partial frame split across chunks reassembles", async () => {
    const io = makeMockStdio();
    const transport = new JsonRpcTransport(io.stdin, io.stdout);
    transport.startReading();

    const pending = transport.send({ jsonrpc: "2.0", id: 5, method: "x" });
    const resp: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: 5,
      result: { piece: "split-frame" },
    };
    const wire = JSON.stringify(resp) + "\n";
    io.pushInbound(wire.slice(0, 12));
    await Promise.resolve();
    io.pushInbound(wire.slice(12));

    expect(await pending).toEqual(resp);

    io.closeInbound();
  });

  test("malformed line is skipped, valid follow-up is delivered", async () => {
    const io = makeMockStdio();
    const transport = new JsonRpcTransport(io.stdin, io.stdout);
    transport.startReading();

    const pending = transport.send({ jsonrpc: "2.0", id: 11, method: "y" });

    io.pushInbound("{not valid json}\n");
    await Promise.resolve();
    io.pushInbound(
      JSON.stringify({ jsonrpc: "2.0", id: 11, result: "ok" }) + "\n",
    );

    const got = await pending;
    expect(got.result).toBe("ok");

    io.closeInbound();
  });

  test("close() rejects all pending callbacks", async () => {
    const io = makeMockStdio();
    const transport = new JsonRpcTransport(io.stdin, io.stdout);
    transport.startReading();

    const p1 = transport.send({ jsonrpc: "2.0", id: 1, method: "a" });
    transport.close();

    await expect(p1).rejects.toThrow(/Transport closed/);

    io.closeInbound();
  });

  test("static encode/decode round-trip preserves shape", () => {
    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "ezcorp/fs",
      params: { operation: "read", path: "/tmp/x" },
    };
    const encoded = JsonRpcTransport.encode(req);
    expect(encoded.endsWith("\n")).toBe(true);

    const respLine = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { allowed: true, resolvedPath: "/tmp/x" },
    });
    const decoded = JsonRpcTransport.decode(respLine);
    expect(decoded.id).toBe(1);
    expect(decoded.result).toEqual({ allowed: true, resolvedPath: "/tmp/x" });
  });
});

// ── Phase 3 chunked-frame transport ────────────────────────────────
//
// The new wire shapes (sentinel bytes are `\x01`, `\x02`, `\x03`):
//   announce: \x02<id>:<total-chunks>\n
//   chunk:    \x01<id>:<seq>:<base64-data>\n
//   cancel:   \x03<id>:<reason>\n
//
// Small responses keep the existing `{...}\n` wire format; only
// streaming responses use sentinel-prefixed frames. The sentinel byte
// itself disambiguates because `{` (0x7B) never collides with
// `\x01`/`\x02`/`\x03`.

describe("json-rpc transport — chunked-frame streaming", () => {
  // Helper: build a chunk frame: \x01<id>:<seq>:<base64>\n
  function chunkFrame(id: number | string, seq: number, payload: string): string {
    const b64 = Buffer.from(payload, "binary").toString("base64");
    return `\x01${id}:${seq}:${b64}\n`;
  }

  function announceFrame(id: number | string, total: number): string {
    return `\x02${id}:${total}\n`;
  }

  function cancelFrame(id: number | string, reason: string): string {
    return `\x03${id}:${reason}\n`;
  }

  test("small response continues to use line-delimited format", async () => {
    const io = makeMockStdio();
    const transport = new JsonRpcTransport(io.stdin, io.stdout);
    transport.startReading();

    const pending = transport.send({ jsonrpc: "2.0", id: 1, method: "x" });
    io.pushInbound(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tiny: true } }) + "\n",
    );
    const r = await pending;
    expect(r.result).toEqual({ tiny: true });

    io.closeInbound();
  });

  test("5MB streaming response reassembles correctly across chunks", async () => {
    const io = makeMockStdio();
    const transport = new JsonRpcTransport(io.stdin, io.stdout);
    transport.startReading();

    const pending = transport.send({ jsonrpc: "2.0", id: 42, method: "fs.read" });

    // Build a synthetic 5MB JSON-RPC response body and split into 256KB
    // chunks. The chunked transport delivers it as `result` on the
    // resolved Promise once `<total-chunks>` are received.
    const bodyStr = "X".repeat(5 * 1024 * 1024); // 5MB
    const responseObj: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: 42,
      result: { body: bodyStr },
    };
    const wireStr = JSON.stringify(responseObj);

    const CHUNK = 256 * 1024;
    const total = Math.ceil(wireStr.length / CHUNK);

    io.pushInbound(announceFrame(42, total));
    for (let i = 0; i < total; i++) {
      const piece = wireStr.slice(i * CHUNK, (i + 1) * CHUNK);
      io.pushInbound(chunkFrame(42, i, piece));
      // yield a microtask between chunks so the read loop drains
      await Promise.resolve();
    }

    const got = await pending;
    expect(got.id).toBe(42);
    const body = (got.result as { body: string }).body;
    expect(body.length).toBe(5 * 1024 * 1024);
    expect(body[0]).toBe("X");
    expect(body[bodyStr.length - 1]).toBe("X");

    io.closeInbound();
  });

  test("out-of-order chunk rejects the streaming response", async () => {
    const io = makeMockStdio();
    const transport = new JsonRpcTransport(io.stdin, io.stdout);
    transport.startReading();

    const pending = transport.send({ jsonrpc: "2.0", id: 7, method: "fs.read" });

    io.pushInbound(announceFrame(7, 3));
    io.pushInbound(chunkFrame(7, 0, "AAA"));
    // Skip seq=1, send seq=2 — out of order.
    io.pushInbound(chunkFrame(7, 2, "CCC"));

    await expect(pending).rejects.toThrow(/out.of.order|sequence/i);

    io.closeInbound();
  });

  test("cancel frame mid-stream surfaces error to caller", async () => {
    const io = makeMockStdio();
    const transport = new JsonRpcTransport(io.stdin, io.stdout);
    transport.startReading();

    const pending = transport.send({
      jsonrpc: "2.0",
      id: 99,
      method: "fs.read",
    });

    io.pushInbound(announceFrame(99, 5));
    io.pushInbound(chunkFrame(99, 0, "AAA"));
    io.pushInbound(chunkFrame(99, 1, "BBB"));
    io.pushInbound(cancelFrame(99, "extension crashed"));

    await expect(pending).rejects.toThrow(/cancelled|extension crashed/i);

    io.closeInbound();
  });

  test("sentinel byte disambiguates streaming frames from line-delimited frames in the same chunk", async () => {
    const io = makeMockStdio();
    const transport = new JsonRpcTransport(io.stdin, io.stdout);
    transport.startReading();

    // Two pending requests: one streaming, one line-delimited.
    const streamingPending = transport.send({
      jsonrpc: "2.0",
      id: 100,
      method: "stream",
    });
    const lineDelimPending = transport.send({
      jsonrpc: "2.0",
      id: 200,
      method: "line",
    });

    // Build a streaming response (ID 100) interleaved with a
    // line-delimited response (ID 200) — the transport must dispatch
    // both correctly without either path tripping over the other's
    // bytes.
    const streamObj: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: 100,
      result: { ok: "stream" },
    };
    const streamWire = JSON.stringify(streamObj);
    io.pushInbound(announceFrame(100, 1));
    io.pushInbound(chunkFrame(100, 0, streamWire));

    const lineObj: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: 200,
      result: { ok: "line" },
    };
    io.pushInbound(JSON.stringify(lineObj) + "\n");

    const [s, l] = await Promise.all([streamingPending, lineDelimPending]);
    expect(s.result).toEqual({ ok: "stream" });
    expect(l.result).toEqual({ ok: "line" });

    io.closeInbound();
  });

  test("cancel for unknown id is a no-op", async () => {
    const io = makeMockStdio();
    const transport = new JsonRpcTransport(io.stdin, io.stdout);
    transport.startReading();

    // No pending stream for id=999 — the transport must simply ignore
    // the frame without throwing or polluting the buffer.
    io.pushInbound(cancelFrame(999, "nothing-here"));
    await Promise.resolve();

    // A subsequent legitimate response for a fresh id still works.
    const pending = transport.send({
      jsonrpc: "2.0",
      id: 1,
      method: "after-cancel",
    });
    io.pushInbound(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }) + "\n",
    );
    expect((await pending).result).toBe("ok");

    io.closeInbound();
  });

  test("oversized chunk body (>256KB) is rejected", async () => {
    const io = makeMockStdio();
    const transport = new JsonRpcTransport(io.stdin, io.stdout);
    transport.startReading();

    const pending = transport.send({ jsonrpc: "2.0", id: 50, method: "z" });

    io.pushInbound(announceFrame(50, 1));
    // 1MB raw payload — base64-encoded chunk body exceeds 256KB cap.
    io.pushInbound(chunkFrame(50, 0, "Y".repeat(1024 * 1024)));

    await expect(pending).rejects.toThrow(/chunk.*exceed|too.*large/i);

    io.closeInbound();
  });

  test("total-bytes cap (>100MB) is rejected", async () => {
    const io = makeMockStdio();
    const transport = new JsonRpcTransport(io.stdin, io.stdout);
    transport.startReading();

    // 410 chunks @ 256KB ≈ 102MB raw payload — total exceeds 100MB cap.
    // We don't push them all; the announce alone, declaring a too-large
    // total, lets the transport reject early.
    const total = Math.ceil((101 * 1024 * 1024) / (256 * 1024));
    const pending = transport.send({ jsonrpc: "2.0", id: 60, method: "huge" });
    io.pushInbound(announceFrame(60, total));

    await expect(pending).rejects.toThrow(/exceed.*100MB|too.*large/i);

    io.closeInbound();
  });
});
