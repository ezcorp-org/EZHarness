import { sshRunner, verifyKnownHostPin, type RemoteRunner } from "../../scripts/incus/inspect";
import type { IncusConnection } from "../../scripts/incus/model";
import type { LiveFixtureHandle } from "./incus-live-cases";
import type { IncusLoadHealth } from "./incus-live-load-probes";

const MAX_OUTPUT_BYTES = 64 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const BOOT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const POOL_NAME = /^[a-z][a-z0-9-]{0,62}$/;

/** One fixed read-only remote command. The pool is a validated positional arg. */
const READ_HEALTH = String.raw`set -eu
hostnamectl --static; printf '\000'
cat /proc/meminfo; printf '\000'
cat /proc/pressure/memory; printf '\000'
cat /proc/pressure/cpu; printf '\000'
cat /proc/vmstat; printf '\000'
cat /proc/loadavg; printf '\000'
cat /proc/sys/kernel/threads-max; printf '\000'
cat /proc/sys/kernel/pid_max; printf '\000'
incus --force-local query "/1.0/storage-pools/$1/resources"; printf '\000'`;

export interface ProtectedNeighborHealth {
  sandboxId: string;
  operationId: string;
  state: "running" | "stopped" | "absent" | "unknown";
  bootId: string | null;
  heartbeat: boolean;
}

export interface IncusLoadHealthOptions {
  connection: IncusConnection;
  expectedHostname: string;
  poolName: string;
  /** A durable host-owned fixture; never take this from an agent request. */
  neighbor: LiveFixtureHandle;
  /** Must inspect the exact durable neighbor through the protected controller. */
  readNeighbor: (neighbor: LiveFixtureHandle) => Promise<ProtectedNeighborHealth>;
  /** Test seams only. Production uses the pinned SSH bootstrap functions. */
  verifyPin?: (connection: IncusConnection) => Promise<void>;
  runner?: RemoteRunner;
}

function unavailable(message: string): never {
  throw new Error(`Incus load health unavailable: ${message}`);
}

function requireHealth(condition: unknown, message: string): asserts condition {
  if (!condition) unavailable(message);
}

function integer(value: unknown, label: string): number {
  requireHealth(typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value), `${label} is unavailable`);
  const parsed = Number(value);
  requireHealth(Number.isSafeInteger(parsed), `${label} exceeds safe integer range`);
  return parsed;
}

function lineValue(text: string, key: string): string {
  const rows = text.split("\n").filter(row => row.startsWith(`${key} `) || row.startsWith(`${key}:`));
  requireHealth(rows.length === 1, `${key} is missing or repeated`);
  return rows[0]!.slice(key.length).replace(/^[:\s]+/, "").trim();
}

function pressure(text: string, label: string): number {
  const some = lineValue(text, "some");
  const match = /^avg10=(\d+(?:\.\d{1,2})?)\s+avg60=\d+(?:\.\d{1,2})?\s+avg300=\d+(?:\.\d{1,2})?\s+total=\d+$/.exec(some);
  requireHealth(match, `${label} pressure is invalid`);
  const value = Number(match[1]);
  requireHealth(Number.isFinite(value) && value >= 0 && value <= 100, `${label} pressure is out of range`);
  return value;
}

function poolFree(text: string): number {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { unavailable("Incus pool resources are invalid JSON"); }
  requireHealth(value && typeof value === "object" && !Array.isArray(value), "Incus pool resources are invalid");
  const space = (value as Record<string, unknown>).space;
  requireHealth(space && typeof space === "object" && !Array.isArray(space), "Incus pool space is missing");
  const { total, used } = space as Record<string, unknown>;
  requireHealth(Number.isSafeInteger(total) && Number.isSafeInteger(used)
    && Number(total) > 0 && Number(used) >= 0 && Number(used) <= Number(total),
  "Incus pool bytes are invalid");
  return Number(total) - Number(used);
}

function parseHost(text: string, expectedHostname: string): Omit<IncusLoadHealth,
  "neighborSandboxId" | "neighborBootId" | "neighborHeartbeat"> {
  requireHealth(Buffer.byteLength(text) <= MAX_OUTPUT_BYTES, "SSH readout exceeds 64 KiB");
  const fields = text.split("\0");
  requireHealth(fields.length === 10 && fields[9] === "", "SSH readout is incomplete");
  const [host, meminfo, memoryPressure, cpuPressure, vmstat, loadavg,
    threadsText, pidText, poolText] = fields.map(value => value.trim());
  requireHealth(host === expectedHostname, "Xeon host identity changed");
  const mem = /^([1-9][0-9]*)\s+kB$/.exec(lineValue(meminfo!, "MemAvailable"));
  requireHealth(mem, "MemAvailable is invalid");
  const memKiB = integer(mem[1], "MemAvailable");
  requireHealth(Number.isSafeInteger(memKiB * 1024), "MemAvailable exceeds safe integer range");
  const oom = integer(lineValue(vmstat!, "oom_kill"), "OOM counter");
  const load = /^\S+\s+\S+\s+\S+\s+\d+\/(\d+)\s+\d+$/.exec(loadavg!);
  requireHealth(load, "host task count is invalid");
  const tasks = integer(load[1], "host task count");
  const threadsMax = integer(threadsText, "host threads maximum");
  const pidMax = integer(pidText, "host PID maximum");
  const ceiling = Math.min(threadsMax, pidMax);
  requireHealth(ceiling > tasks, "host PID headroom is unavailable");
  return { hostId: host!, hostAvailableBytes: memKiB * 1024,
    hostMemoryPressurePercent: pressure(memoryPressure!, "memory"),
    hostCpuPressurePercent: pressure(cpuPressure!, "CPU"),
    hostDiskFreeBytes: poolFree(poolText!), hostAvailablePids: ceiling - tasks,
    hostOomKills: oom };
}

/** Host-owned sampler. Every call pins SSH first and accepts only fixed reads. */
export function createIncusLoadHealthSampler(options: IncusLoadHealthOptions):
  (primary: LiveFixtureHandle) => Promise<IncusLoadHealth> {
  requireHealth(POOL_NAME.test(options.poolName) && ID.test(options.expectedHostname)
    && ID.test(options.neighbor.sandboxId) && ID.test(options.neighbor.operationId),
  "reviewed host, pool, or neighbor identity is invalid");
  const pin = options.verifyPin ?? verifyKnownHostPin;
  const runner = options.runner ?? sshRunner(options.connection);
  return async primary => {
    requireHealth(ID.test(primary.sandboxId) && primary.sandboxId !== options.neighbor.sandboxId,
      "primary and independent neighbor identity are invalid");
    await pin(options.connection);
    const [remote, neighbor] = await Promise.all([
      runner(["sh", "-c", READ_HEALTH, "sh", options.poolName]),
      options.readNeighbor(options.neighbor),
    ]);
    requireHealth(remote.exitCode === 0 && remote.timedOut !== true && remote.stderr.trim() === "",
      "pinned SSH health read failed");
    const host = parseHost(remote.stdout, options.expectedHostname);
    requireHealth(neighbor.sandboxId === options.neighbor.sandboxId
      && neighbor.operationId === options.neighbor.operationId
      && neighbor.state === "running" && neighbor.heartbeat === true
      && typeof neighbor.bootId === "string" && BOOT_ID.test(neighbor.bootId),
    "exact independent neighbor heartbeat is unavailable");
    return { ...host, neighborSandboxId: neighbor.sandboxId,
      neighborBootId: neighbor.bootId, neighborHeartbeat: true };
  };
}
