import type { IncusAdmissionObservation } from "../incus-admission-contract";
import type { IncusSupervisorSelectedPin } from "../incus-qualification-supervisor-client";
export const admissionPin: IncusSupervisorSelectedPin = { scope: { installationId: "installation", releaseId: "release", connectionId: "connection", presetId: "preset" },
  connectionRevision: 1, presetDigest: "a".repeat(64), effectiveSettingsDigest: "b".repeat(64), imageFingerprint: "c".repeat(64), helperSha256: "d".repeat(64) };
export function admissionObservation(pin = admissionPin, now = Date.parse("2026-10-08T12:00:00Z")): IncusAdmissionObservation {
  return { version: 2, ready: true, selectedPin: pin,
    authority: { securitySourceDigest: "1".repeat(64), supervisorServiceDigest: "2".repeat(64), hostPolicyDigest: "3".repeat(64) },
    observation: { hostPolicyDigest: "4".repeat(64), backend: { backendApi: "incus.v1", backendVersion: "6.0.6", architecture: "amd64", storageDriver: "zfs", isolation: "container", nestedCompose: true },
      capacity: { hostId: "host", capturedAt: new Date(now).toISOString(), availableMemoryBytes: 2 ** 40, poolFreeBytes: 2 ** 40, availablePids: 100_000, cpuThreads: 64 } } };
}
