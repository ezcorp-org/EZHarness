import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { canonicalJson } from "@ezcorp/extension-contract";
import { factoryAttemptDeviceFacts, factoryAttemptDeviceGrant, factoryAttemptInvocationId, factoryAttemptWorkerId, type FactoryAttemptDeviceAuthorization, type FactoryAttemptLease } from "./attempt-runtime";

const lease: FactoryAttemptLease = { reservationId: "reservation-identity", grantRevision: 4, allocationGeneration: 5, holderGeneration: 7, allocationToken: "allocation-identity", hostId: "host-identity" };
const gpu = (authorization: FactoryAttemptDeviceAuthorization) => factoryAttemptDeviceGrant("attempt-identity", lease, authorization);

describe("durable launch identity", () => {
  test("the invocation id is reproducible from the attempt coordinate alone", () => {
    const expected = `factory_${createHash("sha256").update("attempt-identity:2:3").digest("hex").slice(0, 48)}`;
    expect(factoryAttemptInvocationId("attempt-identity", 2, 3)).toBe(expected);
    expect(factoryAttemptInvocationId("attempt-identity", 2, 3)).toBe(factoryAttemptInvocationId("attempt-identity", 2, 3));
  });

  test("a different generation, attempt, or attempt id produces a different invocation", () => {
    const base = factoryAttemptInvocationId("attempt-identity", 2, 3);
    expect(factoryAttemptInvocationId("attempt-identity", 3, 3)).not.toBe(base);
    expect(factoryAttemptInvocationId("attempt-identity", 2, 4)).not.toBe(base);
    expect(factoryAttemptInvocationId("attempt-other", 2, 3)).not.toBe(base);
    expect(base).not.toBe(factoryAttemptWorkerId("attempt-identity"));
  });

  test("the canonical zero generation and zero attempt are accepted", () => {
    expect(factoryAttemptInvocationId("attempt-identity", 0, 0)).toMatch(/^factory_[a-f0-9]{48}$/);
  });

  test("an absent attempt id or a negative or fractional counter is rejected", () => {
    expect(() => factoryAttemptInvocationId("", 2, 3)).toThrow("attempt id is invalid");
    expect(() => factoryAttemptInvocationId("attempt-identity", -1, 3)).toThrow("candidate generation is invalid");
    expect(() => factoryAttemptInvocationId("attempt-identity", 2, 1.5)).toThrow("attempt number is invalid");
  });
});

describe("per-attempt device grant", () => {
  test("a CPU attempt carries empty device lists bound to its held lease", () => {
    const grant = factoryAttemptDeviceGrant("attempt-identity", lease);
    expect(grant).toMatchObject({ schemaVersion: "factory.attempt-devices.v1", attemptId: "attempt-identity", reservationId: lease.reservationId, holderGeneration: lease.holderGeneration, hostId: lease.hostId, devices: [], cdiDevices: [], capabilities: [] });
    const { grantDigest, ...unsigned } = grant;
    expect(grantDigest).toBe(`sha256:${createHash("sha256").update(canonicalJson(unsigned)).digest("hex")}`);
  });

  test("the grant digest changes with the authorized devices and with the holding lease", () => {
    const cpu = factoryAttemptDeviceGrant("attempt-identity", lease);
    const withDevice = gpu({ gpuHosts: 1, devices: ["/dev/kfd"] });
    expect(withDevice.grantDigest).not.toBe(cpu.grantDigest);
    expect(withDevice.capabilities).toEqual(["compute", "utility"]);
    expect(factoryAttemptDeviceGrant("attempt-identity", { ...lease, holderGeneration: 8 }).grantDigest).not.toBe(cpu.grantDigest);
  });

  test("a device without a held gpu-host allocation is denied", () => {
    expect(() => gpu({ devices: ["/dev/kfd"] })).toThrow("requires a held gpu-host allocation");
    expect(() => gpu({ cdiDevices: ["nvidia.com/gpu=0"] })).toThrow("requires a held gpu-host allocation");
  });

  test("a held gpu-host allocation that authorizes no device is denied", () => {
    expect(() => gpu({ gpuHosts: 1 })).toThrow("must authorize at least one device");
  });

  test("device nodes outside the shared runner profile are denied", () => {
    expect(() => gpu({ gpuHosts: 1, devices: ["/dev/mem"] })).toThrow("outside the authorized runner profile");
    expect(() => gpu({ gpuHosts: 1, devices: ["/dev/kfd", "/dev/kfd"] })).toThrow("outside the authorized runner profile");
    expect(() => gpu({ gpuHosts: 1, devices: Array.from({ length: 17 }, (_value, index) => `/dev/dri/renderD${128 + index}`) })).toThrow("outside the authorized runner profile");
  });

  test("CDI device names are bounded, unique, and fully qualified", () => {
    expect(gpu({ gpuHosts: 1, cdiDevices: ["nvidia.com/gpu=0"] }).cdiDevices).toEqual(["nvidia.com/gpu=0"]);
    expect(() => gpu({ gpuHosts: 1, cdiDevices: ["gpu=0"] })).toThrow("CDI device names are invalid");
    expect(() => gpu({ gpuHosts: 1, cdiDevices: ["nvidia.com/gpu=0", "nvidia.com/gpu=0"] })).toThrow("CDI device names are invalid");
    expect(() => gpu({ gpuHosts: 1, cdiDevices: Array.from({ length: 17 }, (_value, index) => `nvidia.com/gpu=${index}`) })).toThrow("CDI device names are invalid");
  });

  test("an allocation vector claiming more than one whole host is rejected", () => {
    expect(() => gpu({ gpuHosts: 2, devices: ["/dev/kfd"] })).toThrow("Held gpu-host allocation is invalid");
    expect(() => gpu({ gpuHosts: -1 })).toThrow("Held gpu-host allocation is invalid");
    expect(() => gpu({ gpuHosts: 0.5 })).toThrow("Held gpu-host allocation is invalid");
  });

  test("an invalid attempt id or lease cannot produce a grant", () => {
    expect(() => factoryAttemptDeviceGrant("", lease)).toThrow("attempt id is invalid");
    expect(() => factoryAttemptDeviceGrant("attempt-identity", { ...lease, hostId: "" })).toThrow("host id is invalid");
  });

  test("the durable device facts are exactly the three stored lists", () => {
    expect(factoryAttemptDeviceFacts(gpu({ gpuHosts: 1, devices: ["/dev/kfd"], cdiDevices: ["nvidia.com/gpu=0"] }))).toEqual({ devices: ["/dev/kfd"], cdiDevices: ["nvidia.com/gpu=0"], capabilities: ["compute", "utility"] });
  });
});
