import type { FactoryRunnerResult } from "@ezcorp/factory-sdk";
import { validateFactoryRunnerResult } from "@ezcorp/factory-sdk";
import type { FactoryPrivateRequest, FactoryPrivateResponse } from "../private-https";
import { FactoryAttemptRuntimeError, factoryAttemptLaunchIntentFromWire, type FactoryAttemptLaunchIntent, type FactoryAttemptOpenDisposition } from "./attempt-wire";
import { FACTORY_HOST_FORBIDDEN_TENANT, factoryHostPeerTenantLookup, type FactoryHostGuestTenants, type FactoryHostPeerTenants } from "./host-peer-tenants";

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
  /**
   * Bounded by `signal`: answers with the guest's canonical result, throws a
   * `guest_exited` or `attempt_unknown` {@link FactoryAttemptRuntimeError} when
   * there will never be one, and otherwise returns when `signal` ends the wait.
   */
  result(intent: FactoryAttemptLaunchIntent, signal: AbortSignal): Promise<FactoryRunnerResult>;
}

/** One line in the host's own log for a request it could not answer with a result. */
export interface FactoryHostLaunchReport {
  readonly path: string;
  readonly status: number;
  readonly error: string;
  readonly detail: string;
  readonly attemptId?: string;
  readonly workerId?: string;
}

export interface FactoryHostLaunchServiceOptions {
  readonly hostId: string;
  /** Each mTLS peer allowed to drive attempts on this host, bound to the one tenant it acts for. */
  readonly peerTenants: FactoryHostPeerTenants;
  readonly supervisor: FactoryHostLaunchSupervisor;
  /** Where the tenant of each guest a peer launched or reattached is recorded, for the stop route. */
  readonly guestTenants?: FactoryHostGuestTenants;
  readonly launchTimeoutMs?: number;
  readonly resultTimeoutMs?: number;
  /** Where every refusal is written. Absent, it is the process's standard error, which is the supervisor log. */
  readonly report?: (entry: FactoryHostLaunchReport) => void;
}

/** How long the host may take to start or reattach a guest. */
export const FACTORY_HOST_LAUNCH_TIMEOUT_MS = 60_000;

/**
 * How long one result request waits for a guest that is still running.
 *
 * It is a long-poll window, not the attempt's deadline: the host answers
 * `host_timeout` when it passes and the product asks again. It must stay well
 * inside the product's own request timeout, so the host always answers before
 * the caller gives up on the call.
 */
export const FACTORY_HOST_RESULT_WINDOW_MS = 20_000;

function standardErrorReport(entry: FactoryHostLaunchReport): void {
  console.error(`[factory-host-launch] ${JSON.stringify(entry)}`);
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
 * The intent's tenant must be the one the peer is bound to (W01i): otherwise
 * the request is refused `403 forbidden_tenant` before the supervisor is
 * called, so another tenant's guest is never started, reattached, or read.
 */
export function createFactoryHostLaunchRouteHandler(options: FactoryHostLaunchServiceOptions): (request: FactoryPrivateRequest) => Promise<FactoryPrivateResponse> {
  const snapshot = Object.freeze({
    hostId: options.hostId,
    peers: factoryHostPeerTenantLookup(options.peerTenants),
    supervisor: options.supervisor,
    guestTenants: options.guestTenants,
    launchTimeoutMs: options.launchTimeoutMs ?? FACTORY_HOST_LAUNCH_TIMEOUT_MS,
    resultTimeoutMs: options.resultTimeoutMs ?? FACTORY_HOST_RESULT_WINDOW_MS,
    report: options.report ?? standardErrorReport,
  });
  if (!snapshot.hostId) throw new Error("Factory host launch service needs its own host and at least one authorized peer.");

  return async request => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let intent: FactoryAttemptLaunchIntent | undefined;
    const refused = (status: number, error: string, detail: string): FactoryPrivateResponse => {
      // A result window that closed on a running guest is the long poll working, not a fault.
      if (!(status === 504 && request.path === FACTORY_HOST_RESULT_PATH)) {
        snapshot.report(Object.freeze({ path: request.path, status, error, detail, ...(intent ? { attemptId: intent.request.authority.attemptId, workerId: intent.workerId } : {}) }));
      }
      return json(status, status === 502 ? { error, detail } : { error });
    };
    try {
      const peerTenant = snapshot.peers.get(request.peerIdentity);
      if (peerTenant === undefined) refuse(401, "unauthorized");
      if (request.headers["x-ezcorp-factory-version"] !== "1") refuse(400, "invalid_request");
      if (request.method !== "POST") refuse(404, "not_found");
      if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") refuse(400, "invalid_request");
      let body: unknown;
      try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(request.body)); }
      catch { refuse(400, "invalid_request"); }
      if (!body || typeof body !== "object" || Array.isArray(body)) refuse(400, "invalid_request");
      const fields = body as Record<string, unknown>;
      if (request.path !== FACTORY_HOST_LAUNCH_PATH && request.path !== FACTORY_HOST_ATTACH_PATH && request.path !== FACTORY_HOST_RESULT_PATH) refuse(404, "not_found");
      try { intent = factoryAttemptLaunchIntentFromWire(fields.intent); }
      catch { refuse(400, "invalid_intent"); }
      // A host runs only the attempts its own allocation holds.
      if (intent.lease.hostId !== snapshot.hostId) refuse(403, "forbidden_host");
      // And only for the tenant the calling peer acts for, before anything is started or read.
      if (intent.request.authority.tenantId !== peerTenant) refuse(403, FACTORY_HOST_FORBIDDEN_TENANT);
      snapshot.guestTenants?.record(intent.workerId, peerTenant);

      if (request.path === FACTORY_HOST_LAUNCH_PATH) {
        timer = setTimeout(() => controller.abort(), snapshot.launchTimeoutMs);
        const opened = await snapshot.supervisor.launch(intent, controller.signal);
        return json(200, handle(opened, { workerId: intent.workerId, invocationId: intent.invocationId }));
      }
      if (request.path === FACTORY_HOST_ATTACH_PATH) {
        timer = setTimeout(() => controller.abort(), snapshot.launchTimeoutMs);
        return json(200, handle(await snapshot.supervisor.attach(intent, controller.signal), { workerId: intent.workerId, invocationId: intent.invocationId }));
      }
      timer = setTimeout(() => controller.abort(), snapshot.resultTimeoutMs);
      const result = await snapshot.supervisor.result(intent, controller.signal);
      if (!validateFactoryRunnerResult(result).ok) refuse(500, "invalid_result");
      return json(200, { result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof HostLaunchRouteError) return refused(error.status, error.code, message);
      if (controller.signal.aborted) return refused(504, "host_timeout", message);
      const code = error instanceof FactoryAttemptRuntimeError ? error.code : undefined;
      // The guest ran here and ended without an answer: the detail is the runner's own account of it.
      if (code === "guest_exited") return refused(502, "guest_exited", message);
      if (code === "attempt_unknown" || message.includes("not running") || message.includes("uncertain")) return refused(409, "attempt_uncertain", message);
      return refused(500, "host_failed", message);
    } finally { if (timer) clearTimeout(timer); }
  };
}
