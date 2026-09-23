import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { InvocationContext } from "@ezcorp/extension-contract";
import { RunnerError, safeHostError } from "./core";

export type ReverseRpc = (method: string, params: unknown) => Promise<unknown>;
export const SENSITIVE_PROVIDER_METHOD = "provider/credentials.resolve";
export const MAX_SENSITIVE_RESULT_BYTES = 16 * 1024;

export function sensitiveChannelError(): RunnerError {
  return new RunnerError("sensitive_method", "Sensitive provider workers cannot use ordinary channels");
}

type SensitiveEnvelope =
  | { kind: "provider-credential"; missing: true }
  | { kind: "provider-credential"; encoding: "base64"; data: string };
type Frame = {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
  sensitive?: true | SensitiveEnvelope;
};
type PendingRequest = {
  kind: "ordinary" | "sensitive";
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export abstract class SensitiveRunnerExecution {
  abstract readonly workerId: string;
  abstract request(method: string, params: unknown): Promise<unknown>;
  abstract close(): Promise<void>;
  abstract onNotification(listener: (method: string, params: unknown) => void): () => void;
  /** Internal transport hook. Keep instances typed as RunnerExecution outside the runner package. */
  abstract requestSensitiveProviderResult(params: unknown): Promise<Uint8Array | null>;
}

/** Host-only classified lane. Extension code cannot reach this through RunnerExecution. */
export function requestSensitiveProviderResult(execution: unknown, params: unknown): Promise<Uint8Array | null> {
  if (!(execution instanceof SensitiveRunnerExecution)) return Promise.reject(new RunnerError("sensitive_unavailable", "Sensitive provider transport is unavailable"));
  return execution.requestSensitiveProviderResult(params);
}

function decodeSensitiveEnvelope(value: unknown): Uint8Array | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RunnerError("sensitive_protocol", "Sensitive provider response was invalid");
  const envelope = value as Record<string, unknown>;
  if (envelope.kind !== "provider-credential") throw new RunnerError("sensitive_protocol", "Sensitive provider response was invalid");
  if (envelope.missing === true && Object.keys(envelope).length === 2) return null;
  if (envelope.encoding !== "base64" || typeof envelope.data !== "string" || Object.keys(envelope).length !== 3 || envelope.data.length === 0 || envelope.data.length > Math.ceil(MAX_SENSITIVE_RESULT_BYTES / 3) * 4) throw new RunnerError("sensitive_protocol", "Sensitive provider response was invalid");
  const bytes = Buffer.from(envelope.data, "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SENSITIVE_RESULT_BYTES || bytes.toString("base64") !== envelope.data) {
    bytes.fill(0);
    throw new RunnerError("sensitive_protocol", "Sensitive provider response was invalid");
  }
  return bytes;
}

export function bindSensitiveRequestContext(base: InvocationContext, timeoutMs: number): (params: unknown) => unknown {
  return params => {
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new RunnerError("invalid_context", "Sensitive provider input must be an object");
    return {
      ...params,
      context: {
        ...base,
        invocationId: randomUUID(),
        deadline: Math.min(base.deadline, Date.now() + Math.max(1, timeoutMs - 1)),
      },
    };
  };
}

export class FramedExecution extends SensitiveRunnerExecution {
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(method: string, params: unknown) => void>();
  private sequence = 0;
  private stopped = false;
  private termination: Promise<void> | undefined;
  private reversePending = 0;
  private reverseIds = new Set<string>();
  private logs = 0;
  private received = 0;
  private logText = "";
  private sensitiveMode = false;
  readonly exited: Promise<number | null>;
  constructor(readonly workerId: string, private readonly child: ChildProcessWithoutNullStreams, private readonly reverse: ReverseRpc, private readonly terminate: () => Promise<void>, private readonly frameBytes: number, private readonly timeoutMs: number, private readonly beginRequest?: (method: string, params: unknown) => (() => void), private readonly prepareSensitiveRequest?: (params: unknown) => unknown) {
    super();
    this.exited = new Promise<number | null>(resolve => child.once("close", resolve)).then(async code => { await this.stop(); return code; });
    child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.logs += chunk.byteLength;
      if (!this.sensitiveMode) this.logText = (this.logText + chunk.toString()).slice(-8192);
      else chunk.fill(0);
      if (this.logs > this.frameBytes) this.fail(new RunnerError("output_limit", "Worker log limit exceeded"));
    });
    child.on("error", error => this.fail(error));
    child.on("close", () => this.fail(new RunnerError("worker_exited", this.sensitiveMode ? "Sensitive provider process exited before response" : this.logText.trim() || "Worker exited before response")));
    child.stdin.on("error", error => this.fail(error));
  }
  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  request(method: string, params: unknown): Promise<unknown> {
    if (method === SENSITIVE_PROVIDER_METHOD) return Promise.reject(new RunnerError("sensitive_method", "Sensitive provider methods require the credential broker"));
    return this.startRequest("ordinary", method, params);
  }
  requestSensitiveProviderResult(params: unknown): Promise<Uint8Array | null> {
    return this.startRequest("sensitive", SENSITIVE_PROVIDER_METHOD, params) as Promise<Uint8Array | null>;
  }
  private startRequest(kind: PendingRequest["kind"], method: string, params: unknown): Promise<unknown> {
    if (this.stopped) return Promise.reject(new RunnerError("worker_closed", "Worker is closed"));
    if (kind === "ordinary" && this.sensitiveMode) return Promise.reject(sensitiveChannelError());
    if (this.pending.size >= 32) return Promise.reject(new RunnerError("request_limit", "Worker request limit exceeded"));
    if (kind === "sensitive") {
      if (this.reversePending > 0 || [...this.pending.values()].some(request => request.kind === "ordinary")) return Promise.reject(new RunnerError("sensitive_busy", "Sensitive provider requests require idle ordinary channels"));
      this.sensitiveMode = true;
      this.logText = "";
      this.listeners.clear();
    }
    const id = `host-${++this.sequence}`;
    let requestParams = params;
    let finish: (() => void) | undefined;
    try {
      if (kind === "sensitive") requestParams = this.prepareSensitiveRequest?.(params) ?? params;
      finish = this.beginRequest?.(method, requestParams);
    } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new RunnerError("invocation_timeout", "Worker request exceeded deadline")), this.timeoutMs);
      this.pending.set(id, { kind, resolve, reject, timer });
      try { this.send({ jsonrpc: "2.0", id, method, params: requestParams, ...(kind === "sensitive" ? { sensitive: true as const } : {}) }); } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
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
    if (this.sensitiveMode) {
      this.buffer.fill(0);
      this.buffer = Buffer.alloc(0);
    }
    const sensitiveFailure = this.sensitiveMode ? new RunnerError("sensitive_failed", "Sensitive provider request failed") : undefined;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(sensitiveFailure ?? error); }
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
    try {
      if (this.stopped) return;
      this.received += chunk.byteLength;
      if (this.received > this.frameBytes) { this.fail(new RunnerError("output_limit", "Worker control output exceeded policy")); return; }
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline === -1 ? chunk.length : newline;
        if (this.buffer.length + end - offset > this.frameBytes) { this.fail(new RunnerError("frame_limit", "Worker frame exceeds policy")); return; }
        const previous = this.buffer;
        this.buffer = Buffer.concat([previous, chunk.subarray(offset, end)]);
        if (this.sensitiveMode) previous.fill(0);
        offset = end + 1;
        if (newline === -1) break;
        try {
          const encoded = this.buffer;
          this.buffer = Buffer.alloc(0);
          let frame: unknown;
          try { frame = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(encoded)); }
          finally { if (this.sensitiveMode) encoded.fill(0); }
          this.accept(frame);
        } catch (error) { this.fail(error instanceof RunnerError ? error : new RunnerError("protocol_error", "Worker emitted invalid protocol data")); return; }
      }
    } finally {
      if (this.sensitiveMode) chunk.fill(0);
    }
  }
  private accept(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new RunnerError("protocol_error", "Expected JSON-RPC object");
    const frame = value as Frame;
    if (frame.jsonrpc !== "2.0" || (frame.id !== undefined && typeof frame.id !== "string" && !Number.isSafeInteger(frame.id))) throw new RunnerError("protocol_error", "Invalid JSON-RPC version or ID");
    if (frame.method !== undefined) {
      if (typeof frame.method !== "string" || frame.method.length > 128 || "result" in frame || "error" in frame || "sensitive" in frame) throw new RunnerError("protocol_error", "Invalid request");
      if (this.sensitiveMode) {
        if (frame.id !== undefined) this.send({ jsonrpc: "2.0", id: frame.id, error: { code: -32001, message: sensitiveChannelError().message } });
        return;
      }
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
    const hasResult = "result" in frame;
    const hasError = "error" in frame;
    const hasSensitive = "sensitive" in frame;
    if (typeof frame.id !== "string" || Number(hasResult) + Number(hasError) + Number(hasSensitive) !== 1) throw new RunnerError("protocol_error", "Invalid response");
    const pending = this.pending.get(frame.id);
    if (!pending) throw new RunnerError("protocol_error", "Unknown or replayed response ID");
    if ("error" in frame && (!frame.error || !Number.isInteger(frame.error.code) || typeof frame.error.message !== "string")) throw new RunnerError("protocol_error", "Invalid error response");
    if (pending.kind === "sensitive") {
      if (!hasSensitive || frame.sensitive === true) throw new RunnerError("sensitive_protocol", "Sensitive provider response was invalid");
      const result = decodeSensitiveEnvelope(frame.sensitive);
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      pending.resolve(result);
    } else if (hasSensitive) {
      throw new RunnerError("protocol_error", "Sensitive response used the ordinary result lane");
    } else if (frame.error) {
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      pending.reject(new RunnerError("extension_error", frame.error.message.slice(0, 4096)));
    } else {
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      pending.resolve(frame.result);
    }
  }
}
