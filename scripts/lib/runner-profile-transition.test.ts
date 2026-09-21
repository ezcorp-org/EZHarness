import { describe, expect, test } from "bun:test";
import type { InstallationRecord, ReleaseRecord } from "@ezcorp/extension-contract";
import { assertInstallationIdentityPreserved, assertOldProfileRefused, runnerProfileChanged } from "./runner-profile-transition";

const oldImage = `docker.io/oven/bun@sha256:${"1".repeat(64)}`;
const newImage = `docker.io/oven/bun@sha256:${"2".repeat(64)}`;

const release = { imageDigest: oldImage } as ReleaseRecord;
const installation = {
  id: "installation",
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
    expect(() => assertOldProfileRefused({ success: false, error: "Runtime image differs" })).not.toThrow();
    expect(() => assertOldProfileRefused({ success: true, output: {} })).toThrow("without a rebuild");
  });

  test("allows release generation to change but preserves installation identity and policy", () => {
    expect(() => assertInstallationIdentityPreserved(installation, { ...installation, activeReleaseId: "new-release", generation: 2 } as InstallationRecord)).not.toThrow();
    expect(() => assertInstallationIdentityPreserved(installation, { ...installation, ownerId: "other" } as InstallationRecord)).toThrow("owner");
    expect(() => assertInstallationIdentityPreserved(installation, { ...installation, grants: [] } as InstallationRecord)).toThrow("permission grants");
  });
});
