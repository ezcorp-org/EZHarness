import { expect, test } from "bun:test";
import {
  CANDIDATE_SANDBOX_QUALIFICATION_CASES,
  LIVE_SANDBOX_QUALIFICATION_CASES,
  sandboxPresetDigest,
  type CandidateVerificationReport,
  type ExtensionManifestV4,
  type LiveSandboxPresetQualification,
  type ReleaseRecord,
  type SandboxPresetQualification,
} from "@ezcorp/extension-contract";
import { digestObject } from "./blobs";
import { assertSandboxPresetReady, assertSandboxPresetReleaseQualification } from "./sandbox-preset-qualification";

const NOW = Date.parse("2026-09-21T12:00:00.000Z");
const digest = (character: string) => character.repeat(64);

function manifest(): ExtensionManifestV4 {
  return {
    schemaVersion: 4,
    name: "sandbox-provider",
    version: "1.0.0",
    description: "Sandbox provider fixture",
    author: { name: "Test" },
    permissions: {},
    sandboxProviders: [{
      id: "incus",
      profiles: ["linux-exec.v1"],
      presets: [{
        id: "nixos-small",
        profile: "linux-exec.v1",
        imageDigest: digest("1"),
        recipeDigest: digest("2"),
        helperDigests: [digest("3")],
        storage: { workspace: "ephemeral", minimumBytes: 1024 },
        network: { mode: "private", outbound: "restricted" },
        limits: { memoryBytes: 1024, cpuMillis: 1000, pids: 16, diskBytes: 2048, timeoutMs: 5000 },
        requirements: { backendApis: ["incus/1.0"], architectures: ["amd64"], storageDrivers: ["zfs"], isolation: ["container"], nestedCompose: false },
        allowedOverrides: {},
      }],
    }],
  };
}

function releaseInput(releaseManifest = manifest()) {
  return {
    installationId: "installation",
    workspaceId: "workspace",
    workspaceRevision: 1,
    sourceDigest: digest("4"),
    artifactDigest: digest("5"),
    imageDigest: digest("6"),
    manifest: releaseManifest,
    evidence: { protocolVersion: 4 as const, validatorVersion: "host-v1", tests: [{ name: "build", passed: true }], discoveryDigest: digestObject(releaseManifest) },
    runnerProfile: "isolated-v1",
    policyDigest: digest("7"),
  };
}

async function qualifiedRelease(): Promise<{ release: ReleaseRecord; qualification: SandboxPresetQualification }> {
  const input = releaseInput();
  const releaseDigest = digestObject(input);
  const preset = input.manifest.sandboxProviders![0]!.presets[0]!;
  const qualification: SandboxPresetQualification = {
    producer: "host",
    providerId: "incus",
    presetId: preset.id,
    profile: preset.profile,
    releaseDigest,
    presetDigest: await sandboxPresetDigest(preset),
    verifiedAt: "2026-09-21T11:00:00.000Z",
    validUntil: "2026-09-21T13:00:00.000Z",
    cases: CANDIDATE_SANDBOX_QUALIFICATION_CASES.map(caseId => ({ caseId, status: "passed" })),
  };
  const verification: CandidateVerificationReport = { catalog: "verified", smoke: "not_declared", capabilities: [], sandboxPresetQualifications: [qualification] };
  return { release: { ...input, id: "release", createdAt: "2026-09-21T11:00:00.000Z", verification, releaseDigest: digestObject({ ...input, verification }) }, qualification };
}

function rebindRelease(release: ReleaseRecord, patch: Partial<ReleaseRecord>): ReleaseRecord {
  const changed = { ...release, ...patch };
  const { id: _id, createdAt: _createdAt, releaseDigest: _releaseDigest, ...storedInput } = changed;
  changed.releaseDigest = digestObject(storedInput);
  return changed;
}

test("ordinary releases remain compatible without sandbox qualification", async () => {
  const { sandboxProviders: _sandboxProviders, ...ordinaryManifest } = manifest();
  const input = releaseInput(ordinaryManifest);
  await expect(assertSandboxPresetReleaseQualification({ ...input, id: "release", createdAt: "invalid but unused", releaseDigest: "legacy" })).resolves.toBeUndefined();
});

test("candidate qualification requires the exact current passing case set", async () => {
  const { release, qualification } = await qualifiedRelease();
  await expect(assertSandboxPresetReleaseQualification(release, release.verification, NOW)).resolves.toBeUndefined();
  const invalid: unknown[] = [
    { catalog: "verified", smoke: "not_declared", capabilities: [] },
    { ...release.verification, sandboxPresetQualifications: [] },
    { ...release.verification, sandboxPresetQualifications: [qualification, { ...qualification, presetId: "extra" }] },
    { ...release.verification, sandboxPresetQualifications: [{ ...qualification, cases: qualification.cases.slice(1) }] },
    { ...release.verification, sandboxPresetQualifications: [{ ...qualification, cases: qualification.cases.map((result, index) => index === 0 ? { ...result, status: "failed" as const } : result) }] },
    { ...release.verification, sandboxPresetQualifications: [{ ...qualification, cases: qualification.cases.map((result, index) => index === 0 ? { ...result, status: "skipped" as const } : result) }] },
    { ...release.verification, sandboxPresetQualifications: [{ ...qualification, validUntil: "2026-09-21T12:00:00.000Z" }] },
    { ...release.verification, sandboxPresetQualifications: [{ ...qualification, releaseDigest: digest("8") }] },
    { ...release.verification, sandboxPresetQualifications: [{ ...qualification, presetDigest: digest("9") }] },
    { ...release.verification, sandboxPresetQualifications: [{ ...qualification, providerId: "other" }] },
    { ...release.verification, sandboxPresetQualifications: [{ ...qualification, presetId: "other" }] },
  ];
  for (const verification of invalid) await expect(assertSandboxPresetReleaseQualification(release, verification as CandidateVerificationReport | undefined, NOW)).rejects.toMatchObject({ code: "INVALID_QUALIFICATION" });

  const duplicateManifest = structuredClone(release.manifest);
  duplicateManifest.sandboxProviders![0]!.presets.push({ ...duplicateManifest.sandboxProviders![0]!.presets[0]!, id: "second" });
  const duplicateRelease = rebindRelease(release, { manifest: duplicateManifest });
  const duplicateReport = { ...release.verification!, sandboxPresetQualifications: [qualification, qualification] };
  await expect(assertSandboxPresetReleaseQualification(duplicateRelease, duplicateReport, NOW)).rejects.toMatchObject({ code: "INVALID_QUALIFICATION" });
});

test("candidate evidence is bound to release, source, artifact, preset recipe, image, and helpers", async () => {
  const { release } = await qualifiedRelease();
  const imageChanged = structuredClone(release.manifest);
  imageChanged.sandboxProviders![0]!.presets[0]!.imageDigest = digest("b");
  const recipeChanged = structuredClone(release.manifest);
  recipeChanged.sandboxProviders![0]!.presets[0]!.recipeDigest = digest("c");
  const helpersChanged = structuredClone(release.manifest);
  helpersChanged.sandboxProviders![0]!.presets[0]!.helperDigests = [digest("a")];
  const changed = [
    rebindRelease(release, { sourceDigest: digest("d") }),
    rebindRelease(release, { artifactDigest: digest("e") }),
    ...[imageChanged, recipeChanged, helpersChanged].map(changedManifest => rebindRelease(release, { manifest: changedManifest })),
  ];
  for (const candidate of changed) await expect(assertSandboxPresetReleaseQualification(candidate, candidate.verification, NOW)).rejects.toMatchObject({ code: "INVALID_QUALIFICATION" });
  await expect(assertSandboxPresetReleaseQualification({ ...release, artifactDigest: digest("f") }, release.verification, NOW)).rejects.toMatchObject({ code: "INVALID_QUALIFICATION" });
});

test("activated release keeps intact candidate evidence after its deadline", async () => {
  const { release, qualification } = await qualifiedRelease();
  const later = Date.parse("2026-09-21T14:00:00.000Z");
  await expect(assertSandboxPresetReleaseQualification(release, release.verification, later)).rejects.toMatchObject({ code: "INVALID_QUALIFICATION" });
  await expect(assertSandboxPresetReleaseQualification(release, release.verification, later, "integrity")).resolves.toBeUndefined();
  const missing = rebindRelease(release, { verification: { ...release.verification!, sandboxPresetQualifications: [] } });
  await expect(assertSandboxPresetReleaseQualification(missing, missing.verification, later, "integrity")).rejects.toMatchObject({ code: "INVALID_QUALIFICATION" });
  const forged = rebindRelease(release, { verification: { ...release.verification!, sandboxPresetQualifications: [{ ...qualification, cases: qualification.cases.slice(1) }] } });
  await expect(assertSandboxPresetReleaseQualification(forged, forged.verification, later, "integrity")).rejects.toMatchObject({ code: "INVALID_QUALIFICATION" });
});

test("Ready requires exact live SP01-SP08 evidence for the selected current release and settings", async () => {
  const { release, qualification: candidate } = await qualifiedRelease();
  const live: LiveSandboxPresetQualification = {
    producer: "live-provider",
    connectionId: "connection-1",
    providerId: candidate.providerId,
    presetId: candidate.presetId,
    profile: candidate.profile,
    releaseDigest: release.releaseDigest,
    presetDigest: candidate.presetDigest,
    effectiveSettingsDigest: digest("a"),
    backendVersion: "6.0.6",
    verifiedAt: "2026-09-21T11:00:00.000Z",
    validUntil: "2026-09-21T13:00:00.000Z",
    cases: LIVE_SANDBOX_QUALIFICATION_CASES.map(caseId => ({ caseId, status: "passed" })),
  };
  const context = { providerId: "incus", presetId: "nixos-small", connectionId: "connection-1", effectiveSettingsDigest: digest("a"), now: NOW };
  await expect(assertSandboxPresetReady(release, live, context)).resolves.toBeUndefined();
  await expect(assertSandboxPresetReady(release, { ...live, validUntil: "2026-09-21T15:00:00.000Z" }, { ...context, now: Date.parse("2026-09-21T14:00:00.000Z") })).resolves.toBeUndefined();
  await expect(assertSandboxPresetReady(release, live, { ...context, now: Date.parse("2026-09-21T14:00:00.000Z") })).rejects.toMatchObject({ code: "INVALID_QUALIFICATION" });
  for (const changed of [
    { ...live, cases: live.cases.filter(result => result.caseId !== "SP04") },
    { ...live, cases: live.cases.map(result => result.caseId === "SP06" ? { ...result, status: "failed" as const } : result) },
    { ...live, validUntil: "2026-09-21T12:00:00.000Z" },
    { ...live, connectionId: "other" },
    { ...live, effectiveSettingsDigest: digest("b") },
    { ...live, releaseDigest: digest("c") },
  ]) await expect(assertSandboxPresetReady(release, changed, context)).rejects.toMatchObject({ code: "INVALID_QUALIFICATION" });
  await expect(assertSandboxPresetReady(release, live, { ...context, presetId: "missing" })).rejects.toMatchObject({ code: "INVALID_QUALIFICATION" });
  await expect(assertSandboxPresetReady(release, live, { ...context, providerId: "missing" })).rejects.toMatchObject({ code: "INVALID_QUALIFICATION" });
});
