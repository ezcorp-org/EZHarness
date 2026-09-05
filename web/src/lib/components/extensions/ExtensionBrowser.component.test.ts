import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import ExtensionBrowser from "./ExtensionBrowser.svelte";

const fixture = vi.hoisted(() => ({ dispatch: undefined as any, stop: undefined as any, bridge: undefined as any, fetch: vi.fn() }));
vi.mock("$lib/utils/fetch-policy", () => ({ userFetch: fixture.fetch }));
vi.mock("$lib/extensions/canvas-bridge", () => ({ CanvasBridge: class {
  controller = new AbortController();
  signal = this.controller.signal;
  send = vi.fn();
  connect = vi.fn();
  loaded = vi.fn();
  constructor(_target: unknown, _nonce: string, dispatch: unknown, stopped: unknown) { fixture.dispatch = dispatch; fixture.stop = stopped; fixture.bridge = this; }
  close() { if (this.signal.aborted) return; this.controller.abort(); fixture.stop(); }
} }));

beforeEach(() => {
  fixture.fetch.mockReset().mockImplementation(async () => Response.json({ success: true, output: "safe" }));
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function mount() { return render(ExtensionBrowser, { name: "browser", binding: "a".repeat(64), nonce: crypto.randomUUID(), conversationId: "owned", tools: ["allowed"] }); }

test("renders opaque frame and forwards only exact sealed tool and context", async () => {
  const rendered = mount();
  const iframe = rendered.getByTitle("browser preview");
  expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
  expect(iframe.getAttribute("src")).toContain("conversationId=owned");
  const signal = new AbortController().signal;
  expect(await fixture.dispatch("tool.invoke", { toolName: "allowed", input: { value: 1 } }, signal)).toEqual({ success: true, output: "safe" });
  expect(JSON.parse(fixture.fetch.mock.calls[0]![1].body)).toEqual({ method: "tool.invoke", toolName: "allowed", input: { value: 1 }, binding: "a".repeat(64), conversationId: "owned" });
  await expect(fixture.dispatch("tool.invoke", { toolName: "other", input: {} }, signal)).rejects.toThrow("not exposed");
  await fireEvent.load(iframe);
  expect(fixture.bridge.loaded).toHaveBeenCalled();
  await fireEvent(window, new MessageEvent("message"));
  expect(fixture.bridge.connect).toHaveBeenCalled();
  fixture.fetch.mockResolvedValueOnce(new Response("Denied", { status: 403 }));
  await expect(fixture.dispatch("tool.invoke", { toolName: "allowed", input: {} }, signal)).rejects.toThrow();
  await waitFor(() => expect(rendered.getByRole("alert").textContent).toContain("access changed"));
  expect(fixture.bridge.signal.aborted).toBe(true);
});

test("camera requires host confirmation and cancellation releases pending request", async () => {
  const rendered = mount();
  const controller = new AbortController();
  const pending = fixture.dispatch("camera.start", {}, controller.signal);
  const rejected = expect(pending).rejects.toThrow("cancelled");
  await waitFor(() => expect(rendered.getByRole("dialog")).toBeTruthy());
  await expect(fixture.dispatch("camera.start", {}, controller.signal)).rejects.toThrow("pending");
  await fireEvent.click(rendered.getByRole("button", { name: "Cancel", exact: true }));
  await rejected;
  expect(await fixture.dispatch("camera.stop", { sessionId: crypto.randomUUID() }, controller.signal)).toEqual({ stopped: true });
  await expect(fixture.dispatch("camera.stop", {}, controller.signal)).rejects.toThrow("mismatch");
  await fireEvent(window, new Event("pagehide"));
  expect(fixture.bridge.signal.aborted).toBe(true);
});

test("trusted camera emits bounded frames only after live checks and stops every track", async () => {
  const stop = vi.fn();
  const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn(async () => stream) } });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  const drawing = { drawImage: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(drawing as any);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,ZmFrZQ==");
  const rendered = mount();
  const video = rendered.getByLabelText("Host camera preview") as HTMLVideoElement;
  Object.defineProperty(video, "videoWidth", { value: 1920 });
  Object.defineProperty(video, "videoHeight", { value: 1080 });
  const pending = fixture.dispatch("camera.start", {}, new AbortController().signal);
  await waitFor(() => expect(rendered.getByRole("dialog")).toBeTruthy());
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  await fireEvent.click(rendered.getByRole("button", { name: "Start camera", exact: true }));
  const result = await pending;
  expect(result.sessionId).toMatch(/^[a-f0-9-]{36}$/);
  expect(await fixture.dispatch("camera.start", {}, new AbortController().signal)).toEqual(result);
  await waitFor(() => expect(fixture.bridge.send).toHaveBeenCalledWith({ type: "ezcorp.canvas.camera", sessionId: result.sessionId, dataUrl: "data:image/jpeg;base64,ZmFrZQ==" }), { timeout: 2000 });
  expect(drawing.drawImage).toHaveBeenCalledWith(video, 0, 0, 1280, 720);
  await expect(fixture.dispatch("camera.stop", { sessionId: "different" }, new AbortController().signal)).rejects.toThrow("mismatch");
  fixture.fetch.mockResolvedValueOnce(new Response("revoked", { status: 403 }));
  await waitFor(() => expect(stop).toHaveBeenCalledTimes(1), { timeout: 2000 });
  expect(video.srcObject).toBeNull();
  expect(fixture.bridge.signal.aborted).toBe(true);
});

test("camera denial rejects pending requests without reporting success", async () => {
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn(async () => { throw new Error("permission denied"); }) } });
  const rendered = mount();
  const pending = fixture.dispatch("camera.start", {}, new AbortController().signal);
  const rejection = expect(pending).rejects.toThrow("cancelled");
  await waitFor(() => expect(rendered.getByRole("dialog")).toBeTruthy());
  await fireEvent.click(rendered.getByRole("button", { name: "Start camera", exact: true }));
  await rejection;
  await waitFor(() => expect(rendered.getByRole("status").textContent).toContain("Camera unavailable"));
  const controller = new AbortController();
  controller.abort();
  await expect(fixture.dispatch("camera.start", {}, controller.signal)).rejects.toThrow("expired");
});
