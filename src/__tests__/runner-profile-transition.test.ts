import { describe, expect, test } from "bun:test";
import type { InstallationRecord, ReleaseRecord, WorkspaceRecord } from "@ezcorp/extension-contract";
import {
  assertInstallationIdentityPreserved,
  assertOldProfileRefused,
  assertReleaseWorkspaceContract,
  runnerProfileChanged,
} from "../../scripts/lib/runner-profile-transition";

const oldImage = `docker.io/oven/bun@sha256:${"1".repeat(64)}`;
const newImage = `docker.io/oven/bun@sha256:${"2".repeat(64)}`;

const workspace = { id: "workspace", installationId: "installation", revision: 1, sourceDigest: "source" } as WorkspaceRecord;
const release = {
  imageDigest: oldImage,
  installationId: workspace.installationId,
  workspaceId: workspace.id,
  workspaceRevision: workspace.revision,
  sourceDigest: workspace.sourceDigest,
} as ReleaseRecord;
const installation = {
  id: workspace.installationId,
  ownerId: "owner",
  scope: "user",
  enabled: true,
  uninstalled: false,
  status: "active",
  grants: ["storage"],
} as InstallationRecord;

describe("runner profile transition", () => {
  test("requires a rebuild only when the immutable runner image changes", () => {
    expect(runnerProfileChanged(release, oldImage)).toBe(false);
    expect(runnerProfileChanged(release, newImage)).toBe(true);
    expect(() => runnerProfileChanged(release, "oven/bun:latest")).toThrow("immutable digest");
  });

  test("requires the old release to be refused before a profile migration", () => {
    expect(() => assertOldProfileRefused({ success: false, error: "Runtime image or isolation policy differs from the built release" })).not.toThrow();
    expect(() => assertOldProfileRefused({ success: true, output: {} })).toThrow("without a rebuild");
    expect(() => assertOldProfileRefused({ success: false, error: "Runner unavailable" })).toThrow("profile mismatch");
    expect(() => assertOldProfileRefused({ success: false })).toThrow("profile mismatch");
  });

  test("requires a rebuilt release to keep the archived workspace source contract", () => {
    expect(() => assertReleaseWorkspaceContract(release, installation.id, workspace)).not.toThrow();
    expect(() => assertReleaseWorkspaceContract({ ...release, installationId: "other" }, installation.id, workspace)).toThrow("installation");
    expect(() => assertReleaseWorkspaceContract({ ...release, workspaceId: "other" }, installation.id, workspace)).toThrow("workspace");
    expect(() => assertReleaseWorkspaceContract({ ...release, workspaceRevision: 2 }, installation.id, workspace)).toThrow("workspace revision");
    expect(() => assertReleaseWorkspaceContract({ ...release, sourceDigest: "other" }, installation.id, workspace)).toThrow("workspace source");
  });

  test("allows release generation to change but preserves installation identity and policy", () => {
    expect(() => assertInstallationIdentityPreserved(installation, { ...installation, activeReleaseId: "new-release", generation: 2 } as InstallationRecord)).not.toThrow();
    expect(() => assertInstallationIdentityPreserved(installation, { ...installation, ownerId: "other" } as InstallationRecord)).toThrow("owner");
    expect(() => assertInstallationIdentityPreserved(installation, { ...installation, grants: [] } as InstallationRecord)).toThrow("permission grants");
  });
});
