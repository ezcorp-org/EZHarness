import { expect, test } from "bun:test";
import { admissionAuthority, IncusAdmissionReadinessError, validateIncusAdmissionObservation } from "./incus-admission-contract";
import { admissionPin, admissionObservation } from "./__tests__/incus-admission-observation";


test("v2 admission closes every authority and dynamic observation field", () => {
  const valid = admissionObservation();
  expect(validateIncusAdmissionObservation(valid, admissionPin)).toBe(valid);
  expect(admissionAuthority(valid)).toMatchObject({ ...valid.authority, remoteHostPolicyDigest: "4".repeat(64) });
  expect(new IncusAdmissionReadinessError("capacity_full").code).toBe("capacity_full");
  const invalid: unknown[] = [null, [], true, { ready: true, protocol: "incus-qualification.v1" }, { ...valid, version: 1 }, { ...valid, ready: false }, { ...valid, extra: true },
    { ...valid, authority: null }, { ...valid, authority: { ...valid.authority, extra: true } }, { ...valid, authority: { ...valid.authority, securitySourceDigest: "bad" } },
    { ...valid, selectedPin: { ...admissionPin, connectionRevision: 2 } }, { ...valid, observation: null }, { ...valid, observation: { ...valid.observation, extra: true } }];
  for (const key of Object.keys(valid.observation.backend)) {
    const backend = { ...valid.observation.backend } as Record<string, unknown>;
    delete backend[key];
    invalid.push({ ...valid, observation: { ...valid.observation, backend } });
  }
  for (const backend of [null, { ...valid.observation.backend, backendVersion: "unverified" }, { ...valid.observation.backend, extra: true }, { ...valid.observation.backend, nestedCompose: "true" }]) {
    invalid.push({ ...valid, observation: { ...valid.observation, backend } });
  }
  for (const capacity of [null, { ...valid.observation.capacity, extra: true }, { ...valid.observation.capacity, hostId: "" }, { ...valid.observation.capacity, capturedAt: "invalid" }, { ...valid.observation.capacity, cpuThreads: -1 }]) {
    invalid.push({ ...valid, observation: { ...valid.observation, capacity } });
  }
  invalid.push({ ...valid, observation: { ...valid.observation, hostPolicyDigest: "invalid" } });
  for (const value of invalid) expect(() => validateIncusAdmissionObservation(value, admissionPin)).toThrow("readiness_unavailable");
});
