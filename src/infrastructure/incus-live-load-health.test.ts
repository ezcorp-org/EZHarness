import { expect, test } from "bun:test";
import { createIncusLoadHealthSampler, type IncusLoadHealthOptions } from "./incus-live-load-health";

const primary = { sandboxId: "primary", operationId: "primary-operation" };
const neighbor = { sandboxId: "neighbor", operationId: "neighbor-operation" };
const bootId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const connection = { sshTarget: "dev@xeon.example", sshIdentityFile: "/key",
  sshKnownHostsFile: "/known_hosts", sshHostKeySha256: `SHA256:${"A".repeat(43)}` };

function output(overrides: Record<number, string> = {}): string {
  const fields = [
    "xeon", "MemTotal: 67108864 kB\nMemAvailable: 50331648 kB\n",
    "some avg10=1.25 avg60=2.00 avg300=3.00 total=123\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
    "some avg10=4.50 avg60=5.00 avg300=6.00 total=456\n",
    "oom_kill 7\npgfault 8\n", "0.05 0.03 0.02 2/400 12345\n", "32768\n", "4194304\n",
    JSON.stringify({ space: { total: 100 * 1024 ** 3, used: 20 * 1024 ** 3 } }),
  ];
  for (const [key, value] of Object.entries(overrides)) fields[Number(key)] = value;
  return `${fields.join("\0")}\0`;
}

function sampler(changes: Partial<IncusLoadHealthOptions> = {},
  response: { exitCode: number; stdout: string; stderr: string; timedOut?: boolean } =
    { exitCode: 0, stdout: output(), stderr: "" }) {
  let pinned = false;
  const calls: string[][] = [];
  const options: IncusLoadHealthOptions = {
    connection, expectedHostname: "xeon", poolName: "ezharness-btrfs", neighbor,
    verifyPin: async value => { expect(value).toEqual(connection); pinned = true; },
    runner: async argv => {
      expect(pinned).toBe(true);
      calls.push([...argv]);
      return response;
    },
    readNeighbor: async handle => {
      expect(handle).toEqual(neighbor);
      return { ...neighbor, state: "running", bootId, heartbeat: true };
    },
    ...changes,
  };
  return { calls, run: () => createIncusLoadHealthSampler(options)(primary) };
}

test("pins SSH and reads exact host, pool, and running-neighbor measurements", async () => {
  const example = sampler();
  const health = await example.run();
  expect(health).toEqual({ hostId: "xeon", hostAvailableBytes: 48 * 1024 ** 3,
    hostMemoryPressurePercent: 1.25, hostCpuPressurePercent: 4.5,
    hostDiskFreeBytes: 80 * 1024 ** 3, hostAvailablePids: 32368,
    hostOomKills: 7, neighborSandboxId: "neighbor", neighborBootId: bootId,
    neighborHeartbeat: true });
  expect(example.calls).toHaveLength(1);
  expect(example.calls[0]?.slice(0, 2)).toEqual(["sh", "-c"]);
  expect(example.calls[0]?.slice(3)).toEqual(["sh", "ezharness-btrfs"]);
  expect(example.calls[0]?.[2]).toContain("incus --force-local query");
  expect(example.calls[0]?.[2]).toContain("/proc/pressure/memory");
  expect(Bun.spawnSync({ cmd: ["sh", "-n", "-c", example.calls[0]![2]!] }).exitCode).toBe(0);
});

test("invalid scope is denied before SSH or neighbor calls", async () => {
  let calls = 0;
  const forbidden = { verifyPin: async () => { calls++; },
    runner: async () => { calls++; throw new Error("must not run"); },
    readNeighbor: async () => { calls++; throw new Error("must not read"); } };
  expect(() => sampler({ ...forbidden, poolName: "pool; rm -rf /" }).run())
    .toThrow("reviewed host, pool, or neighbor identity");
  await expect(sampler({ ...forbidden, neighbor: primary }).run())
    .rejects.toThrow("primary and independent neighbor");
  expect(calls).toBe(0);
});

test("a failed pin stops before SSH and neighbor reads", async () => {
  let calls = 0;
  const example = sampler({ verifyPin: async () => { throw new Error("host key changed"); },
    runner: async () => { calls++; throw new Error("must not run"); },
    readNeighbor: async () => { calls++; throw new Error("must not read"); } });
  await expect(example.run()).rejects.toThrow("host key changed");
  expect(calls).toBe(0);
});

test("nonzero SSH, timeout, stderr, and oversized output fail closed", async () => {
  for (const response of [
    { exitCode: 1, stdout: output(), stderr: "error" },
    { exitCode: 0, stdout: output(), stderr: "", timedOut: true },
    { exitCode: 0, stdout: output(), stderr: "warning" },
  ]) await expect(sampler({}, response).run()).rejects.toThrow("pinned SSH health read failed");
  await expect(sampler({}, { exitCode: 0, stdout: `${output()}${"x".repeat(65_536)}`,
    stderr: "" }).run()).rejects.toThrow("exceeds 64 KiB");
});

test("host identity, framing, pressure, and counters must parse exactly", async () => {
  for (const [raw, error] of [
    [output({ 0: "other-host" }), "host identity changed"],
    [output().slice(0, -1), "readout is incomplete"],
    [output({ 2: "some avg10=101.00 avg60=0.00 avg300=0.00 total=0" }), "pressure is out of range"],
    [output({ 4: "oom_kill 1\noom_kill 2" }), "missing or repeated"],
    [output({ 5: "bad loadavg" }), "task count is invalid"],
    [output({ 6: "300" }), "PID headroom is unavailable"],
  ] as const) {
    await expect(sampler({}, { exitCode: 0, stdout: raw, stderr: "" }).run()).rejects.toThrow(error);
  }
});

test("pool bytes must be present, finite, and physically free", async () => {
  for (const raw of ["{}", "not-json", JSON.stringify({ space: { total: 100, used: 101 } }),
    JSON.stringify({ space: { total: 1e30, used: 1 } })]) {
    await expect(sampler({}, { exitCode: 0, stdout: output({ 8: raw }), stderr: "" }).run())
      .rejects.toThrow("Incus pool");
  }
});

test("neighbor must be the exact running fixture with a valid boot and heartbeat", async () => {
  for (const row of [
    { ...neighbor, state: "stopped" as const, bootId, heartbeat: true },
    { ...neighbor, sandboxId: "other", state: "running" as const, bootId, heartbeat: true },
    { ...neighbor, state: "running" as const, bootId: "invalid", heartbeat: true },
    { ...neighbor, state: "running" as const, bootId, heartbeat: false },
  ]) {
    await expect(sampler({ readNeighbor: async () => row }).run())
      .rejects.toThrow("exact independent neighbor heartbeat");
  }
});
