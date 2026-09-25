import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { checkServerIdentity, type PeerCertificate } from "node:tls";
import { IncusTransportError, type IncusTransport, type IncusTransportRequest } from "../../../extensions/incus-sandbox/transport";
import { boundedJson, object, pinnedCertificate, pinnedOrigin, verifiedHttpsRequest, type HostConnectionResolver, type HostConnectionScope, type PinnedFetch, type ResolvedIncusConnection } from "./transport";

const MAX_DEADLINE_MS = 30_000;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const managedBy = "ezharness-incus-sandbox";

function invalid(message: string): never { throw new IncusTransportError("invalid", message); }
function denied(message: string): never { throw new IncusTransportError("permission", message); }
function payload(command: IncusTransportRequest): Record<string, unknown> { return object(command.payload); }
export function resourceName(connectionId: string, sandboxId: string): string {
  return `ezh-${createHash("sha256").update(connectionId).update("\0").update(sandboxId).digest("hex").slice(0, 32)}`;
}
function operationId(kind: string, command: IncusTransportRequest): string {
  const seed = `${command.connectionId}\0${command.tags.sandboxId}\0${command.idempotency?.requestId}\0${command.idempotency?.key}\0${kind}`;
  return `ezh-${kind}-${command.sandboxName!.slice(4)}-${createHash("sha256").update(seed).digest("hex").slice(0, 32)}`;
}
function sourceConfig(scope: HostConnectionScope) {
  const lifecycle = scope.approvedPreset;
  if (!lifecycle || !ID.test(lifecycle.profile) || !NAME.test(lifecycle.incusProfile) || lifecycle.incusProfile === "default" || !ID.test(lifecycle.presetId)
    || !DIGEST.test(lifecycle.presetDigest) || !DIGEST.test(lifecycle.effectiveSettingsDigest)
    || !DIGEST.test(lifecycle.imageFingerprint)) denied("Incus lifecycle policy is unavailable");
  const { limits } = lifecycle;
  if (!limits || !Number.isSafeInteger(limits.memoryBytes) || limits.memoryBytes < 256 * 1024 * 1024 || limits.memoryBytes > 64 * 1024 ** 3
    || !Number.isSafeInteger(limits.cpuMillis) || limits.cpuMillis < 100 || limits.cpuMillis > 16_000
    || !Number.isSafeInteger(limits.pids) || limits.pids < 64 || limits.pids > 8192
    || !Number.isSafeInteger(limits.diskBytes) || limits.diskBytes < 1024 ** 3 || limits.diskBytes > 128 * 1024 ** 3) denied("Incus lifecycle limits are unavailable");
  return lifecycle;
}
function assertScope(command: IncusTransportRequest, scope: HostConnectionScope): void {
  if (!ID.test(scope.providerInstallationId) || !ID.test(scope.providerReleaseId) || !Number.isSafeInteger(scope.revision) || scope.revision < 1) denied("Incus host scope is invalid");
  if (!ID.test(command.connectionId) || command.pins.connectionId !== command.connectionId || command.tags.connectionId !== command.connectionId
    || command.tags.managedBy !== managedBy || !DIGEST.test(command.pins.serverCertificateSha256)
    || !NAME.test(command.pins.project) || command.pins.project === "default"
    || !NAME.test(command.pins.profile) || command.pins.profile === "default"
    || !Number.isFinite(command.deadlineMs) || command.deadlineMs <= Date.now() || command.deadlineMs - Date.now() > MAX_DEADLINE_MS) invalid("Invalid Incus lifecycle scope");
  if (command.action !== "instance.list") {
    if (!command.tags.sandboxId || !ID.test(command.tags.sandboxId) || command.sandboxName !== resourceName(command.connectionId, command.tags.sandboxId)) invalid("Invalid Incus sandbox identity");
  } else if (command.tags.sandboxId || command.sandboxName) invalid("Invalid Incus list scope");
  if (["instance.create", "instance.setPower", "instance.destroy", "helper.file.writeAtomic", "helper.file.remove", "helper.process.start", "helper.process.cancel"].includes(command.action)) {
    if (!command.idempotency || !ID.test(command.idempotency.requestId) || !ID.test(command.idempotency.key)) invalid("Invalid Incus operation identity");
  } else if (command.idempotency && (command.action !== "operation.inspect" || !ID.test(command.idempotency.requestId) || !ID.test(command.idempotency.key))) invalid("Unexpected Incus operation identity");
}

export interface Session {
  connection: ResolvedIncusConnection;
  origin: URL;
  tls: Parameters<PinnedFetch>[1]["tls"];
  signal: AbortSignal;
  request(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: Record<string, unknown>, etag?: string): Promise<{ status: number; envelope: Record<string, unknown>; etag: string | null }>;
}

export async function withSession<T>(connections: HostConnectionResolver, scope: HostConnectionScope, http: PinnedFetch, command: IncusTransportRequest, run: (session: Session) => Promise<T>): Promise<T> {
  assertScope(command, scope);
  let mutationAttempted = false;
  const controller = new AbortController();
  const abort = () => controller.abort();
  scope.signal?.addEventListener("abort", abort, { once: true });
  if (scope.signal?.aborted) controller.abort();
  const timer = setTimeout(abort, Math.max(0, command.deadlineMs - Date.now()));
  const deadline = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(new IncusTransportError("deadline", "Incus lifecycle deadline exceeded")), { once: true });
    if (controller.signal.aborted) reject(new IncusTransportError("deadline", "Incus lifecycle deadline exceeded"));
  });
  try {
    const connection = await Promise.race([connections.resolveForHost({ connectionId: command.connectionId, providerInstallationId: scope.providerInstallationId, providerReleaseId: scope.providerReleaseId, revision: scope.revision }).catch(() => { throw new IncusTransportError("not_found", "Incus connection is unavailable"); }), deadline]);
    if (connection.project !== command.pins.project) denied("Incus project pin does not match");
    const policy = sourceConfig(scope);
    if (policy.incusProfile !== command.pins.profile) denied("Incus profile pin does not match");
    const certificate = pinnedCertificate(connection.serverCertificatePem);
    const fingerprint = createHash("sha256").update(certificate.raw).digest("hex");
    if (fingerprint !== command.pins.serverCertificateSha256) denied("Incus certificate pin does not match");
    const origin = pinnedOrigin(connection.endpoint);
    const hostname = origin.hostname.replace(/^\[|\]$/g, "");
    if (!(isIP(hostname) ? certificate.checkIP(hostname) : certificate.checkHost(hostname))) denied("Incus certificate does not match endpoint");
    const tls = { cert: connection.clientCertificatePem, key: connection.privateKeyPem, ca: connection.serverCertificatePem, rejectUnauthorized: true as const,
      checkServerIdentity: (host: string, peer: PeerCertificate): Error | undefined => {
        if (checkServerIdentity(host, peer) || !peer.raw || createHash("sha256").update(peer.raw).digest("hex") !== fingerprint) return new Error("Incus peer identity rejected");
      } };
    const session: Session = { connection, origin, tls, signal: controller.signal, request: async (method, path, body, etag) => {
      const url = new URL(path, origin);
      if (url.origin !== origin.origin || !url.pathname.startsWith("/1.0/")) denied("Incus route escaped origin");
      // Once a write is attempted, even a lost TLS reply can hide an Incus effect.
      if (method !== "GET") mutationAttempted = true;
      const response = await Promise.race([http(url.href, { method, body: body ? JSON.stringify(body) : undefined, headers: etag ? { "If-Match": etag } : undefined, redirect: "manual", proxy: false, decompress: false, signal: controller.signal, tls }), deadline]);
      if (response.status >= 300 && response.status < 400) denied("Incus redirect denied");
      const envelope = await Promise.race([boundedJson(response, true), deadline]);
      return { status: response.status, envelope, etag: response.headers.get("etag") };
    } };
    return await run(session);
  } catch (error) {
    if (error instanceof IncusTransportError) {
      if (mutationAttempted || error.effect === "none" || error.operationId) throw error;
      throw new IncusTransportError(error.kind, error.message, { effect: "none" });
    }
    const effect = mutationAttempted ? "unknown" : "none";
    if (controller.signal.aborted) throw new IncusTransportError("deadline", "Incus lifecycle deadline exceeded", { effect });
    throw new IncusTransportError("unavailable", "Incus lifecycle request failed", { effect });
  } finally {
    clearTimeout(timer);
    scope.signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}

export function metadata(reply: { status: number; envelope: Record<string, unknown> }, allowMissing = false): unknown {
  if (allowMissing && reply.status === 404) return null;
  if (reply.status === 404) throw new IncusTransportError("not_found", "Incus resource was not found");
  if (reply.status === 409) throw new IncusTransportError("already_exists", "Incus resource already exists");
  if (reply.status === 412) throw new IncusTransportError("revision_conflict", "Incus resource revision changed");
  if (reply.status === 401 || reply.status === 403) denied("Incus server denied the request");
  if (reply.status < 200 || reply.status >= 300) throw new IncusTransportError("unavailable", "Incus request failed");
  if (reply.envelope.type !== "sync" && reply.envelope.type !== "async") throw new IncusTransportError("unavailable", "Invalid Incus response type");
  return reply.envelope.metadata;
}

function instanceIdentity(instance: Record<string, unknown>, command: IncusTransportRequest): void {
  if (instance.name !== command.sandboxName) denied("Incus instance name does not match");
  const config = object(instance.config);
  if (config["user.ezharness.managed_by"] !== managedBy || config["user.ezharness.connection_id"] !== command.connectionId || config["user.ezharness.sandbox_id"] !== command.tags.sandboxId) denied("Incus instance ownership does not match");
}
function inspection(instance: Record<string, unknown>, command: IncusTransportRequest) {
  instanceIdentity(instance, command);
  const config = object(instance.config);
  const state = instance.status === "Running" ? "running" : instance.status === "Stopped" ? "stopped" : "unknown";
  const generation = Number(config["user.ezharness.generation"]);
  if (!Number.isSafeInteger(generation) || generation < 1) denied("Incus instance generation is invalid");
  return { sandboxId: command.tags.sandboxId!, profile: String(config["user.ezharness.profile"]), presetId: String(config["user.ezharness.preset_id"]), desiredState: state, observedState: state, generation, bootId: null, observedAt: new Date().toISOString() };
}
function receipt(kind: "create" | "setPower" | "destroy", command: IncusTransportRequest, id: string) {
  return { ok: true as const, receipt: { operationId: id, kind, requestId: command.idempotency!.requestId, idempotencyKey: command.idempotency!.key, sandboxId: command.tags.sandboxId!, acceptedAt: new Date().toISOString() } };
}
function acceptedOperationId(reply: { envelope: Record<string, unknown> }, kind: string, fallback: string): string {
  const value = reply.envelope.metadata;
  const direct = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).id : undefined;
  const route = reply.envelope.operation;
  const id = typeof direct === "string" ? direct : typeof route === "string" ? /^\/1\.0\/operations\/([a-f0-9-]{36})$/.exec(route)?.[1] : undefined;
  return id && /^[a-f0-9-]{36}$/.test(id) ? `incus-${kind}-${id}` : fallback;
}

type LifecycleContext = {
  session: Session;
  command: IncusTransportRequest;
  project: string;
  collection: string;
  instancePath: string;
  input: Record<string, unknown>;
  policy: ReturnType<typeof sourceConfig>;
};

/** Injected only by the authenticated host operator path. */
export interface PostEffectDestroyReplyFault {
  matches(command: IncusTransportRequest, scope: HostConnectionScope): boolean;
  consume(command: IncusTransportRequest, scope: HostConnectionScope): boolean;
}

async function inspectInstance({ session, command, instancePath }: LifecycleContext) {
  const found = metadata(await session.request("GET", instancePath), true);
  if (!found) throw new IncusTransportError("not_found", "Incus instance not found");
  return { ok: true, sandbox: inspection(object(found), command) };
}

async function listInstances({ session, command, project, input }: LifecycleContext) {
  if (!Number.isSafeInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 100) invalid("Invalid Incus list limit");
  const cursor = input.cursor === undefined ? undefined : object(input.cursor);
  if (cursor && (cursor.connectionId !== command.connectionId || typeof cursor.afterSandboxId !== "string" || !ID.test(cursor.afterSandboxId))) invalid("Invalid Incus list cursor");
  const reply = metadata(await session.request("GET", `/1.0/instances?recursion=1&project=${project}`));
  if (!Array.isArray(reply)) throw new IncusTransportError("unavailable", "Invalid Incus instance list");
  const values = (reply as unknown as Array<Record<string, unknown>>).filter(item => typeof item.name === "string" && item.name.startsWith("ezh-"));
  const sandboxes = values.flatMap(item => {
    try {
      const config = object(item.config);
      const sandboxId = config["user.ezharness.sandbox_id"];
      if (config["user.ezharness.connection_id"] !== command.connectionId || typeof sandboxId !== "string" || !ID.test(sandboxId)) return [];
      const scoped = { ...command, tags: { ...command.tags, sandboxId }, sandboxName: resourceName(command.connectionId, sandboxId) };
      return [inspection(item, scoped)];
    } catch { return []; }
  }).sort((a, b) => a.sandboxId.localeCompare(b.sandboxId));
  const start = cursor ? sandboxes.findIndex(item => item.sandboxId > (cursor.afterSandboxId as string)) : 0;
  const page = sandboxes.slice(start < 0 ? sandboxes.length : start, (start < 0 ? sandboxes.length : start) + (input.limit as number));
  const last = page.at(-1);
  return { ok: true, sandboxes: page, ...(last && sandboxes.some(item => item.sandboxId > last.sandboxId) ? { nextCursor: { connectionId: command.connectionId, afterSandboxId: last.sandboxId } } : {}) };
}

function matchesCreateInstance(instance: Record<string, unknown>, command: IncusTransportRequest,
  policy: LifecycleContext["policy"], stableId: string, requiredState: "stopped" | null): boolean {
  const config = object(instance.config);
  const observed = instance.status === "Running" ? "running" : instance.status === "Stopped" ? "stopped" : null;
  return Boolean(command.idempotency
    && config["user.ezharness.create_key"] === command.idempotency.key
    && config["user.ezharness.operation_id"] === stableId
    && config["user.ezharness.profile"] === policy.profile
    && config["user.ezharness.preset_id"] === policy.presetId
    && config["volatile.base_image"] === policy.imageFingerprint
    && config["user.ezharness.generation"] === "1"
    && Array.isArray(instance.profiles) && instance.profiles.length === 1 && instance.profiles[0] === policy.incusProfile
    && (instance.type === undefined || instance.type === "container")
    && (observed === "running" || observed === "stopped")
    && config["user.ezharness.desired_state"] === observed
    && (requiredState === null || observed === requiredState));
}

async function inspectSyntheticOperation({ session, command, instancePath, policy }: LifecycleContext, id: string) {
  const match = /^ezh-(create|setPower|destroy)-([a-f0-9]{32})-([a-f0-9]{32})$/.exec(id);
  if (!match || `ezh-${match[2]}` !== command.sandboxName) denied("Incus operation escaped sandbox scope");
  if (match[1] === "create" && (!command.idempotency || operationId("create", command) !== id)) denied("Incus creation operation does not match journal scope");
  const found = metadata(await session.request("GET", instancePath), true);
  const instance = found ? object(found) : null;
  if (instance) instanceIdentity(instance, command);
  const config = instance ? object(instance.config) : null;
  const desired = config?.["user.ezharness.desired_state"];
  const observed = instance?.status === "Running" ? "running" : instance?.status === "Stopped" ? "stopped" : "unknown";
  const createProof = match[1] !== "create" || Boolean(instance && matchesCreateInstance(instance, command, policy, id, null));
  const proven = config?.["user.ezharness.operation_id"] === id && desired === observed && createProof && (match[1] === "create" || match[1] === "setPower");
  return { ok: true, operation: { operationId: id, kind: match[1], sandboxId: command.tags.sandboxId, state: proven ? "succeeded" : "outcome_unknown", desiredState: match[1] === "destroy" ? "absent" : desired === "running" ? "running" : "stopped", observedState: observed, resourceId: instance ? command.sandboxName : null, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), error: proven ? null : { code: "OUTCOME_UNKNOWN", message: "Incus mutation outcome is unknown", retryable: false, operationId: id } } };
}

async function verifyCompletedOperation(
  { session, command, instancePath, policy }: LifecycleContext,
  kind: string,
  status: unknown,
) {
  let state = status === "Success" ? "succeeded" : status === "Failure" ? "failed" : "running";
  let observedState: "running" | "stopped" | "absent" | "unknown" = "unknown";
  let desiredState: "running" | "stopped" | "absent" = kind === "destroy" ? "absent" : "stopped";
  if (state === "succeeded") {
    const found = metadata(await session.request("GET", instancePath), true);
    if (kind === "destroy") {
      // A successful, resource-scoped delete plus a fresh absence is proof.
      if (!found) observedState = "absent";
      else { instanceIdentity(object(found), command); state = "outcome_unknown"; }
    } else if (found) {
      const instance = object(found);
      instanceIdentity(instance, command);
      const config = object(instance.config);
      const observed = instance.status === "Running" ? "running" : instance.status === "Stopped" ? "stopped" : null;
      const desired = config["user.ezharness.desired_state"];
      if (config["user.ezharness.profile"] === policy.profile && config["user.ezharness.preset_id"] === policy.presetId
        && Array.isArray(instance.profiles) && instance.profiles.includes(policy.incusProfile)
        && (kind !== "create" || config["user.ezharness.create_key"])
        && (desired === "running" || desired === "stopped") && observed === desired) {
        observedState = observed;
        desiredState = desired;
      } else state = "outcome_unknown";
    } else state = "outcome_unknown";
  }
  return { state, observedState, desiredState };
}

async function inspectIncusOperation(context: LifecycleContext, id: string) {
  const { session, command, project } = context;
  const operationMatch = /^incus-(create|setPower|destroy)-([a-f0-9-]{36})$/.exec(id);
  if (!operationMatch) invalid("Invalid Incus operation identity");
  const operationReply = await session.request("GET", `/1.0/operations/${operationMatch[2]}?project=${project}`);
  if (operationMatch[1] === "create" && operationReply.status === 404) return inspectExpiredCreateOperation(context, id);
  if (operationMatch[1] === "setPower" && operationReply.status === 404) return inspectExpiredPowerOperation(context, id);
  if (operationMatch[1] === "destroy" && operationReply.status === 404) return inspectExpiredDestroyOperation(context, id);
  const reply = object(metadata(operationReply));
  const resources = object(reply.resources);
  const instances = resources.instances;
  if (!Array.isArray(instances) || !instances.some(item => typeof item === "string" && new URL(item, "https://incus.invalid").pathname === `/1.0/instances/${command.sandboxName}`)) denied("Incus operation escaped sandbox scope");
  const { state, observedState, desiredState } = await verifyCompletedOperation(context, operationMatch[1]!, reply.status);
  return { ok: true, operation: { operationId: id, kind: operationMatch[1], sandboxId: command.tags.sandboxId, state, desiredState, observedState, resourceId: command.sandboxName, startedAt: String(reply.created_at ?? new Date().toISOString()), finishedAt: state === "succeeded" || state === "failed" || state === "outcome_unknown" ? String(reply.updated_at ?? new Date().toISOString()) : null, error: state === "outcome_unknown" ? { code: "OUTCOME_UNKNOWN", message: "Incus mutation outcome is unknown", retryable: false, operationId: id } : state === "failed" ? { code: "INTERNAL", message: "Incus operation failed", retryable: false } : null } };
}

async function inspectExpiredDestroyOperation({ session, command, instancePath, input }: LifecycleContext, id: string) {
  const readback = input.readback && typeof input.readback === "object" && !Array.isArray(input.readback)
    ? input.readback as Record<string, unknown> : null;
  const authorized = Boolean(command.idempotency && Number.isSafeInteger(readback?.expectedGeneration)
    && (readback!.expectedGeneration as number) >= 1 && readback?.desiredState === "absent");
  // The expired operation record cannot prove which actor removed the guest.
  // A pinned read of this exact managed resource can still prove the desired
  // ABSENT state for the current host-journaled DESTROY. A failed read cannot.
  const found = authorized ? metadata(await session.request("GET", instancePath), true) : null;
  const absent = authorized && !found;
  return { ok: true, operation: { operationId: id, kind: "destroy", sandboxId: command.tags.sandboxId,
    state: absent ? "succeeded" : "outcome_unknown", desiredState: "absent",
    observedState: absent ? "absent" : "unknown", resourceId: null,
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    error: absent ? null : { code: "OUTCOME_UNKNOWN", message: "Incus mutation outcome is unknown", retryable: false, operationId: id } } };
}

async function inspectExpiredPowerOperation({ session, command, instancePath, input, policy }: LifecycleContext, id: string) {
  // A native operation can expire after Incus accepts it. The host broker
  // supplies this journal identity only after matching the exact current
  // START/STOP receipt; instance state alone is never proof of that receipt.
  const readback = input.readback && typeof input.readback === "object" && !Array.isArray(input.readback)
    ? input.readback as Record<string, unknown> : null;
  const generation = readback?.expectedGeneration;
  const desired = readback?.desiredState;
  const stableId = command.idempotency ? operationId("setPower", command) : null;
  let proven = false;
  if (stableId && Number.isSafeInteger(generation) && (generation as number) >= 1
    && (desired === "running" || desired === "stopped")) {
    const found = metadata(await session.request("GET", instancePath), true);
    if (found) {
      try {
        const instance = object(found);
        instanceIdentity(instance, command);
        const config = object(instance.config);
        proven = config["user.ezharness.operation_id"] === stableId
          && config["user.ezharness.generation"] === String((generation as number) + 1)
          && config["user.ezharness.desired_state"] === desired
          && instance.status === (desired === "running" ? "Running" : "Stopped")
          && config["user.ezharness.profile"] === policy.profile
          && config["user.ezharness.preset_id"] === policy.presetId
          && config["volatile.base_image"] === policy.imageFingerprint
          && Array.isArray(instance.profiles) && instance.profiles.length === 1
          && instance.profiles[0] === policy.incusProfile
          && (instance.type === undefined || instance.type === "container");
      } catch { /* An unowned or malformed instance is no proof of this power operation. */ }
    }
  }
  return { ok: true, operation: { operationId: id, kind: "setPower", sandboxId: command.tags.sandboxId,
    state: proven ? "succeeded" : "outcome_unknown", desiredState: desired === "running" ? "running" : "stopped",
    observedState: proven ? desired : "unknown", resourceId: proven ? command.sandboxName : null,
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    error: proven ? null : { code: "OUTCOME_UNKNOWN", message: "Incus mutation outcome is unknown", retryable: false, operationId: id } } };
}

async function inspectExpiredCreateOperation({ session, command, instancePath, policy }: LifecycleContext, id: string) {
  // The daemon can discard completed operations. Only the host-authorized
  // journal identity and the exact instance created by that journal can settle it.
  const stableId = command.idempotency ? operationId("create", command) : null;
  const found = stableId ? metadata(await session.request("GET", instancePath), true) : null;
  let proven = false;
  if (found) {
    try {
      const instance = object(found);
      instanceIdentity(instance, command);
      proven = matchesCreateInstance(instance, command, policy, stableId!, "stopped");
    } catch { /* An untrusted or malformed instance is no proof of this CREATE. */ }
  }
  return { ok: true, operation: { operationId: id, kind: "create", sandboxId: command.tags.sandboxId,
    state: proven ? "succeeded" : "outcome_unknown", desiredState: "stopped", observedState: proven ? "stopped" : "unknown",
    resourceId: proven ? command.sandboxName : null, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    error: proven ? null : { code: "OUTCOME_UNKNOWN", message: "Incus mutation outcome is unknown", retryable: false, operationId: id } } };
}

async function inspectLifecycleOperation(context: LifecycleContext) {
  const { input } = context;
  if (typeof input.operationId !== "string" || !ID.test(input.operationId)) invalid("Invalid Incus operation identity");
  const id = input.operationId;
  return id.startsWith("ezh-") ? inspectSyntheticOperation(context, id) : inspectIncusOperation(context, id);
}

async function createInstance({ session, command, project, collection, input, policy }: LifecycleContext, existing: Record<string, unknown> | null, stableId: string) {
  if (existing) {
    const config = object(existing.config);
    if (config["user.ezharness.create_key"] !== command.idempotency!.key) throw new IncusTransportError("already_exists", "Incus sandbox already exists");
    return receipt("create", command, stableId);
  }
  if (input.profile !== policy.profile || input.presetId !== policy.presetId
    || input.presetDigest !== policy.presetDigest
    || input.effectiveSettingsDigest !== policy.effectiveSettingsDigest
    || (input.desiredState !== "running" && input.desiredState !== "stopped")) invalid("Invalid Incus creation intent");
  const profile = object(metadata(await session.request("GET", `/1.0/profiles/${policy.incusProfile}?project=${project}`)));
  if (profile.name !== policy.incusProfile) denied("Incus profile identity changed");
  const devices = object(profile.devices);
  if (Object.keys(devices).sort().join(",") !== "eth0,root") denied("Incus feature profile has unexpected devices");
  const root = object(devices.root);
  if (root.type !== "disk" || root.path !== "/" || typeof root.pool !== "string" || !NAME.test(root.pool) || root.source !== undefined) denied("Incus root disk profile is unsafe");
  const nic = object(devices.eth0);
  if (nic.type !== "nic" || nic.name !== "eth0" || typeof nic.network !== "string"
    || !NAME.test(nic.network) || nic["security.port_isolation"] !== "true") {
    denied("Incus feature NIC profile is not isolated");
  }
  const body = { name: command.sandboxName, type: "container", source: { type: "image", fingerprint: policy.imageFingerprint }, profiles: [policy.incusProfile],
    devices: { root: { type: "disk", path: "/", pool: root.pool, size: String(policy.limits.diskBytes) } },
    start: input.desiredState === "running", config: {
    "user.ezharness.managed_by": managedBy, "user.ezharness.connection_id": command.connectionId, "user.ezharness.sandbox_id": command.tags.sandboxId,
    "user.ezharness.create_key": command.idempotency!.key, "user.ezharness.profile": policy.profile, "user.ezharness.preset_id": input.presetId,
    "user.ezharness.generation": "1", "user.ezharness.operation_id": stableId, "user.ezharness.desired_state": input.desiredState,
    // Incus counts limits.cpu toward the project budget; only the time-form allowance enforces a hard CPU ceiling.
    "limits.memory": String(policy.limits.memoryBytes), "limits.cpu": String(Math.ceil(policy.limits.cpuMillis / 1000)),
    "limits.cpu.allowance": `${policy.limits.cpuMillis}ms/1000ms`, "limits.processes": String(policy.limits.pids),
  } };
  try { const reply = await session.request("POST", collection, body); metadata(reply); return receipt("create", command, stableId); }
  catch (error) { throw uncertain(error, stableId); }
}

function assertMutationAllowed(context: LifecycleContext, kind: "setPower" | "destroy",
  existing: Record<string, unknown>, stableId: string) {
  const { command, input } = context;
  const current = inspection(existing, command);
  if (!Number.isSafeInteger(input.expectedGeneration) || (input.expectedGeneration !== current.generation && !(input.expectedGeneration === current.generation - 1 && object(existing.config)["user.ezharness.operation_id"] === stableId))) throw new IncusTransportError("revision_conflict", "Incus sandbox generation changed");
  const previousIntent = object(existing.config)["user.ezharness.operation_id"] === stableId;
  if (previousIntent) {
    if (kind === "setPower" && current.observedState === input.desiredState) return { current, alreadyDone: true };
    throw new IncusTransportError("unavailable", "Incus operation is still unresolved", { effect: "unknown", operationId: stableId });
  }
  if (kind === "setPower") {
    if (input.desiredState !== "running" && input.desiredState !== "stopped") invalid("Invalid Incus power state");
  } else if (current.observedState !== "stopped") throw new IncusTransportError("revision_conflict", "Incus sandbox must be stopped before destroy");
  return { current, alreadyDone: false };
}

async function patchMutationIntent(context: LifecycleContext, kind: "setPower" | "destroy",
  currentReply: Awaited<ReturnType<Session["request"]>>, generation: number, stableId: string): Promise<void> {
  const { session, instancePath, input } = context;
  if (!currentReply.etag) denied("Incus instance ETag is required for mutation");
  try { metadata(await session.request("PATCH", instancePath, { config: { "user.ezharness.generation": String(generation + 1), "user.ezharness.operation_id": stableId, "user.ezharness.desired_state": kind === "setPower" ? input.desiredState : "destroyed" } }, currentReply.etag)); }
  catch (error) { throw uncertain(error, stableId); }
}

async function applyPowerMutation(context: LifecycleContext, observedState: string, stableId: string) {
  const { session, command, project, input } = context;
  if (observedState === input.desiredState) return receipt("setPower", command, stableId);
  try { const reply = await session.request("PUT", `/1.0/instances/${command.sandboxName}/state?project=${project}`, { action: input.desiredState === "running" ? "start" : "stop", timeout: 30 }); metadata(reply); return receipt("setPower", command, acceptedOperationId(reply, "setPower", stableId)); }
  catch (error) { throw uncertain(error, stableId); }
}

async function applyDestroyMutation(context: LifecycleContext, stableId: string,
  fault?: PostEffectDestroyReplyFault, scope?: HostConnectionScope) {
  const { session, command, instancePath } = context;
  let reply: Awaited<ReturnType<Session["request"]>>;
  try { reply = await session.request("DELETE", instancePath); metadata(reply); }
  catch (error) { throw uncertain(error, stableId); }
  const providerId = acceptedOperationId(reply, "destroy", stableId);
  await maybeLoseDestroyReply(context, providerId, fault, scope);
  return receipt("destroy", command, providerId);
}

async function maybeLoseDestroyReply(context: LifecycleContext, providerId: string,
  fault?: PostEffectDestroyReplyFault, scope?: HostConnectionScope): Promise<void> {
  const { command } = context;
  if (!fault || !scope || !fault.matches(command, scope) || !/^incus-destroy-[a-f0-9-]{36}$/.test(providerId)) return;
  // The reply is lost only after the same Incus operation succeeds and this
  // pinned session independently reads the resource as absent.
  while (Date.now() < command.deadlineMs) {
    let state: string;
    try { state = (await inspectIncusOperation(context, providerId)).operation.state; }
    catch { break; }
    if (state === "succeeded") {
      if (fault.consume(command, scope)) throw new IncusTransportError("unavailable", "Incus destroy reply was lost after effect", { effect: "unknown", operationId: providerId });
      break;
    }
    if (state !== "running") break;
    await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, command.deadlineMs - Date.now()))));
  }
}

async function mutateInstance(context: LifecycleContext, kind: "setPower" | "destroy", currentReply: Awaited<ReturnType<Session["request"]>>, existing: Record<string, unknown> | null, stableId: string, fault?: PostEffectDestroyReplyFault, scope?: HostConnectionScope) {
  const { command } = context;
  if (!existing) {
    if (kind === "destroy") return receipt("destroy", command, stableId);
    throw new IncusTransportError("not_found", "Incus sandbox not found");
  }
  const { current, alreadyDone } = assertMutationAllowed(context, kind, existing, stableId);
  if (alreadyDone) return receipt("setPower", command, stableId);
  await patchMutationIntent(context, kind, currentReply, current.generation, stableId);
  return kind === "setPower" ? applyPowerMutation(context, current.observedState, stableId)
    : applyDestroyMutation(context, stableId, fault, scope);
}

async function requestLifecycleAction(session: Session, command: IncusTransportRequest, scope: HostConnectionScope, fault?: PostEffectDestroyReplyFault) {
  const project = encodeURIComponent(session.connection.project);
  const collection = `/1.0/instances?project=${project}`;
  const instancePath = `/1.0/instances/${command.sandboxName}?project=${project}`;
  const input = payload(command);
  const policy = sourceConfig(scope);
  const context: LifecycleContext = { session, command, project, collection, instancePath, input, policy };
  if (command.action === "instance.inspect") return inspectInstance(context);
  if (command.action === "instance.list") return listInstances(context);
  if (command.action === "operation.inspect") return inspectLifecycleOperation(context);
  const kind = command.action === "instance.create" ? "create" : command.action === "instance.setPower" ? "setPower" : "destroy";
  const stableId = operationId(kind, command);
  const currentReply = await session.request("GET", instancePath);
  const found = metadata(currentReply, true);
  const existing = found ? object(found) : null;
  if (existing) instanceIdentity(existing, command);
  if (kind === "create") return createInstance(context, existing, stableId);
  return mutateInstance(context, kind, currentReply, existing, stableId, fault, scope);
}

/** Host-owned lifecycle actions against one pinned Incus project and reviewed policy. */
export class HostIncusLifecycleTransport implements IncusTransport {
  constructor(private readonly connections: HostConnectionResolver, private readonly scope: HostConnectionScope, private readonly http: PinnedFetch = verifiedHttpsRequest,
    private readonly lostDestroyReply?: PostEffectDestroyReplyFault) {}

  async request(command: Readonly<IncusTransportRequest>): Promise<unknown> {
    if (!["instance.create", "instance.inspect", "instance.list", "instance.setPower", "instance.destroy", "operation.inspect"].includes(command.action)) throw new IncusTransportError("unsupported", "Incus lifecycle action is unavailable");
    return withSession(this.connections, this.scope, this.http, command,
      session => requestLifecycleAction(session, command, this.scope, this.lostDestroyReply));
  }
}

function uncertain(error: unknown, id: string): IncusTransportError {
  if (error instanceof IncusTransportError && error.effect === "none") return error;
  return new IncusTransportError(error instanceof IncusTransportError ? error.kind : "unavailable", "Incus mutation outcome is unknown", { effect: "unknown", operationId: id });
}
