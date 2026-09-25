import { request } from "node:http";
import type { BuildRequest, BuildResult, Runner, RunnerExecution, RunnerInspection, StartRequest, WorkspaceFiles } from "@ezcorp/extension-contract";
import { RunnerError, safeHostError } from "./core";
import { MAX_SENSITIVE_RESULT_BYTES, SENSITIVE_PROVIDER_METHOD, SensitiveRunnerExecution, type ReverseRpc } from "./protocol";

type RunnerCall = <Value>(method: string, data: unknown) => Promise<Value>;

class RemoteRunnerExecution extends SensitiveRunnerExecution {
  private closed = false;
  private readonly listeners = new Set<(method: string, params: unknown) => void>();
  constructor(readonly workerId: string, private readonly call: RunnerCall, private readonly sensitiveCall: (workerId: string, params: unknown) => Promise<Uint8Array | null>, private readonly reverseRpc: ReverseRpc) {
    super();
    void this.poll().catch(() => { this.closed = true; void this.call("cancel", { id: this.workerId }).catch(() => {}); });
  }
  private async poll(): Promise<void> {
    while (!this.closed) {
      const { events } = await this.call<{ events: { id?: string; method: string; params: unknown }[] }>("events", { workerId: this.workerId });
      for (const event of events) {
        if (this.closed) break;
        if (event.id) {
          void this.reverseRpc(event.method, event.params).then(result => this.call("reply", { workerId: this.workerId, id: event.id, result }), error => this.call("reply", { workerId: this.workerId, id: event.id, error: safeHostError(error).code })).catch(() => { this.closed = true; void this.call("cancel", { id: this.workerId }).catch(() => {}); });
        } else for (const listener of this.listeners) listener(event.method, event.params);
      }
    }
  }
  async request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) throw new RunnerError("worker_closed", "Worker session closed");
    if (method === SENSITIVE_PROVIDER_METHOD) throw new RunnerError("sensitive_method", "Sensitive provider methods require the credential broker");
    return (await this.call<{ result: unknown }>("request", { workerId: this.workerId, method, params })).result;
  }
  requestSensitiveProviderResult(params: unknown): Promise<Uint8Array | null> {
    if (this.closed) return Promise.reject(new RunnerError("worker_closed", "Worker session closed"));
    return this.sensitiveCall(this.workerId, params);
  }
  async close(): Promise<void> { this.closed = true; this.listeners.clear(); await this.call("cancel", { id: this.workerId }); }
  onNotification(listener: (method: string, params: unknown) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
}

export class RunnerClient implements Runner {
  constructor(private readonly options: { socketPath: string; token: string }) {}
  private call<Value>(method: string, data: unknown): Promise<Value> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(data);
      const outgoing = request({ socketPath: this.options.socketPath, path: `/v4/${method}`, method: "POST", headers: { authorization: `Bearer ${this.options.token}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) }, timeout: 360_000 }, incoming => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        incoming.on("data", (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes > 180 * 1024 ** 2) incoming.destroy(new RunnerError("response_limit", "Runner response exceeded policy")); else chunks.push(chunk); });
        incoming.on("error", reject);
        incoming.on("end", () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (incoming.statusCode !== 200 || result.error) reject(new RunnerError(result.error?.code ?? "runner_failed", result.error?.message ?? "Runner request failed", result.error?.stage, result.error?.retryable));
            else resolve(result);
          } catch { reject(new RunnerError("runner_protocol", "Runner returned invalid JSON")); }
        });
      });
      outgoing.on("error", reject);
      outgoing.on("timeout", () => outgoing.destroy(new RunnerError("runner_timeout", "Runner request timed out")));
      outgoing.end(body);
    });
  }
  private callSensitive(workerId: string, params: unknown): Promise<Uint8Array | null> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ workerId, params });
      const chunks: Buffer[] = [];
      let settled = false;
      const clear = () => { for (const chunk of chunks) chunk.fill(0); chunks.length = 0; };
      const fail = () => {
        if (settled) return;
        settled = true;
        clear();
        reject(new RunnerError("sensitive_failed", "Sensitive provider request failed"));
      };
      const outgoing = request({ socketPath: this.options.socketPath, path: "/v4/sensitive-request", method: "POST", headers: { authorization: `Bearer ${this.options.token}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) }, timeout: 65_000 }, incoming => {
        let bytes = 0;
        incoming.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > MAX_SENSITIVE_RESULT_BYTES) { chunk.fill(0); incoming.destroy(); fail(); }
          else chunks.push(chunk);
        });
        incoming.on("error", fail);
        incoming.on("aborted", fail);
        incoming.on("end", () => {
          if (settled) return;
          if (incoming.statusCode === 204 && bytes === 0) { settled = true; resolve(null); return; }
          if (incoming.statusCode !== 200 || incoming.headers["content-type"] !== "application/octet-stream" || bytes === 0) { fail(); return; }
          const result = Buffer.concat(chunks);
          settled = true;
          clear();
          resolve(result);
        });
      });
      outgoing.on("error", fail);
      outgoing.on("timeout", () => { outgoing.destroy(); fail(); });
      outgoing.end(body);
    });
  }
  build(input: BuildRequest): Promise<BuildResult> { return this.call("build", input); }
  inspect(id: string): Promise<RunnerInspection> { return this.call("inspect", { id }); }
  cancel(id: string): Promise<void> { return this.call("cancel", { id }); }
  async collectArtifacts(artifactDigest: string): Promise<WorkspaceFiles> { return (await this.call<{ files: WorkspaceFiles }>("artifacts", { artifactDigest })).files; }
  async start(input: StartRequest, reverseRpc: ReverseRpc): Promise<RunnerExecution> {
    await this.call("start", input);
    return new RemoteRunnerExecution(input.workerId, this.call.bind(this), this.callSensitive.bind(this), reverseRpc);
  }
}
