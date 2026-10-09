import { afterAll, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sandboxPresetDigest } from "@ezcorp/extension-contract";
import { INCUS_PRESETS } from "../../extensions/incus-sandbox/manifest";
import { setupTestDb, closeTestDb } from "../__tests__/helpers/test-pglite";
import { __test as connectionTest } from "../db/connection";
import { conversations, previewSessions, projectMembers, projects, users, sandboxBindings } from "../db/schema";
import { getServablePreview } from "../db/queries/preview-sessions";
import { redeemOneTimeCode, signPreviewToken, verifyPreviewToken } from "../runtime/preview/preview-token";
import { handlePreviewRequest } from "../runtime/preview/preview-proxy";
import { resolveCurrentPreviewSandboxTarget } from "../runtime/preview/preview-target";
import { IncusQualificationCheckpointStore } from "./incus-qualification-checkpoint";
import { IncusHostLiveWitness } from "./incus-host-live-witness";
import type { IncusPreviewTrafficDriver } from "./incus-preview-traffic";
import { IncusSandboxPreviewBackend } from "./incus-preview-backend";
import { createIncusPreviewAuthorizer } from "./incus-preview-authority";
import { IncusWorkspaceCaller } from "./incus-workspace-caller";
import { createIncusPreviewTrafficDriver } from "./incus-preview-traffic";
import { releaseRuntimeFixture } from "../__tests__/helpers/release-runtime";
import { incusManifest } from "../../extensions/incus-sandbox/manifest";
import { tryBridgePreviewWebSocket, createPreviewWebSocketHandler } from "../../web/src/lib/server/preview/ws-bridge";
import type { IncusQualificationFixtureService, IncusQualificationStore } from "./incus-qualification";
import { logger } from "../logger";

afterAll(async () => { connectionTest.setState(null, null); await closeTestDb(); });

test("SP09 host witness uses the real registry and token gates, then removes its fixture permit", async () => {
  const { db, pglite } = await setupTestDb();
  connectionTest.setState(db, pglite);
  const previousSecret = process.env.EZCORP_JWT_SECRET;
  process.env.EZCORP_JWT_SECRET = "qualification-preview-test-secret";
  const preset = INCUS_PRESETS[1]!;
  const scope = { installationId: "qualification-install", releaseId: "qualification-release",
    connectionId: "qualification-connection", presetId: preset.id };
  const handle = { operationId: "qual-primary-previewrun", sandboxId: "qualification-binding" };
  const challenge = randomUUID();
  const releaseDigest = "a".repeat(64);
  const presetDigest = await sandboxPresetDigest(preset);
  const settingsDigest = "b".repeat(64);
  const ownerId = "qualification-admin";
  const projectId = "qualification-project";
  await db.insert(users).values({ id: ownerId, email: "qual-admin@example.test", passwordHash: "test",
    name: "Qualification Admin", role: "admin", status: "active" });
  await db.insert(projects).values({ id: projectId, name: projectId,
    path: "/__incus_qualification__/preview-test", purpose: "incus-qualification" });
  await db.insert(projectMembers).values({ projectId, userId: ownerId, role: "owner" });
  const fixture = { operationId: handle.operationId, bindingId: handle.sandboxId,
    ownerUserId: ownerId, projectId, installationId: scope.installationId, releaseId: scope.releaseId,
    connectionId: scope.connectionId, connectionRevision: 1, presetId: preset.id,
    presetDigest, effectiveSettingsDigest: settingsDigest };
  let running = true;
  const binding = { id: handle.sandboxId, generation: 1,
    desiredState: "RUNNING", observedState: "RUNNING" };
  const selected = { preset, presetDigest, effectiveSettingsDigest: settingsDigest,
    snapshot: { release: { releaseDigest } }, connection: { revision: 1 } };
  const { snapshot } = releaseRuntimeFixture(scope.installationId, structuredClone(incusManifest));
  snapshot.release.id = scope.releaseId;
  snapshot.release.releaseDigest = releaseDigest;
  snapshot.installation.activeReleaseId = scope.releaseId;
  await db.insert(sandboxBindings).values({ id: handle.sandboxId, projectId,
    providerInstallationId: scope.installationId, providerReleaseId: scope.releaseId,
    connectionId: scope.connectionId, connectionRevision: 1, resourceKey: handle.sandboxId,
    generation: 1, profile: preset.profile, presetId: preset.id, presetDigest,
    effectiveSettingsDigest: settingsDigest, desiredState: "RUNNING", observedState: "RUNNING" });
  const caller = new IncusWorkspaceCaller({ db, resolveRelease: async () => snapshot,
    resolveConnection: async () => ({ id: scope.connectionId, revision: 1,
      providerInstallationId: scope.installationId, providerReleaseId: scope.releaseId, revokedAt: null,
      project: "ezharness", endpoint: "https://incus.example:8443",
      serverCertificatePem: readFileSync(new URL("./incus-transport/test-server.pem", import.meta.url), "utf8"),
      clientCertificatePem: "fixture-client", privateKeyPem: "fixture-key",
      configuration: { kind: "incus", profile: "ezharness-feature", guestUser: "sandbox", helperVersion: "0.1.0" },
    } as never) });
  let ordinaryReadinessCalls = 0;
  let releaseReadiness!: () => void;
  const heldReadiness = new Promise<boolean>(resolve => { releaseReadiness = () => resolve(false); });
  const authorizePreview = createIncusPreviewAuthorizer({ db, caller,
    qualified: async () => { ordinaryReadinessCalls++; return heldReadiness; } });
  const backend = new IncusSandboxPreviewBackend({} as never);
  const served: string[] = [];
  backend.serve = async request => {
    served.push(request.requestPath);
    if (!running || request.targetPort !== 4173 || request.binding.workspaceId !== handle.sandboxId) {
      throw new Error("changed guest target");
    }
    return request.requestPath === "/redirect"
      ? new Response(null, { status: 302, headers: { Location: "http://127.0.0.1:1/" } })
      : new Response(challenge);
  };
  backend.connectWebSocket = async request => {
    if (!running || request.targetPort !== 4173 || request.binding.workspaceId !== handle.sandboxId) {
      throw new Error("changed guest socket target");
    }
    await authorizePreview(request);
    const pending: string[] = [];
    let closed = false;
    let wake: (() => void) | undefined;
    return { protocol: "vite-hmr", send: async frame => { pending.push(String(frame)); wake?.(); },
      messages: (async function* () {
        while (!closed) {
          if (pending.length) { yield pending.shift()!; continue; }
          await new Promise<void>(resolve => { wake = resolve; });
        }
      })(), close: async () => { closed = true; wake?.(); } };
  };
  const token = (cookie: string | null) => cookie?.startsWith("__ezpreview=")
    ? cookie.slice("__ezpreview=".length) : null;
  const socketHandler = createPreviewWebSocketHandler();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    async fetch(request, bunServer) {
      if (new URL(request.url).pathname === "/api/ready") return new Response("ready");
      const previewId = (request.headers.get("host") ?? "").split(".")[0]!;
      return await tryBridgePreviewWebSocket(request, previewId, "localhost", {
        server: { upgrade: (raw, options) => raw === request && bunServer.upgrade(request,
          { data: options?.data, ...(options?.headers ? { headers: options.headers } : {}) }) }, request,
      })
        ?? new Response("Not found", { status: 404 });
    }, websocket: { open: socketHandler.open, close: socketHandler.close,
      message: (socket, frame) => socketHandler.message(socket,
        typeof frame === "string" ? frame : Uint8Array.from(frame).buffer),
    } });
  const wireTraffic = createIncusPreviewTrafficDriver({ env: {
    EZCORP_PUBLIC_URL: `http://127.0.0.1:${server.port}`, EZCORP_PREVIEW_APP_HOST: "localhost" } });
  await wireTraffic.ready();
  const traffic: IncusPreviewTrafficDriver = {
    ready: async () => {},
    handoff: async ({ previewId, code }) => {
      const claims = redeemOneTimeCode(code);
      if (!claims || claims.previewId !== previewId) return { status: 404, cookie: "" };
      return { status: 302, cookie: `__ezpreview=${await signPreviewToken(claims)}` };
    },
    http: async ({ previewId, cookie, path, wrongHost, malformedHost }) => {
      if (wrongHost || malformedHost) return { status: 404, body: new Uint8Array(), location: null };
      const request = new Request(`http://${previewId}.preview.localhost${path}`);
      const response = await handlePreviewRequest({ previewId, requestPath: path,
        cookieToken: token(cookie), request }, {
        verifyToken: verifyPreviewToken, getServable: getServablePreview,
        readFile: async () => { throw new Error("static file not allowed"); },
        resolveWorkspaceTarget: (_reference, row) => resolveCurrentPreviewSandboxTarget(row),
      });
      return { status: response.status, body: new Uint8Array(await response.arrayBuffer()),
        location: response.headers.get("location") };
    },
    webSocket: async request => wireTraffic.webSocket(request),
  };
  const checkpoint = spyOn(IncusQualificationCheckpointStore.prototype, "get")
    .mockImplementation(async () => ({ state: "CLAIMED", runId: "previewrun", nonce: "nonce",
      fixtureOperationId: handle.operationId, bindingId: handle.sandboxId, generation: 1,
      connectionRevision: 1, deadlineAt: new Date(Date.now() + 100_000), scope } as never));
  const witness = new IncusHostLiveWitness({ db,
    qualifications: {} as IncusQualificationStore,
    fixtures: {} as IncusQualificationFixtureService, previewBackend: backend, previewTraffic: traffic,
    activeRelease: async () => ({ installation: { id: scope.installationId,
      activeReleaseId: scope.releaseId }, release: { id: scope.releaseId } } as never),
    resolveConnection: async () => ({ id: scope.connectionId, revision: 1,
      revokedAt: null, configuration: { kind: "incus" } } as never),
  });
  const internal = witness as unknown as {
    owned: (_handle: typeof handle, requireRunning: boolean) => Promise<unknown>;
    context: () => Promise<unknown>;
    guest: (_handle: typeof handle, operation: string, input: Record<string, unknown>) => Promise<unknown>;
  };
  internal.owned = async (_handle, requireRunning) => {
    if (requireRunning && !running) throw new Error("stopped");
    return { fixture, binding: { ...binding,
      desiredState: running ? "RUNNING" : "STOPPED", observedState: running ? "RUNNING" : "STOPPED" },
    scope, selected };
  };
  internal.context = async () => ({ helperDigest: preset.helperDigests[0]! });
  let serverDeadline = 0;
  let probeObservationDeadline = 0;
  internal.guest = async (_handle, operation, input) => {
    if (operation === "processes.start") serverDeadline = Number(input.processDeadlineMs);
    return { processId: "guest-server", bootId: "guest-boot" };
  };
  witness.run = async (_handle, _argv, _timeout, observationDeadline) => {
    probeObservationDeadline = observationDeadline!;
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  witness.setPower = async () => { running = false; };
  try {
    const proof = await witness.exercisePreviewAndStop(handle, scope, preset, challenge);
    expect(proof.httpStatus).toBe(200);
    expect(proof.webSocketStatus).toBe(101);
    expect(ordinaryReadinessCalls).toBe(0);
    expect(proof.dispatch).toMatchObject({ backend: "incus", instanceId: handle.sandboxId,
      port: 4173, httpRequests: 2, webSocketConnections: 1 });
    expect(proof.denied).toEqual({ missingAuth: 404, wrongOwner: 404, malformed: 404,
      wrongHost: 404, wrongSandbox: 502, wrongGeneration: 502, wrongPort: 502,
      expired: 404, revoked: 404, stopped: 502, webSocketWrongOwner: 403,
      webSocketWrongOrigin: 403 });
    expect(served).toEqual(["/proof", "/redirect"]);
    expect(probeObservationDeadline).toBeLessThanOrEqual(serverDeadline - 60_000);
    expect(probeObservationDeadline).toBeGreaterThan(serverDeadline - 110_000);
    expect(running).toBe(false);
    expect(await db.select().from(projectMembers)).toHaveLength(1);
    const rows = await db.select().from(previewSessions);
    expect(rows).toHaveLength(3);
    expect(rows.every(row => row.status === "revoked")).toBe(true);
    expect(await db.select().from(conversations)).toHaveLength(0);
    const warnings: Array<{ message: string; detail: Record<string, unknown> }> = [];
    const originalHttp = traffic.http;
    let firstPositive = true;
    let wrongOwner = true;
    traffic.http = async request => {
      const response = await originalHttp(request);
      if (firstPositive && request.cookie && request.path === "/proof") {
        firstPositive = false;
        return { ...response, body: new TextEncoder().encode("secret-body-canary") };
      }
      if (!request.cookie && request.path === "/proof") return { ...response, status: 503 };
      if (wrongOwner && request.cookie && request.path === "/proof") {
        wrongOwner = false;
        return { ...response, status: Number.POSITIVE_INFINITY };
      }
      return response;
    };
    const child = logger.child("incus.witness");
    const warn = spyOn(logger, "child").mockImplementation(() => ({ ...child,
      warn: (message: string, detail?: Record<string, unknown>) => {
        warnings.push({ message, detail: detail ?? {} });
      } }));
    running = true;
    try {
      await expect(witness.exercisePreviewAndStop(handle, scope, preset, challenge))
        .rejects.toThrow("preview route proof is incomplete");
    } finally {
      warn.mockRestore();
      traffic.http = originalHttp;
    }
    const [diagnostic] = warnings.filter(item => item.message === "Preview route proof failed");
    expect(diagnostic).toBeDefined();
    expect(diagnostic!.detail).toMatchObject({
      positive: { httpStatus: 200, httpBodyMatches: false },
      denied: { missingAuth: 503, wrongOwner: null },
      checks: { positive: false, denied: false },
    });
    const safeLog = JSON.stringify(diagnostic);
    for (const secret of [challenge, "secret-body-canary", handle.sandboxId,
      ownerId, projectId, "__ezpreview=", "http://127.0.0.1:1/"]) {
      expect(safeLog).not.toContain(secret);
    }
    expect(running).toBe(false);
    expect((await db.select().from(previewSessions)).every(row => row.status === "revoked")).toBe(true);
    const events: string[] = [];
    running = true;
    internal.guest = async (_handle, operation) => {
      events.push(operation);
      if (operation === "processes.start") return { processId: "guest-server", bootId: "guest-boot" };
      return { process: { processId: "guest-server", bootId: "guest-boot",
        sandboxId: handle.sandboxId, state: "running", exitCode: null } };
    };
    witness.run = async () => ({ exitCode: 1, stdout: "", stderr: "" });
    witness.setPower = async () => { events.push("power.stop"); running = false; };
    await expect(witness.exercisePreviewAndStop(handle, scope, preset, challenge))
      .rejects.toThrow("preview guest loopback service is unavailable");
    expect(events).toEqual(["processes.start", "processes.inspect", "power.stop"]);
  } finally {
    releaseReadiness();
    server.stop(true);
    checkpoint.mockRestore();
    if (previousSecret === undefined) delete process.env.EZCORP_JWT_SECRET;
    else process.env.EZCORP_JWT_SECRET = previousSecret;
  }
}, 30_000);
