import { expect, test } from "bun:test";
import { createCanvasBridge, invokeScannerTool } from "./lib/bridge.js";
import { createScanner } from "./lib/scanner.js";
import { lookupCard } from "./lib/api.js";
import * as cards from "./lib/db.js";
import { mockCard } from "./lib/mock-card.js";

function fixture() {
  const sent: Array<{ request: Record<string, unknown>; origin: string }> = [];
  const connections: Record<string, unknown>[] = [];
  const hosts: MessagePort[] = [];
  const waiters: Array<() => void> = [];
  let cursor = 0;
  let host: MessagePort;
  const pagehide = new Set<() => void>();
  const parent = { postMessage: (request: Record<string, unknown>, origin: string, ports: MessagePort[]) => {
    connections.push(request);
    host = ports[0]!;
    hosts.push(host);
    host.onmessage = event => { sent.push({ request: event.data, origin }); waiters.shift()?.(); };
    host.start();
  } };
  const target = {
    __EZCORP_CANVAS_NONCE__: crypto.randomUUID(),
    document: { URL: "https://harness.test/api/extensions/graded-card-scanner/preview" }, parent, crypto, MessageChannel,
    addEventListener: (name: string, listener: () => void) => { if (name === "pagehide") pagehide.add(listener); },
    removeEventListener: (name: string, listener: () => void) => { if (name === "pagehide") pagehide.delete(listener); },
  };
  const bridge = createCanvasBridge(target as unknown as Window);
  const reply = (data: Record<string, unknown>, source: unknown = parent, origin = "https://harness.test") => { if (source === parent && origin === "https://harness.test") host.postMessage({ nonce: target.__EZCORP_CANVAS_NONCE__, ...data }); };
  const nextRequest = async () => {
    if (sent.length <= cursor) await new Promise<void>(resolve => waiters.push(resolve));
    return sent[cursor++]!;
  };
  return { bridge, sent, connections, reply, target, nextRequest, pagehide: () => { for (const listener of pagehide) listener(); }, close: () => { bridge.close(); for (const port of hosts) port.close(); } };
}

test("bridge sends only exact tool input; host context is not child authority", async () => {
  const context = fixture();
  const result = context.bridge.request("tool.invoke", { toolName: "lookup_card", input: { cert: "49392223" } });
  await context.nextRequest();
  expect(context.connections[0]).toEqual({ type: "ezcorp.canvas.connect", nonce: context.target.__EZCORP_CANVAS_NONCE__ });
  expect(context.sent[0]).toMatchObject({ origin: "https://harness.test", request: { type: "ezcorp.canvas.request", method: "tool.invoke", params: { toolName: "lookup_card", input: { cert: "49392223" } } } });
  expect(Object.keys(context.sent[0]!.request).sort()).toEqual(["id", "method", "nonce", "params", "type"]);
  const response = { type: "ezcorp.canvas.response", id: context.sent[0]!.request.id, result: { success: true, output: "{}" } };
  let settled = false;
  void result.then(() => { settled = true; });
  context.reply(response, {}, "https://harness.test");
  context.reply(response, undefined, "https://foreign.test");
  context.reply({ ...response, id: "unknown" });
  context.reply({ ...response, nonce: crypto.randomUUID() });
  await Promise.resolve();
  expect(settled).toBe(false);
  context.reply(response);
  expect(await result).toEqual({ success: true, output: "{}" });
  context.close();
});

test("bridge denies generic transport, oversized requests, malformed replies and closed clients", async () => {
  const context = fixture();
  await expect(context.bridge.request("fetch" as never, {})).rejects.toThrow("Unsupported");
  await expect(context.bridge.request("tool.invoke", { data: "x".repeat(300_000) })).rejects.toThrow();
  const malformed = context.bridge.request("tool.invoke", {});
  await context.nextRequest();
  context.reply({ type: "ezcorp.canvas.response", id: context.sent[0]!.request.id });
  await expect(malformed).rejects.toThrow("Invalid host");
  const denied = context.bridge.request("tool.invoke", {});
  await context.nextRequest();
  context.reply({ type: "ezcorp.canvas.response", id: context.sent[1]!.request.id, error: { code: "CANVAS_REQUEST_DENIED", message: "Conversation access denied." } });
  await expect(denied).rejects.toThrow("Conversation access denied");
  context.close();
  await expect(context.bridge.request("camera.start", {})).rejects.toThrow("closed");
});

test("browser lookup and saved-list clients use the nonce-bound bridge, never session HTTP or device storage", async () => {
  const context = fixture();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: context.target });
  const reply = (value: unknown) => context.reply({ type: "ezcorp.canvas.response", id: context.sent.at(-1)!.request.id, result: { success: true, output: JSON.stringify(value) } });
  try {
    const record = mockCard("49392223");
    const lookedUp = lookupCard(record.cert, { fresh: true });
    await context.nextRequest();
    expect(context.sent.at(-1)!.request.params).toEqual({ toolName: "lookup_card", input: { cert: record.cert, fresh: true } });
    reply(record);
    expect(await lookedUp).toEqual(record);
    const saved = { cert: record.cert, status: "done" as const, record, scans: ["2026-09-05T00:00:00.000Z"], savedAt: "2026-09-05T00:00:00.000Z", updatedAt: "2026-09-05T00:00:00.000Z" };
    const put = cards.putCard(saved); await context.nextRequest(); reply({ saved: true }); await put;
    const get = cards.getCard(record.cert); await context.nextRequest(); reply(saved); expect(await get).toEqual(saved);
    const missing = cards.getCard(record.cert); await context.nextRequest(); reply(null); expect(await missing).toBeUndefined();
    const list = cards.listCards(); await context.nextRequest(); reply({ cards: [saved], nextCursor: null }); expect(await list).toEqual([saved]);
    const remove = cards.deleteCard(record.cert); await context.nextRequest(); reply({ deleted: true }); await remove;
    const clear = cards.clearCards(); await context.nextRequest(); reply({ deleted: 0 }); await clear;
    const wrongRecord = lookupCard(record.cert); await context.nextRequest(); reply({ grades: [] }); await expect(wrongRecord).rejects.toThrow("unexpected shape");
    const malformed = cards.listCards(); await context.nextRequest(); reply({ cards: [], nextCursor: 42 }); await expect(malformed).rejects.toThrow("Invalid saved-card");
    const denied = invokeScannerTool("lookup_card", {});
    await context.nextRequest();
    context.reply({ type: "ezcorp.canvas.response", id: context.sent.at(-1)!.request.id, result: { success: false, error: "Approval revoked." } });
    await expect(denied).rejects.toThrow("Approval revoked");
    context.pagehide();
    await expect(invokeScannerTool("lookup_card", {})).rejects.toThrow("closed");
  } finally {
    context.pagehide();
    context.close();
    if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window");
  }
});

test("camera never starts at construction and stopping a pending approval cancels the late session", async () => {
  const context = fixture();
  const sessionId = crypto.randomUUID();
  const image = { removeAttribute: () => {}, src: "" };
  const scanner = createScanner({ videoEl: image as unknown as HTMLImageElement, onText: () => {}, onError: error => { throw error; }, bridge: context.bridge });
  expect(context.sent).toEqual([]);
  const starting = scanner.start();
  await context.nextRequest();
  expect(context.sent[0]!.request).toMatchObject({ method: "camera.start", params: {} });
  scanner.stop();
  context.reply({ type: "ezcorp.canvas.response", id: context.sent[0]!.request.id, result: { sessionId } });
  await context.nextRequest();
  expect(context.sent[1]!.request).toMatchObject({ method: "camera.stop", params: { sessionId } });
  context.reply({ type: "ezcorp.canvas.response", id: context.sent[1]!.request.id, result: { stopped: true } });
  await starting;
  expect(scanner.running).toBe(false);
  scanner.dispose();
  context.close();
});

test("camera accepts only its host session and rejects oversized or non-JPEG frames", async () => {
  const context = fixture();
  const sessionId = crypto.randomUUID();
  const image = { removeAttribute: () => {}, src: "" };
  const errors: string[] = [];
  let stopped: (reason: string) => void = () => {};
  const didStop = new Promise<string>(resolve => { stopped = resolve; });
  const scanner = createScanner({ videoEl: image as unknown as HTMLImageElement, onText: () => {}, onError: error => errors.push(error.message), onStop: stopped, bridge: context.bridge });
  const start = scanner.start();
  await context.nextRequest();
  context.reply({ type: "ezcorp.canvas.response", id: context.sent[0]!.request.id, result: { sessionId } });
  await start;
  expect(scanner.running).toBe(true);
  for (const event of [
    { sessionId: crypto.randomUUID(), dataUrl: "data:image/jpeg;base64,YQ==" },
    { sessionId, dataUrl: "data:image/svg+xml;base64,YQ==" },
    { sessionId, dataUrl: "data:image/jpeg;base64," + "A".repeat(710_000) },
  ]) context.reply({ type: "ezcorp.canvas.camera", ...event });
  expect(image.src).toBe("");
  context.reply({ type: "ezcorp.canvas.camera-stopped", sessionId, reason: "User stopped camera." });
  expect(await didStop).toBe("User stopped camera.");
  expect(scanner.running).toBe(false);
  expect(errors).toEqual([]);
  scanner.dispose();
  context.close();
});

test("host revocation stops the scanner and clears its last frame immediately", async () => {
  const context = fixture();
  const removed: string[] = [];
  const image = { removeAttribute: (name: string) => removed.push(name), src: "" };
  let stopped: (reason: string) => void = () => {};
  const didStop = new Promise<string>(resolve => { stopped = resolve; });
  const scanner = createScanner({ videoEl: image as unknown as HTMLImageElement, onText: () => {}, onError: () => {}, onStop: stopped, bridge: context.bridge });
  const start = scanner.start();
  await context.nextRequest();
  context.reply({ type: "ezcorp.canvas.response", id: context.sent[0]!.request.id, result: { sessionId: crypto.randomUUID() } });
  await start;
  expect(scanner.running).toBe(true);
  context.reply({ type: "ezcorp.canvas.closed" });
  expect(await didStop).toContain("Reopen the extension preview");
  expect(scanner.running).toBe(false);
  expect(removed).toContain("src");
  await expect(context.bridge.request("camera.start", {})).rejects.toThrow("closed");
  scanner.dispose();
  context.close();
});
