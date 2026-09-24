import { expect, test } from "bun:test";
import { sandboxPresetDigest } from "@ezcorp/extension-contract";
import { incusManifest } from "../../extensions/incus-sandbox/manifest";
import type { SandboxWorkspaceTargetResolver } from "../runtime/workspaces/project-target";
import type { ActiveExtensionRelease } from "../extensions/release-process";
import type { ProviderConnectionMetadata } from "./provider-connections/store";
import type { createProviderSandboxWorkspaceBackend } from "../runtime/workspaces/provider-backend";
import { initializeIncusSandboxWorkspace, startIncusSandboxReconciler } from "./incus-startup";

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
  const stop = startIncusSandboxReconciler(30_000, async () => { reconcileCalls++; });
  await stop();
  expect(reconcileCalls).toBe(1);
});
