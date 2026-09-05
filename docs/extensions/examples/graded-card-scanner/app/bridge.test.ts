import { expect, test } from "bun:test";
import { createCanvasBridge, invokeScannerTool } from "./lib/bridge.js";
import { createScanner } from "./lib/scanner.js";
import { lookupCard } from "./lib/api.js";
import * as cards from "./lib/db.js";
import { mockCard } from "./lib/mock-card.js";

function fixture() {
  const sent: Array<{ request: Record<string, unknown>; origin: string }> = [];
  let receive: (event: MessageEvent) => void = () => {};
  let pagehide = () => {};
  const parent = { postMessage: (request: Record<string, unknown>, origin: string) => sent.push({ request, origin }) };
  const target = {
    __EZCORP_CANVAS_NONCE__: crypto.randomUUID(),
    document: { URL: "https://harness.test/api/extensions/graded-card-scanner/preview" }, parent, crypto,
    addEventListener: (name: string, listener: (event: MessageEvent) => void) => { if (name === "message") receive = listener; else if (name === "pagehide") pagehide = listener as unknown as () => void; },
    removeEventListener: () => { receive = () => {}; },
  };
  const bridge = createCanvasBridge(target as unknown as Window);
  const reply = (data: Record<string, unknown>, source: unknown = parent, origin = "https://harness.test") => receive({ source, origin, data: { nonce: target.__EZCORP_CANVAS_NONCE__, ...data } } as MessageEvent);
  return { bridge, sent, reply, target, pagehide: () => pagehide() };
}

test("bridge sends only exact tool input; host context is not child authority", async () => {
  const context = fixture();
  const result = context.bridge.request("tool.invoke", { toolName: "lookup_card", input: { cert: "49392223" } });
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
  context.bridge.close();
});

test("bridge denies generic transport, oversized requests, malformed replies and closed clients", async () => {
  const context = fixture();
  await expect(context.bridge.request("fetch" as never, {})).rejects.toThrow("Unsupported");
  await expect(context.bridge.request("tool.invoke", { data: "x".repeat(300_000) })).rejects.toThrow("too large");
  const malformed = context.bridge.request("tool.invoke", {});
  context.reply({ type: "ezcorp.canvas.response", id: context.sent[0]!.request.id });
  await expect(malformed).rejects.toThrow("Invalid host");
  const denied = context.bridge.request("tool.invoke", {});
  context.reply({ type: "ezcorp.canvas.response", id: context.sent[1]!.request.id, error: { code: "denied", message: "Conversation access denied." } });
  await expect(denied).rejects.toThrow("Conversation access denied");
  context.bridge.close();
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
    expect(context.sent.at(-1)!.request.params).toEqual({ toolName: "lookup_card", input: { cert: record.cert, fresh: true } });
    reply(record);
    expect(await lookedUp).toEqual(record);
    const saved = { cert: record.cert, status: "done" as const, record, scans: ["2026-09-05T00:00:00.000Z"], savedAt: "2026-09-05T00:00:00.000Z", updatedAt: "2026-09-05T00:00:00.000Z" };
    const put = cards.putCard(saved); reply({ saved: true }); await put;
    const get = cards.getCard(record.cert); reply(saved); expect(await get).toEqual(saved);
    const missing = cards.getCard(record.cert); reply(null); expect(await missing).toBeUndefined();
    const list = cards.listCards(); reply({ cards: [saved], nextCursor: null }); expect(await list).toEqual([saved]);
    const remove = cards.deleteCard(record.cert); reply({ deleted: true }); await remove;
    const clear = cards.clearCards(); reply({ deleted: 0 }); await clear;
    const wrongRecord = lookupCard(record.cert); reply({ grades: [] }); await expect(wrongRecord).rejects.toThrow("unexpected shape");
    const malformed = cards.listCards(); reply({ cards: [], nextCursor: 42 }); await expect(malformed).rejects.toThrow("Invalid saved-card");
    const denied = invokeScannerTool("lookup_card", {});
    context.reply({ type: "ezcorp.canvas.response", id: context.sent.at(-1)!.request.id, result: { success: false, error: "Approval revoked." } });
    await expect(denied).rejects.toThrow("Approval revoked");
    context.pagehide();
    await expect(invokeScannerTool("lookup_card", {})).rejects.toThrow("closed");
  } finally {
    context.pagehide();
    context.bridge.close();
    if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window");
  }
});

test("camera never starts at construction and stopping a pending approval cancels the late session", async () => {
  const context = fixture();
  const image = { removeAttribute: () => {}, src: "" };
  const scanner = createScanner({ videoEl: image as unknown as HTMLImageElement, onText: () => {}, onError: error => { throw error; }, bridge: context.bridge });
  expect(context.sent).toEqual([]);
  const starting = scanner.start();
  expect(context.sent[0]!.request).toMatchObject({ method: "camera.start", params: {} });
  scanner.stop();
  context.reply({ type: "ezcorp.canvas.response", id: context.sent[0]!.request.id, result: { sessionId: "late-session" } });
  await Promise.resolve();
  expect(context.sent[1]!.request).toMatchObject({ method: "camera.stop", params: { sessionId: "late-session" } });
  context.reply({ type: "ezcorp.canvas.response", id: context.sent[1]!.request.id, result: { stopped: true } });
  await starting;
  expect(scanner.running).toBe(false);
  scanner.dispose();
  context.bridge.close();
});

test("camera accepts only its host session and rejects oversized or non-JPEG frames", async () => {
  const context = fixture();
  const image = { removeAttribute: () => {}, src: "" };
  const errors: string[] = [];
  const scanner = createScanner({ videoEl: image as unknown as HTMLImageElement, onText: () => {}, onError: error => errors.push(error.message), bridge: context.bridge });
  const start = scanner.start();
  context.reply({ type: "ezcorp.canvas.response", id: context.sent[0]!.request.id, result: { sessionId: "camera" } });
  await start;
  expect(scanner.running).toBe(true);
  for (const event of [
    { sessionId: "foreign", dataUrl: "data:image/jpeg;base64,YQ==" },
    { sessionId: "camera", dataUrl: "data:image/svg+xml;base64,YQ==" },
    { sessionId: "camera", dataUrl: "data:image/jpeg;base64," + "A".repeat(710_000) },
  ]) context.reply({ type: "ezcorp.canvas.camera", ...event });
  expect(image.src).toBe("");
  context.reply({ type: "ezcorp.canvas.camera-stopped", sessionId: "camera", reason: "User stopped camera." });
  expect(scanner.running).toBe(false);
  expect(errors).toEqual(["User stopped camera."]);
  scanner.dispose();
  context.bridge.close();
});
