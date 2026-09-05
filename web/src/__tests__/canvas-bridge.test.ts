import { afterEach, describe, expect, test } from "bun:test";
import { CanvasBridge, type CanvasDispatch } from "../lib/extensions/canvas-bridge";
import { extensionDocumentHeaders } from "../lib/server/extension-document";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

function fixture(dispatch: CanvasDispatch = async (_method, params) => params) {
  const target = {} as Window;
  const nonce = crypto.randomUUID();
  const channel = new MessageChannel();
  const messages: Record<string, unknown>[] = [];
  channel.port1.onmessage = event => messages.push(event.data);
  let stops = 0;
  const bridge = new CanvasBridge(() => target, nonce, dispatch, () => { stops++; });
  const connect = (overrides: Partial<MessageEvent> = {}) => bridge.connect({ source: target, origin: "null", data: { type: "ezcorp.canvas.connect", nonce }, ports: [channel.port2], ...overrides } as MessageEvent);
  const send = (value: Record<string, unknown>) => channel.port1.postMessage({ nonce, ...value });
  const request = (params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => { const id = crypto.randomUUID(); send({ type: "ezcorp.canvas.request", id, method: "tool.invoke", params, ...extra }); return id; };
  cleanup.push(() => { bridge.close(); channel.port1.close(); });
  return { bridge, channel, nonce, messages, connect, send, request, stops: () => stops };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt++) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}

describe("private canvas channel", () => {
  test("binds the exact frame, opaque origin and nonce before accepting requests", async () => {
    const current = fixture();
    current.connect({ source: {} as Window });
    current.connect({ origin: "https://app.example" });
    current.connect({ data: { type: "ezcorp.canvas.connect", nonce: crypto.randomUUID() } });
    current.connect({ ports: [] });
    current.request();
    await Bun.sleep(20);
    expect(current.messages).toEqual([]);
    current.connect();
    await until(() => current.messages.length === 1);
    expect(current.messages[0]?.nonce).toBe(current.nonce);
    expect(current.messages[0]?.result).toEqual({});
    current.connect();
    current.request({ value: 7 });
    await until(() => current.messages.length === 2);
    expect(current.messages[1]?.result).toEqual({ value: 7 });
  });

  test("rejects malformed requests, replay, oversized input and secret-bearing errors", async () => {
    const current = fixture(async () => { throw new Error("HOST_SECRET_MUST_NOT_LEAK"); });
    current.connect();
    current.send({ type: "ezcorp.canvas.request", id: "------------------------------------", method: "tool.invoke", params: {} });
    current.send({ type: "unknown", id: crypto.randomUUID() });
    current.send({ type: "ezcorp.canvas.request", nonce: "wrong", id: crypto.randomUUID() });
    const id = current.request();
    current.request({}, { id });
    current.request({}, { method: "shell.exec" });
    current.request({}, { params: [] });
    current.request({}, { authority: "admin" });
    current.request({ text: "x".repeat(256 * 1024) });
    await until(() => current.messages.length === 6);
    expect(JSON.stringify(current.messages)).not.toContain("HOST_SECRET");
    expect(current.messages.every(message => (message.error as { code: string }).code === "CANVAS_REQUEST_DENIED")).toBe(true);
    expect(() => current.bridge.send({ result: "x".repeat(1024 * 1024) })).toThrow("Canvas response exceeds limit");
  });

  test("cancels only the named request and closes all work on navigation", async () => {
    const signals: AbortSignal[] = [];
    const current = fixture(async (_method, _params, signal) => {
      signals.push(signal);
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      return "must not arrive after abort";
    });
    current.connect();
    current.bridge.loaded();
    const first = current.request();
    current.request({}, { method: "camera.start" });
    await until(() => signals.length === 2);
    current.send({ type: "ezcorp.canvas.cancel", id: first });
    await until(() => signals[0]!.aborted);
    expect(signals[1]!.aborted).toBe(false);
    current.bridge.loaded();
    await until(() => signals[1]!.aborted && current.messages.length === 1);
    expect(current.messages[0]).toEqual({ type: "ezcorp.canvas.closed", nonce: current.nonce });
    expect(current.bridge.signal.aborted).toBe(true);
    expect(current.stops()).toBe(1);
    current.bridge.close();
    expect(current.stops()).toBe(1);
  });

  test("enforces pending limits and handles explicit teardown", async () => {
    const signals: AbortSignal[] = [];
    const current = fixture(async (_method, _params, signal) => {
      signals.push(signal);
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    current.connect();
    for (let index = 0; index < 33; index++) current.request();
    await until(() => current.messages.length === 1);
    expect(signals).toHaveLength(32);
    current.send({ type: "ezcorp.canvas.close" });
    await until(() => current.messages.length === 2);
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });

  test("applies sandbox and non-cacheable document response policy", () => {
    const headers = extensionDocumentHeaders();
    expect(headers["Content-Security-Policy"]).toContain("sandbox allow-scripts;");
    expect(headers["Content-Security-Policy"]).not.toContain("allow-same-origin");
    expect(headers["Cache-Control"]).toBe("private, no-store");
    expect(headers["Permissions-Policy"]).toBe("camera=(), microphone=(), geolocation=()");
  });
});
