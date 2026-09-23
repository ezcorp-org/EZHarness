import { describe, expect, test } from "bun:test";
import type { ExtensionManifestV4, LiveSandboxPresetQualification, SandboxPreset, SandboxPresetQualification } from "./types";
import { composeSandboxPreset as composePreset, linuxSandboxPreset as linuxPreset, manifestWithSandboxPresets as manifestWith, SANDBOX_FIXTURE_NOW as NOW, SANDBOX_FIXTURE_RELEASE_DIGEST as RELEASE_DIGEST, SANDBOX_FIXTURE_SETTINGS_DIGEST as EFFECTIVE_SETTINGS_DIGEST, sandboxFixtureManifest as baseManifest } from "./sandbox-presets.fixture";
import { CANDIDATE_SANDBOX_QUALIFICATION_CASES, LIVE_SANDBOX_QUALIFICATION_CASES, sandboxPresetDigest, validateCandidateSandboxPresetQualifications, validateLiveSandboxPresetQualification, validateManifest, validateWire } from "./validation";

async function candidateQualification(preset: SandboxPreset, overrides: Partial<SandboxPresetQualification> = {}): Promise<SandboxPresetQualification> {
  return {
    producer: "host",
    providerId: "incus",
    presetId: preset.id,
    profile: preset.profile,
    releaseDigest: RELEASE_DIGEST,
    presetDigest: await sandboxPresetDigest(preset),
    verifiedAt: "2026-09-21T11:00:00.000Z",
    validUntil: "2026-09-21T13:00:00.000Z",
    cases: CANDIDATE_SANDBOX_QUALIFICATION_CASES.map(caseId => ({ caseId, status: "passed" })),
    ...overrides,
  };
}

async function liveQualification(preset: SandboxPreset, overrides: Partial<LiveSandboxPresetQualification> = {}): Promise<LiveSandboxPresetQualification> {
  return {
    producer: "live-provider",
    connectionId: "connection-1",
    providerId: "incus",
    presetId: preset.id,
    profile: preset.profile,
    releaseDigest: RELEASE_DIGEST,
    presetDigest: await sandboxPresetDigest(preset),
    effectiveSettingsDigest: EFFECTIVE_SETTINGS_DIGEST,
    backendVersion: "incus-6.0.6",
    verifiedAt: "2026-09-21T11:00:00.000Z",
    validUntil: "2026-09-21T13:00:00.000Z",
    cases: LIVE_SANDBOX_QUALIFICATION_CASES.map(caseId => ({ caseId, status: "passed" })),
    ...overrides,
  };
}

describe("sandbox preset declarations", () => {
  test("keeps manifests without sandbox providers valid", async () => {
    expect(validateManifest(baseManifest)).toEqual(baseManifest);
    expect(await validateCandidateSandboxPresetQualifications(baseManifest, undefined, RELEASE_DIGEST, NOW)).toEqual([]);
  });

  test("accepts complete immutable presets for both fixed profiles", () => {
    const manifest = manifestWith([linuxPreset(), composePreset()]);
    expect(validateManifest(manifest)).toEqual(manifest);
  });

  test("rejects unknown options, credentials, moving identities, bad limits, and duplicate identities", () => {
    const mutations: Array<(manifest: ExtensionManifestV4) => void> = [
      manifest => { (manifest.sandboxProviders![0]!.presets[0]!.network as Record<string, unknown>).allowHost = true; },
      manifest => { (manifest.sandboxProviders![0]!.presets[0] as unknown as Record<string, unknown>).credentials = { token: "secret" }; },
      manifest => { manifest.sandboxProviders![0]!.presets[0]!.imageDigest = "ubuntu:latest"; },
      manifest => { manifest.sandboxProviders![0]!.presets[0]!.recipeDigest = "A".repeat(64); },
      manifest => { manifest.sandboxProviders![0]!.presets[0]!.helperDigests.push("d".repeat(64)); },
      manifest => { manifest.sandboxProviders![0]!.presets[0]!.limits.memoryBytes = 0; },
      manifest => { manifest.sandboxProviders![0]!.presets[0]!.storage.minimumBytes = 3_000_000_000; },
      manifest => { manifest.sandboxProviders![0]!.presets[0]!.allowedOverrides.memoryBytes = { minimum: 2_000_000_000, maximum: 3_000_000_000 }; },
      manifest => { manifest.sandboxProviders![0]!.presets[0]!.allowedOverrides.diskBytes = { minimum: 1, maximum: 4_294_967_296 }; },
      manifest => { manifest.sandboxProviders!.push(structuredClone(manifest.sandboxProviders![0]!)); },
      manifest => { manifest.sandboxProviders![0]!.presets.push(structuredClone(manifest.sandboxProviders![0]!.presets[0]!)); },
    ];
    for (const mutate of mutations) {
      const manifest = manifestWith([linuxPreset()]);
      mutate(manifest);
      expect(() => validateManifest(manifest)).toThrow();
    }
  });

  test("rejects empty declarations and incomplete or inconsistent profile coverage", () => {
    expect(() => validateManifest({ ...baseManifest, sandboxProviders: [] })).toThrow();
    expect(() => validateManifest(manifestWith([], ["linux-exec.v1"]))).toThrow();
    expect(() => validateManifest(manifestWith([linuxPreset()], ["linux-exec.v1", "persistent-web-compose.v1"]))).toThrow();
    expect(() => validateManifest(manifestWith([composePreset()], ["linux-exec.v1"]))).toThrow();
    const incompleteCompose = composePreset();
    incompleteCompose.storage.workspace = "ephemeral";
    expect(() => validateManifest(manifestWith([incompleteCompose]))).toThrow();
    const incompleteLinux = linuxPreset();
    incompleteLinux.requirements.nestedCompose = true;
    expect(() => validateManifest(manifestWith([incompleteLinux]))).toThrow();
  });
});

describe("sandbox preset qualification", () => {
  test("binds candidate evidence to every provider release and preset with exactly the six host cases", async () => {
    const presets = [linuxPreset(), composePreset()];
    const evidence = await Promise.all(presets.map(preset => candidateQualification(preset)));
    expect(await validateCandidateSandboxPresetQualifications(manifestWith(presets), evidence, RELEASE_DIGEST, NOW)).toEqual(evidence);
    expect(evidence[0]!.cases.map(result => result.caseId)).toEqual(["SP01", "SP02", "SP03", "SP05", "SP07", "SP08"]);
  });

  test("rejects missing, extra, duplicate, failed, skipped, stale, future, and mismatched candidate evidence", async () => {
    const first = linuxPreset("first");
    const second = linuxPreset("second");
    const manifest = manifestWith([first, second]);
    const validFirst = await candidateQualification(first);
    const validSecond = await candidateQualification(second);
    const invalidSets: SandboxPresetQualification[][] = [
      [validFirst],
      [validFirst, validSecond, await candidateQualification(second)],
      [validFirst, { ...validSecond, presetId: first.id }],
      [validFirst, { ...validSecond, releaseDigest: "0".repeat(64) }],
      [validFirst, { ...validSecond, presetDigest: "0".repeat(64) }],
      [validFirst, { ...validSecond, profile: "persistent-web-compose.v1" }],
      [validFirst, { ...validSecond, validUntil: "2026-09-21T12:00:00.000Z" }],
      [validFirst, { ...validSecond, verifiedAt: "2026-09-21T12:01:00.000Z" }],
      [validFirst, { ...validSecond, cases: validSecond.cases.map((result, index) => index === 0 ? { ...result, status: "failed" } : result) }],
      [validFirst, { ...validSecond, cases: validSecond.cases.map((result, index) => index === 0 ? { ...result, status: "skipped" } : result) }],
      [validFirst, { ...validSecond, cases: validSecond.cases.map((result, index) => index === 5 ? { ...result, caseId: "SP01" } : result) }],
    ];
    for (const evidence of invalidSets) await expect(validateCandidateSandboxPresetQualifications(manifest, evidence, RELEASE_DIGEST, NOW)).rejects.toThrow();
    await expect(validateCandidateSandboxPresetQualifications(manifest, undefined, RELEASE_DIGEST, NOW)).rejects.toThrow();
  });

  test("requires separate live Ready evidence with all eight cases", async () => {
    const preset = composePreset();
    const context = { providerId: "incus", releaseDigest: RELEASE_DIGEST, connectionId: "connection-1", effectiveSettingsDigest: EFFECTIVE_SETTINGS_DIGEST, now: NOW };
    const evidence = await liveQualification(preset);
    expect(await validateLiveSandboxPresetQualification(preset, evidence, context)).toEqual(evidence);
    expect(evidence.cases.map(result => result.caseId)).toEqual(["SP01", "SP02", "SP03", "SP04", "SP05", "SP06", "SP07", "SP08"]);
    await expect(validateLiveSandboxPresetQualification(preset, { ...evidence, effectiveSettingsDigest: "0".repeat(64) }, context)).rejects.toThrow();
    await expect(validateLiveSandboxPresetQualification(preset, { ...evidence, validUntil: "2026-09-21T11:30:00.000Z" }, context)).rejects.toThrow();
    await expect(validateLiveSandboxPresetQualification(preset, { ...evidence, cases: evidence.cases.slice(0, 7) }, context)).rejects.toThrow();
    await expect(validateLiveSandboxPresetQualification(preset, { ...evidence, cases: evidence.cases.map(result => result.caseId === "SP04" ? { ...result, status: "failed" } : result) }, context)).rejects.toThrow();
  });

  test("keeps qualification evidence out of build evidence", async () => {
    const preset = linuxPreset();
    const liveEvidence = await liveQualification(preset);
    expect(() => validateWire("buildResult", {
      operationId: "build-1",
      state: "failed",
      sourceDigest: "source",
      imageDigest: "image",
      diagnostics: [],
      evidence: { protocolVersion: 4, validatorVersion: "4.0.0", tests: [], discoveryDigest: "catalog", sandboxPresetQualifications: [liveEvidence] },
    })).toThrow();
  });
});
