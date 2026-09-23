import {
  ContractError,
  validateCandidateSandboxPresetQualifications,
  validateLiveSandboxPresetQualification,
  type CandidateVerificationReport,
  type LiveSandboxPresetQualification,
  type LiveSandboxQualificationContext,
  type ReleaseRecord,
} from "@ezcorp/extension-contract";
import { digestObject } from "./blobs";

export type SandboxPresetReadyContext = Omit<LiveSandboxQualificationContext, "releaseDigest"> & { presetId: string };

export function sandboxPresetQualificationReleaseDigest(release: ReleaseRecord): string {
  const { id: _id, createdAt: _createdAt, releaseDigest, ...storedInput } = release;
  if (releaseDigest !== digestObject(storedInput)) throw new ContractError("INVALID_QUALIFICATION", "Sandbox qualification requires an intact immutable release");
  const { verification: _verification, ...releaseInput } = storedInput;
  return digestObject(releaseInput);
}

/** Requires current host-produced SP01/SP02/SP03/SP05/SP07/SP08 evidence for every declared preset. */
export async function assertSandboxPresetReleaseQualification(
  release: ReleaseRecord,
  verification: CandidateVerificationReport | undefined = release.verification,
  now = Date.now(),
): Promise<void> {
  if (release.manifest.sandboxProviders === undefined) return;
  await validateCandidateSandboxPresetQualifications(
    release.manifest,
    verification?.sandboxPresetQualifications,
    sandboxPresetQualificationReleaseDigest(release),
    now,
  );
}

/** Requires candidate evidence and connection-specific SP01-SP08 evidence for one selected preset. */
export async function assertSandboxPresetReady(
  release: ReleaseRecord,
  qualification: LiveSandboxPresetQualification,
  context: SandboxPresetReadyContext,
): Promise<void> {
  await assertSandboxPresetReleaseQualification(release, release.verification, context.now);
  const provider = release.manifest.sandboxProviders?.find(candidate => candidate.id === context.providerId);
  const preset = provider?.presets.find(candidate => candidate.id === context.presetId);
  if (!preset) throw new ContractError("INVALID_QUALIFICATION", "Ready requires a declared sandbox provider preset");
  await validateLiveSandboxPresetQualification(preset, qualification, {
    providerId: context.providerId,
    releaseDigest: release.releaseDigest,
    connectionId: context.connectionId,
    effectiveSettingsDigest: context.effectiveSettingsDigest,
    now: context.now,
  });
}
