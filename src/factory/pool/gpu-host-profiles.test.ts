import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { factoryRejection, makeFactoryPrivateRoot, removeFactoryPrivateRoot, writeModeFile } from "../../__tests__/helpers/factory-private-root";
import { factoryHeldAllocationDevices } from "../runner/attempt-wire";
import { FACTORY_PRODUCTION_GPU_CRITERIA, type FactoryGpuHostProfileError, FactoryGpuHostProfiles, loadFactoryGpuHostProfiles } from "./gpu-host-profiles";

const local = { hostId: "gpu-local", tier: "trusted-local", devices: ["/dev/kfd", "/dev/dri/renderD128", "/dev/dri/renderD129"], cdiDevices: [] };
const document = (hosts: unknown[]) => ({ schemaVersion: "factory.gpu-host-profiles.v1", hosts });
const evidence = Object.fromEntries(FACTORY_PRODUCTION_GPU_CRITERIA.map((criterion) => [criterion, `/evidence/${criterion}.json`]));
const lease = (hostId: string) => ({ reservationId: "r-1", grantRevision: 1, allocationGeneration: 1, holderGeneration: 1, allocationToken: "t-1", hostId });
const code = (work: () => unknown) => { try { work(); } catch (error) { return (error as FactoryGpuHostProfileError).code; } return undefined; };

describe("GPU host profile registration", () => {
  test("a registered profile is the only thing that turns a held gpu-host allocation into devices", () => {
    const profiles = FactoryGpuHostProfiles.register(["gpu-local", "gpu-other"], document([local]));
    expect(factoryHeldAllocationDevices(lease("gpu-local"), { "gpu-host": 1 }, profiles.profile("gpu-local"))).toEqual({ devices: local.devices, cdiDevices: [], gpuHosts: 1 });
    expect(profiles.profile("gpu-other")).toBeUndefined();
    expect(() => factoryHeldAllocationDevices(lease("gpu-other"), { "gpu-host": 1 }, profiles.profile("gpu-other"))).toThrow("supported device profile");
    // A profile registered for one host never authorizes a lease another host holds.
    expect(() => factoryHeldAllocationDevices(lease("gpu-other"), { "gpu-host": 1 }, profiles.profile("gpu-local"))).toThrow("supported device profile");
    expect(factoryHeldAllocationDevices(lease("gpu-local"), {}, profiles.profile("gpu-local"))).toEqual({ devices: [], cdiDevices: [], gpuHosts: 0 });
  });

  test("a trusted-local profile is unmet on every production criterion, by name", () => {
    const profiles = FactoryGpuHostProfiles.register(["gpu-local"], document([local]));
    const rows = profiles.readiness();
    expect(rows.map((row) => row.criterion)).toEqual([...FACTORY_PRODUCTION_GPU_CRITERIA]);
    expect(rows.every((row) => row.verdict === "unmet" && row.evidence === null && row.hostId === "gpu-local")).toBe(true);
    expect(profiles.productionReady("gpu-local")).toBe(false);
    expect(profiles.productionReady("gpu-missing")).toBe(false);
  });

  test("a production profile needs evidence for every criterion, and then reports each as met", () => {
    const production = { hostId: "gpu-nvidia", tier: "production", devices: [], cdiDevices: ["nvidia.com/gpu=0"], evidence };
    const profiles = FactoryGpuHostProfiles.register(["gpu-nvidia"], document([production]));
    expect(profiles.readiness().every((row) => row.verdict === "met" && row.evidence === `/evidence/${row.criterion}.json`)).toBe(true);
    expect(profiles.productionReady("gpu-nvidia")).toBe(true);
    const { "device-reset-before-reuse": _missing, ...partial } = evidence;
    expect(code(() => FactoryGpuHostProfiles.register(["gpu-nvidia"], document([{ ...production, evidence: partial }])))).toBe("gpu_profile_unproven_production");
    expect(code(() => FactoryGpuHostProfiles.register(["gpu-nvidia"], document([{ ...production, evidence: { ...evidence, "tenant-dedicated-host": "" } }])))).toBe("gpu_profile_unproven_production");
    expect(code(() => FactoryGpuHostProfiles.register(["gpu-nvidia"], document([{ ...production, evidence: undefined }].map(({ evidence: _e, ...rest }) => rest))))).toBe("gpu_profile_unproven_production");
  });

  test("hosts the pool does not offer, duplicates, and devices outside the shared allowlist are refused", () => {
    expect(code(() => FactoryGpuHostProfiles.register([], document([local])))).toBe("gpu_profile_unknown_host");
    expect(code(() => FactoryGpuHostProfiles.register(["gpu-local"], document([local, local])))).toBe("gpu_profile_duplicate");
    expect(code(() => FactoryGpuHostProfiles.register(["gpu-local"], document([{ ...local, devices: ["/dev/nvidia0"] }])))).toBe("gpu_profile_devices_invalid");
    expect(code(() => FactoryGpuHostProfiles.register(["gpu-local"], document([{ ...local, devices: [], cdiDevices: [] }])))).toBe("gpu_profile_devices_invalid");
    expect(code(() => FactoryGpuHostProfiles.register(["gpu-local"], document([{ ...local, cdiDevices: ["not a cdi name"] }])))).toBe("gpu_profile_devices_invalid");
  });

  test("a malformed document is refused as a whole", () => {
    for (const bad of [null, [], { schemaVersion: "other", hosts: [] }, { schemaVersion: "factory.gpu-host-profiles.v1" }, { schemaVersion: "factory.gpu-host-profiles.v1", hosts: {} }, { schemaVersion: "factory.gpu-host-profiles.v1", hosts: [], extra: 1 },
      document([null]), document([{ ...local, tier: "gold" }]), document([{ ...local, hostId: "" }]), document([{ ...local, devices: "x" }]), document([{ ...local, cdiDevices: null }]), document([{ ...local, unknown: true }]), document(Array.from({ length: 10_001 }, () => local))]) {
      expect(code(() => FactoryGpuHostProfiles.register(["gpu-local"], bad))).toBe("gpu_profiles_invalid");
    }
    expect(FactoryGpuHostProfiles.register(["gpu-local"], document([])).readiness()).toEqual([]);
  });
});

describe("loading a declaration file", () => {
  let root: string;
  beforeAll(async () => { root = await makeFactoryPrivateRoot(); });
  afterAll(async () => { await removeFactoryPrivateRoot(root); });

  test("reads a private file and registers it; refuses a readable-by-others, missing, or non-JSON file", async () => {
    const path = await writeModeFile(join(root, "gpu.json"), JSON.stringify(document([local])));
    expect((await loadFactoryGpuHostProfiles(path, ["gpu-local"])).profile("gpu-local")?.devices).toEqual(local.devices);
    const shared = await writeModeFile(join(root, "shared.json"), JSON.stringify(document([local])), 0o644);
    expect((await factoryRejection(loadFactoryGpuHostProfiles(shared, ["gpu-local"]))).message).toBe("gpu_profiles_unreadable");
    expect((await factoryRejection(loadFactoryGpuHostProfiles(join(root, "missing.json"), ["gpu-local"]))).message).toBe("gpu_profiles_unreadable");
    const broken = await writeModeFile(join(root, "broken.json"), "{not json");
    expect((await factoryRejection(loadFactoryGpuHostProfiles(broken, ["gpu-local"]))).message).toBe("gpu_profiles_unreadable");
    expect((await factoryRejection(loadFactoryGpuHostProfiles(path, []))).message).toBe("gpu_profile_unknown_host");
  });
});
