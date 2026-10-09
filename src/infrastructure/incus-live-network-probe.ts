import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { isIP, connect as tcpConnect } from "node:net";
import { eq } from "drizzle-orm";
import { validateSandboxProviderMethodExchange, type SandboxProtocolOperation } from "@ezcorp/extension-contract";
import { getDb, type Database } from "../db/connection";
import { incusQualificationFixtures, sandboxBindings } from "../db/schema";
import { ReleaseProcess } from "../extensions/release-process";
import type { LiveFixtureHandle } from "./incus-live-cases";
import { canonicalIncusProbeAddress, type IncusNetworkTarget } from "./incus-live-resource-probes";
import { resourceName, metadata, withSession, type Session } from "./incus-transport/lifecycle";
import type { LiveReadbackContext } from "./incus-transport/live-readback";
import { object, verifiedHttpsRequest, connectPinnedTls, type HostConnectionResolver, type PinnedFetch } from "./incus-transport/transport";
import { ProviderConnectionStore } from "./provider-connections/store";

import { bootstrapFromEnvironment, type IncusOperatorBootstrap } from "./incus-operator/service";
import { sshOwnedNeighborChallenge } from "../../scripts/incus/inspect";

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const WAIT_MS = 100;
const SERVICE_MS = 90_000;
const SERVICE_SCRIPT = `import socket,sys,time
s=socket.socket(socket.AF_INET,socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,0)
s.bind(('0.0.0.0',0))
s.listen(4)
s.settimeout(1)
print(s.getsockname()[1],flush=True)
end=time.monotonic()+75
while time.monotonic()<end:
 try:
  c,_=s.accept()
 except socket.timeout:
  continue
 with c:
  c.settimeout(2)
  c.sendall(sys.argv[1].encode('ascii'))`;

type GuestCall = (installationId: string, bindingId: string, operation: SandboxProtocolOperation,
  input: Record<string, unknown>) => Promise<unknown>;

export interface IncusLiveNetworkProbeDependencies {
  db?: Database;
  observerBootstrap?: () => IncusOperatorBootstrap | null;
  observeNeighbor?: typeof sshOwnedNeighborChallenge;
  connections?: HostConnectionResolver;
  http?: PinnedFetch;
  /** Test seam. Production always calls the protected active release. */
  invokeGuest?: GuestCall;
  /** Test seam for the existing authenticated TLS connection. */
  pinnedConnect?: typeof connectPinnedTls;
  /** Test seam for a host TCP connection. */
  connect?: (target: IncusNetworkTarget, expected?: string) => Promise<boolean>;
}

function requireNetwork(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Incus live network probe unavailable: ${message}`);
}

export async function invokeProtectedIncusGuest(installationId: string, bindingId: string,
  operation: SandboxProtocolOperation,
  input: Record<string, unknown>): Promise<unknown> {
  const process = new ReleaseProcess(installationId);
  try { return (await process.callIncusSandboxOperation(bindingId, operation, input)).result; }
  finally { process.kill(); await process.whenCallsSettled(); }
}

async function withControlDeadline<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new Error("Incus live network probe unavailable: pinned management connection deadline expired"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    if (signal.aborted) return await cancelled;
    return await Promise.race([operation(), cancelled]);
  } finally { signal.removeEventListener("abort", abort); }
}

function ipv4(value: unknown): number | null {
  if (typeof value !== "string" || isIP(value) !== 4) return null;
  const parts = value.split(".").map(Number);
  if (parts.length !== 4) return null;
  return ((parts[0]! * 0x1000000) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!) >>> 0;
}

function addressOnBridge(address: unknown, cidr: unknown): address is string {
  if (typeof cidr !== "string") return false;
  const [gateway, prefixText] = cidr.split("/");
  const a = ipv4(address);
  const g = ipv4(gateway);
  const prefix = Number(prefixText);
  if (a === null || g === null || !Number.isInteger(prefix) || prefix < 2 || prefix > 30) return false;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  const network = g & mask;
  return (a & mask) === network && a !== g && a !== network && a !== ((network | ~mask) >>> 0);
}

export function connectHostTarget(target: IncusNetworkTarget, expected?: string): Promise<boolean> {
  return new Promise(resolve => {
    if (!isIP(target.address) || !Number.isSafeInteger(target.port) || target.port < 1 || target.port > 65535) {
      resolve(false); return;
    }
    const socket = tcpConnect({ host: target.address, port: target.port });
    let done = false;
    const finish = (value: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(2_000, () => finish(false));
    socket.once("error", () => finish(false));
    if (expected) {
      const chunks: Buffer[] = [];
      let length = 0;
      socket.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > 128) { finish(false); return; }
        chunks.push(chunk);
        if (length >= expected.length) finish(Buffer.concat(chunks).toString("ascii") === expected);
      });
      socket.once("end", () => finish(false));
    } else socket.once("connect", () => finish(true));
  });
}

/** Host-owned neighbor target. The port comes from a protected process in the exact fixture. */
export class IncusLiveNetworkProbe {
  private readonly db: Database;
  private readonly connections: HostConnectionResolver;
  private readonly http: PinnedFetch;
  private readonly invokeGuest: GuestCall;
  private readonly pinnedConnect: typeof connectPinnedTls;
  private readonly connect: NonNullable<IncusLiveNetworkProbeDependencies["connect"]>;
  private readonly observerBootstrap: () => IncusOperatorBootstrap | null;
  private readonly observeNeighbor: typeof sshOwnedNeighborChallenge;
  private readonly challenges = new WeakMap<IncusNetworkTarget, {
    token: string; context: LiveReadbackContext; neighbor: LiveFixtureHandle; generation: number;
  }>();
  private readonly managementTargets = new WeakSet<IncusNetworkTarget>();
  private readonly neighborTargets = new Map<string, WeakRef<IncusNetworkTarget>>();

  constructor(deps: IncusLiveNetworkProbeDependencies = {}) {
    this.db = deps.db ?? getDb();
    this.connections = deps.connections ?? new ProviderConnectionStore(this.db);
    this.http = deps.http ?? verifiedHttpsRequest;
    this.invokeGuest = deps.invokeGuest ?? invokeProtectedIncusGuest;
    this.pinnedConnect = deps.pinnedConnect ?? connectPinnedTls;
    this.connect = deps.connect ?? connectHostTarget;
    this.observerBootstrap = deps.observerBootstrap ?? bootstrapFromEnvironment;
    this.observeNeighbor = deps.observeNeighbor ?? sshOwnedNeighborChallenge;
  }

  private controlScope(context: LiveReadbackContext) {
    return Object.freeze({
      connectionId: context.scope.connectionId, project: context.recipe.project.name,
      profile: context.preset.profile, incusProfile: context.recipe.profile.name,
      network: context.recipe.network.name, bridgeCIDR: context.recipe.network.config["ipv4.address"],
      presetId: context.preset.id, imageFingerprint: context.preset.imageDigest,
    });
  }

  private async observer(context: LiveReadbackContext, extra: Record<string, unknown>) {
    return this.pinnedSession(context, undefined, async session => {
      const scope = { ...context.scope };
      const revision = context.connection.revision;
      const expected = { ...session.connection };
      const bootstrap = this.observerBootstrap();
      requireNetwork(bootstrap && bootstrap.ssh.sshMode === "reviewed-envelope-v1"
        && bootstrap.endpoint === session.origin.origin
        && bootstrap.ssh.sshHostKeySha256 === context.recipe.expected.sshHostKeySha256,
      "reviewed neighbor control transport is unavailable");
      const fixed = this.controlScope(context);
      const result = await withControlDeadline(session.signal, () => this.observeNeighbor({ ...bootstrap.ssh },
        { version: 1, ...fixed, ...extra }, session.signal));
      await this.assertManagementConnection(scope, revision, expected, session.signal);
      requireNetwork(!session.signal.aborted && result.exitCode === 0 && !result.timedOut
        && result.stderr === "" && Buffer.byteLength(result.stdout) <= 4096,
      "reviewed neighbor control response is invalid");
      let reply: unknown;
      try { reply = JSON.parse(result.stdout); }
      catch { throw new Error("Incus live network probe unavailable: reviewed neighbor control response is invalid"); }
      requireNetwork(reply && typeof reply === "object" && !Array.isArray(reply),
        "reviewed neighbor control response is invalid");
      return { reply: reply as Record<string, unknown>, fixed };
    });
  }

  async assertControlCapability(context: LiveReadbackContext): Promise<void> {
    let observed: Awaited<ReturnType<IncusLiveNetworkProbe["observer"]>>;
    try { observed = await this.observer(structuredClone(context), { action: "capabilities" }); }
    catch { throw new Error("Incus live network probe unavailable: reviewed neighbor control transport is unavailable"); }
    const { reply, fixed } = observed;
    const expected = { version: 1, purpose: "owned-neighbor-challenge", ...fixed, supported: true };
    requireNetwork(Object.keys(reply).length === Object.keys(expected).length
      && Object.entries(expected).every(([key, value]) => reply[key] === value),
    "reviewed neighbor control response is invalid");
  }

  private async challenge(target: IncusNetworkTarget,
    registered: { token: string; context: LiveReadbackContext; neighbor: LiveFixtureHandle; generation: number }): Promise<boolean> {
    const { token, context, neighbor, generation } = registered;
    requireNetwork(await this.exactFixture(context, neighbor) === generation, "neighbor binding changed or stopped");
    requireNetwork(await this.backendAddress(context, neighbor.sandboxId) === target.address,
      "backend neighbor state changed");
    const { reply, fixed } = await this.observer(context, { action: "challenge",
      sandboxId: neighbor.sandboxId, instance: resourceName(context.scope.connectionId, neighbor.sandboxId),
      address: target.address, port: target.port, token });
    const expected = { version: 1, purpose: "owned-neighbor-challenge", ...fixed, supported: true,
      instance: resourceName(context.scope.connectionId, neighbor.sandboxId),
      address: target.address, port: target.port };
    requireNetwork(Object.keys(reply).length === Object.keys(expected).length + 1
      && Object.entries(expected).every(([key, value]) => reply[key] === value)
      && typeof reply.reachable === "boolean", "reviewed neighbor control response is invalid");
    requireNetwork(await this.exactFixture(context, neighbor) === generation, "neighbor binding changed or stopped");
    requireNetwork(await this.backendAddress(context, neighbor.sandboxId) === target.address,
      "backend neighbor state changed");
    return reply.reachable;
  }

  private async guest(context: LiveReadbackContext, bindingId: string,
    operation: "processes.start" | "processes.readOutput", input: Record<string, unknown>) {
    const now = Date.now();
    const identity = `qual-network-${randomBytes(16).toString("hex")}`;
    const payload = { ...input, providerId: "incus", connectionId: context.scope.connectionId,
      sandboxId: bindingId, rpcDeadlineMs: now + 30_000,
      ...(operation === "processes.start" ? { user: context.connection.configuration.guestUser,
        requestId: identity, idempotencyKey: identity } : {}) };
    const result = await this.invokeGuest(context.scope.installationId, bindingId, operation, payload);
    const validated = validateSandboxProviderMethodExchange(operation, payload, result).result;
    requireNetwork(!!validated && typeof validated === "object" && (validated as Record<string, unknown>).ok === true,
      "protected guest call failed");
    return validated as Record<string, unknown>;
  }

  private async exactFixture(context: LiveReadbackContext, neighbor: LiveFixtureHandle): Promise<number> {
    requireNetwork(ID.test(neighbor.sandboxId) && ID.test(neighbor.operationId), "invalid neighbor identity");
    const [fixture] = await this.db.select().from(incusQualificationFixtures)
      .where(eq(incusQualificationFixtures.operationId, neighbor.operationId)).limit(1);
    requireNetwork(fixture && fixture.bindingId === neighbor.sandboxId
      && fixture.installationId === context.scope.installationId && fixture.releaseId === context.scope.releaseId
      && fixture.connectionId === context.scope.connectionId && fixture.connectionRevision === context.connection.revision
      && fixture.presetId === context.preset.id && fixture.presetDigest === context.presetDigest
      && fixture.effectiveSettingsDigest === context.effectiveSettingsDigest, "neighbor fixture ownership changed");
    const [binding] = await this.db.select().from(sandboxBindings)
      .where(eq(sandboxBindings.id, neighbor.sandboxId)).limit(1);
    requireNetwork(binding && binding.projectId === fixture.projectId
      && binding.providerInstallationId === fixture.installationId && binding.providerReleaseId === fixture.releaseId
      && binding.connectionId === fixture.connectionId && binding.connectionRevision === fixture.connectionRevision
      && binding.presetId === fixture.presetId && binding.presetDigest === fixture.presetDigest
      && binding.effectiveSettingsDigest === fixture.effectiveSettingsDigest
      && binding.resourceKey === fixture.bindingId && !binding.tombstonedAt
      && binding.desiredState === "RUNNING" && binding.observedState === "RUNNING",
    "neighbor binding changed or stopped");
    requireNetwork(Number.isSafeInteger(binding.generation) && binding.generation > 0, "neighbor binding changed or stopped");
    return binding.generation;
  }

  private async pinnedSession<T>(context: LiveReadbackContext, sandboxId: string | undefined,
    run: (session: Session) => Promise<T>): Promise<T> {
    const certificate = new X509Certificate(context.connection.serverCertificatePem);
    const { scope, connection, preset } = context;
    const request = { action: sandboxId ? "instance.inspect" as const : "instance.list" as const, connectionId: scope.connectionId,
      deadlineMs: Date.now() + 30_000,
      pins: { connectionId: scope.connectionId,
        serverCertificateSha256: createHash("sha256").update(certificate.raw).digest("hex"),
        project: connection.project, profile: connection.configuration.profile,
        helperVersion: connection.configuration.helperVersion, guestUser: connection.configuration.guestUser },
      tags: { managedBy: "ezharness-incus-sandbox" as const, connectionId: scope.connectionId, ...(sandboxId ? { sandboxId } : {}) },
      ...(sandboxId ? { sandboxName: resourceName(scope.connectionId, sandboxId) } : {}),
      payload: { providerId: "incus", profile: preset.profile, presetId: preset.id,
        presetDigest: context.presetDigest, effectiveSettingsDigest: context.effectiveSettingsDigest, allocate: false } };
    const policy = { providerInstallationId: scope.installationId, providerReleaseId: scope.releaseId,
      revision: connection.revision, approvedPreset: { profile: preset.profile,
        incusProfile: context.recipe.profile.name, presetId: preset.id,
        presetDigest: context.presetDigest, effectiveSettingsDigest: context.effectiveSettingsDigest,
        imageFingerprint: preset.imageDigest, limits: preset.limits } };
    return withSession(this.connections, policy, this.http, request, run);
  }

  /** Resolve the control IP from the authenticated socket, never a second DNS query. */
  async managementTarget(context: LiveReadbackContext): Promise<IncusNetworkTarget> {
    const scope = { ...context.scope };
    const revision = context.connection.revision;
    return this.pinnedSession(context, undefined, async session => {
      const expected = { ...session.connection };
      const hostname = session.origin.hostname.replace(/^\[|\]$/g, "");
      const port = Number(session.origin.port || 443);
      const socket = await this.pinnedConnect(hostname, port, session.tls, session.signal);
      try {
        const address = socket.remoteAddress;
        const peerPort = socket.remotePort;
        requireNetwork(canonicalIncusProbeAddress(address) && peerPort === port,
          "pinned management peer address is unavailable");
        await this.assertManagementConnection(scope, revision, expected, session.signal);
        const target = Object.freeze({ address: address!, port });
        this.managementTargets.add(target);
        return target;
      } finally { socket.destroy(); }
    });
  }

  private async assertManagementConnection(scope: LiveReadbackContext["scope"], revision: number,
    expected: Session["connection"], signal: AbortSignal): Promise<void> {
    const current = await withControlDeadline(signal, () => this.connections.resolveForHost({
      connectionId: scope.connectionId, providerInstallationId: scope.installationId,
      providerReleaseId: scope.releaseId, revision }));
    requireNetwork(!signal.aborted && ["endpoint", "project", "serverCertificatePem", "clientCertificatePem", "privateKeyPem"]
      .every(key => current[key as keyof typeof current] === expected[key as keyof typeof current]),
    "pinned management connection changed");
  }

  private async backendAddress(context: LiveReadbackContext, sandboxId: string): Promise<string> {
    return this.pinnedSession(context, sandboxId, async session => {
      const { scope, preset } = context;
      const sandboxName = resourceName(scope.connectionId, sandboxId);
      const path = `/1.0/instances/${sandboxName}?project=${encodeURIComponent(session.connection.project)}`;
      const instance = object(metadata(await session.request("GET", path)));
      const config = object(instance.config);
      const devices = object(instance.expanded_devices);
      const nic = object(devices.eth0);
      requireNetwork(instance.name === sandboxName && instance.type === "container"
        && instance.status === "Running" && config["user.ezharness.managed_by"] === "ezharness-incus-sandbox"
        && config["user.ezharness.connection_id"] === scope.connectionId
        && config["user.ezharness.sandbox_id"] === sandboxId
        && config["user.ezharness.profile"] === preset.profile
        && config["user.ezharness.preset_id"] === preset.id
        && config["volatile.base_image"] === preset.imageDigest
        && Array.isArray(instance.profiles) && instance.profiles.includes(context.recipe.profile.name)
        && Object.keys(devices).sort().join(",") === "eth0,root"
        && nic.type === "nic" && nic.network === context.recipe.network.name
        && nic["security.port_isolation"] === "true", "backend neighbor identity changed");
      const state = object(metadata(await session.request("GET", `${path.replace("?", "/state?")}`)));
      const network = object(state.network);
      const eth0 = object(network.eth0);
      const addresses = eth0.addresses;
      requireNetwork(state.status === "Running" && Array.isArray(addresses), "backend neighbor state changed");
      const candidates = addresses.filter((item): item is Record<string, unknown> =>
        !!item && typeof item === "object" && !Array.isArray(item)
        && item.family === "inet" && item.scope === "global");
      requireNetwork(candidates.length === 1
        && addressOnBridge(candidates[0]?.address, context.recipe.network.config["ipv4.address"]),
      "exact neighbor bridge address is unavailable");
      return candidates[0]!.address as string;
    });
  }

  async neighborTarget(context: LiveReadbackContext,
    neighbor: LiveFixtureHandle): Promise<IncusNetworkTarget & { sandboxId: string }> {
    context = structuredClone(context);
    neighbor = Object.freeze({ ...neighbor });
    const generation = await this.exactFixture(context, neighbor);
    const address = await this.backendAddress(context, neighbor.sandboxId);
    const token = randomBytes(24).toString("hex");
    const started = await this.guest(context, neighbor.sandboxId, "processes.start", {
      argv: ["python3", "-c", SERVICE_SCRIPT, token], cwd: ".", env: [],
      processDeadlineMs: Date.now() + SERVICE_MS,
    });
    requireNetwork(typeof started.processId === "string" && ID.test(started.processId)
      && typeof started.bootId === "string" && ID.test(started.bootId), "neighbor listener identity missing");
    let offset = 0;
    let line = "";
    for (let attempt = 0; attempt < 50; attempt++) {
      const output = await this.guest(context, neighbor.sandboxId, "processes.readOutput", {
        processId: started.processId, bootId: started.bootId,
        cursor: { sandboxId: neighbor.sandboxId, processId: started.processId,
          bootId: started.bootId, offsetBytes: offset }, maxBytes: 128,
      });
      requireNetwork(!output.gap && Array.isArray(output.chunks), "neighbor listener output has a gap");
      for (const chunk of output.chunks as Record<string, unknown>[]) {
        const bytes = Buffer.from(String(chunk.dataBase64), "base64");
        requireNetwork(chunk.stream === "stdout" && chunk.offsetBytes === offset
          && chunk.byteLength === bytes.length && bytes.length <= 16 && line.length + bytes.length <= 16,
        "neighbor listener output changed");
        offset += bytes.length;
        line += bytes.toString("ascii");
      }
      const match = /^([1-9][0-9]{0,4})\n$/.exec(line);
      if (match) {
        requireNetwork(Number(match[1]) <= 65535, "neighbor listener port is invalid");
        const target = Object.freeze({ sandboxId: neighbor.sandboxId, address, port: Number(match[1]) });
        requireNetwork(await this.exactFixture(context, neighbor) === generation, "neighbor binding changed or stopped");
        this.challenges.set(target, {
          token, generation, context: structuredClone(context), neighbor: Object.freeze({ ...neighbor }),
        });
        this.neighborTargets.set(`${address}:${target.port}`, new WeakRef(target));
        return target;
      }
      requireNetwork(/^[0-9]{0,5}$/.test(line), "neighbor listener port is invalid");
      requireNetwork(output.nextCursor && typeof output.nextCursor === "object"
        && (output.nextCursor as Record<string, unknown>).offsetBytes === offset
        && output.eof !== true, "neighbor listener ended before it was ready");
      await new Promise(resolve => setTimeout(resolve, WAIT_MS));
    }
    throw new Error("Incus live network probe unavailable: neighbor listener did not become ready");
  }

  async hostCanConnect(target: IncusNetworkTarget): Promise<boolean> {
    const registered = this.neighborTargets.get(`${target.address}:${target.port}`)?.deref();
    if (registered && registered !== target) return false;
    const challenge = this.challenges.get(target);
    if (registered && !challenge) return false;
    if (!challenge && !this.managementTargets.has(target)) return false;
    try { return challenge ? await this.challenge(target, challenge) : await this.connect(target); }
    catch { return false; }
  }
}
