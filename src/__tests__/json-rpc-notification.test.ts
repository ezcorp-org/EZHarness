import { test, expect, describe } from "bun:test";
import { JsonRpcTransport } from "../extensions/json-rpc";
import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "../extensions/types";

function at<T>(arr: readonly T[], i: number, what: string): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`expected ${what} at index ${i}`);
  return v;
}

/**
 * Tests for JSON-RPC notification handling in JsonRpcTransport.
 * Notifications are messages with a method but NO id (fire-and-forget).
 */

function createTransport() {
  const written: string[] = [];
  const stdin = {
    write(data: string | Uint8Array): number {
      written.push(typeof data === "string" ? data : new TextDecoder().decode(data));
      return typeof data === "string" ? data.length : data.byteLength;
    },
  };

  // Create a readable stream we can push data into
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
  });

  const transport = new JsonRpcTransport(stdin, stdout);

  function pushLine(obj: unknown): void {
    const line = JSON.stringify(obj) + "\n";
    controller.enqueue(new TextEncoder().encode(line));
  }

  return { transport, written, pushLine, controller };
}

describe("JsonRpcTransport notification handling", () => {
  test("dispatches notification (method, no id) to onNotification callback", async () => {
    const { transport, pushLine } = createTransport();
    const received: JsonRpcNotification[] = [];
    transport.onNotification = (n) => received.push(n);
    transport.startReading();

    pushLine({ jsonrpc: "2.0", method: "ezcorp/state", params: { foo: "bar" } });

    // Allow the async read loop to process
    await new Promise((r) => setTimeout(r, 50));

    expect(received).toHaveLength(1);
    const first = at(received, 0, "notification");
    expect(first.method).toBe("ezcorp/state");
    expect(first.params).toEqual({ foo: "bar" });
  });

  test("does NOT dispatch notification to onRequest callback", async () => {
    const { transport, pushLine } = createTransport();
    const requests: JsonRpcRequest[] = [];
    const notifications: JsonRpcNotification[] = [];
    transport.onRequest = (r) => requests.push(r);
    transport.onNotification = (n) => notifications.push(n);
    transport.startReading();

    // Notification: has method, NO id
    pushLine({ jsonrpc: "2.0", method: "ezcorp/state", params: {} });

    await new Promise((r) => setTimeout(r, 50));

    expect(requests).toHaveLength(0);
    expect(notifications).toHaveLength(1);
  });

  test("request (method + id) still goes to onRequest, not onNotification", async () => {
    const { transport, pushLine } = createTransport();
    const requests: JsonRpcRequest[] = [];
    const notifications: JsonRpcNotification[] = [];
    transport.onRequest = (r) => requests.push(r);
    transport.onNotification = (n) => notifications.push(n);
    transport.startReading();

    // Request: has both method AND id
    pushLine({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} });

    await new Promise((r) => setTimeout(r, 50));

    expect(requests).toHaveLength(1);
    expect(notifications).toHaveLength(0);
  });

  test("response (id only, no method) still goes to response callback", async () => {
    const { transport, pushLine } = createTransport();
    const notifications: JsonRpcNotification[] = [];
    transport.onNotification = (n) => notifications.push(n);
    transport.startReading();

    // Send a request first so the response callback is registered
    const responsePromise = transport.send({ jsonrpc: "2.0", id: 42, method: "test", params: {} });

    // Push a response (id, no method)
    pushLine({ jsonrpc: "2.0", id: 42, result: { ok: true } });

    const response = await responsePromise;
    expect((response as any).result).toEqual({ ok: true });
    expect(notifications).toHaveLength(0);
  });

  test("silently ignores notification when no onNotification handler set", async () => {
    const { transport, pushLine } = createTransport();
    // No handler set
    transport.startReading();

    pushLine({ jsonrpc: "2.0", method: "ezcorp/state", params: { x: 1 } });

    // Should not throw
    await new Promise((r) => setTimeout(r, 50));
  });

  test("handles malformed JSON lines without crashing", async () => {
    const { transport, controller } = createTransport();
    const notifications: JsonRpcNotification[] = [];
    transport.onNotification = (n) => notifications.push(n);
    transport.startReading();

    // Push garbage followed by valid notification
    controller.enqueue(new TextEncoder().encode("not json at all\n"));
    controller.enqueue(
      new TextEncoder().encode(
        JSON.stringify({ jsonrpc: "2.0", method: "ezcorp/state", params: {} }) + "\n",
      ),
    );

    await new Promise((r) => setTimeout(r, 50));

    // Only the valid notification should be received
    expect(notifications).toHaveLength(1);
  });

  test("notification with explicit id: null is treated as notification", async () => {
    const { transport, pushLine } = createTransport();
    const notifications: JsonRpcNotification[] = [];
    const requests: JsonRpcRequest[] = [];
    transport.onNotification = (n) => notifications.push(n);
    transport.onRequest = (r) => requests.push(r);
    transport.startReading();

    // id explicitly set to null — this is still a notification per JSON-RPC 2.0
    pushLine({ jsonrpc: "2.0", id: null, method: "ezcorp/state", params: {} });

    await new Promise((r) => setTimeout(r, 50));

    // id == null is truthy for `msg.id == null` check
    expect(notifications).toHaveLength(1);
    expect(requests).toHaveLength(0);
  });

  test("notification without params is valid", async () => {
    const { transport, pushLine } = createTransport();
    const notifications: JsonRpcNotification[] = [];
    transport.onNotification = (n) => notifications.push(n);
    transport.startReading();

    pushLine({ jsonrpc: "2.0", method: "lifecycle/agent:spawn" });

    await new Promise((r) => setTimeout(r, 50));

    expect(notifications).toHaveLength(1);
    expect(at(notifications, 0, "notification").params).toBeUndefined();
  });

  test("multiple notifications in rapid succession are all dispatched", async () => {
    const { transport, pushLine } = createTransport();
    const notifications: JsonRpcNotification[] = [];
    transport.onNotification = (n) => notifications.push(n);
    transport.startReading();

    for (let i = 0; i < 10; i++) {
      pushLine({ jsonrpc: "2.0", method: "ezcorp/state", params: { i } });
    }

    await new Promise((r) => setTimeout(r, 100));

    expect(notifications).toHaveLength(10);
    expect(at(notifications, 9, "10th notification").params).toEqual({ i: 9 });
  });

  test("id: 0 (falsy but valid JSON-RPC id) routes to onRequest, not onNotification", async () => {
    const { transport, pushLine } = createTransport();
    const requests: JsonRpcRequest[] = [];
    const notifications: JsonRpcNotification[] = [];
    transport.onRequest = (r) => requests.push(r);
    transport.onNotification = (n) => notifications.push(n);
    transport.startReading();

    // id: 0 is falsy in JS but is a valid JSON-RPC id (0 != null is true)
    pushLine({ jsonrpc: "2.0", id: 0, method: "tools/call", params: { name: "echo" } });

    await new Promise((r) => setTimeout(r, 50));

    expect(requests).toHaveLength(1);
    expect(at(requests, 0, "request").id).toBe(0);
    expect(notifications).toHaveLength(0);
  });

  test("response with id: 0 routes to response callback, not notification", async () => {
    const { transport, pushLine } = createTransport();
    const notifications: JsonRpcNotification[] = [];
    transport.onNotification = (n) => notifications.push(n);
    transport.startReading();

    // Send a request with id: 0
    const responsePromise = transport.send({ jsonrpc: "2.0", id: 0, method: "test", params: {} });

    // Push a response with id: 0
    pushLine({ jsonrpc: "2.0", id: 0, result: { value: "zero" } });

    const response = await responsePromise;
    expect((response as any).result).toEqual({ value: "zero" });
    expect(notifications).toHaveLength(0);
  });
});
