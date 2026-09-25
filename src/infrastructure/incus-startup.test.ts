import { expect, spyOn, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sandboxPresetDigest } from "@ezcorp/extension-contract";
import { incusManifest } from "../../extensions/incus-sandbox/manifest";
import { up as addSandboxController } from "../db/migrations/add-sandbox-controller";
import { up as addQualificationFixtures } from "../db/migrations/add-incus-qualification-fixtures";
import { up as addQualificationRuns } from "../db/migrations/add-incus-qualification-runs";
import * as schema from "../db/schema";
import type { SandboxWorkspaceTargetResolver } from "../runtime/workspaces/project-target";
import type { ActiveExtensionRelease } from "../extensions/release-process";
import type { ProviderConnectionMetadata } from "./provider-connections/store";
import type { createProviderSandboxWorkspaceBackend } from "../runtime/workspaces/provider-backend";
import { IncusLiveProbeFixtureService } from "./incus-live-probe-fixtures";
import { IncusQualificationCheckpointStore } from "./incus-qualification-checkpoint";
import { IncusLiveCleanupController } from "./incus-live-cleanup-controller";
import { IncusFeatureService } from "./incus-feature-service";
import { createIncusQualificationWitness, initializeIncusSandboxWorkspace, resumePendingIncusQualification,
  startIncusQualificationContinuation,
  reconcileIncusWithClaimedCleanup, startIncusSandboxReconciler } from "./incus-startup";

let resolver: SandboxWorkspaceTargetResolver | null = null;
let releaseId = "release";
let releaseFails = false;
let revision = 1;
let revoked = false;
let reconcileCalls = 0;
const preset = incusManifest.sandboxProviders![0]!.presets[0]!;

test("qualification witness requires a host probe root and uses the saved host fixture", async () => {
  const previous = process.env.EZCORP_INCUS_CONTROL_PROBE_ROOT;
  const scope = { installationId: "installation", releaseId: "release",
    connectionId: "connection", presetId: preset.id };
  const db = {} as Parameters<typeof createIncusQualificationWitness>[2];
  const config = { cases: Object.fromEntries(["unsupported", "missingControl", "drift", "unqualified"]
    .map(kind => [kind, { projectId: `probe-${kind}`, canaryPath: `/private/${kind}` }])),
    unqualifiedPresetId: "other-preset" };
  const ready = spyOn(IncusLiveProbeFixtureService.prototype, "readyConfig")
    .mockResolvedValue(config as never);
  try {
    delete process.env.EZCORP_INCUS_CONTROL_PROBE_ROOT;
    await expect(createIncusQualificationWitness(scope, "run", db))
      .rejects.toThrow("control probe root is unavailable");
    expect(ready).not.toHaveBeenCalled();
    process.env.EZCORP_INCUS_CONTROL_PROBE_ROOT = "/private/probe-root";
    const witness = await createIncusQualificationWitness(scope, "run", db);
    expect(ready).toHaveBeenCalledWith(scope, "run");
    expect((witness as unknown as { controlProbe: unknown }).controlProbe).toBeDefined();
  } finally {
    ready.mockRestore();
    if (previous === undefined) delete process.env.EZCORP_INCUS_CONTROL_PROBE_ROOT;
    else process.env.EZCORP_INCUS_CONTROL_PROBE_ROOT = previous;
  }
});

test("qualification continuation reports a failed handoff without leaving a pending shutdown", async () => {
  let attempts = 0;
  const stop = startIncusQualificationContinuation({ db: {} as never,
    checkpoints: { pending: async () => { attempts++; throw new Error("database unavailable"); },
      fail: async () => {} } });
  await stop();
  expect(attempts).toBe(1);
});

test("startup fences the active SP05 run and recovers only a replacement process's exact journal", async () => {
  const calls: string[] = [];
  const scope = { installationId: "install", releaseId: "release", connectionId: "connection", presetId: "preset" };
  const handle = { operationId: "qual-recovery-run", sandboxId: "binding" };
  const pending = { runId: "run", scope, handle, operationId: "destroy-operation",
    operationState: "OUTCOME_UNKNOWN", originProcessCurrent: true };
  const deps = { checkpoints: { pendingCleanup: async () => pending,
    fail: async (runId: string) => { calls.push(`fail:${runId}`); } },
  recover: async (seenScope: typeof scope, seenHandle: typeof handle) => {
    expect(seenScope).toEqual(scope); expect(seenHandle).toEqual(handle); calls.push("recover"); },
  verifySettled: async () => { calls.push("verify"); },
  reconcile: async () => { calls.push("general"); } };
  await reconcileIncusWithClaimedCleanup(deps as never);
  expect(calls).toEqual([]);
  pending.originProcessCurrent = false;
  await reconcileIncusWithClaimedCleanup(deps as never);
  expect(calls).toEqual(["recover", "fail:run", "general"]);
  calls.length = 0;
  pending.operationState = "SUCCEEDED";
  await reconcileIncusWithClaimedCleanup(deps as never);
  expect(calls).toEqual(["verify", "fail:run", "general"]);
  calls.length = 0;
  pending.operationState = "PROVIDER_PENDING";
  await expect(reconcileIncusWithClaimedCleanup(deps as never)).rejects.toThrow("operator review");
  expect(calls).toEqual([]);
  pending.operationState = "OUTCOME_UNKNOWN";
  await expect(reconcileIncusWithClaimedCleanup({ ...deps,
    recover: async () => { throw new Error("journal changed"); },
  } as never)).rejects.toThrow("journal changed");
  expect(calls).toEqual([]);
});

function binding(presetDigest: string) {
  return { id: "binding", projectId: "project", providerInstallationId: "installation",
    providerReleaseId: "release", connectionId: "connection", connectionRevision: 1,
    resourceKey: "binding", profile: preset.profile, presetId: preset.id, presetDigest,
    effectiveSettingsDigest: "settings", desiredState: "RUNNING", observedState: "RUNNING",
    tombstonedAt: null, generation: 2 };
}

test("startup workspace resolver rechecks persisted release, connection and preset pins", async () => {
  releaseId = "release"; revision = 1; revoked = false;
  initializeIncusSandboxWorkspace({
    backend: {} as ReturnType<typeof createProviderSandboxWorkspaceBackend>,
    setResolver: next => { resolver = next; },
    resolveRelease: async () => {
      if (releaseFails) throw new Error("release lookup unavailable");
      return { release: { id: releaseId, releaseDigest: "release-digest", manifest: incusManifest } } as ActiveExtensionRelease;
    },
    getConnectionMetadata: async () => ({ revision, revokedAt: revoked ? new Date() : null,
      providerInstallationId: "installation", providerReleaseId: "release",
      configuration: { kind: "incus" } }) as ProviderConnectionMetadata,
  });
  expect(resolver).not.toBeNull();
  const pinned = binding(await sandboxPresetDigest(preset)) as Parameters<SandboxWorkspaceTargetResolver>[0];
  const target = await resolver!(pinned) as { binding: Record<string, unknown> } | null;
  expect(target?.binding).toMatchObject({ projectId: "project", workspaceId: "binding",
    connectionId: "connection", generation: 2, releaseDigest: "release-digest" });
  expect((target as { backend?: { previews?: unknown } })?.backend?.previews).toBeUndefined();
  expect(await resolver!({ ...pinned, observedState: "STOPPED" })).toBeNull();
  expect(await resolver!({ ...pinned, presetDigest: "wrong" })).toBeNull();
  revision = 2;
  expect(await resolver!(pinned)).toBeNull();
  revision = 1; revoked = true;
  expect(await resolver!(pinned)).toBeNull();
  revoked = false; releaseId = "other";
  expect(await resolver!(pinned)).toBeNull();
  releaseId = "release"; releaseFails = true;
  expect(await resolver!(pinned)).toBeNull();
  releaseFails = false;
});

test("preview backend needs a compose binding and explicit host qualification", async () => {
  const previewBackend = { open: async () => {}, serve: async () => new Response("ok"), close: async () => {} };
  initializeIncusSandboxWorkspace({
    backend: {} as ReturnType<typeof createProviderSandboxWorkspaceBackend>, previewBackend,
    previewQualified: async () => true,
    setResolver: next => { resolver = next; },
    resolveRelease: async () => ({ release: { id: "release", releaseDigest: "release-digest", manifest: incusManifest } }) as ActiveExtensionRelease,
    getConnectionMetadata: async () => ({ revision: 1, revokedAt: null, providerInstallationId: "installation",
      providerReleaseId: "release", configuration: { kind: "incus" } }) as ProviderConnectionMetadata,
  });
  const linux = binding(await sandboxPresetDigest(preset)) as Parameters<SandboxWorkspaceTargetResolver>[0];
  const linuxTarget = await resolver!(linux);
  expect(linuxTarget?.backend?.previews).toBeUndefined();
  const composePreset = incusManifest.sandboxProviders![0]!.presets.find(item => item.profile === "persistent-web-compose.v1")!;
  const compose = { ...linux, profile: composePreset.profile, presetId: composePreset.id,
    presetDigest: await sandboxPresetDigest(composePreset) };
  const composeTarget = await resolver!(compose);
  expect(composeTarget?.backend?.previews).toBe(previewBackend);
});

test("startup reconciler runs immediately and closes without scheduling more work", async () => {
  reconcileCalls = 0;
  const stop = startIncusSandboxReconciler(30_000, async () => { reconcileCalls++; });
  await stop();
  expect(reconcileCalls).toBe(1);
});

test("startup reconciler reads durable state through the real service before shutdown", async () => {
  const pglite = new PGlite();
  try {
    await pglite.waitReady;
    await pglite.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, icon TEXT, variables JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
    const db = drizzle(pglite, { schema });
    await addSandboxController(db);
    await addQualificationFixtures(db);
    await addQualificationRuns(db);
    let reads = 0;
    const observedDb = new Proxy(db, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === "select") return (...args: Parameters<typeof db.select>) => {
        reads++;
        return db.select(...args);
      };
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const stop = startIncusSandboxReconciler(30_000, undefined, observedDb);
    await stop();
    expect(reads).toBeGreaterThan(0);
  } finally {
    await pglite.close();
  }
}, 30_000);

test("default reconciler requires the host project before it recovers an uncertain cleanup", async () => {
  const previous = process.env.EZCORP_INCUS_QUALIFICATION_USER_PROJECT_ID;
  const calls: string[] = [];
  const pending = { runId: "run", scope: { installationId: "installation", releaseId: "release",
    connectionId: "connection", presetId: "preset" },
    handle: { sandboxId: "binding", operationId: "fixture" }, operationId: "destroy",
    originProcessCurrent: false, operationState: "OUTCOME_UNKNOWN" };
  const checkpoint = spyOn(IncusQualificationCheckpointStore.prototype, "pendingCleanup")
    .mockResolvedValue(pending as never);
  const fail = spyOn(IncusQualificationCheckpointStore.prototype, "fail")
    .mockImplementation(async () => { calls.push("checkpoint failed"); });
  const recover = spyOn(IncusLiveCleanupController.prototype, "reconcileFromReopenedController")
    .mockImplementation(async () => { calls.push("recovered"); });
  const settle = spyOn(IncusLiveCleanupController.prototype, "settleAlreadyCompletedDestroy")
    .mockImplementation(async () => { calls.push("settled"); });
  const reconcile = spyOn(IncusFeatureService.prototype, "reconcile")
    .mockImplementation(async () => { calls.push("reconciled"); return [] as never; });
  try {
    delete process.env.EZCORP_INCUS_QUALIFICATION_USER_PROJECT_ID;
    await startIncusSandboxReconciler(30_000, undefined, {} as never)();
    expect(calls).toEqual([]);
    process.env.EZCORP_INCUS_QUALIFICATION_USER_PROJECT_ID = "reviewed-project";
    await startIncusSandboxReconciler(30_000, undefined, {} as never)();
    expect(calls).toEqual(["recovered", "checkpoint failed", "reconciled"]);
    calls.length = 0;
    pending.operationState = "SUCCEEDED";
    await startIncusSandboxReconciler(30_000, undefined, {} as never)();
    expect(calls).toEqual(["settled", "checkpoint failed", "reconciled"]);
  } finally {
    checkpoint.mockRestore(); fail.mockRestore(); recover.mockRestore();
    settle.mockRestore(); reconcile.mockRestore();
    if (previous === undefined) delete process.env.EZCORP_INCUS_QUALIFICATION_USER_PROJECT_ID;
    else process.env.EZCORP_INCUS_QUALIFICATION_USER_PROJECT_ID = previous;
  }
});

test("replacement startup uses one pending checkpoint and persists only resumed evidence", async () => {
  const calls: string[] = [];
  const scope = { installationId: "installation", releaseId: "release", connectionId: "connection", presetId: "preset" };
  const pending = { runId: "run", nonce: "nonce", scope };
  const witness = { name: "new-process-witness" };
  const evidence = { cases: [{ caseId: "SP01", status: "passed" }] };
  const deps = {
    db: {} as never,
    checkpoints: { pending: async () => { calls.push("pending"); return pending; },
      fail: async () => { calls.push("failed"); } },
    qualifications: {
      authorizeFixture: async () => { calls.push("authorize"); return { preset: { id: "preset" } }; },
      recordVerified: async (_scope: unknown, result: unknown) => {
        calls.push("record"); expect(result).toBe(evidence);
      },
    },
    createWitness: async (_scope: unknown, runId: string) => {
      calls.push(`witness:${runId}`); return witness;
    },
    resume: async (_options: { witness: unknown }, _scope: unknown, _preset: unknown,
      run: { runId: string; nonce: string }) => {
      calls.push(`resume:${run.runId}:${run.nonce}`);
      expect(_options.witness).toBe(witness);
      return evidence;
    },
  };
  await resumePendingIncusQualification(deps as never);
  expect(calls).toEqual(["pending", "authorize", "witness:run", "resume:run:nonce", "record"]);
  calls.length = 0;
  await expect(resumePendingIncusQualification({ ...deps,
    resume: async () => { throw new Error("pinned backend changed"); },
  } as never)).rejects.toThrow("pinned backend changed");
  expect(calls).toEqual(["pending", "authorize", "witness:run", "failed"]);
  calls.length = 0;
  await expect(resumePendingIncusQualification({ ...deps,
    checkpoints: { ...deps.checkpoints, fail: async () => { throw new Error("checkpoint write failed"); } },
    resume: async () => { throw new Error("pinned backend changed"); },
  } as never)).rejects.toThrow("pinned backend changed");
  expect(calls).toEqual(["pending", "authorize", "witness:run"]);
  calls.length = 0;
  await resumePendingIncusQualification({ ...deps,
    checkpoints: { ...deps.checkpoints, pending: async () => { calls.push("pending"); return null; } },
  } as never);
  expect(calls).toEqual(["pending"]);
});
