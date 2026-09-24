import { expect, test } from "bun:test";
import { INCUS_PRESETS } from "../../extensions/incus-sandbox/manifest";
import { observeIncusResourceEnforcement, type IncusResourceProbeDependencies,
  type IncusResourceProbeTargets } from "./incus-live-resource-probes";

const preset = INCUS_PRESETS[0]!;
const handle = { sandboxId: "qual-fixture", operationId: "qual-operation" };
const targets: IncusResourceProbeTargets = {
  management: { address: "100.81.181.39", port: 8443 },
  otherSandbox: { address: "10.173.1.10", port: 8080 },
};
const guest = {
  memory: String(preset.limits.memoryBytes), cpu: `${preset.limits.cpuMillis * 100} 100000`,
  pids: String(preset.limits.pids), uidMap: "0 100000 65536\n",
  managementBlocked: true, otherSandboxBlocked: true,
};

function probe(overrides: Partial<IncusResourceProbeDependencies> = {}, readout = guest) {
  const calls: string[][] = [];
  const dependencies: IncusResourceProbeDependencies = {
    hostCanConnect: async () => true,
    readRootQuota: async value => ({ sandboxId: value.sandboxId, bytes: preset.limits.diskBytes }),
    runGuest: async (value, argv) => {
      expect(value).toEqual(handle);
      calls.push([...argv]);
      return { exitCode: 0, stdout: JSON.stringify(readout), stderr: "" };
    },
    ...overrides,
  };
  return { calls, run: () => observeIncusResourceEnforcement(handle, preset, targets, dependencies) };
}

test("reads finite guest cgroups, exact Incus root quota, and two denied host-reachable paths", async () => {
  const example = probe();
  const facts = await example.run();
  expect(facts).toEqual({ memoryMaxBytes: preset.limits.memoryBytes,
    cpuQuotaMillis: preset.limits.cpuMillis, pidsMax: preset.limits.pids,
    rootQuotaBytes: preset.limits.diskBytes, privateNetworkProbeBlocked: true, unprivilegedUidMap: true });
  expect(example.calls).toHaveLength(1);
  expect(example.calls[0]?.slice(0, 3)).toEqual(["python3", "-c", expect.any(String)]);
  expect(example.calls[0]?.slice(3)).toEqual(["100.81.181.39", "8443", "10.173.1.10", "8080"]);
});

test("rejects absent CPU quota, over-limit controls, and a host-root UID map", async () => {
  await expect(probe({}, { ...guest, cpu: "max 100000" }).run()).rejects.toThrow("CPU quota");
  await expect(probe({}, { ...guest, memory: String(preset.limits.memoryBytes + 1) }).run())
    .rejects.toThrow("exceed the reviewed preset");
  await expect(probe({}, { ...guest, uidMap: "0 0 4294967295\n" }).run())
    .rejects.toThrow("UID map");
  await expect(probe({}, { ...guest, pids: "max" }).run()).rejects.toThrow("finite limit");
});

test("does not treat an unreachable control target as isolation evidence", async () => {
  let guestCalls = 0;
  const example = probe({ hostCanConnect: async target => target.address !== targets.otherSandbox.address,
    runGuest: async () => { guestCalls++; throw new Error("must not run"); } });
  await expect(example.run()).rejects.toThrow("otherSandbox control target");
  expect(guestCalls).toBe(0);
});

test("denies a blocked guest result if the neighbor listener expires before the final host check", async () => {
  const checks: IncusResourceProbeTargets[keyof IncusResourceProbeTargets][] = [];
  const example = probe({ hostCanConnect: async target => {
    checks.push(target);
    return !(target === targets.otherSandbox && checks.length === 4);
  } });
  await expect(example.run()).rejects.toThrow("otherSandbox control target");
  expect(example.calls).toHaveLength(1);
  expect(checks).toEqual([targets.management, targets.otherSandbox,
    targets.management, targets.otherSandbox]);
  expect(checks[1]).toBe(checks[3]);
});

test("rejects network access, quota identity drift, and malformed guest output", async () => {
  await expect(probe({}, { ...guest, managementBlocked: false }).run()).rejects.toThrow("forbidden network");
  await expect(probe({}, { ...guest, otherSandboxBlocked: false }).run()).rejects.toThrow("forbidden network");
  await expect(probe({ readRootQuota: async () => ({ sandboxId: "other", bytes: 100 }) }).run())
    .rejects.toThrow("exact fixture root quota");
  await expect(probe({ runGuest: async () => ({ exitCode: 0, stdout: "not JSON", stderr: "" }) }).run())
    .rejects.toThrow("invalid JSON");
});

test("requires distinct IP-literal destinations before any host probe", async () => {
  let hostCalls = 0;
  const dependencies: IncusResourceProbeDependencies = {
    hostCanConnect: async () => { hostCalls++; return true; },
    runGuest: async () => { throw new Error("must not run"); },
    readRootQuota: async () => { throw new Error("must not read"); },
  };
  await expect(observeIncusResourceEnforcement(handle, preset,
    { management: targets.management, otherSandbox: { address: "incus.example", port: 8080 } },
    dependencies))
    .rejects.toThrow("IP-literal targets");
  await expect(observeIncusResourceEnforcement(handle, preset,
    { management: targets.management, otherSandbox: targets.management }, dependencies))
    .rejects.toThrow("distinct IP-literal targets");
  expect(hostCalls).toBe(0);
});

test("rejects loopback and unspecified IPv6 spellings before any host probe", async () => {
  let hostCalls = 0;
  const dependencies: IncusResourceProbeDependencies = {
    hostCanConnect: async () => { hostCalls++; return true; },
    runGuest: async () => { throw new Error("must not run"); },
    readRootQuota: async () => { throw new Error("must not read"); },
  };
  for (const address of ["::ffff:127.0.0.1", "0:0:0:0:0:0:0:1", "0:0:0:0:0:0:0:0",
    "::ffff:0.0.0.0", "127.12.0.1", "0.1.2.3"]) {
    await expect(observeIncusResourceEnforcement(handle, preset,
      { ...targets, otherSandbox: { address, port: 8080 } }, dependencies))
      .rejects.toThrow("IP-literal targets");
  }
  expect(hostCalls).toBe(0);
});

test("treats IPv4-mapped and plain IPv4 spellings as the same destination", async () => {
  let hostCalls = 0;
  const dependencies: IncusResourceProbeDependencies = {
    hostCanConnect: async () => { hostCalls++; return true; },
    runGuest: async () => { throw new Error("must not run"); },
    readRootQuota: async () => { throw new Error("must not read"); },
  };
  await expect(observeIncusResourceEnforcement(handle, preset,
    { management: { address: "10.173.1.10", port: 8080 },
      otherSandbox: { address: "::ffff:10.173.1.10", port: 8080 } }, dependencies))
    .rejects.toThrow("distinct IP-literal targets");
  expect(hostCalls).toBe(0);
});

test("accepts distinct non-loopback IPv6 control targets and compares expanded forms", async () => {
  const dependencies: IncusResourceProbeDependencies = {
    hostCanConnect: async () => true,
    readRootQuota: async value => ({ sandboxId: value.sandboxId, bytes: preset.limits.diskBytes }),
    runGuest: async (_value, argv) => {
      expect(argv.slice(3)).toEqual(["fd00::1", "8443", "fd00::2", "8080"]);
      return { exitCode: 0, stdout: JSON.stringify(guest), stderr: "" };
    },
  };
  await expect(observeIncusResourceEnforcement(handle, preset,
    { management: { address: "fd00::1", port: 8443 },
      otherSandbox: { address: "fd00::2", port: 8080 } }, dependencies)).resolves.toMatchObject({
    privateNetworkProbeBlocked: true,
  });
  await expect(observeIncusResourceEnforcement(handle, preset,
    { management: { address: "fd00::1", port: 8443 },
      otherSandbox: { address: "fd00:0:0:0:0:0:0:1", port: 8443 } }, dependencies))
    .rejects.toThrow("distinct IP-literal targets");
});
