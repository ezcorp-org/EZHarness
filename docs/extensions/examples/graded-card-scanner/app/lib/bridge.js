// @ts-check

/** @param {Window} target */
export function createCanvasBridge(target) {
  const origin = new URL(target.document.URL).origin;
  if (origin === "null" || target.parent === target) throw new Error("Open the scanner from its trusted extension preview.");
  const nonce = /** @type {Window & {__EZCORP_CANVAS_NONCE__?:unknown}} */ (target).__EZCORP_CANVAS_NONCE__;
  if (typeof nonce !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nonce)) throw new Error("Trusted scanner session is missing.");
  /** @type {Map<string, {resolve:(value:any)=>void,reject:(reason:Error)=>void,timer:ReturnType<typeof setTimeout>}>} */
  const pending = new Map();
  /** @type {Set<(event:any)=>void>} */
  const listeners = new Set();
  let closed = false;
  const receive = (/** @type {MessageEvent} */ event) => {
    if (event.source !== target.parent || event.origin !== origin) return;
    const data = event.data;
    if (!data || typeof data !== "object" || data.nonce !== nonce) return;
    if (data.type === "ezcorp.canvas.camera" || data.type === "ezcorp.canvas.camera-stopped") {
      for (const listener of listeners) listener(data);
      return;
    }
    if (data.type !== "ezcorp.canvas.response" || typeof data.id !== "string") return;
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    clearTimeout(request.timer);
    if (data.error && typeof data.error.message === "string") request.reject(new Error(data.error.message));
    else if (Object.hasOwn(data, "result")) request.resolve(data.result);
    else request.reject(new Error("Invalid host bridge response."));
  };
  target.addEventListener("message", receive);
  return {
    /** @param {"tool.invoke"|"camera.start"|"camera.stop"} method @param {Record<string,unknown>} params */
    request(method, params) {
      if (closed) return Promise.reject(new Error("Scanner bridge is closed."));
      if (!["tool.invoke", "camera.start", "camera.stop"].includes(method)) return Promise.reject(new Error("Unsupported scanner bridge method."));
      if (pending.size >= 32) return Promise.reject(new Error("Too many pending scanner requests."));
      const id = target.crypto.randomUUID();
      const request = JSON.parse(JSON.stringify({ type: "ezcorp.canvas.request", nonce, id, method, params }));
      if (new TextEncoder().encode(JSON.stringify(request)).length > 256 * 1024) return Promise.reject(new Error("Scanner request is too large."));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("The host did not answer the scanner request.")); }, method === "camera.start" ? 300_000 : 60_000);
        pending.set(id, { resolve, reject, timer });
        target.parent.postMessage(request, origin);
      });
    },
    /** @param {(event:any)=>void} listener */
    subscribeCamera(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    close() {
      closed = true;
      target.removeEventListener("message", receive);
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("Scanner bridge is closed.")); }
      pending.clear();
      listeners.clear();
    },
  };
}

/** @type {ReturnType<typeof createCanvasBridge>|undefined} */
let bridge;
export function canvasBridge() {
  if (!bridge) {
    bridge = createCanvasBridge(window);
    window.addEventListener("pagehide", () => bridge?.close(), { once: true });
  }
  return bridge;
}

/** @param {string} toolName @param {Record<string,unknown>} input */
export async function invokeScannerTool(toolName, input) {
  const response = await canvasBridge().request("tool.invoke", { toolName, input });
  if (!response || response.success !== true || typeof response.output !== "string") throw new Error(response?.error || "Scanner tool failed.");
  return JSON.parse(response.output);
}
