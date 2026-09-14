import type { FactoryRunnerResult } from "@ezcorp/factory-sdk";
import { validateFactoryRunnerResult } from "@ezcorp/factory-sdk";
import type { FactoryPrivateRequest, FactoryPrivateResponse } from "../private-https";
import { factoryAttemptLaunchIntentFromWire, type FactoryAttemptLaunchIntent, type FactoryAttemptOpenDisposition } from "./attempt-runtime";

/** What a host reports about one physical attempt. It carries no tenant record. */
export interface FactoryHostAttemptHandle {
  readonly disposition: FactoryAttemptOpenDisposition;
  readonly workerId: string;
  readonly invocationId: string;
}

/**
 * The physical half of an attempt, and the only half a host owns.
 *
 * The durable launch intent, the journal, and the terminal record stay in the
 * product process; this interface is reached only over mutual TLS and only ever
 * starts, reconnects to, or reports on a guest.
 */
export interface FactoryHostLaunchSupervisor {
  launch(intent: FactoryAttemptLaunchIntent, signal: AbortSignal): Promise<FactoryHostAttemptHandle>;
  /**
   * Reconnects to a guest this host is already running. It takes the whole
   * intent rather than an id so a restarted host, which remembers nothing, can
   * still rebuild the worker and invocation identities it must reconnect to.
   */
  attach(intent: FactoryAttemptLaunchIntent, signal: AbortSignal): Promise<FactoryHostAttemptHandle>;
  /** Bounded: answers with the guest's canonical result, or refuses if none exists yet. */
  result(intent: FactoryAttemptLaunchIntent, signal: AbortSignal): Promise<FactoryRunnerResult>;
}

export interface FactoryHostLaunchServiceOptions {
  readonly hostId: string;
  /** mTLS peer identities allowed to drive attempts on this host. */
  readonly allowedPeers: readonly string[];
  readonly supervisor: FactoryHostLaunchSupervisor;
  readonly launchTimeoutMs?: number;
  readonly resultTimeoutMs?: number;
}

export const FACTORY_HOST_LAUNCH_PATH = "/v1/host/launches";
export const FACTORY_HOST_ATTACH_PATH = "/v1/host/attachments";
export const FACTORY_HOST_RESULT_PATH = "/v1/host/results";

class HostLaunchRouteError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); this.name = "HostLaunchRouteError"; }
}
function refuse(status: number, code: string): never { throw new HostLaunchRouteError(status, code); }

function json(status: number, value: unknown): FactoryPrivateResponse {
  return { status, body: Buffer.from(JSON.stringify(value)) };
}

/** A handle the host asserts must still name the worker and invocation it was asked about. */
function handle(value: FactoryHostAttemptHandle, expected: { workerId?: string; invocationId?: string }): FactoryHostAttemptHandle {
  if (!["started", "attached", "terminal", "uncertain"].includes(value.disposition)) refuse(500, "invalid_disposition");
  if (expected.workerId !== undefined && value.workerId !== expected.workerId) refuse(409, "conflict");
  if (expected.invocationId !== undefined && value.invocationId !== expected.invocationId) refuse(409, "conflict");
  return Object.freeze({ disposition: value.disposition, workerId: value.workerId, invocationId: value.invocationId });
}

/**
 * The authenticated host launch, attach, and result routes.
 *
 * Only the mutual-TLS peer identity authorizes a request, exactly as the host
 * stop route does; nothing in a body names its caller. A launch body carries a
 * complete intent whose derived identities are recomputed here, so a caller
 * cannot assert a worker, an invocation, or a device grant it did not earn.
 */
export function createFactoryHostLaunchRouteHandler(options: FactoryHostLaunchServiceOptions): (request: FactoryPrivateRequest) => Promise<FactoryPrivateResponse> {
  const snapshot = Object.freeze({
    hostId: options.hostId,
    peers: new Set(options.allowedPeers),
    supervisor: options.supervisor,
    launchTimeoutMs: options.launchTimeoutMs ?? 60_000,
    resultTimeoutMs: options.resultTimeoutMs ?? 120_000,
  });
  if (!snapshot.peers.size || !snapshot.hostId) throw new Error("Factory host launch service needs its own host and at least one authorized peer.");

  return async request => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!snapshot.peers.has(request.peerIdentity)) refuse(401, "unauthorized");
      if (request.headers["x-ezcorp-factory-version"] !== "1") refuse(400, "invalid_request");
      if (request.method !== "POST") refuse(404, "not_found");
      if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") refuse(400, "invalid_request");
      let body: unknown;
      try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(request.body)); }
      catch { refuse(400, "invalid_request"); }
      if (!body || typeof body !== "object" || Array.isArray(body)) refuse(400, "invalid_request");
      const fields = body as Record<string, unknown>;

      if (request.path === FACTORY_HOST_LAUNCH_PATH) {
        let intent: FactoryAttemptLaunchIntent;
        try { intent = factoryAttemptLaunchIntentFromWire(fields.intent); }
        catch { refuse(400, "invalid_intent"); }
        // A host runs only the attempts its own allocation holds.
        if (intent.lease.hostId !== snapshot.hostId) refuse(403, "forbidden_host");
        timer = setTimeout(() => controller.abort(), snapshot.launchTimeoutMs);
        const opened = await snapshot.supervisor.launch(intent, controller.signal);
        return json(200, handle(opened, { workerId: intent.workerId, invocationId: intent.invocationId }));
      }
      if (request.path === FACTORY_HOST_ATTACH_PATH || request.path === FACTORY_HOST_RESULT_PATH) {
        let intent: FactoryAttemptLaunchIntent;
        try { intent = factoryAttemptLaunchIntentFromWire(fields.intent); }
        catch { refuse(400, "invalid_intent"); }
        if (intent.lease.hostId !== snapshot.hostId) refuse(403, "forbidden_host");
        if (request.path === FACTORY_HOST_ATTACH_PATH) {
          timer = setTimeout(() => controller.abort(), snapshot.launchTimeoutMs);
          return json(200, handle(await snapshot.supervisor.attach(intent, controller.signal), { workerId: intent.workerId, invocationId: intent.invocationId }));
        }
        timer = setTimeout(() => controller.abort(), snapshot.resultTimeoutMs);
        const result = await snapshot.supervisor.result(intent, controller.signal);
        if (!validateFactoryRunnerResult(result).ok) refuse(500, "invalid_result");
        return json(200, { result });
      }
      refuse(404, "not_found");
    } catch (error) {
      if (error instanceof HostLaunchRouteError) return json(error.status, { error: error.code });
      const message = error instanceof Error ? error.message : "";
      if (controller.signal.aborted) return json(504, { error: "host_timeout" });
      if (message.includes("not running") || message.includes("uncertain")) return json(409, { error: "attempt_uncertain" });
      return json(500, { error: "host_failed" });
    } finally { if (timer) clearTimeout(timer); }
  };
}
