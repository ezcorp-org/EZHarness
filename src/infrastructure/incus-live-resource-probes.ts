import { isIP } from "node:net";
import type { SandboxPreset } from "@ezcorp/extension-contract";
import { ipv6ToBytes, parseIpv4 } from "../search/egress";
import type { LiveCommandResult, LiveEnforcementFacts, LiveFixtureHandle } from "./incus-live-cases";

export interface IncusNetworkTarget {
  address: string;
  port: number;
}

export interface IncusResourceProbeDependencies {
  /** Must run through the protected, exact-fixture guest transport. */
  runGuest: (handle: LiveFixtureHandle, argv: readonly string[], timeoutMs: number) => Promise<LiveCommandResult>;
  /** Must read the exact instance root-volume quota over the pinned Incus transport. */
  readRootQuota: (handle: LiveFixtureHandle) => Promise<{ sandboxId: string; bytes: number }>;
  /** Proves each denied target is reachable from the host at probe time. */
  hostCanConnect: (target: IncusNetworkTarget) => Promise<boolean>;
}

export interface IncusResourceProbeTargets {
  management: IncusNetworkTarget;
  otherProject: IncusNetworkTarget;
}

const GUEST_SCRIPT = `import json, pathlib, socket, sys
def read(name):
    return pathlib.Path('/sys/fs/cgroup', name).read_text(encoding='ascii').strip()
def blocked(address, port):
    try:
        connection = socket.create_connection((address, int(port)), timeout=2)
    except OSError:
        return True
    else:
        connection.close()
        return False
print(json.dumps({'memory': read('memory.max'), 'cpu': read('cpu.max'),
    'pids': read('pids.max'), 'uidMap': pathlib.Path('/proc/self/uid_map').read_text(encoding='ascii'),
    'managementBlocked': blocked(sys.argv[1], sys.argv[2]),
    'otherProjectBlocked': blocked(sys.argv[3], sys.argv[4])}))`;

function requireProbe(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Incus resource probe unavailable: ${message}`);
}

function integer(value: unknown, label: string): number {
  requireProbe(typeof value === "string" && /^[1-9][0-9]*$/.test(value), `${label} is not a finite limit`);
  const parsed = Number(value);
  requireProbe(Number.isSafeInteger(parsed), `${label} is outside safe integer range`);
  return parsed;
}

function cpuMillis(value: unknown): number {
  requireProbe(typeof value === "string", "CPU cgroup quota is missing");
  const parts = value.trim().split(/\s+/);
  requireProbe(parts.length === 2, "CPU cgroup quota has an invalid format");
  const quota = integer(parts[0], "CPU quota");
  const period = integer(parts[1], "CPU period");
  const millis = (quota * 1000) / period;
  requireProbe(Number.isSafeInteger(millis) && millis > 0, "CPU quota cannot be expressed exactly");
  return millis;
}

function isolatedUidMap(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const entries = value.trim().split("\n").map(line => line.trim().split(/\s+/));
  return entries.length === 1 && entries[0]?.length === 3
    && entries[0][0] === "0" && /^[1-9][0-9]*$/.test(entries[0][1] ?? "")
    && /^[1-9][0-9]*$/.test(entries[0][2] ?? "")
    && Number(entries[0][1]) > 0 && Number.isSafeInteger(Number(entries[0][1]));
}

function canonicalAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const family = isIP(value);
  if (family === 4) {
    const bytes = parseIpv4(value);
    return bytes && bytes[0] !== 0 && bytes[0] !== 127 ? `v4:${bytes.join(".")}` : null;
  }
  if (family !== 6) return null;
  const bytes = ipv6ToBytes(value.toLowerCase());
  if (!bytes) return null;
  const zeroPrefix = bytes.slice(0, 10).every(byte => byte === 0);
  if (zeroPrefix && bytes[10] === 255 && bytes[11] === 255) {
    return bytes[12] !== 0 && bytes[12] !== 127 ? `v4:${bytes.slice(12).join(".")}` : null;
  }
  // This also rejects expanded :: and ::1, plus deprecated v4-compatible
  // loopback/unspecified spellings. Compare the remaining IPv6 addresses by bytes.
  if (bytes.slice(0, 12).every(byte => byte === 0)
    && (bytes[12] === 0 || bytes[12] === 127)) return null;
  return `v6:${Buffer.from(bytes).toString("hex")}`;
}

function validPort(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 65535;
}

/** Reads enforced guest cgroups and checks two host-reachable forbidden network targets. */
export async function observeIncusResourceEnforcement(
  handle: LiveFixtureHandle, preset: SandboxPreset, targets: IncusResourceProbeTargets,
  dependencies: IncusResourceProbeDependencies,
): Promise<LiveEnforcementFacts> {
  const managementAddress = canonicalAddress(targets.management?.address);
  const otherAddress = canonicalAddress(targets.otherProject?.address);
  requireProbe(managementAddress && otherAddress
    && validPort(targets.management.port) && validPort(targets.otherProject.port)
    && (managementAddress !== otherAddress || targets.management.port !== targets.otherProject.port),
  "distinct IP-literal targets are required");
  for (const [name, target] of Object.entries(targets)) {
    requireProbe(await dependencies.hostCanConnect(target), `${name} control target is not reachable from the host`);
  }
  const result = await dependencies.runGuest(handle, ["python3", "-c", GUEST_SCRIPT,
    targets.management.address, String(targets.management.port),
    targets.otherProject.address, String(targets.otherProject.port)], 30_000);
  requireProbe(result.exitCode === 0 && result.stderr.length === 0 && result.stdout.length <= 4096,
    "guest control readout failed or exceeded its bound");
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(result.stdout); }
  catch { throw new Error("Incus resource probe unavailable: guest control readout is invalid JSON"); }
  requireProbe(raw && typeof raw === "object" && !Array.isArray(raw), "guest control readout is invalid");
  const memoryMaxBytes = integer(raw.memory, "memory cgroup limit");
  const quotaMillis = cpuMillis(raw.cpu);
  const pidsMax = integer(raw.pids, "PID cgroup limit");
  const root = await dependencies.readRootQuota(handle);
  requireProbe(root.sandboxId === handle.sandboxId && Number.isSafeInteger(root.bytes) && root.bytes > 0,
    "exact fixture root quota is unavailable");
  requireProbe(memoryMaxBytes <= preset.limits.memoryBytes && quotaMillis <= preset.limits.cpuMillis
    && pidsMax <= preset.limits.pids && root.bytes <= preset.limits.diskBytes,
  "observed controls exceed the reviewed preset");
  requireProbe(raw.managementBlocked === true && raw.otherProjectBlocked === true,
    "guest reached a forbidden network target");
  requireProbe(isolatedUidMap(raw.uidMap), "guest UID map is not isolated from host root");
  return { memoryMaxBytes, cpuQuotaMillis: quotaMillis, pidsMax,
    rootQuotaBytes: root.bytes, privateNetworkProbeBlocked: true, unprivilegedUidMap: true };
}
