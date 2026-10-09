import { describe, expect, test } from "bun:test";
import type { ExtensionManifestV4, LiveSandboxPreviewProof, LiveSandboxPresetQualification, SandboxPreset, SandboxPresetQualification } from "./types";
import { composeSandboxPreset as composePreset, linuxSandboxPreset as linuxPreset, liveComposePreviewProof, manifestWithSandboxPresets as manifestWith, SANDBOX_FIXTURE_NOW as NOW, SANDBOX_FIXTURE_RELEASE_DIGEST as RELEASE_DIGEST, SANDBOX_FIXTURE_SETTINGS_DIGEST as EFFECTIVE_SETTINGS_DIGEST, sandboxFixtureManifest as baseManifest } from "./sandbox-presets.fixture";
import { CANDIDATE_SANDBOX_QUALIFICATION_CASES, LIVE_SANDBOX_QUALIFICATION_CASES, PERSISTENT_WEB_COMPOSE_LIVE_CASES, sandboxPresetDigest, validateCandidateSandboxPresetQualifications, validateLiveSandboxPresetQualification, validateManifest, validateWire } from "./validation";

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
    cases: (preset.profile === "persistent-web-compose.v1" ? PERSISTENT_WEB_COMPOSE_LIVE_CASES : LIVE_SANDBOX_QUALIFICATION_CASES)
      .map(caseId => ({ caseId, status: "passed" })),
    ...(preset.profile === "persistent-web-compose.v1" ? { previewProof: await liveComposePreviewProof(preset) } : {}),
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

  test("historical candidate checks preserve identity and interval integrity after expiry", async () => {
    const preset = linuxPreset();
    const manifest = manifestWith([preset]);
    const evidence = await candidateQualification(preset);
    const later = Date.parse("2026-09-21T14:00:00.000Z");
    await expect(validateCandidateSandboxPresetQualifications(manifest, [evidence], RELEASE_DIGEST, later)).rejects.toThrow();
    expect(await validateCandidateSandboxPresetQualifications(manifest, [evidence], RELEASE_DIGEST, later, "integrity")).toEqual([evidence]);
    for (const invalid of [
      { ...evidence, releaseDigest: "0".repeat(64) },
      { ...evidence, cases: evidence.cases.slice(1) },
      { ...evidence, validUntil: evidence.verifiedAt },
      { ...evidence, verifiedAt: "2026-09-21T15:00:00.000Z", validUntil: "2026-09-21T16:00:00.000Z" },
    ]) await expect(validateCandidateSandboxPresetQualifications(manifest, [invalid], RELEASE_DIGEST, later, "integrity")).rejects.toThrow();
    await expect(validateCandidateSandboxPresetQualifications(manifest, undefined, RELEASE_DIGEST, later, "integrity")).rejects.toThrow();
  });

  test("requires separate live Ready evidence and real Compose preview proof", async () => {
    const preset = composePreset();
    const context = { providerId: "incus", releaseDigest: RELEASE_DIGEST, connectionId: "connection-1", effectiveSettingsDigest: EFFECTIVE_SETTINGS_DIGEST, now: NOW };
    const evidence = await liveQualification(preset);
    expect(await validateLiveSandboxPresetQualification(preset, evidence, context)).toEqual(evidence);
    expect(evidence.cases.map(result => result.caseId)).toEqual(["SP01", "SP02", "SP03", "SP04", "SP05", "SP06", "SP07", "SP08", "SP09"]);
    await expect(validateLiveSandboxPresetQualification(preset, { ...evidence, effectiveSettingsDigest: "0".repeat(64) }, context)).rejects.toThrow();
    await expect(validateLiveSandboxPresetQualification(preset, { ...evidence, validUntil: "2026-09-21T11:30:00.000Z" }, context)).rejects.toThrow();
    await expect(validateLiveSandboxPresetQualification(preset, { ...evidence, cases: evidence.cases.slice(0, 7) }, context)).rejects.toThrow();
    await expect(validateLiveSandboxPresetQualification(preset, { ...evidence, cases: evidence.cases.map(result => result.caseId === "SP04" ? { ...result, status: "failed" } : result) }, context)).rejects.toThrow();
    await expect(validateLiveSandboxPresetQualification(preset, { ...evidence, cases: evidence.cases.slice(0, 8) }, context)).rejects.toThrow();
    await expect(validateLiveSandboxPresetQualification(preset, { ...evidence, previewProof: undefined }, context)).rejects.toThrow();
    await expect(validateLiveSandboxPresetQualification(preset, { ...evidence, previewProof: { ...evidence.previewProof!, webSocketStatus: 502 } }, context)).rejects.toThrow();
    await expect(validateLiveSandboxPresetQualification(preset, { ...evidence, previewProof: { ...evidence.previewProof!, denied: { ...evidence.previewProof!.denied, wrongOwner: 200 } } }, context)).rejects.toThrow();
    await expect(validateLiveSandboxPresetQualification(preset, { ...evidence, previewProof: { ...evidence.previewProof!, denied: { ...evidence.previewProof!.denied, wrongOwner: 500 } } }, context)).rejects.toThrow();
    await expect(validateLiveSandboxPresetQualification(preset, { ...evidence, previewProof: { ...evidence.previewProof!, dispatch: { ...evidence.previewProof!.dispatch, instanceId: "other" } } }, context)).rejects.toThrow();
    const linux = linuxPreset();
    const linuxEvidence = await liveQualification(linux);
    expect((await validateLiveSandboxPresetQualification(linux, linuxEvidence, context)).cases).toHaveLength(8);
  });

  test("rejects mismatched preview identity, endpoint, exchanges, denials, and dispatch", async () => {
    const preset = composePreset();
    const context = { providerId: "incus", releaseDigest: RELEASE_DIGEST, connectionId: "connection-1", effectiveSettingsDigest: EFFECTIVE_SETTINGS_DIGEST, now: NOW };
    const evidence = await liveQualification(preset);
    const proof = evidence.previewProof!;
    const fields: Array<[keyof LiveSandboxPreviewProof, unknown]> = [
      ["connectionId", "other"], ["presetId", "other"], ["releaseDigest", "0".repeat(64)],
      ["presetDigest", "0".repeat(64)], ["effectiveSettingsDigest", "0".repeat(64)],
      ["imageDigest", "0".repeat(64)], ["helperDigest", "0".repeat(64)],
      ["sandboxId", ""], ["operationId", ""], ["endpointId", ""], ["ownerId", ""],
      ["generation", 0.5], ["generation", 0], ["port", 0.5], ["port", 0], ["port", 65536],
      ["expiresAt", "not-a-time"], ["expiresAt", "2026-99-99T00:00:00.000Z"],
      ["challengeSha256", "bad"], ["httpStatus", 500], ["httpBodySha256", "0".repeat(64)],
      ["webSocketStatus", 500], ["webSocketMessageSha256", "0".repeat(64)],
      ["webSocketSubprotocol", "other"], ["redirectStatus", 301], ["redirectLocation", "http://other/"],
    ];
    const denied = Object.keys(proof.denied).map(key => ({ denied: { ...proof.denied, [key]: 500 } }));
    const dispatch = [
      { instanceId: "other" }, { port: proof.port + 1 },
      { httpRequests: 0.5 }, { httpRequests: 0 },
      { webSocketConnections: 0.5 }, { webSocketConnections: 0 },
    ].map(change => ({ dispatch: { ...proof.dispatch, ...change } }));
    const changes = [...fields.map(([key, value]) => ({ [key]: value })), ...denied, ...dispatch];
    for (const change of changes) {
      await expect(validateLiveSandboxPresetQualification(preset,
        { ...evidence, previewProof: { ...proof, ...change } }, context))
        .rejects.toMatchObject({ code: "INVALID_QUALIFICATION", message: "Sandbox preview proof is incomplete or mismatched" });
    }
    // Expected identity is checked before any proof mismatch.
    await expect(validateLiveSandboxPresetQualification(preset,
      { ...evidence, previewProof: { ...proof, connectionId: "other" } }, { ...context, providerId: "" }))
      .rejects.toMatchObject({ code: "INVALID_QUALIFICATION", message: "Invalid expected live sandbox qualification identity" });
    expect(await validateLiveSandboxPresetQualification(preset, evidence, context)).toEqual(evidence);
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
