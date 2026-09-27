import { createPrivateKey, type KeyObject } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { FactoryPrivateRequest, FactoryPrivateResponse } from "../private-https";
import { signFactoryPhysicalStopReceipt, type FactoryPhysicalStopReason, type FactoryPhysicalStopReceipt, type FactoryUnsignedPhysicalStopReceipt } from "./attempt-wire";
import { FACTORY_HOST_FORBIDDEN_TENANT, factoryHostPeerTenantLookup, type FactoryHostGuestTenants, type FactoryHostPeerTenants } from "./host-peer-tenants";

/** The sealed coordinates a gateway may ask a host to stop. */
export interface FactoryHostStopCommand {
  readonly attemptId: string;
  readonly reservationId: string;
  readonly workerId: string;
  readonly holderGeneration: number;
  readonly allocationGeneration: number;
  readonly hostId: string;
  readonly reason: FactoryPhysicalStopReason;
  /** The tenant whose guest this is. Optional on the wire; without it the host uses the tenant it recorded at launch. */
  readonly tenantId?: string;
}

/**
 * The one physical action the host offers. The supervisor implements it; the
 * gateway can only ask for it, and never receives the host private key.
 */
export interface FactoryHostStopSupervisor {
  stop(command: FactoryHostStopCommand, signal: AbortSignal): Promise<FactoryUnsignedPhysicalStopReceipt>;
}

/** Where the host's current signing key lives. Reloaded on every signature. */
export interface FactoryHostSigningKeySource {
  readonly hostId: string;
  /** File holding the current PEM private key. Rotating the file rotates the signature. */
  readonly privateKeyPath: string;
  /** File holding the current key id. Rotating it together keeps the pair consistent. */
  readonly keyIdPath: string;
}

export interface FactoryHostStopServiceOptions {
  readonly hostId: string;
  /** Each mTLS peer allowed to request a stop on this host, bound to the one tenant it acts for. */
  readonly peerTenants: FactoryHostPeerTenants;
  /** The tenant this host recorded for each guest at launch or reattachment. */
  readonly guestTenants?: FactoryHostGuestTenants;
  readonly supervisor: FactoryHostStopSupervisor;
  readonly signingKey: FactoryHostSigningKeySource;
  readonly stopTimeoutMs?: number;
}

export const FACTORY_HOST_STOP_PATH = "/v1/host/stops";
const MAX_KEY_BYTES = 16 * 1024;
const MAX_KEY_ID_BYTES = 512;

class HostStopRouteError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); this.name = "HostStopRouteError"; }
}

function refuse(status: number, code: string): never { throw new HostStopRouteError(status, code); }

function text(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || [...value].some(character => (character.codePointAt(0) ?? 0) < 0x20)) refuse(400, `invalid_${label}`);
  return value;
}

function counter(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) refuse(400, `invalid_${label}`);
  return value;
}

const REASONS = new Set<FactoryPhysicalStopReason>(["completed", "failed", "cancelled", "lease-revoked"]);
const COMMAND_FIELDS = ["attemptId", "reservationId", "workerId", "holderGeneration", "allocationGeneration", "hostId", "reason", "tenantId"];

function command(body: unknown, hostId: string): FactoryHostStopCommand {
  if (!body || typeof body !== "object" || Array.isArray(body)) refuse(400, "invalid_request");
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some(name => !COMMAND_FIELDS.includes(name))) refuse(400, "invalid_request");
  const reason = value.reason;
  if (typeof reason !== "string" || !REASONS.has(reason as FactoryPhysicalStopReason)) refuse(400, "invalid_reason");
  const named = text(value.hostId, "host");
  // A gateway cannot address another host through this one.
  if (named !== hostId) refuse(403, "forbidden_host");
  return Object.freeze({
    attemptId: text(value.attemptId, "attempt"),
    reservationId: text(value.reservationId, "reservation"),
    workerId: text(value.workerId, "worker"),
    holderGeneration: counter(value.holderGeneration, "holder_generation"),
    allocationGeneration: counter(value.allocationGeneration, "allocation_generation"),
    hostId: named,
    reason: reason as FactoryPhysicalStopReason,
    ...(value.tenantId === undefined ? {} : { tenantId: text(value.tenantId, "tenant") }),
  });
}

/**
 * Loads the host's current signing material for one signature.
 *
 * Reading it per signature is what makes rotation work without a restart: the
 * next stop after the operator replaces the files is signed by the new key and
 * carries the new key id, and a half-written pair is refused rather than used.
 */
export async function loadFactoryHostSigningKey(source: FactoryHostSigningKeySource): Promise<{ readonly hostKeyId: string; readonly privateKey: KeyObject }> {
  const [pem, keyId] = await Promise.all([readFile(source.privateKeyPath), readFile(source.keyIdPath, "utf8")]);
  if (pem.byteLength > MAX_KEY_BYTES || keyId.length > MAX_KEY_ID_BYTES) throw new Error("Factory host signing material is oversized.");
  const hostKeyId = keyId.trim();
  if (!hostKeyId || [...hostKeyId].some(character => (character.codePointAt(0) ?? 0) < 0x20)) throw new Error("Factory host key id is invalid.");
  let privateKey: KeyObject;
  try { privateKey = createPrivateKey(pem); }
  catch { throw new Error("Factory host signing key is invalid."); }
  return Object.freeze({ hostKeyId, privateKey });
}

function json(status: number, value: unknown): FactoryPrivateResponse {
  return { status, body: Buffer.from(JSON.stringify(value)) };
}

/**
 * The authenticated host stop route.
 *
 * Only the mutual-TLS peer identity authorizes the request; nothing in the body
 * names the caller. The response is a physical observation the host signs
 * itself, so a gateway callback can request a stop but can never assert one.
 *
 * The guest's tenant must be the one the peer is bound to (W01i). It is the
 * tenant this host recorded when the guest was launched or reattached, else the
 * one the request names; a named tenant that disagrees with the recorded one, a
 * tenant that is not the peer's, or a guest whose tenant is known neither way is
 * refused `403 forbidden_tenant` before the supervisor is called.
 */
export function createFactoryHostStopRouteHandler(options: FactoryHostStopServiceOptions): (request: FactoryPrivateRequest) => Promise<FactoryPrivateResponse> {
  const snapshot = Object.freeze({
    hostId: options.hostId,
    peers: factoryHostPeerTenantLookup(options.peerTenants),
    guestTenants: options.guestTenants,
    supervisor: options.supervisor,
    signingKey: Object.freeze({ ...options.signingKey }),
    stopTimeoutMs: options.stopTimeoutMs ?? 20_000,
  });
  if (snapshot.signingKey.hostId !== snapshot.hostId) throw new Error("Factory host stop service needs its own host and at least one authorized peer.");
  return async request => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const peerTenant = snapshot.peers.get(request.peerIdentity);
      if (peerTenant === undefined) refuse(401, "unauthorized");
      if (request.headers["x-ezcorp-factory-version"] !== "1") refuse(400, "invalid_request");
      if (request.method !== "POST" || request.path !== FACTORY_HOST_STOP_PATH) refuse(404, "not_found");
      if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") refuse(400, "invalid_request");
      let body: unknown;
      try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(request.body)); }
      catch { refuse(400, "invalid_request"); }
      const stop = command(body, snapshot.hostId);
      const recorded = snapshot.guestTenants?.of(stop.workerId);
      if (recorded !== undefined && stop.tenantId !== undefined && stop.tenantId !== recorded) refuse(403, FACTORY_HOST_FORBIDDEN_TENANT);
      if ((recorded ?? stop.tenantId) !== peerTenant) refuse(403, FACTORY_HOST_FORBIDDEN_TENANT);
      timer = setTimeout(() => controller.abort(), snapshot.stopTimeoutMs);
      const unsigned = await snapshot.supervisor.stop(stop, controller.signal);
      if (unsigned.attemptId !== stop.attemptId || unsigned.reservationId !== stop.reservationId || unsigned.workerId !== stop.workerId
        || unsigned.holderGeneration !== stop.holderGeneration || unsigned.allocationGeneration !== stop.allocationGeneration
        || unsigned.hostId !== stop.hostId || unsigned.reason !== stop.reason || unsigned.processGroupAbsent !== true) refuse(409, "conflict");
      const key = await loadFactoryHostSigningKey(snapshot.signingKey);
      const signature = signFactoryPhysicalStopReceipt(unsigned, key.hostKeyId, key.privateKey);
      const { createHash } = await import("node:crypto");
      const { canonicalJson } = await import("@ezcorp/extension-contract");
      const receipt: FactoryPhysicalStopReceipt = { ...unsigned, ...signature, receiptDigest: `sha256:${createHash("sha256").update(canonicalJson(unsigned)).digest("hex")}` };
      return json(200, receipt);
    } catch (error) {
      if (error instanceof HostStopRouteError) return json(error.status, { error: error.code });
      const message = error instanceof Error ? error.message : "";
      if (controller.signal.aborted) return json(504, { error: "stop_timeout" });
      if (message.includes("not physically confirmed") || message.includes("uncertain")) return json(409, { error: "stop_uncertain" });
      return json(500, { error: "stop_failed" });
    } finally { if (timer) clearTimeout(timer); }
  };
}
