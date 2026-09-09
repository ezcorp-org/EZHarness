import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { RunnerError, safeHostError } from "./core";

export type ReverseRpc = (method: string, params: unknown) => Promise<unknown>;
type Frame = { jsonrpc: "2.0"; id?: string | number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };

export class FramedExecution {
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly listeners = new Set<(method: string, params: unknown) => void>();
  private sequence = 0;
  private stopped = false;
  private termination: Promise<void> | undefined;
  private reversePending = 0;
  private reverseIds = new Set<string>();
  private logs = 0;
  private received = 0;
  private logText = "";
  readonly exited: Promise<number | null>;
  constructor(readonly workerId: string, private readonly child: ChildProcessWithoutNullStreams, private readonly reverse: ReverseRpc, private readonly terminate: () => Promise<void>, private readonly frameBytes: number, private readonly timeoutMs: number, private readonly beginRequest?: (method: string, params: unknown) => (() => void)) {
    this.exited = new Promise<number | null>(resolve => child.once("close", resolve)).then(async code => { await this.stop(); return code; });
    child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    child.stderr.on("data", (chunk: Buffer) => { this.logs += chunk.byteLength; this.logText = (this.logText + chunk.toString()).slice(-8192); if (this.logs > this.frameBytes) this.fail(new RunnerError("output_limit", "Worker log limit exceeded")); });
    child.on("error", error => this.fail(error));
    child.on("close", () => this.fail(new RunnerError("worker_exited", this.logText.trim() || "Worker exited before response")));
    child.stdin.on("error", error => this.fail(error));
  }
  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  request(method: string, params: unknown): Promise<unknown> {
    if (this.stopped) return Promise.reject(new RunnerError("worker_closed", "Worker is closed"));
    if (this.pending.size >= 32) return Promise.reject(new RunnerError("request_limit", "Worker request limit exceeded"));
    const id = `host-${++this.sequence}`;
    let finish: (() => void) | undefined;
    try { finish = this.beginRequest?.(method, params); } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new RunnerError("invocation_timeout", "Worker request exceeded deadline")), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ jsonrpc: "2.0", id, method, params }); } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    }).finally(() => finish?.());
  }
  async close(): Promise<void> {
    this.fail(new RunnerError("cancelled", "Worker closed"));
    await this.stop();
  }
  private stop(): Promise<void> { this.termination ??= this.terminate(); return this.termination; }
  private fail(error: Error): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.listeners.clear();
    void this.stop().catch(() => this.child.kill("SIGKILL"));
  }
  private send(frame: Frame): void {
    const encoded = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(encoded) > this.frameBytes) throw new RunnerError("frame_limit", "Control frame exceeds policy");
    if (this.child.stdin.writableLength > this.frameBytes * 2) throw new RunnerError("backpressure_limit", "Worker is not reading input");
    this.child.stdin.write(encoded);
  }
  private consume(chunk: Buffer): void {
    if (this.stopped) return;
    this.received += chunk.byteLength;
    if (this.received > this.frameBytes) { this.fail(new RunnerError("output_limit", "Worker control output exceeded policy")); return; }
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      if (this.buffer.length + end - offset > this.frameBytes) { this.fail(new RunnerError("frame_limit", "Worker frame exceeds policy")); return; }
      this.buffer = Buffer.concat([this.buffer, chunk.subarray(offset, end)]);
      offset = end + 1;
      if (newline === -1) break;
      try {
        const frame: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(this.buffer));
        this.buffer = Buffer.alloc(0);
        this.accept(frame);
      } catch (error) { this.fail(error instanceof RunnerError ? error : new RunnerError("protocol_error", "Worker emitted invalid protocol data")); return; }
    }
  }
  private accept(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new RunnerError("protocol_error", "Expected JSON-RPC object");
    const frame = value as Frame;
    if (frame.jsonrpc !== "2.0" || (frame.id !== undefined && typeof frame.id !== "string" && !Number.isSafeInteger(frame.id))) throw new RunnerError("protocol_error", "Invalid JSON-RPC version or ID");
    if (frame.method !== undefined) {
      if (typeof frame.method !== "string" || frame.method.length > 128 || "result" in frame || "error" in frame) throw new RunnerError("protocol_error", "Invalid request");
      if (frame.id === undefined) { for (const listener of this.listeners) listener(frame.method, frame.params); return; }
      const key = `${typeof frame.id}:${frame.id}`;
      if (this.reversePending >= 32 || this.reverseIds.has(key)) throw new RunnerError("protocol_error", "Duplicate or excess host request");
      this.reversePending++;
      this.reverseIds.add(key);
      void this.reverse(frame.method, frame.params).then(result => {
        if (!this.stopped) this.send({ jsonrpc: "2.0", id: frame.id, result });
      }, error => {
        const safe = safeHostError(error);
        if (!this.stopped) this.send({ jsonrpc: "2.0", id: frame.id, error: { code: safe.code === "STATE_CONFLICT" ? -32009 : -32001, message: safe.message } });
      }).catch(error => this.fail(error instanceof Error ? error : new Error(String(error)))).finally(() => { this.reversePending--; this.reverseIds.delete(key); });
      return;
    }
    if (typeof frame.id !== "string" || ("result" in frame) === ("error" in frame)) throw new RunnerError("protocol_error", "Invalid response");
    const pending = this.pending.get(frame.id);
    if (!pending) throw new RunnerError("protocol_error", "Unknown or replayed response ID");
    if ("error" in frame && (!frame.error || !Number.isInteger(frame.error.code) || typeof frame.error.message !== "string")) throw new RunnerError("protocol_error", "Invalid error response");
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.error) {
      pending.reject(new RunnerError("extension_error", frame.error.message.slice(0, 4096)));
    } else pending.resolve(frame.result);
  }
}
