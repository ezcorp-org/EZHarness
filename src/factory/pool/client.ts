import { createGatewayTransport, type GatewayResponse, type GatewayTransport, type GatewayTransportOptions } from "@ezcorp/factory-transport";
import { POOL_RESOURCE_CLASSES, type PoolDecision, type PoolLease, type PoolLeaseState, type PoolLeaseStatus, type PoolResourceClass, type PoolResourceVector } from "./ledger";
import type { PoolAdmissionRequest, PoolLeaseFenceInput } from "./service";
import { parseWireJson, POOL_HTTP_BYTES_LIMIT, wireCounter, wireExact, wireIsoDate, wireRecord, wireResources, wireText } from "./wire";

const leaseStates = new Set<PoolLeaseState>(["queued", "held", "running", "revoking", "uncertain", "settled", "rejected"]);
const decisionStates = new Set<PoolDecision["status"]>(["queued", "rejected", "admitted", "cancelled"]);

export interface PoolAdmissionClient {
  request(input: PoolAdmissionRequest, signal?: AbortSignal): Promise<PoolDecision>;
  status(reservationId: string, signal?: AbortSignal): Promise<PoolLeaseStatus | undefined>;
  acknowledgeStart(input: PoolLeaseFenceInput, signal?: AbortSignal): Promise<PoolLease>;
  renew(input: PoolLeaseFenceInput, signal?: AbortSignal): Promise<PoolLease>;
  cancel(reservationId: string, allocationGeneration: number, signal?: AbortSignal): Promise<PoolLeaseStatus>;
}

export interface PoolAdmissionClientOptions extends GatewayTransportOptions { readonly tenantId: string }

function json(response: GatewayResponse, label: string): unknown {
  try { return parseWireJson(response.body, label); }
  catch { throw new Error(`Pool admission returned invalid ${label}.`); }
}

function optionalText(value: unknown, label: string): string | undefined { return value === undefined ? undefined : wireText(value, label); }

function sameResources(left: PoolResourceVector, right: PoolResourceVector): boolean {
  return POOL_RESOURCE_CLASSES.every(resourceClass => left[resourceClass] === right[resourceClass]);
}

function lease(value: unknown): PoolLease {
  const input = wireRecord(value, "lease");
  wireExact(input, ["reservationId", "tenantId", "grantRevision", "allocationGeneration", "holderGeneration", "allocationToken", "fence", "deadlineAt", "resources", "hostId"], "lease");
  return {
    reservationId: wireText(input.reservationId, "lease reservation id"),
    tenantId: wireText(input.tenantId, "lease tenant id"),
    grantRevision: wireCounter(input.grantRevision, "lease grant revision", 1),
    allocationGeneration: wireCounter(input.allocationGeneration, "lease allocation generation", 1),
    holderGeneration: wireCounter(input.holderGeneration, "lease holder generation", 1),
    allocationToken: wireText(input.allocationToken, "lease allocation token"),
    fence: wireText(input.fence, "lease fence"),
    deadlineAt: wireIsoDate(input.deadlineAt, "lease deadline"),
    resources: wireResources(input.resources),
    ...(input.hostId === undefined ? {} : { hostId: wireText(input.hostId, "lease host id") }),
  };
}

function status(value: unknown): PoolLeaseStatus {
  const input = wireRecord(value, "lease status");
  wireExact(input, ["reservationId", "tenantId", "state", "allocationGeneration", "holderGeneration", "effects", "resources", "hostId", "reason"], "lease status");
  if (typeof input.state !== "string" || !leaseStates.has(input.state as PoolLeaseState)) throw new Error("Pool lease status state is malformed.");
  return {
    reservationId: wireText(input.reservationId, "status reservation id"),
    tenantId: wireText(input.tenantId, "status tenant id"),
    state: input.state as PoolLeaseState,
    allocationGeneration: wireCounter(input.allocationGeneration, "status allocation generation", 1),
    holderGeneration: wireCounter(input.holderGeneration, "status holder generation"),
    effects: wireCounter(input.effects, "status effects"),
    resources: wireResources(input.resources),
    ...(input.hostId === undefined ? {} : { hostId: wireText(input.hostId, "status host id") }),
    ...(input.reason === undefined ? {} : { reason: wireText(input.reason, "status reason") }),
  };
}

/** Decode the exact pool decision shape from a durable or HTTP boundary. */
export function parsePoolDecision(value: unknown): PoolDecision {
  const input = wireRecord(value, "admission decision");
  if (typeof input.status !== "string" || !decisionStates.has(input.status as PoolDecision["status"])) throw new Error("Pool admission decision status is malformed.");
  const state = input.status as PoolDecision["status"];
  wireExact(input, state === "admitted" ? ["status", "reservationId", "lease"] : ["status", "reservationId", "reason", "retryAfterSeconds", "queueAgeMs", "blockingResource"], "admission decision");
  const reservationId = wireText(input.reservationId, "decision reservation id");
  if (state === "admitted") return { status: state, reservationId, lease: lease(input.lease) };
  const blocking = optionalText(input.blockingResource, "blocking resource");
  if (blocking !== undefined && !(POOL_RESOURCE_CLASSES as readonly string[]).includes(blocking)) throw new Error("Pool blocking resource is malformed.");
  return {
    status: state,
    reservationId,
    ...(input.reason === undefined ? {} : { reason: wireText(input.reason, "decision reason") }),
    ...(input.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: wireCounter(input.retryAfterSeconds, "retry interval", 1) }),
    ...(input.queueAgeMs === undefined ? {} : { queueAgeMs: wireCounter(input.queueAgeMs, "queue age") }),
    ...(blocking === undefined ? {} : { blockingResource: blocking as PoolResourceClass }),
  };
}

function snapshotRequest(value: PoolAdmissionRequest): PoolAdmissionRequest {
  const input = wireRecord(value, "admission request");
  wireExact(input, ["reservationId", "grantRevision", "grantScope", "resources", "admissionDeadline", "priority", "readySequence", "nodeId"], "admission request");
  return {
    reservationId: wireText(input.reservationId, "reservation id"),
    grantRevision: wireCounter(input.grantRevision, "grant revision", 1),
    grantScope: wireText(input.grantScope, "grant scope"),
    resources: wireResources(input.resources),
    admissionDeadline: wireIsoDate(input.admissionDeadline, "admission deadline").toISOString(),
    ...(input.priority === undefined ? {} : { priority: wireCounter(input.priority, "priority") }),
    ...(input.readySequence === undefined ? {} : { readySequence: wireCounter(input.readySequence, "ready sequence") }),
    ...(input.nodeId === undefined ? {} : { nodeId: wireText(input.nodeId, "node id") }),
  };
}

function snapshotFence(value: PoolLeaseFenceInput): PoolLeaseFenceInput {
  const input = wireRecord(value, "lease fence");
  wireExact(input, ["reservationId", "grantRevision", "allocationGeneration", "allocationToken"], "lease fence");
  return { reservationId: wireText(input.reservationId, "reservation id"), grantRevision: wireCounter(input.grantRevision, "grant revision", 1), allocationGeneration: wireCounter(input.allocationGeneration, "allocation generation", 1), allocationToken: wireText(input.allocationToken, "allocation token") };
}

function assertLeaseBinding(value: PoolLease, tenantId: string, expected: Pick<PoolLeaseFenceInput, "reservationId" | "grantRevision"> & Partial<Pick<PoolLeaseFenceInput, "allocationGeneration">>, resources?: PoolResourceVector): void {
  if (value.tenantId !== tenantId || value.reservationId !== expected.reservationId || value.grantRevision !== expected.grantRevision || expected.allocationGeneration !== undefined && value.allocationGeneration !== expected.allocationGeneration || resources !== undefined && !sameResources(value.resources, resources)) throw new Error("Pool admission returned a mismatched lease.");
}

function assertStatusBinding(value: PoolLeaseStatus, tenantId: string, reservationId: string): void {
  if (value.tenantId !== tenantId || value.reservationId !== reservationId) throw new Error("Pool admission returned a mismatched status.");
}

async function requestJson(transport: GatewayTransport, method: "GET" | "POST", path: string, body: unknown, signal?: AbortSignal): Promise<GatewayResponse> {
  return transport.request(method, path, body, POOL_HTTP_BYTES_LIMIT, signal);
}

/** Tenant-scoped C03 client. Every mutation makes one bounded transport call. */
export async function createPoolAdmissionClient(options: PoolAdmissionClientOptions): Promise<PoolAdmissionClient> {
  const tenantId = wireText(options.tenantId, "client tenant id");
  const transport = await createGatewayTransport(options);
  const path = (reservationId: string) => `/v1/pool/requests/${encodeURIComponent(reservationId)}`;
  const client: PoolAdmissionClient = {
    async request(value: PoolAdmissionRequest, signal?: AbortSignal) {
      const input = snapshotRequest(value);
      const result = parsePoolDecision(json(await requestJson(transport, "POST", "/v1/pool/requests", input, signal), "admission decision"));
      if (result.reservationId !== input.reservationId) throw new Error("Pool admission returned a mismatched reservation.");
      if (result.status === "admitted") assertLeaseBinding(result.lease!, tenantId, input, input.resources);
      return result;
    },
    async status(value: string, signal?: AbortSignal) {
      const reservationId = wireText(value, "reservation id");
      const response = await requestJson(transport, "GET", path(reservationId), undefined, signal);
      if (response.statusCode === 204) {
        if (response.body.byteLength !== 0) throw new Error("Pool admission returned an invalid empty status.");
        return undefined;
      }
      const result = status(json(response, "lease status"));
      assertStatusBinding(result, tenantId, reservationId);
      return result;
    },
    async acknowledgeStart(value: PoolLeaseFenceInput, signal?: AbortSignal) {
      const input = snapshotFence(value);
      const result = lease(json(await requestJson(transport, "POST", `${path(input.reservationId)}/acknowledge-start`, { grantRevision: input.grantRevision, allocationGeneration: input.allocationGeneration, allocationToken: input.allocationToken }, signal), "lease"));
      assertLeaseBinding(result, tenantId, input);
      return result;
    },
    async renew(value: PoolLeaseFenceInput, signal?: AbortSignal) {
      const input = snapshotFence(value);
      const result = lease(json(await requestJson(transport, "POST", `${path(input.reservationId)}/renew`, { grantRevision: input.grantRevision, allocationGeneration: input.allocationGeneration, allocationToken: input.allocationToken }, signal), "lease"));
      assertLeaseBinding(result, tenantId, input);
      return result;
    },
    async cancel(value: string, generation: number, signal?: AbortSignal) {
      const reservationId = wireText(value, "reservation id");
      const allocationGeneration = wireCounter(generation, "allocation generation", 1);
      const result = status(json(await requestJson(transport, "POST", `${path(reservationId)}/cancel`, { allocationGeneration }, signal), "lease status"));
      assertStatusBinding(result, tenantId, reservationId);
      if (result.allocationGeneration < allocationGeneration) throw new Error("Pool admission returned a stale cancellation status.");
      return result;
    },
  };
  return Object.freeze(client);
}
