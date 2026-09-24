import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sandboxPresetDigest } from "@ezcorp/extension-contract";
import { incusManifest } from "../../extensions/incus-sandbox/manifest";
import { up as addSandboxController } from "../db/migrations/add-sandbox-controller";
import { up as addQualificationFixtures } from "../db/migrations/add-incus-qualification-fixtures";
import * as schema from "../db/schema";
import type { SandboxWorkspaceTargetResolver } from "../runtime/workspaces/project-target";
import type { ActiveExtensionRelease } from "../extensions/release-process";
import type { ProviderConnectionMetadata } from "./provider-connections/store";
import type { createProviderSandboxWorkspaceBackend } from "../runtime/workspaces/provider-backend";
import { initializeIncusSandboxWorkspace, resumePendingIncusQualification,
  startIncusSandboxReconciler } from "./incus-startup";

let resolver: SandboxWorkspaceTargetResolver | null = null;
let releaseId = "release";
let releaseFails = false;
let revision = 1;
let revoked = false;
let reconcileCalls = 0;
const preset = incusManifest.sandboxProviders![0]!.presets[0]!;

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
  await resumePendingIncusQualification({ ...deps,
    checkpoints: { ...deps.checkpoints, pending: async () => { calls.push("pending"); return null; } },
  } as never);
  expect(calls).toEqual(["pending"]);
});
