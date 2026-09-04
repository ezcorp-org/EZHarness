import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { BuildRequest, Runner, RunnerExecution, StartRequest } from "@ezcorp/extension-contract";
import { validateResourceLimits, validateInvocationContext } from "@ezcorp/extension-contract";
import { identifier, processSpawn, RunnerError, validateFiles } from "./core";

type Event = { id?: string; method: string; params: unknown };
interface Session { execution: RunnerExecution; events: Event[]; pending: Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>; timer: ReturnType<typeof setTimeout>; wake?: () => void }
export interface RunnerServiceOptions { socketPath: string; token: string; runner: Runner; allowedUid: number; python?: string }

export async function startRunnerService(options: RunnerServiceOptions): Promise<{ close(): Promise<void> }> {
  if (Buffer.byteLength(options.token) < 32 || !Number.isSafeInteger(options.allowedUid) || options.allowedUid < 0) throw new RunnerError("service_config", "Runner requires a strong shared credential and exact peer UID");
  const directory = dirname(options.socketPath);
  await mkdir(directory, { recursive: true, mode: 0o750 });
  const status = await lstat(directory);
  if (status.isSymbolicLink() || !status.isDirectory() || (status.mode & 0o022) !== 0 || status.uid !== process.getuid?.()) throw new RunnerError("unsafe_socket", "Runner socket directory must be owned by runner and not writable by others");
  const privateDirectory = join(directory, `.private-${randomUUID()}`);
  await mkdir(privateDirectory, { mode: 0o700 });
  const privatePath = join(privateDirectory, "runner.sock");
  const sessions = new Map<string, Session>();
  let starting = 0;
  const server = createServer({ maxHeaderSize: 4096, requestTimeout: 360_000, headersTimeout: 5000 }, (request, response) => {
    void handle(request, response).catch(error => {
      if (!response.headersSent) send(response, 400, { error: (error instanceof RunnerError ? error : new RunnerError("invalid_request", "Runner request was invalid")).diagnostic() });
      else response.destroy();
    });
  });
  server.maxConnections = 32;
  const send = (response: ServerResponse, status: number, body: unknown) => {
    const json = JSON.stringify(body);
    if (Buffer.byteLength(json) > 180 * 1024 ** 2) throw new RunnerError("response_limit", "Runner response exceeds policy");
    response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(json) });
    response.end(json);
  };
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const authorization = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${options.token}`);
    if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) { send(response, 401, { error: { code: "unauthorized", message: "Runner authentication failed" } }); return; }
    if (request.method !== "POST" || request.headers["content-type"] !== "application/json") throw new RunnerError("invalid_request", "Use versioned JSON POST endpoints");
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) { bytes += chunk.length; if (bytes > 128 * 1024 ** 2) throw new RunnerError("request_limit", "Runner request exceeds policy"); chunks.push(Buffer.from(chunk)); }
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new RunnerError("invalid_request", "Expected object");
    switch (request.url) {
      case "/v4/build": {
        validateFiles(data.files);
        validateResourceLimits(data.limits);
        send(response, 200, await options.runner.build(data as BuildRequest));
        return;
      }
      case "/v4/start": {
        identifier(data.workerId);
        validateInvocationContext(data.context);
        validateResourceLimits(data.limits);
        if (sessions.size + starting >= 4 || sessions.has(data.workerId)) throw new RunnerError("runner_busy", "Worker session limit reached");
        const pending: Session["pending"] = new Map();
        const events: Event[] = [];
        starting++;
        const execution = await options.runner.start(data as StartRequest, (method, params) => new Promise((resolve, reject) => {
          const session = sessions.get(data.workerId);
          if (!session || pending.size >= 32 || events.length >= 32) { reject(new RunnerError("host_unavailable", "Host reverse RPC unavailable")); return; }
          const id = randomUUID();
          const timer = setTimeout(() => { pending.delete(id); reject(new RunnerError("host_timeout", "Host reverse RPC timed out")); }, Math.max(1, Math.min(60_000, data.context.deadline - Date.now())));
          pending.set(id, { resolve, reject, timer });
          events.push({ id, method, params });
          session.wake?.();
        })).finally(() => { starting--; });
        const timer = setTimeout(() => { void closeSession(data.workerId); }, Math.max(1, Math.min(data.limits.timeoutMs, data.context.deadline - Date.now())));
        const session: Session = { execution, pending, events, timer };
        sessions.set(data.workerId, session);
        execution.onNotification((method, params) => {
          if (events.length >= 32) { void closeSession(data.workerId); return; }
          events.push({ method, params });
          session.wake?.();
        });
        send(response, 200, { workerId: data.workerId });
        return;
      }
      case "/v4/request": {
        const session = sessions.get(identifier(data.workerId));
        if (!session || typeof data.method !== "string" || data.method.length > 128) throw new RunnerError("unknown_worker", "Worker is unavailable");
        send(response, 200, { result: await session.execution.request(data.method, data.params) });
        return;
      }
      case "/v4/events": {
        const session = sessions.get(identifier(data.workerId));
        if (!session || session.wake) throw new RunnerError("unknown_worker", "Worker event stream is unavailable or already attached");
        if (session.events.length === 0) await new Promise<void>(resolve => {
          const timer = setTimeout(finish, 20_000);
          function finish() { clearTimeout(timer); session!.wake = undefined; response.off("close", finish); resolve(); }
          session.wake = finish;
          response.once("close", finish);
        });
        send(response, 200, { events: session.events.splice(0) });
        return;
      }
      case "/v4/reply": {
        const session = sessions.get(identifier(data.workerId));
        const pending = session?.pending.get(data.id);
        if (!pending) throw new RunnerError("unknown_request", "Host reply ID is stale or invalid");
        clearTimeout(pending.timer);
        session?.pending.delete(data.id);
        if (data.error) pending.reject(new RunnerError("host_denied", "Host capability denied")); else pending.resolve(data.result);
        send(response, 200, {});
        return;
      }
      case "/v4/cancel": await closeSession(identifier(data.id)); await options.runner.cancel(data.id); send(response, 200, {}); return;
      case "/v4/inspect": send(response, 200, await options.runner.inspect(identifier(data.id))); return;
      case "/v4/artifacts": send(response, 200, { files: await options.runner.collectArtifacts(data.artifactDigest) }); return;
      default: send(response, 404, { error: { code: "unknown_method", message: "Unknown runner endpoint" } });
    }
  }
  async function closeSession(id: string): Promise<void> {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    clearTimeout(session.timer);
    session.wake?.();
    for (const pending of session.pending.values()) { clearTimeout(pending.timer); pending.reject(new RunnerError("cancelled", "Worker session closed")); }
    await session.execution.close();
  }
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(privatePath, resolve); });
  await chmod(privatePath, 0o600);
  const gateway = processSpawn(options.python ?? "python3", [new URL("./peer-gateway.py", import.meta.url).pathname, options.socketPath, privatePath, String(options.allowedUid)]);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new RunnerError("peer_gateway_failed", "Unix peer identity gateway did not start")), 5000);
      gateway.stdout.once("data", chunk => { clearTimeout(timer); if (chunk.toString().trim() === "READY") resolve(); else reject(new RunnerError("peer_gateway_failed", "Invalid peer gateway startup")); });
      gateway.once("error", error => { clearTimeout(timer); reject(error); });
      gateway.once("exit", () => { clearTimeout(timer); reject(new RunnerError("peer_gateway_failed", "Unix peer gateway exited")); });
    });
  } catch (error) { gateway.kill(); server.close(); await rm(privateDirectory, { recursive: true, force: true }); throw error; }
  return { async close() {
    gateway.kill("SIGTERM");
    await Promise.all([...sessions.keys()].map(closeSession));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(options.socketPath, { force: true });
    await rm(privateDirectory, { recursive: true, force: true });
  } };
}
