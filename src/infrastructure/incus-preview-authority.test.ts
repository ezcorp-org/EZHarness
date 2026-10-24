import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sandboxPresetDigest } from "@ezcorp/extension-contract";
import { incusManifest } from "../../extensions/incus-sandbox/manifest";
import { releaseRuntimeFixture } from "../__tests__/helpers/release-runtime";
import type { SandboxBinding } from "../db/schema";
import type { SandboxWorkspaceBinding } from "../runtime/workspaces/target";
import type { IncusWorkspaceCaller } from "./incus-workspace-caller";
import type { IncusPreviewDuplexRequest } from "./incus-transport/preview-duplex";
import { createIncusPreviewAuthorizer, incusPreviewQualified, type IncusPreviewAuthorityDependencies } from "./incus-preview-authority";
import { IncusQualificationStore } from "./incus-qualification";
import { setupTestDb, closeTestDb } from "../__tests__/helpers/test-pglite";
import { users, projects, conversations, previewSessions } from "../db/schema";
import { eq } from "drizzle-orm";
import { registerClaimedQualificationPreview } from "./incus-qualification-preview-permit";
import { registerQualificationPreviewTarget } from "../runtime/preview/preview-target";
import { sandboxWorkspaceTarget } from "../runtime/workspaces/target";
import { IncusSandboxPreviewBackend } from "./incus-preview-backend";

async function fixture() {
  const now = Date.now();
  const { snapshot } = releaseRuntimeFixture("preview-installation", structuredClone(incusManifest));
  const preset = snapshot.release.manifest.sandboxProviders![0]!.presets.find(p => p.profile === "persistent-web-compose.v1")!;
  const binding: SandboxWorkspaceBinding = { providerId: "incus", projectId: "project", workspaceId: "sandbox",
    connectionId: "connection", generation: 3, presetId: preset.id, presetDigest: await sandboxPresetDigest(preset),
    releaseDigest: snapshot.release.releaseDigest, effectiveSettingsDigest: "b".repeat(64) };
  const current = { id: binding.workspaceId, projectId: binding.projectId, connectionId: binding.connectionId,
    providerInstallationId: snapshot.installation.id, providerReleaseId: snapshot.release.id, connectionRevision: 2,
    resourceKey: binding.workspaceId, generation: binding.generation, profile: preset.profile, presetId: preset.id,
    presetDigest: binding.presetDigest, effectiveSettingsDigest: binding.effectiveSettingsDigest,
    desiredState: "RUNNING", observedState: "RUNNING", tombstonedAt: null } as SandboxBinding;
  const connection = { id: "connection", revision: 2, providerInstallationId: snapshot.installation.id,
    providerReleaseId: snapshot.release.id, revokedAt: null, project: "ezharness",
    endpoint: "https://incus.example:8443", serverCertificatePem: readFileSync(new URL("./incus-transport/test-server.pem", import.meta.url), "utf8"),
    configuration: { kind: "incus" as const, profile: "ezharness-feature", guestUser: "sandbox", helperVersion: "0.1.0" },
    clientCertificatePem: "client-certificate", privateKeyPem: "host-private-key" };
  const row = { id: "a".repeat(26), userId: "owner", conversationId: "conversation",
    kind: "dynamic" as const, status: "active", revokedAt: null as Date | null,
    expiresAt: new Date(now + 60_000), targetPort: 3000, workspaceTarget: { kind: "sandbox" as const, binding } };
  const conversation = { userId: "owner", projectId: "project" };
  const calls: string[] = [];
  let qualified = true;
  let permitted = false;
  let revoked = false;
  const deps: IncusPreviewAuthorityDependencies = { db: {} as never, now: () => now,
    readPreview: async id => { calls.push(`preview:${id}`); return row as never; },
    readConversation: async () => conversation,
    caller: { authorizeBinding: async (seen, userId) => {
      calls.push(`authorize:${userId}`);
      expect(seen).toEqual(binding);
      if (revoked) throw new Error("Member revoked");
      return { current, snapshot, connection } as Awaited<ReturnType<IncusWorkspaceCaller["authorizeBinding"]>>;
    } }, qualified: async () => qualified, fixturePermitted: async () => permitted };
  const request: IncusPreviewDuplexRequest = { binding, previewId: row.id, userId: row.userId,
    targetPort: row.targetPort, expiresAt: row.expiresAt, requestPath: "/hmr", search: "?v=1",
    subprotocol: "vite-hmr", signal: new AbortController().signal };
  return { authorize: createIncusPreviewAuthorizer(deps), deps, request, row, conversation, connection, current, calls,
    setQualified: (value: boolean) => { qualified = value; },
    setPermitted: (value: boolean) => { permitted = value; },
    revoke: () => { revoked = true; } };
}

async function claimedFixture() {
  const f = await fixture();
  let now = Date.now();
  let ordinaryQualified = false;
  let ordinaryCalls = 0;
  const state = { runId: "claimed-run", nonce: "claimed-nonce", state: "CLAIMED",
    fixtureOperationId: "claimed-operation", fixtureBindingId: f.request.binding.workspaceId,
    fixtureGeneration: f.request.binding.generation, connectionRevision: 2,
    releaseDigest: f.request.binding.releaseDigest!, binding: f.request.binding, running: true };
  const target = sandboxWorkspaceTarget(f.request.binding, { execute: async () => { throw new Error("No guest execution in this fixture"); },
    previews: new IncusSandboxPreviewBackend({} as never) });
  const dispose = await registerClaimedQualificationPreview({
    key: { previewId: f.request.previewId, userId: f.request.userId,
      conversationId: f.row.conversationId, binding: f.request.binding, targetPort: f.request.targetPort! },
    runId: state.runId, nonce: state.nonce, fixtureOperationId: state.fixtureOperationId,
    connectionRevision: state.connectionRevision, releaseDigest: state.releaseDigest,
    expiresAtMs: now + 60_000, target,
  }, { register: registerQualificationPreviewTarget, readCurrent: async () => state, now: () => now });
  const authorize = createIncusPreviewAuthorizer({ ...f.deps, fixturePermitted: undefined,
    qualified: async () => { ordinaryCalls++; return ordinaryQualified; } });
  return { ...f, authorize, state, dispose,
    expire: () => { now += 60_000; }, ordinaryCalls: () => ordinaryCalls,
    qualifyOrdinary: () => { ordinaryQualified = true; } };
}

test("a strict claimed fixture skips ordinary readiness and revalidates its current lease", async () => {
  const f = await claimedFixture();
  try {
    const approved = await f.authorize(f.request);
    expect(f.ordinaryCalls()).toBe(0);
    await approved.revalidate();
    expect(f.ordinaryCalls()).toBe(0);
    f.state.running = false;
    await expect(approved.revalidate()).rejects.toThrow("not qualified");
    expect(f.ordinaryCalls()).toBe(1);
    f.qualifyOrdinary();
    await approved.revalidate();
    expect(f.ordinaryCalls()).toBe(2);
    f.revoke();
    await expect(approved.revalidate()).rejects.toThrow("Member revoked");
  } finally { f.dispose(); }
});

const staleClaims = {
  state: "COMPLETED", runId: "other-run", nonce: "other-nonce", fixtureOperationId: "other-operation",
  fixtureBindingId: "other-binding", fixtureGeneration: 4, connectionRevision: 3,
  releaseDigest: "f".repeat(64), running: false,
} as const;
for (const [field, value] of Object.entries(staleClaims)) {
  test(`a stale claimed preview ${field} falls back to fresh ordinary qualification`, async () => {
    const f = await claimedFixture();
    try {
      Object.assign(f.state, { [field]: value });
      await expect(f.authorize(f.request)).rejects.toThrow("not qualified");
      expect(f.ordinaryCalls()).toBe(1);
      f.qualifyOrdinary();
      const approved = await f.authorize(f.request);
      expect(f.ordinaryCalls()).toBe(2);
      await approved.revalidate();
      expect(f.ordinaryCalls()).toBe(3);
    } finally { f.dispose(); }
  });
}
for (const lifecycle of ["disposed", "expired"] as const) {
  test(`a ${lifecycle} claimed preview falls back to fresh ordinary qualification`, async () => {
    const f = await claimedFixture();
    try {
      if (lifecycle === "disposed") f.dispose(); else f.expire();
      await expect(f.authorize(f.request)).rejects.toThrow("not qualified");
      expect(f.ordinaryCalls()).toBe(1);
      f.qualifyOrdinary();
      const approved = await f.authorize(f.request);
      expect(f.ordinaryCalls()).toBe(2);
      await approved.revalidate();
      expect(f.ordinaryCalls()).toBe(3);
    } finally { f.dispose(); }
  });
}

test("preview authority binds transport to the registered guest and keeps credentials host-only", async () => {
  const f = await fixture();
  const authorized = await f.authorize(f.request);
  expect(authorized.command).toMatchObject({ action: "endpoint.open", connectionId: "connection",
    tags: { sandboxId: "sandbox", managedBy: "ezharness-incus-sandbox" }, payload: {} });
  expect(authorized.scope).toMatchObject({ revision: 2, approvedGuest: { uid: 1000, gid: 1000, user: "sandbox" } });
  expect(authorized.command.deadlineMs).toBe(f.row.expiresAt.getTime());
  expect(JSON.stringify(authorized.command)).not.toContain("host-private-key");
  expect(await authorized.connections.resolveForHost({ connectionId: "connection",
    providerInstallationId: f.current.providerInstallationId, providerReleaseId: f.current.providerReleaseId,
    revision: 2 })).toEqual(f.connection);
  await expect(authorized.connections.resolveForHost({ connectionId: "other",
    providerInstallationId: f.current.providerInstallationId, providerReleaseId: f.current.providerReleaseId,
    revision: 2 })).rejects.toThrow("connection changed");
});

test("preview authority rejects foreign identity, port, generation, expiry and conversation before transport", async () => {
  const f = await fixture();
  const attempts: IncusPreviewDuplexRequest[] = [
    { ...f.request, userId: "other" }, { ...f.request, targetPort: 3001 },
    { ...f.request, binding: { ...f.request.binding, generation: 4 } },
    { ...f.request, expiresAt: new Date(f.request.expiresAt.getTime() + 1) },
    { ...f.request, previewId: "bad" },
  ];
  for (const request of attempts) await expect(f.authorize(request)).rejects.toThrow();
  expect(f.calls.some(call => call.startsWith("authorize:"))).toBe(false);
  f.conversation.projectId = "other-project";
  await expect(f.authorize(f.request)).rejects.toThrow("conversation changed");
});

test("an established stream rechecks revocation and membership before further frames", async () => {
  const f = await fixture();
  const authorized = await f.authorize(f.request);
  f.row.revokedAt = new Date();
  await expect(authorized.revalidate()).rejects.toThrow("registration changed");
  f.row.revokedAt = null;
  f.revoke();
  await expect(authorized.revalidate()).rejects.toThrow("Member revoked");
});

test("missing qualification stays closed except an exact host fixture permit", async () => {
  const f = await fixture();
  f.setQualified(false);
  await expect(f.authorize(f.request)).rejects.toThrow("not qualified");
  f.setPermitted(true);
  const authorized = await f.authorize(f.request);
  f.setPermitted(false);
  await expect(authorized.revalidate()).rejects.toThrow("not qualified");
});

test("capture prevents caller mutation from replacing the authority during an open stream", async () => {
  const f = await fixture();
  const authorized = await f.authorize(f.request);
  f.request.userId = "attacker";
  f.request.binding = { ...f.request.binding, generation: 99 };
  await authorized.revalidate();
  expect(f.calls.at(-1)).toBe("authorize:owner");
});

test("production preview qualification rejects a missing or mismatched current profile proof", async () => {
  const f = await fixture();
  const load = spyOn(IncusQualificationStore.prototype, "load").mockResolvedValue(null);
  try {
    expect(await incusPreviewQualified({ ...f.current, profile: "linux-exec.v1" }, f.deps.db)).toBe(false);
    expect(await incusPreviewQualified(f.current, f.deps.db)).toBe(false);
    load.mockResolvedValue({ presetDigest: "stale", effectiveSettingsDigest: f.current.effectiveSettingsDigest } as never);
    expect(await incusPreviewQualified(f.current, f.deps.db)).toBe(false);
    load.mockResolvedValue({ presetDigest: f.current.presetDigest, effectiveSettingsDigest: f.current.effectiveSettingsDigest } as never);
    expect(await incusPreviewQualified(f.current, f.deps.db)).toBe(true);
    const authorizer = createIncusPreviewAuthorizer({ ...f.deps, qualified: undefined });
    await authorizer(f.request);
  } finally { load.mockRestore(); }
});

test("no fixture registration grants access to an unqualified preview", async () => {
  const f = await fixture();
  f.setQualified(false);
  const authorize = createIncusPreviewAuthorizer({ ...f.deps, fixturePermitted: undefined });
  await expect(authorize(f.request)).rejects.toThrow("not qualified");
});

test("an invalid request cannot open the default host caller or registry", async () => {
  const f = await fixture();
  const authorize = createIncusPreviewAuthorizer({ db: {} as never });
  await expect(authorize({ ...f.request, previewId: "invalid" })).rejects.toThrow("authority is unavailable");
});

test("production registry queries observe persisted port changes before another stream frame", async () => {
  const f = await fixture();
  const { db } = await setupTestDb();
  try {
    await db.insert(users).values({ id: "owner", email: "owner@example.test", passwordHash: "unused", name: "Owner" });
    await db.insert(projects).values({ id: "project", name: "Preview fixture", path: "/__sandbox_unavailable__/project" });
    await db.insert(conversations).values({ id: "conversation", projectId: "project", userId: "owner" });
    await db.insert(previewSessions).values({ ...f.row, status: "active" });
    const authorize = createIncusPreviewAuthorizer({ ...f.deps, db, readPreview: undefined, readConversation: undefined });
    const stream = await authorize(f.request);
    await db.update(previewSessions).set({ targetPort: 4000 }).where(eq(previewSessions.id, f.row.id));
    await expect(stream.revalidate()).rejects.toThrow("registration changed");
  } finally { await closeTestDb(); }
}, 30_000);
