import type { FactoryPrivateRequest, FactoryPrivateResponse } from "../private-https";
import { POOL_QUEUE_FULL_HTTP_STATUS, POOL_QUEUE_FULL_REASON, type PoolDecision } from "./ledger";
import { authenticatePoolPrincipal, type PoolAdmissionIdentityConfig, type PoolAdmissionRequest, type PoolAdmissionService, type PoolLeaseFenceInput, type PoolReimageInput, type PoolStopInput } from "./service";
import type { PoolTokenVerifierOptions } from "./service-token";
import { decodeReservationPath, encodeWireJson, parseWireJson, POOL_HTTP_BYTES_LIMIT, wireCounter, wireExact, wireIsoDate, wireRecord, wireResources, wireText } from "./wire";

export interface PoolAdmissionRouteOptions {
  readonly identities: PoolAdmissionIdentityConfig;
  readonly tokens: PoolTokenVerifierOptions;
  readonly service: PoolAdmissionService;
}

class PoolRouteError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

function fail(status: number, code: string): never { throw new PoolRouteError(status, code); }
function json(status: number, value: unknown): FactoryPrivateResponse { return { status, body: encodeWireJson(value) }; }
function empty(): FactoryPrivateResponse { return { status: 204, body: Buffer.alloc(0) }; }

/**
 * C03 rejects a new start with 429 when the outstanding-request queue is full.
 * The retry interval travels in the decision body: `FactoryPrivateResponse`
 * carries no response headers, so this handler cannot emit `Retry-After` yet.
 * `docs/factory-pool-admission.md` records the change W09 must make to
 * `src/factory/private-https.ts` for the header itself.
 */
function decision(value: PoolDecision): FactoryPrivateResponse {
  return json(value.status === "rejected" && value.reason === POOL_QUEUE_FULL_REASON ? POOL_QUEUE_FULL_HTTP_STATUS : 200, value);
}

function authorization(request: FactoryPrivateRequest, options: PoolAdmissionRouteOptions) {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ") || value.length <= 7) fail(401, "unauthorized");
  try { return authenticatePoolPrincipal(request.peerIdentity, value.slice(7), options.identities, options.tokens); }
  catch { fail(401, "unauthorized"); }
}

function payload(request: FactoryPrivateRequest, allowed: readonly string[]): Record<string, unknown> {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") fail(400, "invalid_request");
  let result: Record<string, unknown>;
  try { result = wireRecord(parseWireJson(request.body, "request body"), "request body"); wireExact(result, allowed, "request body"); }
  catch { fail(400, "invalid_request"); }
  return result;
}

function requestInput(value: Record<string, unknown>): PoolAdmissionRequest {
  return {
    reservationId: wireText(value.reservationId, "reservation id"),
    grantRevision: wireCounter(value.grantRevision, "grant revision", 1),
    grantScope: wireText(value.grantScope, "grant scope"),
    resources: wireResources(value.resources),
    admissionDeadline: wireIsoDate(value.admissionDeadline, "admission deadline").toISOString(),
    ...(value.priority === undefined ? {} : { priority: wireCounter(value.priority, "priority") }),
    ...(value.readySequence === undefined ? {} : { readySequence: wireCounter(value.readySequence, "ready sequence") }),
    ...(value.nodeId === undefined ? {} : { nodeId: wireText(value.nodeId, "node id") }),
  };
}

function fence(value: Record<string, unknown>, reservationId: string): PoolLeaseFenceInput {
  return { reservationId, grantRevision: wireCounter(value.grantRevision, "grant revision", 1), allocationGeneration: wireCounter(value.allocationGeneration, "allocation generation", 1), allocationToken: wireText(value.allocationToken, "allocation token") };
}

function reservation(value: string): string {
  try { return decodeReservationPath(value); }
  catch { fail(400, "invalid_request"); }
}

function serviceError(error: unknown): FactoryPrivateResponse {
  if (error instanceof PoolRouteError) return json(error.status, { error: error.code });
  const message = error instanceof Error ? error.message : "";
  if (message.includes("malformed") || message.includes("expired") || message.includes("unsupported") || message.includes("empty")) return json(400, { error: "invalid_request" });
  if (message.includes("conflict") || message.includes("fenced") || message.includes("stale") || message.includes("cannot")) return json(409, { error: "conflict" });
  if (message.includes("does not exist")) return json(404, { error: "not_found" });
  if (message.includes("scope") || message.includes("owned") || message.includes("authorized") || message.includes("requires a tenant") || message.includes("requires a supervisor")) return json(403, { error: "forbidden" });
  return json(500, { error: "request_failed" });
}

/** The principal `authenticatePoolPrincipal` proves from the peer identity and the bearer token. */
type PoolPrincipal = ReturnType<typeof authenticatePoolPrincipal>;

/**
 * One action on an existing reservation, or `undefined` when the last path segment names none.
 *
 * Returning `undefined` rather than a 404 keeps the not-found answer in one place: an unknown
 * action under a known prefix is not found for the same reason an unknown prefix is.
 */
async function reservationAction(service: PoolAdmissionService, request: FactoryPrivateRequest, principal: PoolPrincipal, parts: readonly string[]): Promise<FactoryPrivateResponse | undefined> {
  const reservationId = reservation(parts[3]!);
  if (parts[4] === "acknowledge-start" || parts[4] === "renew") {
    const body = payload(request, ["grantRevision", "allocationGeneration", "allocationToken"]);
    const input = fence(body, reservationId);
    return json(200, parts[4] === "acknowledge-start" ? await service.acknowledgeStart(principal, input) : await service.renew(principal, input));
  }
  if (parts[4] === "confirm-stopped") {
    const body = payload(request, ["holderGeneration", "hostId"]);
    return json(200, await service.acknowledgeStopped(principal, { reservationId, holderGeneration: wireCounter(body.holderGeneration, "holder generation", 1), hostId: wireText(body.hostId, "host id") }));
  }
  if (parts[4] === "cancel") {
    const body = payload(request, ["allocationGeneration"]);
    return json(200, await service.cancel(principal, reservationId, wireCounter(body.allocationGeneration, "allocation generation", 1)));
  }
  return undefined;
}

/** A supervisor's stop confirmation, with the reimage receipt when the path asks for one. */
async function supervisorConfirmation(service: PoolAdmissionService, request: FactoryPrivateRequest, principal: PoolPrincipal, url: URL): Promise<FactoryPrivateResponse> {
  const reimage = url.pathname.endsWith("/reimage");
  const body = payload(request, reimage ? ["reservationId", "holderGeneration", "hostId", "receipt"] : ["reservationId", "holderGeneration", "hostId"]);
  const stop: PoolStopInput = { reservationId: wireText(body.reservationId, "reservation id"), holderGeneration: wireCounter(body.holderGeneration, "holder generation", 1), hostId: wireText(body.hostId, "host id") };
  return json(200, reimage
    ? await service.confirmReimage(principal, { ...stop, receipt: wireText(body.receipt, "reimage receipt") } satisfies PoolReimageInput)
    : await service.confirmStopped(principal, stop));
}

/** The route table itself, matched in the order the paths were written. */
async function poolRoute(service: PoolAdmissionService, request: FactoryPrivateRequest, principal: PoolPrincipal, url: URL): Promise<FactoryPrivateResponse> {
  const parts = url.pathname.split("/").filter(Boolean);
  if (request.method === "POST" && url.pathname === "/v1/pool/requests") {
    const body = payload(request, ["reservationId", "grantRevision", "grantScope", "resources", "admissionDeadline", "priority", "readySequence", "nodeId"]);
    return decision(await service.request(principal, requestInput(body)));
  }
  if (parts.length === 4 && parts[0] === "v1" && parts[1] === "pool" && parts[2] === "requests" && request.method === "GET") {
    if (request.body.byteLength !== 0) fail(400, "invalid_request");
    const result = await service.status(principal, reservation(parts[3]!));
    return result === undefined ? empty() : json(200, result);
  }
  if (parts.length === 5 && parts[0] === "v1" && parts[1] === "pool" && parts[2] === "requests" && request.method === "POST") {
    const handled = await reservationAction(service, request, principal, parts);
    if (handled) return handled;
  }
  if (request.method === "POST" && (url.pathname === "/v1/pool/supervisor/stop" || url.pathname === "/v1/pool/supervisor/reimage")) {
    return supervisorConfirmation(service, request, principal, url);
  }
  return json(404, { error: "not_found" });
}

/** One authenticated and bounded route table shared by the Bun and Node TLS listeners. */
export function createPoolAdmissionRouteHandler(options: PoolAdmissionRouteOptions): (request: FactoryPrivateRequest) => Promise<FactoryPrivateResponse> {
  const snapshot = Object.freeze({
    identities: Object.freeze({
      tenants: Object.freeze(Object.fromEntries(Object.entries(options.identities.tenants).map(([key, value]) => [key, Object.freeze({ ...value })]))),
      supervisors: Object.freeze(Object.fromEntries(Object.entries(options.identities.supervisors).map(([key, value]) => [key, Object.freeze({ ...value, hostIds: Object.freeze([...value.hostIds]) })]))),
    }),
    tokens: Object.freeze({ ...options.tokens, publicKeys: Object.freeze({ ...options.tokens.publicKeys }) }),
    service: options.service,
  });
  return async request => {
    try {
      const principal = authorization(request, snapshot);
      if (request.headers["x-ezcorp-factory-version"] !== "1") fail(400, "invalid_request");
      const url = new URL(request.path, "https://pool.local");
      if (url.origin !== "https://pool.local" || url.search || url.hash) fail(400, "invalid_request");
      return await poolRoute(snapshot.service, request, principal, url);
    } catch (error) {
      try { return serviceError(error); }
      catch { return { status: 500, body: Buffer.from('{"error":"response_too_large"}') }; }
    }
  };
}

export { POOL_HTTP_BYTES_LIMIT };
