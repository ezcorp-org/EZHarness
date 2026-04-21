import { test, expect, describe } from "bun:test";
import { JsonRpcTransport } from "../extensions/json-rpc";
import type { JsonRpcRequest } from "../extensions/types";

function at<T>(arr: readonly T[], i: number, what: string): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`expected ${what} at index ${i}`);
  return v;
}

function createMockTransport() {
  const written: string[] = [];
  const stdin = {
    write(data: string) { written.push(data); return data.length; },
    flush() {},
  };

  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
  });

  const transport = new JsonRpcTransport(stdin, stdout);
  const encoder = new TextEncoder();

  return {
    transport,
    written,
    push(data: string) { controller.enqueue(encoder.encode(data)); },
    close() { controller.close(); },
  };
}

describe("JsonRpcTransport", () => {
  describe("static methods", () => {
    test("encode() serializes a request with trailing newline", () => {
      const req: JsonRpcRequest = { jsonrpc: "2.0", id: 1, method: "test", params: { a: 1 } };
      const encoded = JsonRpcTransport.encode(req);
      expect(encoded).toBe('{"jsonrpc":"2.0","id":1,"method":"test","params":{"a":1}}\n');
    });

    test("decode() parses a JSON-RPC response", () => {
      const line = '{"jsonrpc":"2.0","id":1,"result":"ok"}\n';
      const decoded = JsonRpcTransport.decode(line);
      expect(decoded).toEqual({ jsonrpc: "2.0", id: 1, result: "ok" });
    });

    test("decode() trims whitespace", () => {
      const decoded = JsonRpcTransport.decode('  {"jsonrpc":"2.0","id":2,"result":null}  ');
      expect(decoded.id).toBe(2);
    });
  });

  describe("buffer framing", () => {
    test("resolves pending callback on complete response", async () => {
      const { transport, push } = createMockTransport();
      transport.startReading();

      const promise = transport.send({ jsonrpc: "2.0", id: 1, method: "foo" });
      push('{"jsonrpc":"2.0","id":1,"result":"bar"}\n');

      const resp = await promise;
      expect(resp.result).toBe("bar");
    });
  });

  describe("fragmented messages", () => {
    test("reassembles a message split across chunks", async () => {
      const { transport, push } = createMockTransport();
      transport.startReading();

      const promise = transport.send({ jsonrpc: "2.0", id: 1, method: "foo" });
      push('{"jsonrpc":"2.0",');
      push('"id":1,"result":"hello"}\n');

      const resp = await promise;
      expect(resp.result).toBe("hello");
    });
  });

  describe("multiple messages in one chunk", () => {
    test("resolves multiple pending callbacks from a single chunk", async () => {
      const { transport, push } = createMockTransport();
      transport.startReading();

      const p1 = transport.send({ jsonrpc: "2.0", id: 1, method: "a" });
      const p2 = transport.send({ jsonrpc: "2.0", id: 2, method: "b" });
      push('{"jsonrpc":"2.0","id":1,"result":"r1"}\n{"jsonrpc":"2.0","id":2,"result":"r2"}\n');

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.result).toBe("r1");
      expect(r2.result).toBe("r2");
    });
  });

  describe("malformed JSON lines", () => {
    test("skips malformed lines without crashing", async () => {
      const { transport, push } = createMockTransport();
      transport.startReading();

      const promise = transport.send({ jsonrpc: "2.0", id: 1, method: "foo" });
      push('not valid json\n{"jsonrpc":"2.0","id":1,"result":"ok"}\n');

      const resp = await promise;
      expect(resp.result).toBe("ok");
    });
  });

  describe("empty lines", () => {
    test("skips empty lines without crashing", async () => {
      const { transport, push } = createMockTransport();
      transport.startReading();

      const promise = transport.send({ jsonrpc: "2.0", id: 1, method: "foo" });
      push('\n\n{"jsonrpc":"2.0","id":1,"result":"ok"}\n');

      const resp = await promise;
      expect(resp.result).toBe("ok");
    });
  });

  describe("EOF / stream close", () => {
    test("rejects all pending callbacks when stream ends", async () => {
      const { transport, close } = createMockTransport();
      transport.startReading();

      const p1 = transport.send({ jsonrpc: "2.0", id: 1, method: "a" }).catch((e: Error) => e);
      const p2 = transport.send({ jsonrpc: "2.0", id: 2, method: "b" }).catch((e: Error) => e);

      close();

      const [e1, e2] = await Promise.all([p1, p2]);
      expect(e1).toBeInstanceOf(Error);
      expect((e1 as Error).message).toBe("Transport closed");
      expect(e2).toBeInstanceOf(Error);
      expect((e2 as Error).message).toBe("Transport closed");
    });
  });

  describe("close() method", () => {
    test("rejects all pending callbacks", async () => {
      const { transport } = createMockTransport();
      transport.startReading();

      const p1 = transport.send({ jsonrpc: "2.0", id: 1, method: "a" });
      const p2 = transport.send({ jsonrpc: "2.0", id: 2, method: "b" });

      transport.close();

      await expect(p1).rejects.toThrow("Transport closed");
      await expect(p2).rejects.toThrow("Transport closed");
    });
  });

  describe("onRequest callback", () => {
    test("calls onRequest for messages with both method and id", async () => {
      const { transport, push } = createMockTransport();
      const received: JsonRpcRequest[] = [];
      transport.onRequest = (req) => received.push(req);
      transport.startReading();

      push('{"jsonrpc":"2.0","id":99,"method":"notify","params":{"x":1}}\n');

      // Give the read loop a tick to process
      await new Promise((r) => setTimeout(r, 10));

      expect(received).toHaveLength(1);
      const first = at(received, 0, "request");
      expect(first.method).toBe("notify");
      expect(first.id).toBe(99);
      expect(first.params).toEqual({ x: 1 });
    });

    test("does not resolve a pending send callback for incoming requests", async () => {
      const { transport, push } = createMockTransport();
      transport.onRequest = () => {};
      transport.startReading();

      // Send a request with id=1, then receive an incoming *request* with id=1
      // The incoming request should go to onRequest, not resolve the send promise
      const promise = transport.send({ jsonrpc: "2.0", id: 1, method: "foo" });

      push('{"jsonrpc":"2.0","id":1,"method":"bar"}\n');
      await new Promise((r) => setTimeout(r, 10));

      // The send promise should still be pending (not resolved)
      // Verify by closing and checking it rejects
      transport.close();
      await expect(promise).rejects.toThrow("Transport closed");
    });
  });

  describe("startReading idempotency", () => {
    test("calling startReading() twice does not start two read loops", async () => {
      const { transport, push } = createMockTransport();
      transport.startReading();
      transport.startReading(); // Should be a no-op

      const promise = transport.send({ jsonrpc: "2.0", id: 1, method: "foo" });
      push('{"jsonrpc":"2.0","id":1,"result":"ok"}\n');

      // If two read loops were started, the second getReader() call would throw
      // since a ReadableStream can only have one active reader
      const resp = await promise;
      expect(resp.result).toBe("ok");
    });
  });

  describe("send()", () => {
    test("writes JSON-RPC request with trailing newline to stdin", () => {
      const { transport, written } = createMockTransport();
      transport.send({ jsonrpc: "2.0", id: 1, method: "test", params: { key: "val" } });

      expect(written).toHaveLength(1);
      expect(written[0]).toBe('{"jsonrpc":"2.0","id":1,"method":"test","params":{"key":"val"}}\n');
    });
  });
});
