import { strict as assert } from "node:assert";
import type { InstallationRecord, ReleaseRecord } from "@ezcorp/extension-contract";

export type ToolInvocationResult = { success: boolean; error?: string; output?: unknown };

export function runnerProfileChanged(previous: ReleaseRecord, currentRunnerImage: string): boolean {
  assert.match(currentRunnerImage, /^\S+@sha256:[a-f0-9]{64}$/, "Current runner image must be an immutable digest");
  assert.match(previous.imageDigest, /^\S+@sha256:[a-f0-9]{64}$/, "Previous release must record an immutable runner image");
  return previous.imageDigest !== currentRunnerImage;
}

export function assertOldProfileRefused(result: ToolInvocationResult): void {
  assert.equal(result.success, false, "An old-profile release executed under the new runner profile without a rebuild");
}

export function assertInstallationIdentityPreserved(previous: InstallationRecord, current: InstallationRecord): void {
  assert.equal(current.id, previous.id, "Runner-profile rebuild replaced the installation");
  assert.equal(current.ownerId, previous.ownerId, "Runner-profile rebuild changed the installation owner");
  assert.equal(current.scope, previous.scope, "Runner-profile rebuild changed the installation scope");
  assert.equal(current.enabled, true, "Runner-profile rebuild did not leave the installation enabled");
  assert.equal(current.uninstalled, false, "Runner-profile rebuild uninstalled the extension");
  assert.equal(current.status, "active", "Runner-profile rebuild did not restore active status");
  assert.deepEqual(current.grants, previous.grants, "Runner-profile rebuild changed permission grants");
}
