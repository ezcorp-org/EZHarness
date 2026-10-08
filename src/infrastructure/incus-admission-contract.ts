import type { SandboxCompatibilityObservation } from "@ezcorp/extension-contract";
import { digest } from "../../scripts/incus/model";
import type { CapacityObservation } from "./incus-operator/capacity";
import type { IncusSupervisorSelectedPin } from "./incus-qualification-supervisor-client";

export interface IncusAdmissionAuthority {
  securitySourceDigest: string;
  supervisorServiceDigest: string;
  hostPolicyDigest: string;
  remoteHostPolicyDigest: string;
  backendDigest: string;
}

export interface IncusAdmissionObservation {
  version: 2;
  ready: true;
  authority: Omit<IncusAdmissionAuthority, "remoteHostPolicyDigest" | "backendDigest">;
  selectedPin: IncusSupervisorSelectedPin;
  observation: { backend: SandboxCompatibilityObservation; capacity: CapacityObservation; hostPolicyDigest: string };
}

export class IncusAdmissionReadinessError extends Error {
  constructor(readonly code: "qualification_expired" | "readiness_unavailable" | "capacity_full") {
    super(code);
    this.name = "IncusAdmissionReadinessError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).sort().join() === keys.sort().join();
}

function validBackend(value: Record<string, unknown>): boolean {
  return exact(value, ["backendApi", "backendVersion", "architecture", "storageDriver", "isolation", "nestedCompose"])
    && ["backendApi", "backendVersion", "architecture", "storageDriver", "isolation"].every(key =>
      typeof value[key] === "string" && value[key] !== "unverified" && value[key] !== "")
    && typeof value.nestedCompose === "boolean";
}

function validCapacity(value: Record<string, unknown>): boolean {
  return exact(value, ["hostId", "capturedAt", "availableMemoryBytes", "poolFreeBytes", "availablePids", "cpuThreads"])
    && typeof value.hostId === "string" && value.hostId.length > 0
    && typeof value.capturedAt === "string" && Number.isFinite(Date.parse(value.capturedAt))
    && ["availableMemoryBytes", "poolFreeBytes", "availablePids", "cpuThreads"].every(key =>
      typeof value[key] === "number" && Number.isSafeInteger(value[key]) && (value[key] as number) >= 0);
}

/** A legacy boolean, unknown field, or partial response cannot authorize admission. */
export function validateIncusAdmissionObservation(value: unknown, pin: IncusSupervisorSelectedPin): IncusAdmissionObservation {
  if (!exact(value, ["version", "ready", "authority", "selectedPin", "observation"])
    || value.version !== 2 || value.ready !== true || !record(value.selectedPin) || digest(value.selectedPin) !== digest(pin)
    || !exact(value.authority, ["hostPolicyDigest", "securitySourceDigest", "supervisorServiceDigest"])
    || !Object.values(value.authority).every(sha)
    || !exact(value.observation, ["backend", "capacity", "hostPolicyDigest"])) {
    throw new IncusAdmissionReadinessError("readiness_unavailable");
  }
  const { backend, capacity } = value.observation;
  if (!sha(value.observation.hostPolicyDigest) || !record(backend) || !validBackend(backend)
    || !record(capacity) || !validCapacity(capacity)) throw new IncusAdmissionReadinessError("readiness_unavailable");
  return value as unknown as IncusAdmissionObservation;
}

export function admissionAuthority(observation: IncusAdmissionObservation): IncusAdmissionAuthority {
  return { ...observation.authority, remoteHostPolicyDigest: observation.observation.hostPolicyDigest,
    backendDigest: digest(observation.observation.backend) };
}
