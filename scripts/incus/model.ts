import { createHash } from "node:crypto";
import { canonicalJson } from "@ezcorp/extension-contract";

export const SETUP_SCHEMA_VERSION = 1 as const;
export const DIGEST = /^[a-f0-9]{64}$/;
export const NAME = /^[a-z][a-z0-9-]{0,62}$/;

export interface IncusConnection {
  sshTarget: string;
  sshIdentityFile: string;
  sshKnownHostsFile: string;
  sshHostKeySha256: string;
}

export interface IncusInventory {
  schemaVersion: typeof SETUP_SCHEMA_VERSION;
  capturedAt: string;
  connection: Pick<IncusConnection, "sshTarget" | "sshHostKeySha256">;
  host: {
    hostname: string;
    os: string;
    kernel: string;
    architecture: string;
    cpuThreads: number;
    memoryBytes: number;
    rootFreeBytes: number;
    addresses: string[];
    cgroupVersion: "v2" | "other";
    ntpSynchronized: boolean;
  };
  server: {
    clientVersion: string;
    serverVersion: string;
    certificateFingerprint: string;
    certificatePem?: string;
    apiStatus: string;
    clustered: boolean;
    firewall: string;
    serviceActive: boolean;
    apiExtensions: string[];
    storageDrivers: Array<{ name: string; version: string; remote: boolean }>;
    httpsAddresses: string[];
  };
  routes: string[];
  routeBindings?: Array<{ destination: string; device: string }>;
  projects: IncusProject[];
  storagePools: IncusStoragePool[];
  networks: IncusNetwork[];
  profiles: IncusProfile[];
  images?: Array<{ fingerprint: string; aliases: string[] }>;
  instances: Array<{ name: string; project: string; status: string; type: string }>;
  trust: Array<{ fingerprint: string; name: string; restricted: boolean; projects: string[]; type: string }>;
}

export interface IncusProject { name: string; description: string; config: Record<string, string> }
export interface IncusStoragePool { name: string; driver: string; description: string; config: Record<string, string>; status: string }
export interface IncusNetwork { name: string; project: string; type: string; managed: boolean; description: string; config: Record<string, string>; status: string }
export interface IncusProfile { name: string; project: string; description: string; config: Record<string, string>; devices: Record<string, Record<string, string>> }

export interface IncusSetupRecipe {
  schemaVersion: typeof SETUP_SCHEMA_VERSION;
  id: string;
  version: string;
  expected: {
    hostname: string;
    architecture: "x86_64";
    incusVersion: string;
    serverCertificateFingerprint: string;
    sshHostKeySha256: string;
    firewall: "nftables";
    minimumRootFreeBytes: number;
    requiredApiExtensions: string[];
  };
  storage: { name: string; driver: "lvm" | "btrfs" | "zfs"; size: string; sizeBytes: number; defaultVolumeSize: string };
  network: { name: string; project: "default"; type: "bridge"; config: Record<string, string> };
  project: { name: string; description: string; config: Record<string, string> };
  profile: { name: string; description: string; config: Record<string, string>; devices: Record<string, Record<string, string>> };
  server: { httpsAddress: string };
  guestImage?: {
    alias: string;
    fingerprint: string | null;
    sourceFingerprint: string | null;
    helperSha256: string;
    user: "sandbox";
    uid: 1000;
    gid: 1000;
    pythonPackageVersion: string | null;
    dockerArchiveSha256: string | null;
    composeSha256: string | null;
  };
  providerClient?: { name: string; certificateFingerprint: string; certificatePem: string; projects: string[]; restricted: true };
}

export type SetupResource = "storage" | "network" | "project" | "profile" | "server" | "trust";
export interface SetupStep {
  id: string;
  resource: SetupResource;
  description: string;
  inspect: { argv: string[]; expected: unknown; notFoundExitCodes: number[]; emptyAsAbsent?: boolean };
  apply: { argv: string[]; stdin?: string };
}

export interface IncusSetupPlan {
  schemaVersion: typeof SETUP_SCHEMA_VERSION;
  setupId: string;
  recipeId: string;
  recipeVersion: string;
  recipeDigest: string;
  inventoryFingerprint: string;
  status: "ready" | "blocked";
  blockedReasons: string[];
  steps: SetupStep[];
  planDigest: string;
}

export type StepObservation = "absent" | "match" | "drift";
export type OutcomeClass = "succeeded" | "reconcile" | "retryable" | "review_required";
export interface CommandResult { exitCode: number; stdout: string; stderr: string; timedOut?: boolean }
export interface ApplyReceipt {
  schemaVersion: typeof SETUP_SCHEMA_VERSION;
  planDigest: string;
  dryRun: boolean;
  state: "dry_run" | "applied" | "blocked" | "reconcile_required" | "review_required";
  blockedReasons?: string[];
  steps: Array<{ id: string; before: StepObservation; action: "planned" | "skipped" | "executed" | "stopped"; outcome: OutcomeClass; exitCode?: number }>;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function digest(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function assertSetupPlanDigest(plan: IncusSetupPlan): void {
  const { planDigest: _planDigest, ...payload } = plan;
  if (digest(payload) !== plan.planDigest) throw new Error("setup plan digest mismatch");
}

export function inventoryFingerprint(inventory: IncusInventory): string {
  const { capturedAt: _capturedAt, ...stable } = inventory;
  return digest({
    ...stable,
    host: { ...stable.host, addresses: [...stable.host.addresses].sort() },
    server: { ...stable.server, apiExtensions: [...stable.server.apiExtensions].sort(), storageDrivers: [...stable.server.storageDrivers].sort((left, right) => left.name.localeCompare(right.name)), httpsAddresses: [...stable.server.httpsAddresses].sort() },
    routes: [...stable.routes].sort(),
    ...(stable.routeBindings ? { routeBindings: [...stable.routeBindings].sort((left, right) => `${left.destination}/${left.device}`.localeCompare(`${right.destination}/${right.device}`)) } : {}),
    projects: [...stable.projects].sort((left, right) => left.name.localeCompare(right.name)),
    storagePools: [...stable.storagePools].sort((left, right) => left.name.localeCompare(right.name)),
    networks: [...stable.networks].sort((left, right) => `${left.project}/${left.name}`.localeCompare(`${right.project}/${right.name}`)),
    profiles: [...stable.profiles].sort((left, right) => `${left.project}/${left.name}`.localeCompare(`${right.project}/${right.name}`)),
    instances: [...stable.instances].sort((left, right) => `${left.project}/${left.name}`.localeCompare(`${right.project}/${right.name}`)),
    trust: [...stable.trust].sort((left, right) => left.fingerprint.localeCompare(right.fingerprint)),
  });
}

export function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

export function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const expected = new Set(allowed);
  const extra = Object.keys(value).filter(key => !expected.has(key));
  if (extra.length) throw new Error(`${label} contains unsupported fields: ${extra.sort().join(", ")}`);
}

export function stringMap(value: unknown, label: string): Record<string, string> {
  assertRecord(value, label);
  const output: Record<string, string> = {};
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    if (!key || key === "__proto__" || key === "constructor" || key === "prototype" || typeof entry !== "string") throw new Error(`${label} must contain safe string values`);
    output[key] = entry;
  }
  return output;
}

export function sortedStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== "string" || !entry)) throw new Error(`${label} must be a string list`);
  if (new Set(value).size !== value.length) throw new Error(`${label} must not contain duplicates`);
  return [...value].sort();
}

export function assertSafeName(value: string, label: string): void {
  if (!NAME.test(value)) throw new Error(`${label} must be a lowercase bounded name`);
}

export function assertSha256(value: string, label: string): void {
  if (!DIGEST.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
}

export function isSubset(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((entry, index) => isSubset(entry, actual[index]));
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
    return Object.entries(expected as Record<string, unknown>).every(([key, value]) => Object.hasOwn(actual, key) && isSubset(value, (actual as Record<string, unknown>)[key]));
  }
  return expected === actual;
}
