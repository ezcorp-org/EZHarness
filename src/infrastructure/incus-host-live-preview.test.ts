import { afterAll, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sandboxPresetDigest } from "@ezcorp/extension-contract";
import { INCUS_PRESETS } from "../../extensions/incus-sandbox/manifest";
import { setupTestDb, closeTestDb } from "../__tests__/helpers/test-pglite";
import { __test as connectionTest } from "../db/connection";
import { conversations, previewSessions, projectMembers, projects, users } from "../db/schema";
import { getServablePreview, isValidPreviewId } from "../db/queries/preview-sessions";
import { redeemOneTimeCode, signPreviewToken, verifyPreviewToken } from "../runtime/preview/preview-token";
import { handlePreviewRequest } from "../runtime/preview/preview-proxy";
import { decideWebSocketUpgrade } from "../runtime/preview/preview-ws";
import { resolveCurrentPreviewSandboxTarget } from "../runtime/preview/preview-target";
import { IncusQualificationCheckpointStore } from "./incus-qualification-checkpoint";
import { IncusHostLiveWitness } from "./incus-host-live-witness";
import type { IncusPreviewTrafficDriver } from "./incus-preview-traffic";
import { IncusSandboxPreviewBackend } from "./incus-preview-backend";
import type { IncusQualificationFixtureService, IncusQualificationStore } from "./incus-qualification";

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
    let sent = "";
    return { protocol: "vite-hmr", send: async frame => { sent = String(frame); },
      messages: (async function* () { yield sent; })(), close: async () => {} };
  };
  const token = (cookie: string | null) => cookie?.startsWith("__ezpreview=")
    ? cookie.slice("__ezpreview=".length) : null;
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
    webSocket: async ({ previewId, cookie, path, challenge: socketChallenge, wrongOrigin }) => {
      const decision = await decideWebSocketUpgrade({ previewId, requestPath: path,
        cookieToken: token(cookie), origin: wrongOrigin ? "https://invalid.invalid"
          : `http://${previewId}.preview.localhost`, appHost: "localhost" },
      { verifyToken: verifyPreviewToken, getServable: getServablePreview, isValidPreviewId });
      if (!decision.accept || !("kind" in decision) || decision.kind !== "sandbox") {
        return { status: 403, subprotocol: null, reply: "" };
      }
      const target = await resolveCurrentPreviewSandboxTarget(decision.row);
      if (target?.kind !== "sandbox" || !target.backend?.previews?.connectWebSocket) {
        return { status: 403, subprotocol: null, reply: "" };
      }
      const socket = await target.backend.previews.connectWebSocket({ binding: target.binding,
        previewId, userId: decision.userId, targetPort: decision.port, requestPath: path,
        search: "", expiresAt: decision.row.expiresAt!, signal: new AbortController().signal,
        subprotocol: "vite-hmr" });
      await socket.send(socketChallenge);
      for await (const reply of socket.messages) {
        await socket.close();
        return { status: 101, subprotocol: socket.protocol, reply: String(reply) };
      }
      throw new Error("guest socket did not answer");
    },
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
    checkpoint.mockRestore();
    if (previousSecret === undefined) delete process.env.EZCORP_JWT_SECRET;
    else process.env.EZCORP_JWT_SECRET = previousSecret;
  }
}, 30_000);
