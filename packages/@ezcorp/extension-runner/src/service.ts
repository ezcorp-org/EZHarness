import { chmod, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { BuildRequest, Runner, RunnerExecution, StartRequest } from "@ezcorp/extension-contract";
import { validateResourceLimits, validateInvocationContext } from "@ezcorp/extension-contract";
import { identifier, processSpawn, RunnerError, validateFiles, safeHostError } from "./core";

type Event = { id?: string; method: string; params: unknown };
/**
 * One decoded request body. It arrives from an untrusted peer, so it carries no
 * static shape: every endpoint validates the exact fields it reads.
 */
type RunnerRequestBody = ReturnType<typeof JSON.parse>;
interface Session { execution: RunnerExecution; events: Event[]; pending: Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>; timer: ReturnType<typeof setTimeout>; wake?: () => void; attached: boolean; lease?: ReturnType<typeof setTimeout> }
export interface RunnerServiceOptions { socketPath: string; token: string; runner: Runner; allowedUid: number; python?: string; eventPollTimeoutMs?: number; attachmentLeaseMs?: number }
export interface RunnerService {
  close(): Promise<void>;
  /** Worker IDs whose event stream a host holds right now. Observation only; no endpoint exposes it. */
  attachments(): string[];
}

/** One parked event-stream poll answers within this window even when nothing happens. */
const DEFAULT_EVENT_POLL_TIMEOUT_MS = 20_000;
const MINIMUM_EVENT_POLL_TIMEOUT_MS = 100;
const MAXIMUM_EVENT_POLL_TIMEOUT_MS = 300_000;
/**
 * A host holds its attachment under a lease that every event-stream poll
 * renews. Measured on Bun 1.3.14: `Request.signal` aborts within ~10 ms when a
 * host drops the connection, which releases the attachment at once. The lease
 * bounds the one form Bun reports nothing for, a client that half-closes its
 * socket and never collects its stream again. A lease no longer than one poll
 * would evict a healthy host mid-poll, so the two settings are checked
 * together.
 */
const DEFAULT_ATTACHMENT_LEASE_MS = 30_000;
const MAXIMUM_ATTACHMENT_LEASE_MS = 600_000;
/** Request and response policy. Bun.serve carries no header option, so this file holds it. */
const MAXIMUM_HEADER_BYTES = 4096;
const MAXIMUM_REQUEST_BYTES = 128 * 1024 ** 2;
const MAXIMUM_RESPONSE_BYTES = 180 * 1024 ** 2;

/** Read one bounded JSON object body. A stream over the policy limit is refused mid-flight. */
async function readRequestBody(request: Request): Promise<RunnerRequestBody> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = request.body?.getReader();
  while (reader) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > MAXIMUM_REQUEST_BYTES) { await reader.cancel(); throw new RunnerError("request_limit", "Runner request exceeds policy"); }
    chunks.push(chunk.value);
  }
  const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new RunnerError("invalid_request", "Expected object");
  return data;
}

/** One bounded JSON answer. */
function respond(status: number, body: unknown): Response {
  const json = JSON.stringify(body);
  if (Buffer.byteLength(json) > MAXIMUM_RESPONSE_BYTES) throw new RunnerError("response_limit", "Runner response exceeds policy");
  return new Response(json, { status, headers: { "content-type": "application/json" } });
}

/** Release one host attachment. The worker keeps running and keeps every queued event. */
function releaseAttachment(session: Session): void {
  clearTimeout(session.lease);
  session.lease = undefined;
  session.attached = false;
  const wake = session.wake;
  session.wake = undefined;
  wake?.();
}

/**
 * Park one event-stream poll until an event arrives, the long poll expires, or
 * the runtime reports that the host dropped the stream. The abort listener is
 * the signal Bun actually delivers; nothing here polls for a disconnect.
 */
function parkEventStream(session: Session, signal: AbortSignal, pollTimeoutMs: number): Promise<void> {
  return new Promise<void>(resolve => {
    const settle = (released: boolean) => { clearTimeout(timer); signal.removeEventListener("abort", dropped); session.wake = undefined; if (released) releaseAttachment(session); resolve(); };
    const dropped = () => settle(true);
    const timer = setTimeout(() => settle(false), pollTimeoutMs);
    session.wake = () => settle(false);
    if (signal.aborted) dropped(); else signal.addEventListener("abort", dropped);
  });
}

export async function startRunnerService(options: RunnerServiceOptions): Promise<RunnerService> {
  if (Buffer.byteLength(options.token) < 32 || !Number.isSafeInteger(options.allowedUid) || options.allowedUid < 0) throw new RunnerError("service_config", "Runner requires a strong shared credential and exact peer UID");
  const eventPollTimeoutMs = options.eventPollTimeoutMs ?? DEFAULT_EVENT_POLL_TIMEOUT_MS;
  if (!Number.isSafeInteger(eventPollTimeoutMs) || eventPollTimeoutMs < MINIMUM_EVENT_POLL_TIMEOUT_MS || eventPollTimeoutMs > MAXIMUM_EVENT_POLL_TIMEOUT_MS) throw new RunnerError("event_poll_window", "Runner event poll window must be between 100 milliseconds and five minutes");
  const attachmentLeaseMs = options.attachmentLeaseMs ?? DEFAULT_ATTACHMENT_LEASE_MS;
  if (!Number.isSafeInteger(attachmentLeaseMs) || attachmentLeaseMs <= eventPollTimeoutMs || attachmentLeaseMs > MAXIMUM_ATTACHMENT_LEASE_MS) throw new RunnerError("attachment_lease", "Runner attachment lease must outlast one event poll and stay under ten minutes");
  const directory = dirname(options.socketPath);
  await mkdir(directory, { recursive: true, mode: 0o750 });
  const status = await lstat(directory);
  if (status.isSymbolicLink() || !status.isDirectory() || (status.mode & 0o022) !== 0 || status.uid !== process.getuid?.()) throw new RunnerError("unsafe_socket", "Runner socket directory must be owned by runner and not writable by others");
  // The public socket can live in a service-specific nested directory. Keep
  // the upstream socket short: Unix-domain socket paths have a small fixed
  // byte limit, and the UUID directory below the public path can exceed it.
  const privateDirectory = await mkdtemp("/tmp/ez-runner-");
  // mkdtemp is atomic and creates a new owner-only directory.
  const privatePath = join(privateDirectory, "runner.sock");
  const sessions = new Map<string, Session>();
  let starting = 0;
  /** Take the one host attachment for this worker and arm its lease. */
  function attachHost(session: Session): void { session.attached = true; renewAttachment(session); }
  /** Renew the attachment lease. Every event-stream poll renews it, so a host that stops collecting is released within one lease. */
  function renewAttachment(session: Session): void { clearTimeout(session.lease); session.lease = setTimeout(() => releaseAttachment(session), attachmentLeaseMs); }
  /** Open one worker session and wire its reverse-RPC and notification queues. */
  async function startSession(data: RunnerRequestBody): Promise<Response> {
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
    const session: Session = { execution, pending, events, timer, attached: false };
    sessions.set(data.workerId, session);
    execution.onNotification((method, params) => {
      if (events.length >= 32) { void closeSession(data.workerId); return; }
      events.push({ method, params });
      session.wake?.();
    });
    return respond(200, { workerId: data.workerId });
  }

  /** Settle one reverse call and retire the queued event that carried it. */
  function replyToHost(data: RunnerRequestBody): Response {
    const session = sessions.get(identifier(data.workerId));
    const pending = session?.pending.get(data.id);
    if (!pending) throw new RunnerError("unknown_request", "Host reply ID is stale or invalid");
    clearTimeout(pending.timer);
    session?.pending.delete(data.id);
    const eventIndex = session?.events.findIndex(event => event.id === data.id) ?? -1;
    if (eventIndex >= 0) session!.events.splice(eventIndex, 1);
    if (data.error) { const safe = safeHostError({ code: data.error }); pending.reject(new RunnerError(safe.code, safe.message)); } else pending.resolve(data.result);
    return respond(200, {});
  }

  /** Serve one event-stream poll, holding the attachment only while the host is still collecting it. */
  async function collectEvents(request: Request, data: RunnerRequestBody): Promise<Response> {
    const session = sessions.get(identifier(data.workerId));
    if (!session?.attached || session.wake) throw new RunnerError("unknown_worker", "Worker event stream is unavailable or already attached");
    renewAttachment(session);
    if (session.events.length === 0) await parkEventStream(session, request.signal, eventPollTimeoutMs);
    // A released attachment answers nothing and keeps every queued event, so a
    // replacement host resumes the reverse calls AND the notifications.
    if (!session.attached) throw new RunnerError("unknown_worker", "Worker event stream is unavailable or already attached");
    // Reverse calls stay queued until their matching reply is accepted.
    // A replacement client can therefore resume after a dropped poll.
    const events = session.events.filter(event => event.id !== undefined);
    const notifications = session.events.filter(event => event.id === undefined);
    session.events.splice(0, session.events.length, ...events);
    return respond(200, { events: [...events, ...notifications] });
  }

  /** Route one authenticated request to the endpoint that owns it. */
  async function dispatch(request: Request, data: RunnerRequestBody): Promise<Response> {
    switch (new URL(request.url).pathname) {
      case "/v4/build": {
        validateFiles(data.files);
        validateResourceLimits(data.limits);
        return respond(200, await options.runner.build(data as BuildRequest));
      }
      case "/v4/start": return startSession(data);
      case "/v4/request": {
        const session = sessions.get(identifier(data.workerId));
        if (!session || typeof data.method !== "string" || data.method.length > 128) throw new RunnerError("unknown_worker", "Worker is unavailable");
        return respond(200, { result: await session.execution.request(data.method, data.params) });
      }
      case "/v4/events": return collectEvents(request, data);
      case "/v4/attach": {
        const session = sessions.get(identifier(data.workerId));
        if (!session || session.attached) throw new RunnerError("unknown_worker", "Worker is unavailable or already attached");
        attachHost(session);
        return respond(200, { workerId: data.workerId });
      }
      case "/v4/reply": return replyToHost(data);
      case "/v4/cancel": await closeSession(identifier(data.id)); await options.runner.cancel(data.id); return respond(200, {});
      case "/v4/inspect": return respond(200, await options.runner.inspect(identifier(data.id)));
      case "/v4/artifacts": return respond(200, { files: await options.runner.collectArtifacts(data.artifactDigest) });
      default: return respond(404, { error: { code: "unknown_method", message: "Unknown runner endpoint" } });
    }
  }

  async function handle(request: Request): Promise<Response> {
    let headerBytes = 0;
    request.headers.forEach((value, name) => { headerBytes += name.length + value.length + 4; });
    if (headerBytes > MAXIMUM_HEADER_BYTES) throw new RunnerError("request_limit", "Runner request headers exceed policy");
    const authorization = Buffer.from(request.headers.get("authorization") ?? "");
    const expected = Buffer.from(`Bearer ${options.token}`);
    if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) return respond(401, { error: { code: "unauthorized", message: "Runner authentication failed" } });
    if (request.method !== "POST" || request.headers.get("content-type") !== "application/json") throw new RunnerError("invalid_request", "Use versioned JSON POST endpoints");
    return dispatch(request, await readRequestBody(request));
  }
  async function closeSession(id: string): Promise<void> {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    clearTimeout(session.timer);
    clearTimeout(session.lease);
    session.wake?.();
    for (const pending of session.pending.values()) { clearTimeout(pending.timer); pending.reject(new RunnerError("cancelled", "Worker session closed")); }
    await session.execution.close();
  }
  let cleanupGateway: ReturnType<typeof processSpawn> | undefined;
  let listener: ReturnType<typeof Bun.serve> | undefined;
  try {
    // Bun.serve, not node:http: measured on Bun 1.3.14, a node:http server
    // raises no close, no abort and no socket event when a client drops a
    // parked response, and writes into the dead connection keep succeeding.
    // `Request.signal` is the one disconnect this runtime reports.
    listener = Bun.serve({
      unix: privatePath,
      // The policy bound lives in readRequestBody so an oversized body is
      // refused with the runner's own typed diagnostic; this is the backstop.
      maxRequestBodySize: MAXIMUM_REQUEST_BYTES + 1024 ** 2,
      // Bun's unix listener takes no idle timeout. The slow-client bound stays
      // where the untrusted peer connects: peer-gateway.py times out every
      // relay read at 360 s and admits at most 32 connections.
      fetch: request => handle(request).catch(error => respond(400, { error: (error instanceof RunnerError ? error : new RunnerError("invalid_request", "Runner request was invalid")).diagnostic() })),
    });
    await chmod(privatePath, 0o600);
    const gateway = processSpawn(options.python ?? "python3", [new URL("./peer-gateway.py", import.meta.url).pathname, options.socketPath, privatePath, String(options.allowedUid)]);
    cleanupGateway = gateway;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new RunnerError("peer_gateway_failed", "Unix peer identity gateway did not start")), 5000);
      gateway.stdout.once("data", chunk => { clearTimeout(timer); if (chunk.toString().trim() === "READY") resolve(); else reject(new RunnerError("peer_gateway_failed", "Invalid peer gateway startup")); });
      gateway.once("error", error => { clearTimeout(timer); reject(error); });
      gateway.once("exit", () => { clearTimeout(timer); reject(new RunnerError("peer_gateway_failed", "Unix peer gateway exited")); });
    });
    const started = listener;
    return {
      async close() {
        gateway.kill("SIGTERM");
        await Promise.all([...sessions.keys()].map(closeSession));
        await started.stop(true);
        await rm(options.socketPath, { force: true });
        await rm(privateDirectory, { recursive: true, force: true });
      },
      attachments: () => [...sessions].filter(([, session]) => session.attached).map(([workerId]) => workerId),
    };
  } catch (error) {
    cleanupGateway?.kill("SIGTERM");
    await listener?.stop(true);
    // Before READY, the public path may belong to an active service that the
    // gateway refused to replace. Only the private upstream is ours to remove.
    await rm(privateDirectory, { recursive: true, force: true });
    throw error;
  }
}
