import { request } from "node:http";
import type { BuildRequest, BuildResult, Runner, RunnerCapabilities, RunnerExecution, RunnerInspection, StartRequest, WorkspaceFiles } from "@ezcorp/extension-contract";
import { RunnerError, RunnerStartRefusedError, safeHostError } from "./core";
import { MAX_SENSITIVE_RESULT_BYTES, SENSITIVE_PROVIDER_METHOD, SensitiveRunnerExecution, type ReverseRpc } from "./protocol";

type RunnerCall = <Value>(method: string, data: unknown) => Promise<Value>;

class RemoteRunnerExecution extends SensitiveRunnerExecution {
  private closed = false;
  private readonly listeners = new Set<(method: string, params: unknown) => void>();
  constructor(readonly workerId: string, private readonly call: RunnerCall, private readonly sensitiveCall: (workerId: string, params: unknown) => Promise<Uint8Array | null>, private readonly reverseRpc: ReverseRpc) {
    super();
    void this.poll().catch(() => { this.closed = true; });
  }
  private async poll(): Promise<void> {
    let recoveries = 0;
    while (!this.closed) {
      let events: { id?: string; method: string; params: unknown }[];
      try {
        ({ events } = await this.call<{ events: { id?: string; method: string; params: unknown }[] }>("events", { workerId: this.workerId }));
        recoveries = 0;
      } catch (error) {
        if (this.closed || recoveries >= MAX_STREAM_RECOVERIES) throw error;
        recoveries += 1;
        await this.call("attach", { workerId: this.workerId });
        continue;
      }
      for (const event of events) {
        if (this.closed) break;
        if (event.id) {
          let reply: { result: unknown } | { error: string };
          try { reply = { result: await this.reverseRpc(event.method, event.params) }; }
          catch (error) { reply = { error: safeHostError(error).code }; }
          // A stale reply does not cancel a worker whose attachment can resume.
          await this.call("reply", { workerId: this.workerId, id: event.id, ...reply }).catch(() => {});
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

/**
 * How many times in a row a host may take its own event stream back without a
 * poll succeeding in between. A worker that is really gone refuses the attach
 * and ends the loop on the first try; this bound only stops a service that
 * accepts an attach and then refuses every poll from spinning.
 */
const MAX_STREAM_RECOVERIES = 3;

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
            if (incoming.statusCode !== 200 || result.error) {
              if (method === "start" && result.error?.code === "runtime_profile_changed" && result.error?.workerStarted === false) reject(new RunnerStartRefusedError());
              else reject(new RunnerError(result.error?.code ?? "runner_failed", result.error?.message ?? "Runner request failed", result.error?.stage, result.error?.retryable));
            }
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
  /**
   * What the runner service enforces. A service from before `/v4/capabilities`
   * answers unknown_method: it enforces nothing optional, so that is reported
   * as such rather than as an error.
   */
  async capabilities(): Promise<RunnerCapabilities> {
    try { return { processSpawnEnforcement: (await this.call<Partial<RunnerCapabilities>>("capabilities", {})).processSpawnEnforcement === true }; }
    catch (error) { if (error instanceof RunnerError && error.code === "unknown_method") return { processSpawnEnforcement: false }; throw error; }
  }
  async start(input: StartRequest, reverseRpc: ReverseRpc): Promise<RunnerExecution> {
    await this.call("start", input);
    return this.attach(input, reverseRpc);
  }
  async attach(input: StartRequest, reverseRpc: ReverseRpc): Promise<RunnerExecution> {
    await this.call("attach", { workerId: input.workerId });
    return new RemoteRunnerExecution(input.workerId, this.call.bind(this), this.callSensitive.bind(this), reverseRpc);
  }
}
