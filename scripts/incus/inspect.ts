import { createHash, X509Certificate } from "node:crypto";
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import type { CommandResult, IncusConnection, IncusInventory } from "./model";
import { SETUP_SCHEMA_VERSION, assertRecord, stringMap } from "./model";

export type RemoteRunner = (argv: readonly string[], stdin?: string) => Promise<CommandResult>;
export const SSH_GATE_COMMAND = "ezh-incus-operator-v1";
export const SSH_GATE_MAX_REQUEST_BYTES = 64 * 1024;

export function sshGateRequest(argv: readonly string[], stdin?: string): string {
  const request = `${JSON.stringify({ version: 1, argv, ...(stdin === undefined ? {} : { stdin }) })}\n`;
  if (Buffer.byteLength(request) > SSH_GATE_MAX_REQUEST_BYTES) throw new Error("Incus SSH gate request exceeds 64 KiB");
  return request;
}

function quote(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }

export async function verifyKnownHostPin(connection: IncusConnection): Promise<void> {
  const target = /^(?<user>[a-z_][a-z0-9_-]{0,31})@(?<host>[A-Za-z0-9.-]{1,253})$/.exec(connection.sshTarget);
  if (!target?.groups || !isAbsolute(connection.sshIdentityFile) || !isAbsolute(connection.sshKnownHostsFile) || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(connection.sshHostKeySha256)) throw new Error("SSH connection must use a closed target, absolute files and an exact host key fingerprint");
  const child = Bun.spawn(["ssh-keygen", "-F", target.groups.host!, "-f", connection.sshKnownHostsFile], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`SSH host is not pinned in known_hosts: ${stderr.trim() || `exit ${exitCode}`}`);
  const fingerprints = stdout.split("\n").filter(line => line && !line.startsWith("#")).flatMap(line => {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3) return [];
    try {
      const fingerprint = createHash("sha256").update(Buffer.from(fields[2]!, "base64")).digest("base64").replace(/=+$/, "");
      return [`SHA256:${fingerprint}`];
    } catch {
      return [];
    }
  });
  // SSH accepts any matching host key in this file. Every matching entry must
  // match the reviewed pin, or a second key could bypass the setup review.
  if (!fingerprints.length || fingerprints.some(value => value !== connection.sshHostKeySha256)) {
    throw new Error("SSH known_hosts fingerprint does not match the pinned connection fingerprint");
  }
}

export function sshRunner(connection: IncusConnection): RemoteRunner {
  return async (argv, stdin) => {
    if (connection.sshMode !== undefined && connection.sshMode !== "reviewed-envelope-v1") throw new Error("Unsupported Incus SSH mode");
    const reviewed = connection.sshMode === "reviewed-envelope-v1";
    const request = reviewed ? sshGateRequest(argv, stdin) : stdin;
    const command = reviewed ? SSH_GATE_COMMAND : argv.map(quote).join(" ");
    const args = [
      "-F", "/dev/null", "-i", connection.sshIdentityFile, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
      "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2",
      "-o", "GlobalKnownHostsFile=/dev/null", "-o", "UpdateHostKeys=no",
      "-o", `UserKnownHostsFile=${connection.sshKnownHostsFile}`, connection.sshTarget, command,
    ];
    return new Promise<CommandResult>((resolve) => {
      const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let size = 0;
      let timedOut = false;
      let failed = false;
      const stop = () => {
        child.kill("SIGTERM");
        const force = setTimeout(() => child.kill("SIGKILL"), 3_000);
        force.unref();
      };
      const timer = setTimeout(() => { timedOut = true; stop(); }, 60_000);
      timer.unref();
      const capture = (chunks: Buffer[]) => (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1_048_576) { if (!timedOut) { timedOut = true; stop(); } return; }
        chunks.push(chunk);
      };
      child.stdout.on("data", capture(stdout));
      child.stderr.on("data", capture(stderr));
      child.on("error", () => { failed = true; });
      child.stdin.on("error", () => { /* SSH may exit before it reads the public certificate. */ });
      child.on("close", code => {
        clearTimeout(timer);
        resolve({ exitCode: code ?? 127, stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: failed ? "SSH could not start" : Buffer.concat(stderr).toString("utf8"), ...(timedOut ? { timedOut: true } : {}) });
      });
      if (request === undefined) child.stdin.end();
      else child.stdin.end(request);
    });
  };
}

async function required(runner: RemoteRunner, argv: string[]): Promise<string> {
  const result = await runner(argv);
  if (result.exitCode !== 0) throw new Error(`read-only inspection failed: ${argv.join(" ")}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  return result.stdout.trim();
}

async function collect(runner: RemoteRunner, commands: string[][], concurrency = 4): Promise<string[]> {
  const output = new Array<string>(commands.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < commands.length) {
      const index = next++;
      output[index] = await required(runner, commands[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, commands.length) }, () => worker()));
  return output;
}

function json(text: string, label: string): unknown {
  try { return JSON.parse(text); } catch { throw new Error(`${label} returned invalid JSON`); }
}

function rows(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some(entry => !entry || typeof entry !== "object" || Array.isArray(entry))) throw new Error(`${label} must return an array of objects`);
  return value as Record<string, unknown>[];
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function osPrettyName(contents: string): string {
  const row = contents.split("\n").find(line => line.startsWith("PRETTY_NAME="));
  if (!row) throw new Error("/etc/os-release has no PRETTY_NAME");
  const value = row.slice("PRETTY_NAME=".length);
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1).replaceAll('\\"', '"') : value;
}

function number(value: string, label: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${label} must be a safe integer`);
  return Number(value);
}

export const INCUS_INVENTORY_COMMANDS: readonly (readonly string[])[] = [
    ["hostnamectl", "--static"], ["cat", "/etc/os-release"], ["uname", "-r"], ["uname", "-m"],
    ["nproc"], ["getconf", "_PHYS_PAGES"], ["getconf", "PAGESIZE"], ["df", "-B1", "--output=avail", "/"],
    ["stat", "-f", "-c", "%T", "/sys/fs/cgroup"], ["timedatectl", "show", "--property=NTPSynchronized", "--value"],
    ["systemctl", "is-active", "incus.service"], ["incus", "version"], ["incus", "query", "/1.0"],
    ["incus", "project", "list", "--format=json"], ["incus", "storage", "list", "--format=json"],
    ["incus", "network", "list", "--all-projects", "--format=json"], ["incus", "profile", "list", "--all-projects", "--format=json"],
    ["incus", "list", "--all-projects", "--format=json"], ["incus", "config", "trust", "list", "--format=json"], ["ip", "-j", "route", "show", "table", "all"],
    ["ip", "-j", "address", "show"], ["incus", "image", "list", "--project=default", "--format=json"],
];

export function incusCapacityCommands(poolName: string): string[][] {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(poolName)) throw new Error("Invalid reviewed Incus pool name");
  return [["cat", "/proc/meminfo"], ["cat", "/proc/loadavg"], ["cat", "/proc/sys/kernel/threads-max"],
    ["cat", "/proc/sys/kernel/pid_max"], ["incus", "--force-local", "query", `/1.0/storage-pools/${poolName}/resources`]];
}

export async function inspectIncus(connection: IncusConnection, options: { capturedAt?: string; runner?: RemoteRunner } = {}): Promise<IncusInventory> {
  if (!options.runner) await verifyKnownHostPin(connection);
  const runner = options.runner ?? sshRunner(connection);
  const [hostname, osRelease, kernel, architecture, cpuThreads, pages, pageSize, rootFree, cgroup, ntp, service, versions, rawServer, rawProjects, rawPools, rawNetworks, rawProfiles, rawInstances, rawTrust, rawRoutes, rawAddresses, rawImages] = await collect(runner, INCUS_INVENTORY_COMMANDS.map(argv => [...argv])) as [string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string];
  const server = json(rawServer, "Incus server"); assertRecord(server, "Incus server");
  const environment = server.environment; assertRecord(environment, "Incus environment");
  const certificatePem = environment.certificate === undefined ? undefined : text(environment.certificate, "server certificate");
  if (certificatePem && (!certificatePem.startsWith("-----BEGIN CERTIFICATE-----") || certificatePem.length > 16_384 ||
    createHash("sha256").update(new X509Certificate(certificatePem).raw).digest("hex") !== environment.certificate_fingerprint)) {
    throw new Error("Incus server certificate does not match its fingerprint");
  }
  const versionLines = versions.split("\n").map(line => line.trim()).filter(Boolean);
  const clientVersion = versionLines.find(line => line.startsWith("Client version:"))?.slice("Client version:".length).trim();
  const serverVersion = versionLines.find(line => line.startsWith("Server version:"))?.slice("Server version:".length).trim();
  if (!clientVersion || !serverVersion) throw new Error("incus version did not report client and server versions");
  const routeRows = rows(json(rawRoutes, "routes"), "routes");
  const routes = routeRows.map(route => route.dst).filter((entry): entry is string => typeof entry === "string").sort();
  const routeBindings = routeRows.filter(route => typeof route.dst === "string" && typeof route.dev === "string")
    .map(route => ({ destination: route.dst as string, device: route.dev as string }))
    .sort((left, right) => `${left.destination}/${left.device}`.localeCompare(`${right.destination}/${right.device}`));
  const addresses = rows(json(rawAddresses, "addresses"), "addresses").flatMap((network, networkIndex) => {
    if (!Array.isArray(network.addr_info)) throw new Error(`addresses[${networkIndex}].addr_info must be an array`);
    return network.addr_info.map((entry, addressIndex) => {
      assertRecord(entry, `addresses[${networkIndex}].addr_info[${addressIndex}]`);
      return text(entry.local, `addresses[${networkIndex}].addr_info[${addressIndex}].local`);
    });
  }).sort();
  const pageCount = number(pages, "physical page count");
  const bytesPerPage = number(pageSize, "page size");
  const memoryBytes = pageCount * bytesPerPage;
  if (!Number.isSafeInteger(memoryBytes)) throw new Error("host memory exceeds safe integer range");
  const rootLines = rootFree.split("\n").map(line => line.trim()).filter(Boolean);
  const inventory: IncusInventory = {
    schemaVersion: SETUP_SCHEMA_VERSION,
    capturedAt: options.capturedAt ?? new Date().toISOString(),
    connection: { sshTarget: connection.sshTarget, sshHostKeySha256: connection.sshHostKeySha256,
      ...(connection.sshMode ? { sshMode: connection.sshMode } : {}) },
    host: { hostname, os: osPrettyName(osRelease), kernel, architecture, cpuThreads: number(cpuThreads, "CPU threads"), memoryBytes, rootFreeBytes: number(rootLines.at(-1) ?? "", "root free bytes"), addresses, cgroupVersion: cgroup === "cgroup2fs" ? "v2" : "other", ntpSynchronized: ntp === "yes" },
    server: {
      clientVersion, serverVersion, certificateFingerprint: text(environment.certificate_fingerprint, "server certificate fingerprint"), ...(certificatePem ? { certificatePem } : {}), apiStatus: text(server.api_status, "API status"),
      clustered: boolean(environment.server_clustered, "clustered status"), firewall: text(environment.firewall, "firewall"), serviceActive: service === "active",
      apiExtensions: [...new Set((server.api_extensions as unknown[]).map((entry, index) => text(entry, `api_extensions[${index}]`)))].sort(),
      storageDrivers: rows(environment.storage_supported_drivers, "storage drivers").map(driver => ({ name: text(driver.Name, "storage driver name"), version: text(driver.Version, "storage driver version"), remote: boolean(driver.Remote, "storage driver remote") })).sort((left, right) => left.name.localeCompare(right.name)),
      httpsAddresses: Array.isArray(environment.addresses) ? environment.addresses.map((entry, index) => text(entry, `addresses[${index}]`)).sort() : [],
    },
    routes, routeBindings,
    projects: rows(json(rawProjects, "projects"), "projects").map(row => ({ name: text(row.name, "project name"), description: text(row.description ?? "", "project description"), config: stringMap(row.config ?? {}, "project config") })).sort((left, right) => left.name.localeCompare(right.name)),
    storagePools: rows(json(rawPools, "storage pools"), "storage pools").map(row => ({ name: text(row.name, "pool name"), driver: text(row.driver, "pool driver"), description: text(row.description ?? "", "pool description"), config: stringMap(row.config ?? {}, "pool config"), status: text(row.status ?? "", "pool status") })).sort((left, right) => left.name.localeCompare(right.name)),
    networks: rows(json(rawNetworks, "networks"), "networks").map(row => ({ name: text(row.name, "network name"), project: text(row.project ?? "default", "network project"), type: text(row.type, "network type"), managed: boolean(row.managed, "network managed"), description: text(row.description ?? "", "network description"), config: stringMap(row.config ?? {}, "network config"), status: text(row.status ?? "", "network status") })).sort((left, right) => `${left.project}/${left.name}`.localeCompare(`${right.project}/${right.name}`)),
    profiles: rows(json(rawProfiles, "profiles"), "profiles").map(row => ({ name: text(row.name, "profile name"), project: text(row.project ?? "default", "profile project"), description: text(row.description ?? "", "profile description"), config: stringMap(row.config ?? {}, "profile config"), devices: Object.fromEntries(Object.entries(row.devices && typeof row.devices === "object" ? row.devices as Record<string, unknown> : {}).sort().map(([name, device]) => [name, stringMap(device, `profile device ${name}`)])) })).sort((left, right) => `${left.project}/${left.name}`.localeCompare(`${right.project}/${right.name}`)),
    images: rows(json(rawImages, "images"), "images").map(row => ({ fingerprint: text(row.fingerprint, "image fingerprint"),
      aliases: rows(row.aliases, "image aliases").map(alias => text(alias.name, "image alias")).sort() })).sort((left, right) => left.fingerprint.localeCompare(right.fingerprint)),
    instances: rows(json(rawInstances, "instances"), "instances").map(row => ({ name: text(row.name, "instance name"), project: text(row.project ?? "default", "instance project"), status: text(row.status ?? "", "instance status"), type: text(row.type ?? "", "instance type") })).sort((left, right) => `${left.project}/${left.name}`.localeCompare(`${right.project}/${right.name}`)),
    trust: rows(json(rawTrust, "trust"), "trust").map(row => ({ fingerprint: text(row.fingerprint, "trust fingerprint"), name: text(row.name ?? "", "trust name"), restricted: boolean(row.restricted, "trust restriction"), projects: Array.isArray(row.projects) ? row.projects.map((entry, index) => text(entry, `trust projects[${index}]`)).sort() : [], type: text(row.type, "trust type") })).sort((left, right) => left.fingerprint.localeCompare(right.fingerprint)),
  };
  return inventory;
}
