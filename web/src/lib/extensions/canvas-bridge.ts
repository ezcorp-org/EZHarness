export type CanvasMethod = "tool.invoke" | "camera.start" | "camera.stop";
export type CanvasDispatch = (method: CanvasMethod, params: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;

export class CanvasBridge {
  private port: MessagePort | undefined;
  private connected = false;
  private closed = false;
  private loads = 0;
  private readonly lifetime = new AbortController();
  private readonly seen = new Set<string>();
  private readonly pending = new Map<string, AbortController>();
  private inflight = 0;
  private windowStart = Date.now();
  private requests = 0;

  constructor(private readonly target: () => Window | null | undefined, private readonly nonce: string, private readonly dispatch: CanvasDispatch, private readonly stopped: () => void) {}

  get signal(): AbortSignal { return this.lifetime.signal; }

  connect(event: MessageEvent): void {
    const target = this.target();
    if (this.closed || this.connected || !target || event.source !== target || event.origin !== "null" || event.data?.type !== "ezcorp.canvas.connect" || event.data?.nonce !== this.nonce || event.ports.length !== 1) return;
    this.connected = true;
    this.port = event.ports[0]!;
    this.port.onmessage = event => { void this.request(event.data); };
    this.port.onmessageerror = () => this.close();
    this.port.start();
  }

  loaded(): void { if (++this.loads > 1) this.close(); }

  send(value: Record<string, unknown>): void {
    if (this.closed || !this.port) return;
    const envelope = { ...value, nonce: this.nonce };
    if (new TextEncoder().encode(JSON.stringify(envelope)).byteLength > 1024 * 1024) throw new Error("Canvas response exceeds limit");
    this.port.postMessage(envelope);
  }

  private async request(value: unknown): Promise<void> {
    if (this.closed || !value || typeof value !== "object" || Array.isArray(value)) return;
    const request = value as Record<string, unknown>;
    if (request.nonce !== this.nonce) return;
    if (request.type === "ezcorp.canvas.close" && Object.keys(request).length === 2) { this.close(); return; }
    if (typeof request.id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(request.id)) return;
    if (request.type === "ezcorp.canvas.cancel" && Object.keys(request).length === 3) { this.pending.get(request.id)?.abort(); return; }
    if (request.type !== "ezcorp.canvas.request") return;
    const fail = () => this.send({ type: "ezcorp.canvas.response", id: request.id, error: { code: "CANVAS_REQUEST_DENIED", message: "The preview request was denied or failed. Reload if access changed." } });
    if (Date.now() - this.windowStart >= 60_000) { this.windowStart = Date.now(); this.requests = 0; }
    if (this.inflight >= 32 || ++this.requests > 120 || this.seen.has(request.id) || !["tool.invoke", "camera.start", "camera.stop"].includes(String(request.method)) || !request.params || typeof request.params !== "object" || Array.isArray(request.params) || Object.keys(request).some(key => !["type", "nonce", "id", "method", "params"].includes(key))) { fail(); return; }
    this.seen.add(request.id);
    if (this.seen.size > 256) this.seen.delete(this.seen.values().next().value!);
    this.inflight++;
    const controller = new AbortController();
    this.pending.set(request.id, controller);
    try {
      if (new TextEncoder().encode(JSON.stringify(request)).byteLength > 256 * 1024) throw new Error("Canvas request exceeds limit");
      const signal = AbortSignal.any([this.lifetime.signal, controller.signal, AbortSignal.timeout(request.method === "camera.start" ? 300_000 : 60_000)]);
      const result = await this.dispatch(request.method as CanvasMethod, request.params as Record<string, unknown>, signal);
      if (!signal.aborted) this.send({ type: "ezcorp.canvas.response", id: request.id, result });
    } catch { fail(); } finally { this.inflight--; this.pending.delete(request.id); }
  }

  close(): void {
    if (this.closed) return;
    this.send({ type: "ezcorp.canvas.closed" });
    this.closed = true;
    this.lifetime.abort();
    const port = this.port;
    if (port) {
      const drain = setTimeout(() => port.close(), 1000);
      port.onmessage = event => {
        const value = event.data;
        if (value?.type === "ezcorp.canvas.closed-ack" && value.nonce === this.nonce && Object.keys(value).length === 2) { clearTimeout(drain); port.close(); }
      };
    }
    this.seen.clear();
    this.pending.clear();
    this.stopped();
  }
}
