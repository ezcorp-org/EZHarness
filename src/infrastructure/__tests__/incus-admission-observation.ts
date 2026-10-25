import type { IncusAdmissionObservation } from "../incus-admission-contract";
import type { IncusSupervisorSelectedPin } from "../incus-qualification-supervisor-client";
import type { IncusQualificationStore } from "../incus-qualification";
import { readFileSync } from "node:fs";
export const admissionPin: IncusSupervisorSelectedPin = { scope: { installationId: "installation", releaseId: "release", connectionId: "connection", presetId: "preset" },
  connectionRevision: 1, presetDigest: "a".repeat(64), effectiveSettingsDigest: "b".repeat(64), imageFingerprint: "c".repeat(64), helperSha256: "d".repeat(64) };
export function admissionObservation(pin = admissionPin, now = Date.parse("2026-10-08T12:00:00Z")): IncusAdmissionObservation {
  return { version: 2, ready: true, selectedPin: pin,
    authority: { securitySourceDigest: "1".repeat(64), supervisorServiceDigest: "2".repeat(64), hostPolicyDigest: "3".repeat(64) },
    observation: { hostPolicyDigest: "4".repeat(64), backend: { backendApi: "incus.v1", backendVersion: "6.0.6", architecture: "amd64", storageDriver: "zfs", isolation: "container", nestedCompose: true },
      capacity: { hostId: "host", capturedAt: new Date(now).toISOString(), availableMemoryBytes: 2 ** 40, poolFreeBytes: 2 ** 40, availablePids: 100_000, cpuThreads: 64 } } };
}

export function admissionSelection(pin = admissionPin): Awaited<ReturnType<IncusQualificationStore["authorizeFixture"]>> {
  return { snapshot: { installation: { generation: 1 }, release: { releaseDigest: "release-digest" } },
    connection: { revision: pin.connectionRevision, serverCertificatePem: readFileSync(new URL("../incus-transport/test-server.pem", import.meta.url), "utf8"), project: "project", configuration: { profile: "profile" } },
    preset: { imageDigest: pin.imageFingerprint, limits: { memoryBytes: 1024, cpuMillis: 1000, pids: 10, diskBytes: 4096 } },
    presetDigest: pin.presetDigest, effectiveSettingsDigest: pin.effectiveSettingsDigest, helperDigest: pin.helperSha256 } as Awaited<ReturnType<IncusQualificationStore["authorizeFixture"]>>;
}
