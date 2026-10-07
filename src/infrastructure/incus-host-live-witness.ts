import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import { resolveSandboxPreset, sandboxPresetDigest, validateSandboxProviderMethodExchange,
  type SandboxPreset, type SandboxProtocolOperation } from "@ezcorp/extension-contract";
import type { LiveSandboxPreviewProof } from "@ezcorp/extension-contract";
import { getDb, type Database } from "../db/connection";
import { incusQualificationFixtures, projectMembers, previewSessions, sandboxBindings, type SandboxOperation } from "../db/schema";
import { createConversation, deleteConversation } from "../db/queries/conversations";
import { createPreviewSession, revokePreview } from "../db/queries/preview-sessions";
import { mintOneTimeCode, signPreviewToken } from "../runtime/preview/preview-token";
import { registerQualificationPreviewTarget } from "../runtime/preview/preview-target";
import { sameSandboxWorkspaceBinding, sandboxWorkspaceTarget, workspaceTargetReference,
  type SandboxPreviewBackend, type SandboxWorkspaceBinding } from "../runtime/workspaces/target";
import { releaseRows } from "../db/queries/extension-releases";
import { getReleaseRuntime, ReleaseProcess, resolveActiveRelease,
  type ActiveExtensionRelease } from "../extensions/release-process";
import type { IncusSetupRecipe } from "../../scripts/incus/model";
import { assertIncusQualificationOwner, IncusQualificationOperationUnsettledError, IncusQualificationFixtureService, IncusQualificationStore, type IncusImageReceipt,
  type IncusQualificationScope } from "./incus-qualification";
import { incusGuestFailureCauseCode, INCUS_WITNESS_GUEST_OPERATIONS, type HostIncusLiveWitness, type LiveFixtureHandle, type LiveFixtureInspection } from "./incus-live-cases";
import { observeIncusResourceEnforcement, type IncusNetworkTarget } from "./incus-live-resource-probes";
import { exerciseIncusLimits } from "./incus-live-limit-probe";
import { loadIncusMemoryStressAsset } from "./incus-memory-stress-asset";
import { IncusLiveNetworkProbe } from "./incus-live-network-probe";
import { HostIncusLiveReadback, type LiveReadbackContext } from "./incus-transport/live-readback";
import { ProviderConnectionStore, type ProviderConnectionCredentials,
  type ProviderConnectionScope } from "./provider-connections/store";
import { IncusQualificationCheckpointStore } from "./incus-qualification-checkpoint";
import { registerClaimedQualificationPreview } from "./incus-qualification-preview-permit";
import { IncusSandboxPreviewBackend } from "./incus-preview-backend";
import type { IncusPreviewTrafficDriver } from "./incus-preview-traffic";
import { IncusQualificationContinuation } from "./incus-qualification-continuation";
import { requestIncusSupervisorReadiness, requestIncusSupervisorReceipt, type IncusSupervisorSelectedPin,
  requestIncusSupervisorRestart, releaseTerminalIncusQualification } from "./incus-qualification-supervisor-client";
import { observeFailedCleanupRecovery } from "./incus-live-recovery-probes";
import { IncusLiveCleanupController } from "./incus-live-cleanup-controller";
import { logger } from "../logger";
import { incusSupervisorPublicKeyPem } from "./incus-supervisor-public-key";

const MAX_FILE_BYTES = 64 * 1024;
const POLL_MS = 100;
const CONTROL_DENIALS = ["unsupported", "missingControl", "drift", "unqualified"] as const;
type ControlDenial = (typeof CONTROL_DENIALS)[number];
const guestOperations = new Set<SandboxProtocolOperation>(INCUS_WITNESS_GUEST_OPERATIONS);
const PREVIEW_PORT = 4173;
const PREVIEW_PYTHON = `import base64,hashlib,http.server,os,socketserver
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_GET(self):
  if self.path=="/redirect":
   self.send_response(302); self.send_header("Location","http://127.0.0.1:1/"); self.end_headers(); return
  if self.path!="/proof": self.send_error(404); return
  payload=os.environ["EZH_QUAL_CHALLENGE"].encode()
  if self.headers.get("Upgrade","").lower()=="websocket":
   key=self.headers.get("Sec-WebSocket-Key","")
   if not key or self.headers.get("Sec-WebSocket-Protocol")!="vite-hmr": self.send_error(403); return
   accept=base64.b64encode(hashlib.sha1((key+"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
   self.send_response(101); self.send_header("Upgrade","websocket"); self.send_header("Connection","Upgrade")
   self.send_header("Sec-WebSocket-Accept",accept); self.send_header("Sec-WebSocket-Protocol","vite-hmr"); self.end_headers()
   first=self.rfile.read(2)
   if len(first)!=2 or first[1]&128==0 or first[1]&127>125: return
   mask=self.rfile.read(4); size=first[1]&127; encoded=self.rfile.read(size)
   value=bytes(byte^mask[index%4] for index,byte in enumerate(encoded))
   if value!=payload: return
   self.wfile.write(bytes([129,len(payload)])+payload); self.wfile.flush()
  else:
   self.send_response(200); self.send_header("Content-Length",str(len(payload))); self.end_headers(); self.wfile.write(payload)
class Server(socketserver.ThreadingMixIn,http.server.HTTPServer): daemon_threads=True
Server(("127.0.0.1",4173),Handler).serve_forever()`;

/** This checks operator wiring before allocation. Only the full live run can publish SP evidence. */
export async function incusHostLiveWitnessReady(deps: {
  env?: NodeJS.ProcessEnv;
  expectedPin?: IncusSupervisorSelectedPin;
  supervisorReadiness?: typeof requestIncusSupervisorReadiness;
  terminalRelease?: typeof releaseTerminalIncusQualification;
} = {}): Promise<boolean> {
  const env = deps.env ?? process.env;
  const root = env.EZCORP_INCUS_CONTROL_PROBE_ROOT;
  const socket = env.EZCORP_INCUS_SUPERVISOR_SOCKET;
  const project = env.EZCORP_INCUS_QUALIFICATION_USER_PROJECT_ID;
  const image = env.EZCORP_INCUS_COMPOSE_FIXTURE_IMAGE_REF;
  if (process.platform !== "linux" || !root?.startsWith("/") || !socket?.startsWith("/")
    || !project || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(project)
    || !image || !/^[a-z0-9][a-z0-9.-]+(?::[1-9][0-9]{0,4})?\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/.test(image)
    || typeof process.getuid !== "function") return false;
  try {
    if (!incusSupervisorPublicKeyPem(env)) return false;
    const [rootStat, socketStat, canonicalRoot] = await Promise.all([
      lstat(root), lstat(socket), realpath(root),
    ]);
    if (canonicalRoot !== root || !rootStat.isDirectory() || rootStat.isSymbolicLink()
      || (rootStat.mode & 0o077) !== 0 || rootStat.uid !== process.getuid()
      || !socketStat.isSocket() || socketStat.isSymbolicLink()) return false;
    // A missed post-commit IPC can be recovered from the host-owned terminal row.
    // Failed proof leaves the supervisor claim intact; readiness still refuses it.
    await (deps.terminalRelease ?? releaseTerminalIncusQualification)(undefined, env).catch(() => undefined);
    return await (deps.supervisorReadiness ?? requestIncusSupervisorReadiness)(socket, deps.expectedPin);
  } catch { return false; }
}

export class IncusLiveWitnessError extends Error {
  readonly code?: string;
  constructor(reason: string, operation?: unknown, providerCode?: unknown) {
    super(`Incus live witness unavailable: ${reason}`);
    this.name = "IncusLiveWitnessError";
    if (operation !== undefined) this.code = incusGuestFailureCauseCode(operation, providerCode);
  }
}

function deny(reason: string): never {
  throw new IncusLiveWitnessError(reason);
}

function reply(value: unknown, operation: SandboxProtocolOperation): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) deny("invalid guest reply");
  const result = value as Record<string, unknown>;
  if (result.ok !== true) {
    const error = result.error as Record<string, unknown> | undefined;
    throw new IncusLiveWitnessError("guest action failed", operation, error?.code);
  }
  return result;
}

function safePath(path: string): string {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")
    || path.split("/").some(part => part === ".." || part === "")) deny("invalid guest path");
  return path;
}

function inventoryIds(values: string[]): string {
  if (!Array.isArray(values) || values.some(value => typeof value !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value))
    || new Set(values).size !== values.length) deny("control inventory identity is invalid");
  return [...values].sort().join("\0");
}

export interface IncusHostLiveWitnessDependencies {
  db?: Database;
  qualifications?: IncusQualificationStore;
  fixtures?: IncusQualificationFixtureService;
  qualificationOwnerId?: string;
  /** Replace only with a test seam that performs the same protected release call. */
  invokeGuest?: (installationId: string, bindingId: string, operation: SandboxProtocolOperation,
    input: Record<string, unknown>) => Promise<unknown>;
  activeRelease?: (installationId: string) => Promise<ActiveExtensionRelease>;
  resolveConnection?: (scope: ProviderConnectionScope) => Promise<ProviderConnectionCredentials>;
  readSetup?: (installationId: string) => Promise<IncusImageReceipt | null>;
  backend?: Pick<HostIncusLiveReadback, "image" | "instance"> & {
    /** Added by the pinned host readback; absent implementations fail SP04. */
    poolResources?: (context: LiveReadbackContext) => Promise<{ freeBytes: number }>;
  };
  /** An operator-owned probe must call production admission and read independent
   * reservation, operation, backend inventory, and local canary state. No default. */
  controlProbe?: {
    snapshot(kind: ControlDenial, scope: IncusQualificationScope): Promise<{
      reservationIds: string[]; operationIds: string[]; backendIds: string[];
      canaryIdentity: string; canaryBytes: Uint8Array;
    }>;
    attempt(kind: ControlDenial, scope: IncusQualificationScope, preset: SandboxPreset): Promise<string>;
  };
  /** Host-owned source of a running, distinct sandbox service and independent
   * host reachability checks. */
  resourceNetwork?: {
    assertControlCapability(context: LiveReadbackContext): Promise<void>;
    managementTarget(context: LiveReadbackContext): Promise<IncusNetworkTarget>;
    neighborTarget(context: LiveReadbackContext, neighbor: LiveFixtureHandle): Promise<IncusNetworkTarget & {
      sandboxId: string;
    }>;
    hostCanConnect(target: IncusNetworkTarget): Promise<boolean>;
  };
  /** Operator-owned fault controller. It must use the one-shot post-effect
   * destroy fault, call real feature preparation for readiness, then reopen
   * the durable controller and reconcile the same journaled operation. */
  cleanupRecovery?: {
    injectLostDestroyReply(scope: IncusQualificationScope, handle: LiveFixtureHandle): Promise<void>;
    attemptReadiness(scope: IncusQualificationScope, handle: LiveFixtureHandle): Promise<void>;
    reconcileFromReopenedController(scope: IncusQualificationScope, handle: LiveFixtureHandle): Promise<void>;
  };
  /** This is the real app listener traffic driver and the production Incus relay. */
  previewTraffic?: IncusPreviewTrafficDriver;
  previewBackend?: IncusSandboxPreviewBackend;
  supervisorSocketPath?: string;
  now?: () => number;
}

async function readSetup(db: Database, installationId: string): Promise<IncusImageReceipt | null> {
  const [row] = releaseRows<IncusImageReceipt>(await db.execute(sql`SELECT
    provider_release_id AS "providerReleaseId", provider_release_digest AS "providerReleaseDigest",
    connection_id AS "connectionId", connection_revision AS "connectionRevision", state, recipe
    FROM incus_operator_setups WHERE provider_installation_id = ${installationId}
    ORDER BY created_at DESC, id DESC LIMIT 1`));
  return row ?? null;
}

async function invokeRelease(installationId: string, bindingId: string, operation: SandboxProtocolOperation,
  input: Record<string, unknown>): Promise<unknown> {
  const process = new ReleaseProcess(installationId);
  try {
    return (await process.callIncusSandboxOperation(bindingId, operation, input)).result;
  } finally {
    process.kill();
    await process.whenCallsSettled();
  }
}

/** Host authority for a qualification fixture. It never accepts a user binding.
 * The durable runner uses beginRestart/claimRestart. The legacy one-process
 * restart method stays closed because it cannot survive its own process exit. */
export class IncusHostLiveWitness implements HostIncusLiveWitness {
  private readonly db: Database;
  private readonly qualifications: IncusQualificationStore;
  private readonly fixtures: IncusQualificationFixtureService;
  private readonly invokeGuest: NonNullable<IncusHostLiveWitnessDependencies["invokeGuest"]>;
  private readonly activeRelease: NonNullable<IncusHostLiveWitnessDependencies["activeRelease"]>;
  private readonly resolveConnection: NonNullable<IncusHostLiveWitnessDependencies["resolveConnection"]>;
  private readonly readSetup: NonNullable<IncusHostLiveWitnessDependencies["readSetup"]>;
  private readonly backend: NonNullable<IncusHostLiveWitnessDependencies["backend"]>;
  private readonly controlProbe: IncusHostLiveWitnessDependencies["controlProbe"];
  private readonly resourceNetwork: IncusHostLiveWitnessDependencies["resourceNetwork"];
  private readonly cleanupRecovery: IncusHostLiveWitnessDependencies["cleanupRecovery"];
  private readonly previewTraffic: IncusHostLiveWitnessDependencies["previewTraffic"];
  private readonly previewBackend: IncusHostLiveWitnessDependencies["previewBackend"];
  private readonly now: () => number;
  private readonly supervisorSocketPath: string | undefined;

  constructor(deps: IncusHostLiveWitnessDependencies = {}) {
    this.db = deps.db ?? getDb();
    this.qualifications = deps.qualifications ?? new IncusQualificationStore({ db: this.db });
    this.fixtures = deps.fixtures ?? new IncusQualificationFixtureService({ db: this.db,
      qualifications: this.qualifications, qualificationOwnerId: deps.qualificationOwnerId });
    this.invokeGuest = deps.invokeGuest ?? invokeRelease;
    this.activeRelease = deps.activeRelease ?? (id => resolveActiveRelease(id, getReleaseRuntime()));
    this.resolveConnection = deps.resolveConnection ?? (scope => new ProviderConnectionStore(this.db).resolveForHost(scope));
    this.readSetup = deps.readSetup ?? (id => readSetup(this.db, id));
    this.backend = deps.backend ?? new HostIncusLiveReadback(new ProviderConnectionStore(this.db));
    this.controlProbe = deps.controlProbe;
    this.previewTraffic = deps.previewTraffic;
    this.previewBackend = deps.previewBackend;
    this.resourceNetwork = deps.resourceNetwork ?? new IncusLiveNetworkProbe({ db: this.db });
    this.now = deps.now ?? Date.now;
    this.supervisorSocketPath = deps.supervisorSocketPath ?? process.env.EZCORP_INCUS_SUPERVISOR_SOCKET;
    const readinessProjectId = process.env.EZCORP_INCUS_QUALIFICATION_USER_PROJECT_ID;
    this.cleanupRecovery = deps.cleanupRecovery ?? (this.supervisorSocketPath && readinessProjectId
      ? new IncusLiveCleanupController({ db: this.db, fixtures: this.fixtures,
        qualifications: this.qualifications, readinessProjectId }) : undefined);
  }

  private async continuation(scope: IncusQualificationScope, preset: SandboxPreset) {
    const { context } = await this.context(scope, preset);
    return new IncusQualificationContinuation({
      checkpoints: new IncusQualificationCheckpointStore(this.db), fixtures: this.fixtures,
      readback: this.backend, context,
    });
  }

  async findFixture(scope: IncusQualificationScope, operationId: string): Promise<LiveFixtureHandle> {
    const readback = await this.fixtures.status(scope, operationId);
    const handle = { operationId, sandboxId: readback.fixture.bindingId };
    await this.owned(handle, false);
    return handle;
  }

  async beginRestart(scope: IncusQualificationScope, preset: SandboxPreset,
    handle: LiveFixtureHandle, runId: string, nonce: string, deadlineMs: number): Promise<void> {
    if (!this.supervisorSocketPath) deny("operator supervisor socket is unavailable");
    const prepared = await (await this.continuation(scope, preset))
      .prepare({ runId, nonce, deadlineMs, scope, handle });
    await requestIncusSupervisorRestart(this.supervisorSocketPath, {
      version: 1, action: "restart", runId, nonce, deadlineMs, scope,
      fixtureOperationId: prepared.fixtureOperationId, bindingId: prepared.bindingId,
      generation: prepared.generation, connectionRevision: prepared.connectionRevision,
      lastOperationId: prepared.lastOperationId, beforeDigest: prepared.beforeDigest,
    });
  }

  async claimRestart(scope: IncusQualificationScope, preset: SandboxPreset,
    runId: string, nonce: string): Promise<LiveFixtureHandle> {
    if (!this.supervisorSocketPath) deny("operator supervisor socket is unavailable");
    const claimed = await (await this.continuation(scope, preset)).resume(runId, nonce,
      payload => requestIncusSupervisorReceipt(this.supervisorSocketPath!, runId, nonce,
        payload.afterDigest, payload.deadlineMs));
    if (claimed.scope.installationId !== scope.installationId || claimed.scope.releaseId !== scope.releaseId
      || claimed.scope.connectionId !== scope.connectionId || claimed.scope.presetId !== scope.presetId) {
      deny("claimed qualification scope changed");
    }
    return claimed.handle;
  }

  private async persistedOwned(handle: LiveFixtureHandle, requireRunning: boolean, allowTombstoned = false) {
    const [fixture] = await this.db.select().from(incusQualificationFixtures)
      .where(eq(incusQualificationFixtures.operationId, handle.operationId)).limit(1);
    if (!fixture || fixture.bindingId !== handle.sandboxId) deny("fixture identity changed");
    const [binding] = await this.db.select().from(sandboxBindings)
      .where(eq(sandboxBindings.id, fixture.bindingId)).limit(1);
    if (!binding || binding.projectId !== fixture.projectId || binding.resourceKey !== fixture.bindingId
      || binding.providerInstallationId !== fixture.installationId || binding.providerReleaseId !== fixture.releaseId
      || binding.connectionId !== fixture.connectionId || binding.connectionRevision !== fixture.connectionRevision
      || binding.presetId !== fixture.presetId || binding.presetDigest !== fixture.presetDigest
      || binding.effectiveSettingsDigest !== fixture.effectiveSettingsDigest
      || binding.tombstonedAt && !allowTombstoned
      || requireRunning && (binding.desiredState !== "RUNNING" || binding.observedState !== "RUNNING")) {
      deny("fixture binding changed or is not running");
    }
    const scope: IncusQualificationScope = { installationId: fixture.installationId, releaseId: fixture.releaseId,
      connectionId: fixture.connectionId, presetId: fixture.presetId };
    return { fixture, binding, scope };
  }

  private async owned(handle: LiveFixtureHandle, requireRunning: boolean, allowTombstoned = false) {
    const { fixture, binding, scope } = await this.persistedOwned(handle, requireRunning, allowTombstoned);
    const selected = await this.qualifications.authorizeFixture(scope);
    if (selected.connection.revision !== fixture.connectionRevision || selected.presetDigest !== fixture.presetDigest
      || selected.effectiveSettingsDigest !== fixture.effectiveSettingsDigest) deny("reviewed fixture settings changed");
    return { fixture, binding, scope, selected };
  }

  /** SP09 uses the real preview registry, token handoff, app listener, and
   * guest loopback relay. The temporary fixture route exists only for this
   * claimed run and is removed even when a request fails. */
  async exercisePreviewAndStop(handle: LiveFixtureHandle, scope: IncusQualificationScope,
    preset: SandboxPreset, challenge: string): Promise<LiveSandboxPreviewProof> {
    const traffic = this.previewTraffic;
    const backend = this.previewBackend;
    if (!traffic || !(backend instanceof IncusSandboxPreviewBackend)) {
      deny("preview app listener or Incus guest relay is unavailable");
    }
    await traffic.ready();
    const { fixture, binding, scope: ownedScope, selected } = await this.owned(handle, true);
    if (preset.profile !== "persistent-web-compose.v1" || selected.preset.id !== preset.id
      || ownedScope.installationId !== scope.installationId || ownedScope.releaseId !== scope.releaseId
      || ownedScope.connectionId !== scope.connectionId || ownedScope.presetId !== scope.presetId
      || !/^[0-9a-f-]{36}$/.test(challenge) || !handle.operationId.startsWith("qual-primary-")) {
      deny("preview fixture scope or challenge changed");
    }
    const runId = handle.operationId.slice("qual-primary-".length);
    const checkpointStore = new IncusQualificationCheckpointStore(this.db);
    const checkpoint = await checkpointStore.get(runId);
    if (checkpoint?.state !== "CLAIMED" || checkpoint.fixtureOperationId !== handle.operationId
      || checkpoint.bindingId !== handle.sandboxId || checkpoint.generation !== binding.generation
      || checkpoint.connectionRevision !== fixture.connectionRevision
      || checkpoint.scope.installationId !== scope.installationId
      || checkpoint.scope.releaseId !== scope.releaseId
      || checkpoint.scope.connectionId !== scope.connectionId
      || checkpoint.scope.presetId !== scope.presetId
      || new Date(checkpoint.deadlineAt).getTime() <= this.now()) deny("preview restart claim changed");
    if (!fixture.ownerUserId) deny("qualification project owner is unavailable");
    await assertIncusQualificationOwner(this.db, fixture.ownerUserId);
    const [owner] = await this.db.select().from(projectMembers)
      .where(and(eq(projectMembers.projectId, fixture.projectId),
        eq(projectMembers.userId, fixture.ownerUserId), eq(projectMembers.role, "owner"))).limit(1);
    if (!owner) deny("qualification project owner changed");
    const context = await this.context(scope, preset);
    const workspaceBinding: SandboxWorkspaceBinding = {
      projectId: fixture.projectId, workspaceId: fixture.bindingId, connectionId: fixture.connectionId,
      providerId: "incus", generation: binding.generation, presetId: preset.id,
      releaseDigest: selected.snapshot.release.releaseDigest, presetDigest: selected.presetDigest,
      effectiveSettingsDigest: selected.effectiveSettingsDigest,
    };
    let previewId = "";
    let httpRequests = 0;
    let webSocketConnections = 0;
    let observedInstanceId = "";
    let observedPort = 0;
    const exact = (request: { previewId: string; binding: Readonly<SandboxWorkspaceBinding>; targetPort: number | null }) =>
      request.previewId === previewId && request.targetPort === PREVIEW_PORT
      && sameSandboxWorkspaceBinding(request.binding, workspaceBinding);
    const observedBackend: SandboxPreviewBackend = {
      open: request => backend.open(request), close: request => backend.close(request),
      serve: async request => {
        const response = await backend.serve(request);
        if (exact(request)) {
          observedInstanceId = request.binding.workspaceId;
          observedPort = request.targetPort!;
          httpRequests++;
        }
        return response;
      },
      connectWebSocket: async request => {
        const socket = await backend.connectWebSocket(request);
        if (exact(request)) {
          observedInstanceId = request.binding.workspaceId;
          observedPort = request.targetPort!;
          webSocketConnections++;
        }
        return socket;
      },
    };
    const target = sandboxWorkspaceTarget(workspaceBinding, {
      execute: async () => { throw new Error("Qualification preview cannot run workspace tools"); },
      previews: observedBackend,
    });
    const registered: Array<{ id: string; target: typeof target }> = [];
    let conversationId: string | undefined;
    let dispose: (() => void) | undefined;
    let stopped = false;
    let primaryFailure: unknown;
    let proofResult: LiveSandboxPreviewProof | undefined;
    const cleanupFailures: unknown[] = [];
    const createRow = async (candidate: typeof target, port: number, ttlMs = 90_000) => {
      const row = await createPreviewSession({ userId: owner.userId, conversationId: conversationId!,
        kind: "dynamic", targetPort: port, ttlMs, workspaceTarget: candidate });
      registered.push({ id: row.id, target: candidate });
      return row;
    };
    const status = async (id: string, cookie: string | null, options: {
      path?: string; wrongHost?: boolean; malformedHost?: boolean;
    } = {}) => (await traffic.http({ previewId: id, cookie, path: options.path ?? "/proof",
      wrongHost: options.wrongHost, malformedHost: options.malformedHost })).status;
    try {
      // The only server process is in the already claimed guest, on guest loopback.
      const started = await this.guest(handle, "processes.start", {
        argv: ["python3", "-u", "-c", PREVIEW_PYTHON], cwd: ".",
        env: [{ name: "EZH_QUAL_CHALLENGE", value: challenge }], processDeadlineMs: this.now() + 110_000,
      });
      if (typeof started.processId !== "string" || typeof started.bootId !== "string") {
        deny("preview guest service did not start");
      }
      let listening = false;
      for (let attempt = 0; attempt < 8 && !listening; attempt++) {
        try {
          const probe = await this.run(handle, ["python3", "-c",
            "import socket; s=socket.create_connection(('127.0.0.1',4173),1); s.close()"], 3000);
          listening = probe.exitCode === 0;
        } catch { await Bun.sleep(100); }
      }
      if (!listening) deny("preview guest loopback service is unavailable");
      const conversation = await createConversation(fixture.projectId,
        { title: "Qualification preview", userId: owner.userId, test: true });
      conversationId = conversation.id;
      const row = await createRow(target, PREVIEW_PORT);
      previewId = row.id;
      dispose = await registerClaimedQualificationPreview({
        key: { previewId, userId: owner.userId, conversationId, binding: workspaceBinding, targetPort: PREVIEW_PORT },
        runId, nonce: checkpoint.nonce, fixtureOperationId: handle.operationId,
        connectionRevision: fixture.connectionRevision, releaseDigest: workspaceBinding.releaseDigest,
        expiresAtMs: Math.min(this.now() + 100_000, new Date(checkpoint.deadlineAt).getTime()), target,
      }, { register: registerQualificationPreviewTarget, now: this.now,
        readCurrent: async () => {
          const current = await checkpointStore.get(runId);
          const owned = await this.owned(handle, true).catch(() => null);
          const ownerCurrent = await assertIncusQualificationOwner(this.db, fixture.ownerUserId!)
            .then(() => true).catch(() => false);
          const [member] = ownerCurrent ? await this.db.select({ userId: projectMembers.userId })
            .from(projectMembers).where(and(eq(projectMembers.projectId, fixture.projectId),
              eq(projectMembers.userId, fixture.ownerUserId!), eq(projectMembers.role, "owner"))).limit(1) : [];
          const active = await this.activeRelease(fixture.installationId).catch(() => null);
          const connection = await this.resolveConnection({ connectionId: fixture.connectionId,
            providerInstallationId: fixture.installationId, providerReleaseId: fixture.releaseId,
            revision: fixture.connectionRevision }).catch(() => null);
          if (!current || !owned || !member || owned.fixture.ownerUserId !== fixture.ownerUserId
            || current.state !== "CLAIMED"
            || new Date(current.deadlineAt).getTime() <= this.now()
            || owned.selected.snapshot.release.releaseDigest !== workspaceBinding.releaseDigest
            || active?.installation.id !== fixture.installationId
            || active?.release.id !== fixture.releaseId
            || active?.installation.activeReleaseId !== fixture.releaseId
            || connection?.id !== fixture.connectionId || connection?.revision !== fixture.connectionRevision
            || connection?.revokedAt || connection?.configuration.kind !== "incus") return null;
          return { runId: current.runId, nonce: current.nonce, state: current.state,
            fixtureOperationId: current.fixtureOperationId, fixtureBindingId: current.bindingId,
            fixtureGeneration: current.generation, connectionRevision: current.connectionRevision,
            releaseDigest: owned.selected.snapshot.release.releaseDigest, binding: workspaceBinding,
            running: owned.binding.desiredState === "RUNNING" && owned.binding.observedState === "RUNNING" };
        } });
      const handoff = await traffic.handoff({ previewId, code: mintOneTimeCode({ previewId, userId: owner.userId }) });
      if (handoff.status !== 302 || !handoff.cookie) deny("preview one-time handoff failed");
      const cookie = handoff.cookie;
      const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
      const challengeSha256 = digest(Buffer.from(challenge));
      const positive = await traffic.http({ previewId, cookie, path: "/proof" });
      const socket = await traffic.webSocket({ previewId, cookie, path: "/proof",
        subprotocol: "vite-hmr", challenge });
      const redirect = await traffic.http({ previewId, cookie, path: "/redirect" });
      const wrongOwnerCookie = `__ezpreview=${await signPreviewToken({ previewId, userId: randomUUID() })}`;
      const deniedMissingAuth = await status(previewId, null);
      const deniedWrongOwner = await status(previewId, wrongOwnerCookie);
      const deniedMalformed = await status(previewId, cookie, { malformedHost: true });
      const deniedWrongHost = await status(previewId, cookie, { wrongHost: true });
      const deniedWebSocketWrongOwner = (await traffic.webSocket({ previewId, cookie: wrongOwnerCookie,
        path: "/proof", subprotocol: "vite-hmr", challenge })).status;
      const deniedWebSocketWrongOrigin = (await traffic.webSocket({ previewId, cookie,
        path: "/proof", subprotocol: "vite-hmr", challenge, wrongOrigin: true })).status;
      // Change the same leased row, so these are binding and port checks,
      // not merely an unregistered preview-id denial.
      const mismatched = async (change: Partial<SandboxWorkspaceBinding>, port: number) => {
        const reference = workspaceTargetReference(sandboxWorkspaceTarget(
          { ...workspaceBinding, ...change }, target.backend));
        const [changed] = await this.db.update(previewSessions)
          .set({ workspaceTarget: reference, targetPort: port })
          .where(and(eq(previewSessions.id, previewId), eq(previewSessions.userId, owner.userId)))
          .returning({ id: previewSessions.id });
        if (!changed) deny("preview mutation lost its owned row");
        try { return await status(previewId, cookie); }
        finally {
          const [restored] = await this.db.update(previewSessions)
            .set({ workspaceTarget: workspaceTargetReference(target), targetPort: PREVIEW_PORT })
            .where(and(eq(previewSessions.id, previewId), eq(previewSessions.userId, owner.userId)))
            .returning({ id: previewSessions.id });
          if (!restored) deny("preview row restoration failed");
        }
      };
      const deniedWrongSandbox = await mismatched({ workspaceId: randomUUID() }, PREVIEW_PORT);
      const deniedWrongGeneration = await mismatched({ generation: workspaceBinding.generation + 1 }, PREVIEW_PORT);
      const deniedWrongPort = await mismatched({}, PREVIEW_PORT + 1);
      const expiring = await createRow(target, PREVIEW_PORT, 1500);
      const expiringCookie = `__ezpreview=${await signPreviewToken({ previewId: expiring.id, userId: owner.userId })}`;
      await Bun.sleep(Math.max(0, expiring.expiresAt.getTime() - this.now() + 1));
      const deniedExpired = await status(expiring.id, expiringCookie);
      const revoked = await createRow(target, PREVIEW_PORT);
      const revokedCookie = `__ezpreview=${await signPreviewToken({ previewId: revoked.id, userId: owner.userId })}`;
      if (!await revokePreview(revoked.id, owner.userId, new Date(), target)) deny("preview revoke failed");
      const deniedRevoked = await status(revoked.id, revokedCookie);
      await this.setPower(handle, "stopped");
      stopped = true;
      const deniedStopped = await status(previewId, cookie);
      if (positive.status !== 200 || digest(positive.body) !== challengeSha256
        || socket.status !== 101 || socket.subprotocol !== "vite-hmr" || !socket.reply
        || digest(socket.reply) !== challengeSha256 || redirect.status !== 302
        || redirect.location !== "http://127.0.0.1:1/"
        || [deniedMissingAuth, deniedWrongOwner, deniedMalformed, deniedWrongHost,
          deniedExpired, deniedRevoked].some(value => value !== 404)
        || [deniedWrongSandbox, deniedWrongGeneration, deniedWrongPort, deniedStopped].some(value => value !== 502)
        || deniedWebSocketWrongOwner !== 403 || deniedWebSocketWrongOrigin !== 403
        || httpRequests < 2 || webSocketConnections < 1
        || observedInstanceId !== handle.sandboxId || observedPort !== PREVIEW_PORT) {
        deny("preview route proof is incomplete");
      }
      proofResult = { version: 1, connectionId: scope.connectionId, presetId: preset.id,
        releaseDigest: workspaceBinding.releaseDigest, presetDigest: workspaceBinding.presetDigest,
        effectiveSettingsDigest: workspaceBinding.effectiveSettingsDigest, imageDigest: preset.imageDigest,
        helperDigest: context.helperDigest, sandboxId: handle.sandboxId, operationId: handle.operationId,
        generation: binding.generation, endpointId: previewId, ownerId: owner.userId, port: PREVIEW_PORT,
        expiresAt: row.expiresAt.toISOString(), challengeSha256, httpStatus: positive.status,
        httpBodySha256: digest(positive.body), webSocketStatus: socket.status,
        webSocketMessageSha256: digest(socket.reply), webSocketSubprotocol: socket.subprotocol,
        redirectStatus: redirect.status, redirectLocation: redirect.location,
        dispatch: { backend: "incus", instanceId: observedInstanceId, port: observedPort,
          httpRequests, webSocketConnections },
        denied: { missingAuth: deniedMissingAuth, wrongOwner: deniedWrongOwner,
          wrongSandbox: deniedWrongSandbox, wrongGeneration: deniedWrongGeneration,
          wrongPort: deniedWrongPort, expired: deniedExpired, malformed: deniedMalformed,
          revoked: deniedRevoked, stopped: deniedStopped, wrongHost: deniedWrongHost,
          webSocketWrongOwner: deniedWebSocketWrongOwner, webSocketWrongOrigin: deniedWebSocketWrongOrigin } };
    } catch (error) {
      primaryFailure = error;
    } finally {
      try { dispose?.(); }
      catch (error) { cleanupFailures.push(error); }
      for (const item of registered.reverse()) {
        try {
          if (!await revokePreview(item.id, owner.userId, new Date(), item.target)) {
            cleanupFailures.push(new Error("Qualification preview row could not be revoked"));
          }
        } catch (error) { cleanupFailures.push(error); }
      }
      if (conversationId) {
        try {
          if (!await deleteConversation(conversationId)) {
            cleanupFailures.push(new Error("Qualification conversation was not deleted"));
          }
        } catch (error) { cleanupFailures.push(error); }
      }
      if (!stopped) {
        try { await this.setPower(handle, "stopped"); }
        catch (error) { cleanupFailures.push(error); }
      }
    }
    if (cleanupFailures.length) throw new AggregateError(
      primaryFailure === undefined ? cleanupFailures : [primaryFailure, ...cleanupFailures],
      "Qualification preview cleanup is unverified");
    if (primaryFailure !== undefined) throw primaryFailure;
    if (!proofResult) deny("preview proof was not produced");
    return proofResult;
  }

  private async guest(handle: LiveFixtureHandle, operation: SandboxProtocolOperation,
    payload: Record<string, unknown>, observationDeadline?: number): Promise<Record<string, unknown>> {
    if (!guestOperations.has(operation)) deny("guest operation is not approved for a witness");
    const { fixture, binding } = await this.owned(handle, true);
    const active = await this.activeRelease(fixture.installationId);
    if (active.installation.id !== fixture.installationId || active.release.id !== fixture.releaseId
      || active.installation.activeReleaseId !== fixture.releaseId) deny("active release changed");
    const connection = await this.resolveConnection({
      connectionId: fixture.connectionId, providerInstallationId: fixture.installationId,
      providerReleaseId: fixture.releaseId, revision: fixture.connectionRevision,
    });
    if (connection.id !== fixture.connectionId || connection.revision !== fixture.connectionRevision
      || connection.revokedAt || connection.configuration.kind !== "incus") deny("connection changed");
    const now = this.now();
    if (observationDeadline !== undefined && now >= observationDeadline) deny("guest process deadline expired");
    const input: Record<string, unknown> = { ...payload, providerId: "incus", connectionId: fixture.connectionId,
      sandboxId: fixture.bindingId, rpcDeadlineMs: Math.min(now + 30_000, observationDeadline ?? Infinity) };
    if (operation === "processes.start") {
      const requestedDeadline = Number(payload.processDeadlineMs);
      if (!Number.isSafeInteger(requestedDeadline) || requestedDeadline <= now
        || requestedDeadline > now + 120_000) deny("guest process deadline changed");
      input.user = connection.configuration.guestUser;
      input.rpcDeadlineMs = Math.min(now + 30_000, requestedDeadline);
      input.processDeadlineMs = requestedDeadline;
    }
    if (operation === "files.writeAtomic" || operation === "processes.start") {
      const identity = `qual-guest-${createHash("sha256").update(JSON.stringify([
        fixture.operationId, binding.generation, operation, payload, now,
      ])).digest("hex")}`;
      input.requestId = identity;
      input.idempotencyKey = identity;
    }
    const result = await this.invokeGuest(fixture.installationId, fixture.bindingId, operation, input);
    return reply(validateSandboxProviderMethodExchange(operation, input, result).result, operation);
  }

  private async assertDurableState(handle: LiveFixtureHandle, scope: IncusQualificationScope,
    state: "RUNNING" | "STOPPED" | "ABSENT"): Promise<void> {
    const readback = await this.fixtures.status(scope, handle.operationId);
    if (readback.fixture.bindingId !== handle.sandboxId
      || readback.fixture.installationId !== scope.installationId
      || readback.fixture.releaseId !== scope.releaseId
      || readback.fixture.connectionId !== scope.connectionId
      || readback.fixture.presetId !== scope.presetId
      || readback.binding.id !== handle.sandboxId
      || readback.binding.observedState !== state || readback.binding.desiredState !== state) {
      deny("durable fixture state changed");
    }
  }

  private async context(scope: IncusQualificationScope, preset: SandboxPreset): Promise<{
    context: LiveReadbackContext; helperDigest: string;
  }> {
    const selected = await this.qualifications.authorizeFixture(scope);
    const setup = await this.readSetup(scope.installationId);
    const image = setup?.recipe?.guestImage;
    if (setup?.state !== "verified" || setup.providerReleaseId !== scope.releaseId
      || setup.providerReleaseDigest !== selected.snapshot.release.releaseDigest
      || setup.connectionId !== scope.connectionId || setup.connectionRevision !== selected.connection.revision
      || selected.preset.id !== preset.id || selected.presetDigest !== await sandboxPresetDigest(preset)
      || image?.fingerprint !== preset.imageDigest || !preset.helperDigests.includes(image.helperSha256)
      || setup.recipe.profile.name !== selected.connection.configuration.profile) {
      deny("verified setup, release, connection, image, or helper changed");
    }
    return { context: { scope, connection: selected.connection, preset,
      presetDigest: selected.presetDigest, effectiveSettingsDigest: selected.effectiveSettingsDigest,
      recipe: setup.recipe as IncusSetupRecipe }, helperDigest: image.helperSha256 };
  }

  async preflightNetwork(scope: IncusQualificationScope, preset: SandboxPreset): Promise<void> {
    const { context } = await this.context(scope, preset);
    if (!this.resourceNetwork) deny("host-owned sandbox network control targets are unavailable");
    await this.resourceNetwork.assertControlCapability(context);
  }

  async observe(scope: IncusQualificationScope, preset: SandboxPreset): ReturnType<HostIncusLiveWitness["observe"]> {
    const selected = await this.context(scope, preset);
    const observed = await this.backend.image(selected.context);
    if (observed.imageDigest !== preset.imageDigest || observed.helperDigest !== selected.helperDigest
      || observed.profile !== preset.profile) deny("backend artifact readback changed");
    return observed;
  }

  async controlFacts(scope: IncusQualificationScope, preset: SandboxPreset): ReturnType<HostIncusLiveWitness["controlFacts"]> {
    if (!this.controlProbe) deny("operator-owned production admission, inventory, and distinct canary probes are unavailable");
    const { context, helperDigest } = await this.context(scope, preset);
    const provider = (await this.qualifications.authorizeFixture(scope)).snapshot.release.manifest
      .sandboxProviders?.find(item => item.id === "incus" && item.kind === "sandbox");
    if (!provider) deny("reviewed provider declaration is unavailable");
    const backend = await this.backend.image(context);
    if (backend.imageDigest !== preset.imageDigest || backend.helperDigest !== helperDigest
      || backend.profile !== preset.profile) deny("backend artifact changed during control probe");
    const observed = backend.observation;
    const request = { profile: preset.profile, presetId: preset.id, observation: observed };
    const baseline = await resolveSandboxPreset(provider, request);
    const repeated = await resolveSandboxPreset(provider, request);
    const change = (Object.keys(preset.allowedOverrides) as Array<keyof SandboxPreset["limits"]>)
      .find(key => {
        const bounds = preset.allowedOverrides[key];
        return bounds && (bounds.minimum !== preset.limits[key] || bounds.maximum !== preset.limits[key]);
      });
    if (!change) deny("reviewed preset has no measurable settings change");
    const bounds = preset.allowedOverrides[change]!;
    const alternate = bounds.minimum !== preset.limits[change] ? bounds.minimum : bounds.maximum;
    const changed = await resolveSandboxPreset(provider,
      { ...request, overrides: { [change]: alternate } });
    if (baseline.effectiveSettingsDigest !== repeated.effectiveSettingsDigest
      || baseline.effectiveSettingsDigest === changed.effectiveSettingsDigest) {
      deny("effective settings resolution is not deterministic");
    }
    const codes = new Map<ControlDenial, string>();
    const deltas = new Map<ControlDenial, number>();
    const canaries: Array<{ kind: ControlDenial; identity: string; before: string; after: string }> = [];
    for (const kind of CONTROL_DENIALS) {
      const before = await this.controlProbe.snapshot(kind, scope);
      const code = await this.controlProbe.attempt(kind, scope, preset);
      const after = await this.controlProbe.snapshot(kind, scope);
      const allocationDelta = after.reservationIds.length + after.operationIds.length + after.backendIds.length
        - before.reservationIds.length - before.operationIds.length - before.backendIds.length;
      if (typeof code !== "string" || !code.startsWith("DENIED_")
        || allocationDelta !== 0
        || inventoryIds(before.reservationIds) !== inventoryIds(after.reservationIds)
        || inventoryIds(before.operationIds) !== inventoryIds(after.operationIds)
        || inventoryIds(before.backendIds) !== inventoryIds(after.backendIds)
        || !before.canaryIdentity || before.canaryIdentity !== after.canaryIdentity
        || !(before.canaryBytes instanceof Uint8Array) || !(after.canaryBytes instanceof Uint8Array)) {
        deny(`${kind} admission or allocation readback changed`);
      }
      codes.set(kind, code);
      deltas.set(kind, allocationDelta);
      canaries.push({ kind, identity: before.canaryIdentity,
        before: createHash("sha256").update(before.canaryBytes).digest("hex"),
        after: createHash("sha256").update(after.canaryBytes).digest("hex") });
    }
    if (new Set(canaries.map(value => value.identity)).size !== CONTROL_DENIALS.length
      || canaries.some(value => value.before !== value.after)) deny("distinct local canaries changed");
    const beforeCanaryDigest = createHash("sha256").update(JSON.stringify(canaries.map(value =>
      [value.kind, value.identity, value.before]))).digest("hex");
    const afterCanaryDigest = createHash("sha256").update(JSON.stringify(canaries.map(value =>
      [value.kind, value.identity, value.after]))).digest("hex");
    return { baselinePlanDigest: baseline.effectiveSettingsDigest,
      repeatedPlanDigest: repeated.effectiveSettingsDigest, changedPlanDigest: changed.effectiveSettingsDigest,
      unsupportedAdmissionCode: codes.get("unsupported")!, unsupportedAllocationDelta: deltas.get("unsupported")!,
      missingControlAdmissionCode: codes.get("missingControl")!, missingControlAllocationDelta: deltas.get("missingControl")!,
      driftAdmissionCode: codes.get("drift")!, driftAllocationDelta: deltas.get("drift")!,
      unqualifiedAdmissionCode: codes.get("unqualified")!, unqualifiedAllocationDelta: deltas.get("unqualified")!,
      localCanaryBefore: beforeCanaryDigest, localCanaryAfter: afterCanaryDigest };
  }

  async createFixture(scope: IncusQualificationScope, preset: SandboxPreset,
    operationId: string, dropFirstReply: boolean): Promise<LiveFixtureHandle> {
    const selected = await this.qualifications.authorizeFixture(scope);
    if (preset.id !== scope.presetId || preset.id !== selected.preset.id
      || await sandboxPresetDigest(preset) !== selected.presetDigest) deny("fixture preset changed");
    // Throw away the first service reply at this host boundary, then ask the
    // durable controller for the same operation. Both IDs must be identical.
    let admittedOperation: SandboxOperation | undefined;
    try {
      const first = dropFirstReply ? await this.fixtures.create(scope, operationId) : null;
      admittedOperation = first ?? undefined;
      let operation = await this.fixtures.create(scope, operationId);
      admittedOperation = operation;
      if (first && (first.id !== operation.id || first.bindingId !== operation.bindingId)) {
        deny("lost create reply replay allocated another fixture");
      }
      operation = await this.settleOperation(scope, operationId, operation);
      admittedOperation = operation;
      if (operation.state !== "SUCCEEDED" || operation.kind !== "CREATE") deny("fixture create is not verified");
      const handle = { sandboxId: operation.bindingId, operationId };
      await this.owned(handle, false);
      await this.assertDurableState(handle, scope, "STOPPED");
      return handle;
    } catch (error) {
      if (error instanceof IncusQualificationOperationUnsettledError) throw error;
      if (admittedOperation && admittedOperation.state !== "FAILED") {
        throw new IncusQualificationOperationUnsettledError(admittedOperation.id, admittedOperation.state, error, "authority_changed");
      }
      if (admittedOperation?.state === "FAILED") {
        try {
          const cleanup = await this.settleOperation(scope, operationId, await this.fixtures.destroy(scope, operationId));
          if (cleanup.state !== "SUCCEEDED") deny("failed create cleanup is not verified");
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Incus live create and cleanup are unverified");
        }
      }
      throw error;
    }
  }

  async inspectFixture(handle: LiveFixtureHandle): ReturnType<HostIncusLiveWitness["inspectFixture"]> {
    const { scope, selected, binding } = await this.owned(handle, false, true);
    const approved = await this.context(scope, selected.preset);
    const observed = await this.backend.instance(approved.context, handle.sandboxId);
    const expected = binding.observedState === "RUNNING" ? "running"
      : binding.observedState === "STOPPED" ? "stopped"
        : binding.observedState === "ABSENT" ? "absent" : "unknown";
    if (observed.state !== expected) deny("backend and durable fixture state disagree");
    if (observed.state === "absent") return { sandboxId: handle.sandboxId, state: "absent" } as LiveFixtureInspection;
    if (observed.imageDigest !== selected.preset.imageDigest || observed.profile !== selected.preset.profile
      || !observed.memoryBytes || !observed.cpuMillis || !observed.pids || !observed.diskBytes
      || !observed.storageDriver || observed.privateNetwork !== true
      || observed.restrictedProject !== true || observed.unprivileged !== true) {
      deny("backend fixture resource or isolation readback changed");
    }
    let bootId: string | null = null;
    if (observed.state === "running") {
      const guest = await this.run(handle,
        ["sh", "-c", "id -un; pwd; cat /proc/sys/kernel/random/boot_id"], 30_000);
      const [user, workspace, boot, ...extra] = guest.stdout.trim().split("\n");
      if (guest.exitCode !== 0 || user !== selected.connection.configuration.guestUser
        || workspace !== "/workspace" || !/^[a-f0-9-]{36}$/.test(boot ?? "") || extra.length) {
        deny("guest user, workspace, or boot identity is unavailable");
      }
      bootId = boot!;
    }
    return { sandboxId: handle.sandboxId, state: observed.state,
      imageDigest: observed.imageDigest, helperDigest: approved.helperDigest,
      profile: observed.profile, workspaceRoot: "/workspace", guestUser: selected.connection.configuration.guestUser,
      memoryBytes: observed.memoryBytes, cpuMillis: observed.cpuMillis, pids: observed.pids,
      diskBytes: observed.diskBytes, storageDriver: observed.storageDriver,
      privateNetwork: observed.privateNetwork, restrictedProject: observed.restrictedProject,
      unprivileged: observed.unprivileged, bootId };
  }

  async observeEnforcement(handle: LiveFixtureHandle,
    neighbor: LiveFixtureHandle): ReturnType<HostIncusLiveWitness["observeEnforcement"]> {
    if (!this.resourceNetwork) deny("host-owned sandbox network control targets are unavailable");
    if (handle.sandboxId === neighbor.sandboxId || handle.operationId === neighbor.operationId) {
      deny("resource probe needs two distinct fixtures");
    }
    const [primaryOwned, neighborOwned] = await Promise.all([
      this.owned(handle, true), this.owned(neighbor, true),
    ]);
    if (primaryOwned.scope.installationId !== neighborOwned.scope.installationId
      || primaryOwned.scope.releaseId !== neighborOwned.scope.releaseId
      || primaryOwned.scope.connectionId !== neighborOwned.scope.connectionId
      || primaryOwned.scope.presetId !== neighborOwned.scope.presetId) {
      deny("resource probe fixtures have different reviewed scopes");
    }
    const { context } = await this.context(primaryOwned.scope, primaryOwned.selected.preset);
    const [primary, adjacent, neighborTarget] = await Promise.all([
      this.backend.instance(context, handle.sandboxId),
      this.backend.instance(context, neighbor.sandboxId),
      this.resourceNetwork.neighborTarget(context, neighbor),
    ]);
    if (primary.state !== "running" || adjacent.state !== "running"
      || primary.privateNetwork !== true || adjacent.privateNetwork !== true
      || primary.diskBytes === undefined || neighborTarget.sandboxId !== neighbor.sandboxId) {
      deny("running fixture, root quota, or neighbor network identity changed");
    }
    const management = await this.resourceNetwork.managementTarget(context);
    return observeIncusResourceEnforcement(handle, primaryOwned.selected.preset,
      { management, otherSandbox: neighborTarget }, {
      runGuest: (fixture, argv, timeoutMs) => this.run(fixture, argv, timeoutMs),
        readRootQuota: async () => ({ sandboxId: handle.sandboxId, bytes: primary.diskBytes! }),
        hostCanConnect: target => this.resourceNetwork!.hostCanConnect(target),
      });
  }

  async exerciseLimits(handle: LiveFixtureHandle,
    neighbor: LiveFixtureHandle): ReturnType<HostIncusLiveWitness["exerciseLimits"]> {
    if (!this.resourceNetwork || handle.sandboxId === neighbor.sandboxId
      || handle.operationId === neighbor.operationId) deny("limit probe needs two distinct running fixtures");
    const [primary, adjacent] = await Promise.all([this.owned(handle, true), this.owned(neighbor, true)]);
    if (primary.scope.installationId !== adjacent.scope.installationId
      || primary.scope.releaseId !== adjacent.scope.releaseId
      || primary.scope.connectionId !== adjacent.scope.connectionId
      || primary.scope.presetId !== adjacent.scope.presetId) deny("limit probe fixture scopes differ");
    const { context } = await this.context(primary.scope, primary.selected.preset);
    const management = await this.resourceNetwork.managementTarget(context);
    const healthyInstance = async (fixture: LiveFixtureHandle) => {
      const observed = await this.backend.instance(context, fixture.sandboxId);
      return observed.state === "running" && observed.privateNetwork === true
        && observed.restrictedProject === true && observed.unprivileged === true;
    };
    const facts = await this.observeEnforcement(handle, neighbor);
    return exerciseIncusLimits(handle, primary.selected.preset, facts, {
      prepareMemoryLoad: fixture => this.stageMemoryLoad(fixture),
      runGuest: (fixture, argv, timeoutMs) => this.run(fixture, argv, timeoutMs),
      neighborHealthy: async () => {
        if (!await healthyInstance(neighbor)) return false;
        const canary = await this.run(neighbor, ["sh", "-c", "printf %s ezh-neighbor-ok"], 10_000);
        return canary.exitCode === 0 && canary.stdout === "ezh-neighbor-ok" && canary.stderr === "";
      },
      hostHealthy: async () => {
        if (!await this.resourceNetwork!.hostCanConnect(management)) return false;
        const readback = await this.backend.image(context);
        return readback.imageDigest === primary.selected.preset.imageDigest
          && readback.profile === primary.selected.preset.profile
          && primary.selected.preset.helperDigests.includes(readback.helperDigest);
      },
      hostStorageFreeBytes: async () => {
        if (!this.backend.poolResources) deny("independent Incus storage-pool readback is unavailable");
        return (await this.backend.poolResources(context)).freeBytes;
      },
    });
  }

  private settleOperation(scope: IncusQualificationScope, fixtureOperationId: string,
    operation: Awaited<ReturnType<IncusQualificationFixtureService["create"]>>) {
    return operation.state === "SUCCEEDED" || operation.state === "FAILED" ? Promise.resolve(operation)
      : this.fixtures.waitForOperation(scope, fixtureOperationId, operation.id);
  }

  async setPower(handle: LiveFixtureHandle, state: "running" | "stopped"): Promise<void> {
    const { scope } = await this.owned(handle, false);
    const operation = await this.settleOperation(scope, handle.operationId,
      await this.fixtures.setPower(scope, handle.operationId, state, `qual-power-${randomUUID()}`));
    if (operation.state !== "SUCCEEDED" || operation.bindingId !== handle.sandboxId
      || operation.kind !== (state === "running" ? "START" : "STOP")) {
      deny("fixture power change is not verified");
    }
    await this.assertDurableState(handle, scope, state === "running" ? "RUNNING" : "STOPPED");
  }

  private async stageMemoryLoad(handle: LiveFixtureHandle): Promise<string> {
    const { scope, selected } = await this.owned(handle, true);
    const backend = await this.observe(scope, selected.preset);
    const asset = await loadIncusMemoryStressAsset(backend.observation.architecture);
    const identity = createHash("sha256").update(JSON.stringify([scope, handle.operationId, handle.sandboxId])).digest("hex");
    const path = `ezh-memory-probe-${identity}`;
    const result = await this.guest(handle, "files.writeAtomic", { path, expectedRevision: null,
      dataBase64: Buffer.from(asset.bytes).toString("base64"), byteLength: asset.bytes.length, executable: true });
    if (result.path !== path || result.sizeBytes !== asset.bytes.length) deny("memory asset write changed");
    const stat = await this.guest(handle, "files.stat", { path });
    const file = stat.file as Record<string, unknown> | undefined;
    if (file?.path !== path || file.kind !== "file" || file.executable !== true
      || file.sizeBytes !== asset.bytes.length) deny("memory asset executable readback changed");
    const bytes = await this.readFile(handle, path);
    if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) deny("memory asset digest changed");
    return path;
  }

  async writeFile(handle: LiveFixtureHandle, path: string, bytes: Uint8Array): Promise<void> {
    safePath(path);
    if (bytes.length > MAX_FILE_BYTES) deny("file exceeds one verified guest write");
    const result = await this.guest(handle, "files.writeAtomic", { path, expectedRevision: null,
      dataBase64: Buffer.from(bytes).toString("base64"), byteLength: bytes.length, executable: false });
    if (result.path !== path || result.sizeBytes !== bytes.length) deny("guest file write readback changed");
  }

  async readFile(handle: LiveFixtureHandle, path: string): Promise<Uint8Array> {
    safePath(path);
    const stat = await this.guest(handle, "files.stat", { path });
    const file = stat.file as Record<string, unknown> | undefined;
    if (file?.path !== path || file.kind !== "file" || typeof file.revision !== "string"
      || !Number.isSafeInteger(file.sizeBytes) || Number(file.sizeBytes) > MAX_FILE_BYTES) deny("guest file stat changed");
    const read = await this.guest(handle, "files.readRange", { path, revision: file.revision,
      offsetBytes: 0, lengthBytes: Math.max(1, Number(file.sizeBytes)) });
    const bytes = Buffer.from(String(read.dataBase64), "base64");
    if (read.path !== path || read.revision !== file.revision || read.offsetBytes !== 0
      || read.byteLength !== bytes.length || bytes.length !== file.sizeBytes || read.eof !== true) {
      deny("guest file readback changed");
    }
    return bytes;
  }

  async run(handle: LiveFixtureHandle, argv: readonly string[], timeoutMs: number): ReturnType<HostIncusLiveWitness["run"]> {
    if (!argv.length || argv.some(arg => typeof arg !== "string") || !Number.isSafeInteger(timeoutMs)
      || timeoutMs < 1 || timeoutMs > 120_000) deny("invalid guest process request");
    const deadline = this.now() + timeoutMs;
    const start = await this.guest(handle, "processes.start", { argv: [...argv], cwd: ".",
      env: [], processDeadlineMs: deadline });
    if (typeof start.processId !== "string" || typeof start.bootId !== "string") deny("guest process identity missing");
    let offset = 0;
    let stdout = "";
    let stderr = "";
    let terminalExitCode: number | null = null;
    const observe = async (operation: "processes.readOutput" | "processes.inspect",
      payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
      let firstDeadlineAt: number | undefined;
      let lastDeadlineAt: number | undefined;
      let deadlineCount = 0;
      let lastDeadlineError: IncusLiveWitnessError | undefined;
      try {
        while (this.now() < deadline) {
          try {
            const value = await this.guest(handle, operation, payload, deadline);
            if (this.now() >= deadline) deny("guest process deadline expired");
            return value;
          }
          catch (error) {
            if (!(error instanceof IncusLiveWitnessError)
              || error.code !== incusGuestFailureCauseCode(operation, "DEADLINE_EXCEEDED")) throw error;
            lastDeadlineError = error;
            lastDeadlineAt = this.now();
            firstDeadlineAt ??= lastDeadlineAt;
            deadlineCount++;
            await new Promise(resolve => setTimeout(resolve, POLL_MS));
          }
        }
        throw lastDeadlineError ?? new IncusLiveWitnessError("guest process deadline expired");
      } finally {
        if (deadlineCount) logger.child("incus.witness").warn("Guest process observation deadline summary", {
          operation, causeCode: lastDeadlineError?.code, deadlineCount, firstDeadlineAt, lastDeadlineAt, processDeadlineMs: deadline,
        });
      }
    };
    while (this.now() < deadline) {
      const output = await observe("processes.readOutput", { processId: start.processId,
        bootId: start.bootId, cursor: { sandboxId: handle.sandboxId, processId: start.processId,
          bootId: start.bootId, offsetBytes: offset }, maxBytes: MAX_FILE_BYTES });
      if (output.gap || !Array.isArray(output.chunks)) deny("guest process output has a gap");
      for (const chunk of output.chunks as Record<string, unknown>[]) {
        const bytes = Buffer.from(String(chunk.dataBase64), "base64");
        if (chunk.offsetBytes !== offset || chunk.byteLength !== bytes.length) deny("guest process output changed");
        if (chunk.stream === "stdout") stdout += bytes.toString();
        else if (chunk.stream === "stderr") stderr += bytes.toString();
        else deny("guest process stream changed");
        offset += bytes.length;
      }
      const next = output.nextCursor as Record<string, unknown> | undefined;
      if (next?.offsetBytes !== offset || offset > MAX_FILE_BYTES) deny("guest process output exceeded bound");
      const inspected = await observe("processes.inspect", { processId: start.processId, bootId: start.bootId });
      const process = inspected.process as Record<string, unknown> | undefined;
      if (process?.processId !== start.processId || process.sandboxId !== handle.sandboxId
        || process.bootId !== start.bootId) deny("guest process identity changed");
      if (["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(String(process.state))) {
        if (!Number.isSafeInteger(process.exitCode)) deny("guest process exit is unavailable");
        terminalExitCode = Number(process.exitCode);
      }
      if (terminalExitCode !== null && output.eof === true) return { exitCode: terminalExitCode, stdout, stderr };
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
    return deny("guest process deadline expired");
  }

  async restartController(_handle: LiveFixtureHandle): ReturnType<HostIncusLiveWitness["restartController"]> {
    return deny("host controller process restart and durable reconnect is not implemented");
  }

  async exerciseFailedCleanupRecovery(handle: LiveFixtureHandle,
    unrelated: LiveFixtureHandle): ReturnType<HostIncusLiveWitness["exerciseFailedCleanupRecovery"]> {
    if (!this.cleanupRecovery) deny("operator-owned destroy fault and readiness probe are unavailable");
    if (handle.sandboxId === unrelated.sandboxId || handle.operationId === unrelated.operationId) {
      deny("cleanup recovery needs two distinct fixtures");
    }
    const [primary, adjacent] = await Promise.all([this.owned(handle, false), this.owned(unrelated, false)]);
    if (primary.scope.installationId !== adjacent.scope.installationId
      || primary.scope.releaseId !== adjacent.scope.releaseId
      || primary.scope.connectionId !== adjacent.scope.connectionId
      || primary.scope.presetId !== adjacent.scope.presetId) deny("cleanup recovery fixture scopes differ");
    await this.context(primary.scope, primary.selected.preset);
    const observed = await observeFailedCleanupRecovery(primary.scope, handle, unrelated, {
      readDurable: value => this.fixtures.status(primary.scope, value.operationId),
      readBackend: value => this.inspectFixture(value),
      injectLostDestroyReply: () => this.cleanupRecovery!.injectLostDestroyReply(primary.scope, handle),
      attemptReadiness: () => this.cleanupRecovery!.attemptReadiness(primary.scope, handle),
      reconcileFromReopenedController: () => this.cleanupRecovery!.reconcileFromReopenedController(primary.scope, handle),
    });
    await Promise.all([this.assertDurableState(handle, primary.scope, "ABSENT"),
      this.assertDurableState(unrelated, primary.scope, "STOPPED")]);
    return { firstDestroyOperationId: observed.failed.operation!.id,
      recordedState: "RECONCILE_REQUIRED", readinessErrorCode: observed.readinessErrorCode,
      reconciledOperationId: observed.recovered.operation!.id,
      finalState: observed.backend.state, unrelatedState: observed.unrelatedBackend.state };
  }

  async destroyFixture(handle: LiveFixtureHandle): Promise<void> {
    const { scope, binding } = await this.persistedOwned(handle, false, true);
    if (!binding.tombstonedAt && binding.observedState === "RUNNING") {
      await this.setPower(handle, "stopped");
    }
    const operation = await this.settleOperation(scope, handle.operationId,
      await this.fixtures.destroy(scope, handle.operationId));
    if (operation.state !== "SUCCEEDED" || operation.kind !== "DESTROY" || operation.bindingId !== handle.sandboxId) {
      deny("fixture destroy is not verified");
    }
    await this.assertDurableState(handle, scope, "ABSENT");
  }
}
