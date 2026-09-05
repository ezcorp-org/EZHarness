import { assertJson } from "@ezcorp/extension-contract/json";

export type CanvasMethod = "tool.invoke" | "camera.start" | "camera.stop";
export type CanvasCameraEvent = { type: "ezcorp.canvas.camera"; nonce: string; sessionId: string; dataUrl: string } | { type: "ezcorp.canvas.camera-stopped"; nonce: string; sessionId: string; reason: string };
export interface CanvasRequestOptions { signal?: AbortSignal; timeoutMs?: number }
export interface CanvasWindow {
  readonly document: { readonly URL: string };
  readonly parent: { postMessage(message: unknown, origin: string, transfer: MessagePort[]): void };
  readonly crypto: { randomUUID(): string };
  readonly __EZCORP_CANVAS_NONCE__?: unknown;
  addEventListener(type: "pagehide", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "pagehide", listener: () => void): void;
}
export interface CanvasBridge {
  request<Result = unknown>(method: CanvasMethod, params: Record<string, unknown>, options?: CanvasRequestOptions): Promise<Result>;
  subscribeCamera(listener: (event: CanvasCameraEvent) => void): () => void;
  close(): void;
}
interface Pending { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxRequestBytes = 256 * 1024;
const maxResponseBytes = 1024 * 1024;
const maxCameraBase64 = Math.ceil(512 * 1024 / 3) * 4;

export function createCanvasBridge(target: CanvasWindow): CanvasBridge {
  const origin = new URL(target.document.URL).origin;
  if (origin === "null" || target.parent as unknown === target) throw new Error("Open this extension in its trusted host preview.");
  const nonce = target.__EZCORP_CANVAS_NONCE__;
  if (typeof nonce !== "string" || !uuid.test(nonce)) throw new Error("Trusted extension session is missing.");
  const channel = new MessageChannel();
  const port = channel.port1;
  const pending = new Map<string, Pending>();
  const listeners = new Set<(event: CanvasCameraEvent) => void>();
  let closed = false;
  function finish(id: string, error: Error | undefined, result?: unknown): void {
    const call = pending.get(id);
    if (!call) return;
    pending.delete(id);
    call.cleanup();
    if (error) call.reject(error); else call.resolve(result);
  }
  function send(message: unknown): void { port.postMessage(message); }
  function cancel(id: string, error: Error): void {
    if (!pending.has(id)) return;
    try { send({ type: "ezcorp.canvas.cancel", nonce, id }); }
    finally { finish(id, error); }
  }
  function close(): void {
    if (closed) return;
    closed = true;
    target.removeEventListener("pagehide", close);
    try { send({ type: "ezcorp.canvas.close", nonce }); }
    finally {
      port.onmessage = null;
      port.onmessageerror = null;
      port.close();
      channel.port2.close();
      for (const id of pending.keys()) finish(id, new Error("Extension bridge is closed."));
      listeners.clear();
    }
  }
  port.onmessage = event => {
    if (closed) return;
    let data: Record<string, unknown>;
    try {
      assertJson(event.data, maxResponseBytes);
      if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) return;
      data = event.data as Record<string, unknown>;
    } catch { close(); return; }
    if (data.nonce !== nonce) return;
    if (data.type === "ezcorp.canvas.camera" || data.type === "ezcorp.canvas.camera-stopped") {
      const image = data.type === "ezcorp.canvas.camera";
      const keys = image ? ["type", "nonce", "sessionId", "dataUrl"] : ["type", "nonce", "sessionId", "reason"];
      if (Object.keys(data).some(key => !keys.includes(key)) || typeof data.sessionId !== "string" || !uuid.test(data.sessionId)) return;
      if (image ? typeof data.dataUrl !== "string" || data.dataUrl.length > maxCameraBase64 + 23 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]*={0,2}$/.test(data.dataUrl) : typeof data.reason !== "string" || data.reason.length > 256) return;
      for (const listener of listeners) listener(data as CanvasCameraEvent);
      return;
    }
    if (data.type !== "ezcorp.canvas.response" || typeof data.id !== "string" || !pending.has(data.id)) return;
    if (Object.keys(data).some(key => !["type", "nonce", "id", "result", "error"].includes(key)) || Object.hasOwn(data, "result") === Object.hasOwn(data, "error")) { finish(data.id, new Error("Invalid host bridge response.")); return; }
    if (Object.hasOwn(data, "error")) {
      const error = data.error;
      const valid = error && typeof error === "object" && !Array.isArray(error) && "code" in error && error.code === "CANVAS_REQUEST_DENIED" && "message" in error && typeof error.message === "string" && error.message.length <= 1000 && Object.keys(error).every(key => key === "code" || key === "message");
      finish(data.id, new Error(valid ? error.message as string : "Invalid host bridge response."));
    } else finish(data.id, undefined, data.result);
  };
  port.onmessageerror = close;
  port.start();
  target.addEventListener("pagehide", close, { once: true });
  try { target.parent.postMessage({ type: "ezcorp.canvas.connect", nonce }, origin, [channel.port2]); }
  catch (error) { close(); throw error; }
  return {
    async request<Result>(method: CanvasMethod, params: Record<string, unknown>, options: CanvasRequestOptions = {}): Promise<Result> {
      if (closed) throw new Error("Extension bridge is closed.");
      if (!["tool.invoke", "camera.start", "camera.stop"].includes(method)) throw new Error("Unsupported extension bridge method.");
      options.signal?.throwIfAborted();
      if (pending.size >= 32) throw new Error("Too many pending extension requests.");
      if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("Extension request parameters must be an object.");
      const maximum = method === "camera.start" ? 300_000 : 60_000;
      const timeoutMs = options.timeoutMs ?? maximum;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maximum) throw new Error("Invalid extension request timeout.");
      const id = target.crypto.randomUUID();
      if (!uuid.test(id) || pending.has(id)) throw new Error("Invalid or duplicate extension request identifier.");
      const message = { type: "ezcorp.canvas.request", nonce, id, method, params };
      assertJson(message, maxRequestBytes);
      return new Promise<Result>((resolve, reject) => {
        const timer = setTimeout(() => cancel(id, new Error("The host did not answer the extension request.")), timeoutMs);
        const abort = () => cancel(id, new Error("Extension request cancelled."));
        pending.set(id, { resolve: value => resolve(value as Result), reject, cleanup: () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); } });
        options.signal?.addEventListener("abort", abort, { once: true });
        try { send(message); } catch { finish(id, new Error("Extension request could not be sent.")); }
      });
    },
    subscribeCamera(listener) {
      if (closed) throw new Error("Extension bridge is closed.");
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    close,
  };
}
