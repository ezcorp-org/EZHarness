import { afterEach, expect, test } from "bun:test";
import { createCanvasBridge, type CanvasBridge, type CanvasMethod, type CanvasWindow } from "./index";

const opened: CanvasBridge[] = [];
afterEach(() => { for (const bridge of opened.splice(0)) bridge.close(); });

function fixture(overrides: Record<string, unknown> = {}) {
  const nonce = crypto.randomUUID();
  const events = new EventTarget();
  const inbox: Record<string, unknown>[] = [];
  const waiters: Array<(value: Record<string, unknown>) => void> = [];
  let port!: MessagePort;
  const connects: unknown[] = [];
  const target = Object.assign(events, { document: { URL: "https://host.test/api/extensions/test/browser" }, __EZCORP_CANVAS_NONCE__: nonce, crypto, parent: { postMessage(message: unknown, origin: string, ports: MessagePort[]) {
    connects.push({ message, origin, count: ports.length });
    port = structuredClone(ports[0]!, { transfer: ports });
    port.onmessage = event => {
      const waiting = waiters.shift();
      if (waiting) waiting(event.data); else inbox.push(event.data);
      if (event.data.type === "ezcorp.canvas.close") port.postMessage({ type: "ezcorp.canvas.closed", nonce });
    };
    port.start();
  } }, ...overrides }) as unknown as CanvasWindow;
  const bridge = createCanvasBridge(target);
  opened.push(bridge);
  return { bridge, nonce, connects, target, events, reply: (message: unknown) => port.postMessage(message), next: () => inbox.length ? Promise.resolve(inbox.shift()!) : new Promise<Record<string, unknown>>(resolve => waiters.push(resolve)) };
}

test("connects once to the exact parent origin and carries responses only on its private port", async () => {
  const data = fixture();
  expect(data.connects).toEqual([{ message: { type: "ezcorp.canvas.connect", nonce: data.nonce }, origin: "https://host.test", count: 1 }]);
  const result = data.bridge.request<{ saved: boolean }>("tool.invoke", { toolName: "save", input: {} });
  const request = await data.next();
  expect(request).toMatchObject({ type: "ezcorp.canvas.request", nonce: data.nonce, method: "tool.invoke", params: { toolName: "save", input: {} } });
  data.events.dispatchEvent(new MessageEvent("message", { data: { type: "ezcorp.canvas.response", nonce: data.nonce, id: request.id, result: "forged" } }));
  data.reply({ type: "ezcorp.canvas.response", nonce: "wrong", id: request.id, result: "forged" });
  data.reply({ type: "ezcorp.canvas.response", nonce: data.nonce, id: "unknown", result: "forged" });
  data.reply({ type: "ezcorp.canvas.response", nonce: data.nonce, id: request.id, result: { saved: true } });
  expect(await result).toEqual({ saved: true });
});

test("cancels one exact call, keeps its sibling active, and closes on pagehide", async () => {
  const data = fixture();
  const controller = new AbortController();
  const first = data.bridge.request("tool.invoke", {}, { signal: controller.signal });
  const firstMessage = await data.next();
  const second = data.bridge.request("tool.invoke", {});
  const secondMessage = await data.next();
  controller.abort();
  await expect(first).rejects.toThrow("cancelled");
  expect(await data.next()).toEqual({ type: "ezcorp.canvas.cancel", nonce: data.nonce, id: firstMessage.id });
  data.reply({ type: "ezcorp.canvas.response", nonce: data.nonce, id: secondMessage.id, result: "sibling" });
  expect(await second).toBe("sibling");
  const third = data.bridge.request("camera.start", {});
  await data.next();
  data.events.dispatchEvent(new Event("pagehide"));
  await expect(third).rejects.toThrow("closed");
  expect(await data.next()).toEqual({ type: "ezcorp.canvas.close", nonce: data.nonce });
  await expect(data.bridge.request("camera.stop", {})).rejects.toThrow("closed");
  expect(() => data.bridge.subscribeCamera(() => {})).toThrow("closed");
});

test("bounds timeouts and propagates only well-formed host error responses", async () => {
  const data = fixture();
  const timeout = data.bridge.request("tool.invoke", {}, { timeoutMs: 10 });
  const request = await data.next();
  await expect(timeout).rejects.toThrow("did not answer");
  expect(await data.next()).toEqual({ type: "ezcorp.canvas.cancel", nonce: data.nonce, id: request.id });
  for (const error of [{ code: "CANVAS_REQUEST_DENIED", message: "Denied by host" }, { code: "other", message: "Unsafe" }, null]) {
    const promise = data.bridge.request("tool.invoke", {});
    const next = await data.next();
    data.reply({ type: "ezcorp.canvas.response", nonce: data.nonce, id: next.id, error });
    await expect(promise).rejects.toThrow(error?.code === "CANVAS_REQUEST_DENIED" ? "Denied by host" : "Invalid host");
  }
  const malformed = data.bridge.request("tool.invoke", {});
  const next = await data.next();
  data.reply({ type: "ezcorp.canvas.response", nonce: data.nonce, id: next.id, result: 1, error: {} });
  await expect(malformed).rejects.toThrow("Invalid host");
});

test("rejects unsafe input, invalid methods and duplicate identifiers before posting", async () => {
  const data = fixture();
  for (const timeoutMs of [0, -1, 60_001, 1.5]) await expect(data.bridge.request("tool.invoke", {}, { timeoutMs })).rejects.toThrow("timeout");
  await expect(data.bridge.request("unsupported" as CanvasMethod, {})).rejects.toThrow("Unsupported");
  await expect(data.bridge.request("tool.invoke", [] as unknown as Record<string, unknown>)).rejects.toThrow("object");
  await expect(data.bridge.request("tool.invoke", { data: "x".repeat(256 * 1024) })).rejects.toThrow("limit");
  await expect(data.bridge.request("tool.invoke", { get secret() { throw new Error("getter executed"); } })).rejects.toThrow("Accessors");
  await expect(data.bridge.request("tool.invoke", {}, { signal: AbortSignal.abort(new Error("pre-aborted")) })).rejects.toThrow("pre-aborted");
  const duplicate = fixture({ crypto: { randomUUID: () => "11111111-1111-1111-1111-111111111111" } });
  const first = duplicate.bridge.request("tool.invoke", {});
  await duplicate.next();
  await expect(duplicate.bridge.request("tool.invoke", {})).rejects.toThrow("duplicate");
  duplicate.bridge.close();
  await expect(first).rejects.toThrow("closed");
});

test("limits outstanding calls and tears down all pending callers", async () => {
  const data = fixture();
  const calls = Array.from({ length: 32 }, () => data.bridge.request("tool.invoke", {}));
  await expect(data.bridge.request("tool.invoke", {})).rejects.toThrow("Too many");
  data.bridge.close();
  expect((await Promise.allSettled(calls)).every(result => result.status === "rejected")).toBe(true);
});

test("camera events require the bound nonce, fixed shape and bounded JPEG data", async () => {
  const data = fixture();
  const received: unknown[] = [];
  const unsubscribe = data.bridge.subscribeCamera(event => received.push(event));
  const sessionId = crypto.randomUUID();
  data.reply(null);
  data.reply({ type: "unknown", nonce: data.nonce });
  data.reply({ type: "ezcorp.canvas.camera", nonce: data.nonce, sessionId: "invalid", dataUrl: "bad" });
  data.reply({ type: "ezcorp.canvas.camera", nonce: data.nonce, sessionId, dataUrl: "data:text/html;base64,AA==" });
  data.reply({ type: "ezcorp.canvas.camera-stopped", nonce: data.nonce, sessionId, reason: "x".repeat(257) });
  const frame = { type: "ezcorp.canvas.camera", nonce: data.nonce, sessionId, dataUrl: "data:image/jpeg;base64,AA==" };
  const stopped = { type: "ezcorp.canvas.camera-stopped", nonce: data.nonce, sessionId, reason: "stopped" };
  data.reply(frame);
  data.reply(stopped);
  const sentinel = data.bridge.request("camera.stop", {});
  const request = await data.next();
  data.reply({ type: "ezcorp.canvas.response", nonce: data.nonce, id: request.id, result: null });
  await sentinel;
  expect(received).toEqual([frame, stopped]);
  unsubscribe();
  data.reply(frame);
});

test("oversized host frames close the session and reject outstanding callers", async () => {
  const data = fixture();
  const promise = data.bridge.request("tool.invoke", {});
  await data.next();
  data.reply({ data: "x".repeat(1024 * 1024) });
  await expect(promise).rejects.toThrow("closed");
});

test("host authority revocation rejects requests and notifies camera subscribers immediately", async () => {
  const data = fixture();
  const events: unknown[] = [];
  data.bridge.subscribeCamera(event => events.push(event));
  const pending = data.bridge.request("camera.start", {});
  await data.next();
  data.reply({ type: "ezcorp.canvas.closed", nonce: data.nonce });
  await expect(pending).rejects.toThrow("closed");
  expect(events).toEqual([{ type: "ezcorp.canvas.closed", nonce: data.nonce }]);
});

test("rejects missing trusted context and compiles as a pure browser module", async () => {
  expect(() => fixture({ document: { URL: "data:text/html,test" } })).toThrow("trusted");
  expect(() => fixture({ __EZCORP_CANVAS_NONCE__: "invalid" })).toThrow("missing");
  expect(() => fixture({ parent: { postMessage() { throw new Error("connect denied"); } } })).toThrow("connect denied");
  const result = await Bun.build({ entrypoints: [new URL("./index.ts", import.meta.url).pathname], target: "browser", minify: true });
  expect(result.success).toBe(true);
  const output = await result.outputs[0]!.text();
  for (const forbidden of ["node:", "process.stdin", "new Function(", "eval(", "ajv"]) expect(output).not.toContain(forbidden);
});
