import { expect, mock, test } from "bun:test";
import { sandboxPresetDigest } from "@ezcorp/extension-contract";
import { incusManifest } from "../../extensions/incus-sandbox/manifest";

let resolver: ((binding: Record<string, unknown>) => Promise<unknown>) | null = null;
let releaseId = "release";
let releaseFails = false;
let revision = 1;
let revoked = false;
let reconcileCalls = 0;
mock.module("../db/connection", () => ({ getDb: () => ({}) }));
mock.module("../runtime/workspaces/project-target", () => ({
  setSandboxWorkspaceTargetResolver: (next: typeof resolver) => { resolver = next; },
}));
mock.module("../extensions/release-process", () => ({
  getReleaseRuntime: () => ({}),
  resolveActiveRelease: async () => { if (releaseFails) throw new Error("release lookup unavailable"); return { release: { id: releaseId, releaseDigest: "release-digest", manifest: incusManifest } }; },
}));
mock.module("./provider-connections/store", () => ({
  ProviderConnectionStore: class {
    async getMetadata() { return { revision, revokedAt: revoked ? new Date() : null,
      providerInstallationId: "installation", providerReleaseId: "release", configuration: { kind: "incus" } }; }
  },
}));
mock.module("./incus-feature-service", () => ({
  IncusFeatureService: class { async reconcile() { reconcileCalls++; } },
}));
mock.module("./incus-qualification", () => ({ IncusQualificationStore: class { async load() { return null; } } }));
const { initializeIncusSandboxWorkspace, startIncusSandboxReconciler } = await import("./incus-startup");
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
  initializeIncusSandboxWorkspace();
  expect(resolver).not.toBeNull();
  const pinned = binding(await sandboxPresetDigest(preset));
  const target = await resolver!(pinned) as { binding: Record<string, unknown> } | null;
  expect(target?.binding).toMatchObject({ projectId: "project", workspaceId: "binding",
    connectionId: "connection", generation: 2, releaseDigest: "release-digest" });
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

test("startup reconciler runs immediately and closes without scheduling more work", async () => {
  reconcileCalls = 0;
  const stop = startIncusSandboxReconciler(30_000);
  await stop();
  expect(reconcileCalls).toBe(1);
});
