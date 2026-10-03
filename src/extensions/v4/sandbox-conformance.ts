import {
  CANDIDATE_SANDBOX_QUALIFICATION_CASES,
  ContractError,
  canonicalJson,
  resolveSandboxPreset,
  sandboxPresetDigest,
  validateCandidateSandboxPresetQualifications,
  validateSandboxProviderContribution,
  validateSandboxProviderDescription,
  validateSandboxProviderMethodExchange,
  type CandidateSandboxQualificationCase,
  type ReleaseRecord,
  type SandboxCompatibilityObservation,
  type SandboxPreset,
  type SandboxPresetLimitOverrides,
  type SandboxPresetQualification,
  type SandboxProtocolContribution,
} from "@ezcorp/extension-contract";
import { LifecycleError } from "./types";
import { sandboxPresetQualificationReleaseDigest } from "./sandbox-preset-qualification";
import type { SandboxWorkspaceBinding } from "../../runtime/workspaces/target";
import type { SandboxLocalFallbackProof } from "../../runtime/workspaces/host-routing-proof";

const QUALIFICATION_VALIDITY_MS = 60 * 60 * 1000;
const CONFORMANCE_CONNECTION_ID = "host-candidate-conformance";

export type SandboxWorkspaceIdentity = SandboxWorkspaceBinding;
export type SandboxWorkspaceRoutingProof = SandboxLocalFallbackProof;

export interface SandboxConformanceDependencies {
  invoke(method: string, input: unknown): Promise<unknown>;
  proveWorkspaceRouting?: (identity: SandboxWorkspaceIdentity) => Promise<SandboxWorkspaceRoutingProof>;
  now?: () => number;
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new LifecycleError("sandbox_conformance_failed", message);
}

async function mustReject(action: () => Promise<unknown>, expectedCodes: string | readonly string[], message: string): Promise<void> {
  let rejected = false;
  try {
    await action();
  } catch (error) {
    const codes = typeof expectedCodes === "string" ? [expectedCodes] : expectedCodes;
    if (!(error instanceof ContractError) || !codes.includes(error.code)) throw error;
    rejected = true;
  }
  if (!rejected) throw new LifecycleError("sandbox_conformance_failed", message);
}

function supportedObservation(preset: SandboxPreset): SandboxCompatibilityObservation {
  return {
    backendApi: preset.requirements.backendApis[0]!,
    backendVersion: "host-conformance-v1",
    architecture: preset.requirements.architectures[0]!,
    storageDriver: preset.requirements.storageDrivers[0]!,
    isolation: preset.requirements.isolation[0]!,
    nestedCompose: preset.requirements.nestedCompose,
  };
}

async function assertCompatibilityBoundary(provider: SandboxProtocolContribution, preset: SandboxPreset, observation: SandboxCompatibilityObservation): Promise<void> {
  const unlisted = (values: readonly string[], prefix: string): string => {
    let candidate = prefix;
    while (values.includes(candidate)) candidate += "-x";
    return candidate;
  };
  const incompatible: SandboxCompatibilityObservation[] = [
    { ...observation, backendApi: unlisted(preset.requirements.backendApis, "unsupported.backend.v1") },
    { ...observation, storageDriver: unlisted(preset.requirements.storageDrivers, "unsupported-storage") },
  ];
  const otherArchitecture = observation.architecture === "amd64" ? "arm64" : "amd64";
  if (!preset.requirements.architectures.includes(otherArchitecture)) incompatible.push({ ...observation, architecture: otherArchitecture });
  const otherIsolation = observation.isolation === "container" ? "virtual-machine" : "container";
  if (!preset.requirements.isolation.includes(otherIsolation)) incompatible.push({ ...observation, isolation: otherIsolation });
  if (preset.requirements.nestedCompose) incompatible.push({ ...observation, nestedCompose: false });
  for (const candidate of incompatible) {
    await mustReject(
      () => resolveSandboxPreset(provider, { profile: preset.profile, presetId: preset.id, observation: candidate }),
      "INCOMPATIBLE_PRESET",
      `Sandbox preset ${provider.id}/${preset.id} accepted an incompatible backend observation.`,
    );
  }
}

async function assertOverrideBoundary(provider: SandboxProtocolContribution, preset: SandboxPreset, observation: SandboxCompatibilityObservation, baseDigest: string): Promise<void> {
  const fields = ["memoryBytes", "cpuMillis", "pids", "diskBytes", "timeoutMs"] as const;
  for (const field of fields) {
    const bounds = preset.allowedOverrides[field];
    const invalidValue = !bounds ? preset.limits[field] : bounds.minimum > 1 ? bounds.minimum - 1 : bounds.maximum + 1;
    await mustReject(
      () => resolveSandboxPreset(provider, { profile: preset.profile, presetId: preset.id, observation, overrides: { [field]: invalidValue } }),
      ["INVALID_PRESET_OVERRIDE", "INVALID_CONTRACT"],
      `Sandbox preset ${provider.id}/${preset.id} accepted an invalid ${field} override.`,
    );
    if (!bounds) continue;
    const changed = bounds.minimum !== preset.limits[field] ? bounds.minimum : bounds.maximum;
    if (changed === preset.limits[field]) continue;
    const overrides = { [field]: changed } as SandboxPresetLimitOverrides;
    const resolution = await resolveSandboxPreset(provider, { profile: preset.profile, presetId: preset.id, observation, overrides });
    if (resolution.effectiveSettingsDigest === baseDigest) throw new LifecycleError("sandbox_conformance_failed", `Sandbox preset ${provider.id}/${preset.id} did not bind its effective ${field} override.`);
  }
}

async function assertPresetDrift(provider: SandboxProtocolContribution, preset: SandboxPreset, observation: SandboxCompatibilityObservation, presetDigest: string, settingsDigest: string): Promise<void> {
  const otherDigest = (value: string) => value === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64);
  const driftedPresets = [
    { ...preset, imageDigest: otherDigest(preset.imageDigest) },
    { ...preset, recipeDigest: otherDigest(preset.recipeDigest) },
    { ...preset, helperDigests: preset.helperDigests.length ? [otherDigest(preset.helperDigests[0]!), ...preset.helperDigests.slice(1)] : ["0".repeat(64)] },
  ];
  for (const driftedPreset of driftedPresets) if (await sandboxPresetDigest(driftedPreset) === presetDigest) throw new LifecycleError("sandbox_conformance_failed", `Sandbox preset ${provider.id}/${preset.id} immutable artifact drift was not bound.`);
  const drifted = await resolveSandboxPreset(provider, {
    profile: preset.profile,
    presetId: preset.id,
    observation: { ...observation, backendVersion: `${observation.backendVersion}-drift` },
  });
  if (drifted.effectiveSettingsDigest === settingsDigest) throw new LifecycleError("sandbox_conformance_failed", `Sandbox preset ${provider.id}/${preset.id} backend drift was not bound.`);
}

async function runProviderExchange(
  dependencies: SandboxConformanceDependencies,
  provider: SandboxProtocolContribution,
  operation: "describe" | "preflight",
  input: unknown,
): Promise<unknown> {
  const method = provider.methodGroups[0]!.methods[operation];
  const result = await dependencies.invoke(method, input);
  return validateSandboxProviderMethodExchange(operation, input, result).result;
}

/** Executes the host-owned static sandbox suite and emits evidence only after every assertion passes. */
export async function runSandboxCandidateConformance(
  release: ReleaseRecord,
  dependencies: SandboxConformanceDependencies,
): Promise<SandboxPresetQualification[]> {
  const declarations = release.manifest.sandboxProviders;
  if (declarations === undefined) return [];
  if (!dependencies.proveWorkspaceRouting) throw new LifecycleError("sandbox_workspace_proof_required", "Sandbox qualification requires an executed host workspace-routing proof.");

  try {
    const now = dependencies.now?.() ?? Date.now();
    if (!Number.isFinite(now)) throw new LifecycleError("sandbox_conformance_failed", "Sandbox conformance time must be finite.");
    const releaseDigest = sandboxPresetQualificationReleaseDigest(release);
    const passed = new Map<string, Set<CandidateSandboxQualificationCase>>();
    const presets: Array<{ provider: SandboxProtocolContribution; preset: SandboxPreset; presetDigest: string }> = [];

    for (const declaration of declarations) {
      const provider = validateSandboxProviderContribution(declaration);
      const describeInput = { providerId: provider.id };
      const described = await runProviderExchange(dependencies, provider, "describe", describeInput);
      validateSandboxProviderDescription(provider, described);

      for (const preset of provider.presets) {
        const key = `${provider.id}\0${preset.id}`;
        const cases = new Set<CandidateSandboxQualificationCase>(["SP01"]);
        passed.set(key, cases);
        const observation = supportedObservation(preset);
        const first = await resolveSandboxPreset(provider, { profile: preset.profile, presetId: preset.id, observation });
        const second = await resolveSandboxPreset(provider, { profile: preset.profile, presetId: preset.id, observation });
        assertEqual(second, first, `Sandbox preset ${provider.id}/${preset.id} did not resolve deterministically.`);
        await assertCompatibilityBoundary(provider, preset, observation);
        cases.add("SP02");

        const preflightInput = {
          providerId: provider.id,
          connectionId: CONFORMANCE_CONNECTION_ID,
          profile: preset.profile,
          presetId: preset.id,
          presetDigest: first.presetDigest,
          effectiveSettingsDigest: first.effectiveSettingsDigest,
        };
        const firstPreflight = await runProviderExchange(dependencies, provider, "preflight", preflightInput);
        const secondPreflight = await runProviderExchange(dependencies, provider, "preflight", preflightInput);
        assertEqual(firstPreflight, { observation }, `Sandbox provider ${provider.id}/${preset.id} preflight did not return the asserted observation.`);
        assertEqual(secondPreflight, firstPreflight, `Sandbox provider ${provider.id}/${preset.id} preflight was nondeterministic.`);
        await assertOverrideBoundary(provider, preset, observation, first.effectiveSettingsDigest);
        cases.add("SP03");

        const identity: SandboxWorkspaceIdentity = {
          projectId: `verification:${release.installationId}`,
          workspaceId: release.workspaceId,
          connectionId: CONFORMANCE_CONNECTION_ID,
          providerId: provider.id,
          generation: 1,
          presetId: preset.id,
          releaseDigest: release.releaseDigest,
          presetDigest: first.presetDigest,
          effectiveSettingsDigest: first.effectiveSettingsDigest,
        };
        const proof = await dependencies.proveWorkspaceRouting(identity);
        assertEqual(proof, {
          binding: identity,
          cases: [
            { toolName: "readFile", localFallbackDenied: true },
            { toolName: "editFile", localFallbackDenied: true },
            { toolName: "shell", localFallbackDenied: true },
          ],
          hostCanaryUnchanged: true,
        }, `Sandbox preset ${provider.id}/${preset.id} workspace-routing proof was missing or mismatched.`);
        cases.add("SP05");

        await assertPresetDrift(provider, preset, observation, first.presetDigest, first.effectiveSettingsDigest);
        cases.add("SP07");
        presets.push({ provider, preset, presetDigest: first.presetDigest });
      }
    }

    const expectedKeys = declarations.flatMap(provider => provider.presets.map(preset => `${provider.id}\0${preset.id}`));
    if (passed.size !== expectedKeys.length || new Set(expectedKeys).size !== expectedKeys.length || expectedKeys.some(key => !passed.has(key))) throw new LifecycleError("sandbox_conformance_failed", "Sandbox conformance did not execute every declared provider preset exactly once.");
    for (const cases of passed.values()) cases.add("SP08");

    const verifiedAt = new Date(now).toISOString();
    const validUntil = new Date(now + QUALIFICATION_VALIDITY_MS).toISOString();
    const qualifications = presets.map(({ provider, preset, presetDigest }) => ({
      producer: "host" as const,
      providerId: provider.id,
      presetId: preset.id,
      profile: preset.profile,
      releaseDigest,
      presetDigest,
      verifiedAt,
      validUntil,
      cases: CANDIDATE_SANDBOX_QUALIFICATION_CASES.map(caseId => ({ caseId, status: passed.get(`${provider.id}\0${preset.id}`)!.has(caseId) ? "passed" as const : "failed" as const })),
    }));
    return await validateCandidateSandboxPresetQualifications(release.manifest, qualifications, releaseDigest, now);
  } catch (error) {
    if (error instanceof LifecycleError) throw error;
    throw new LifecycleError("sandbox_conformance_failed", error instanceof Error ? error.message : "Sandbox conformance failed.");
  }
}
