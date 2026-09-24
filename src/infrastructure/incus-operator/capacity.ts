import { sql } from "drizzle-orm";
import { digest, type IncusConnection, type IncusInventory, type IncusSetupPlan, type IncusSetupRecipe } from "../../../scripts/incus/model";
import { inspectIncus, sshRunner, verifyKnownHostPin, type RemoteRunner } from "../../../scripts/incus/inspect";
import { verifySetupPlan } from "../../../scripts/incus/plan";
import type { Database, DbTransaction } from "../../db/connection";
import { releaseRows } from "../../db/queries/extension-releases";
import type { ActiveExtensionRelease } from "../../extensions/release-process";
import { SandboxAdmissionStore, type SandboxHostCapacityInput, type SandboxResourceVector } from "../../sandboxes/admission";
import type { ProviderConnectionStore } from "../provider-connections/store";

const GIB = 1024 ** 3;
const EXTERNAL_MEMORY_RESERVE = 8 * GIB;
const EXTERNAL_DISK_RESERVE = 10 * GIB;
const EXTERNAL_PID_RESERVE = 1024;
const EXTERNAL_CPU_RESERVE = 2;
const PLAN_LIFETIME_MS = 10 * 60_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

interface SetupRow {
  id: string;
  providerInstallationId: string;
  providerReleaseId: string;
  providerReleaseDigest: string;
  providerGeneration: number;
  connectionId: string;
  connectionRevision: number;
  recipe: IncusSetupRecipe;
  plan: IncusSetupPlan;
  state: string;
  capacityReceipt: CapacityReceipt | null;
}

export interface CapacityObservation {
  capturedAt: string;
  hostId: string;
  availableMemoryBytes: number;
  poolFreeBytes: number;
  availablePids: number;
  cpuThreads: number;
}

export interface IncusCapacityPlan {
  schemaVersion: 1;
  setupId: string;
  installationId: string;
  releaseId: string;
  releaseDigest: string;
  generation: number;
  connectionId: string;
  connectionRevision: number;
  recipeDigest: string;
  setupPlanDigest: string;
  observation: CapacityObservation;
  capacity: SandboxHostCapacityInput;
  expiresAt: string;
  planDigest: string;
}

export interface CapacityReceipt { plan: IncusCapacityPlan; appliedBy: string; appliedAt: string }

export interface CapacityDependencies {
  database: Database;
  connections: ProviderConnectionStore;
  bootstrap: IncusConnection;
  activeRelease(installationId: string): Promise<ActiveExtensionRelease>;
  inspect?: typeof inspectIncus;
  runner?: RemoteRunner;
  verifyPin?: typeof verifyKnownHostPin;
  now?: () => Date;
}

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Incus capacity unavailable: ${message}`);
}

function whole(value: unknown, label: string): number {
  requireValue(typeof value === "number" && Number.isSafeInteger(value) && value >= 0, `${label} is not a safe integer`);
  return value;
}

function binarySize(value: string | undefined, label: string): number {
  const match = /^(0|[1-9][0-9]*)(GiB|MiB)$/.exec(value ?? "");
  requireValue(match, `${label} is not an exact binary size`);
  return whole(Number(match[1]) * (match[2] === "GiB" ? GIB : 1024 ** 2), label);
}

function positiveDecimal(value: string | undefined, label: string): number {
  requireValue(typeof value === "string" && /^[1-9][0-9]*$/.test(value), `${label} is not a positive integer`);
  return whole(Number(value), label);
}

function boundedOutput(value: string, label: string): string {
  requireValue(Buffer.byteLength(value) <= 32 * 1024, `${label} exceeds 32 KiB`);
  return value.trim();
}

/** All commands are fixed, read-only host commands. No request supplies shell text. */
export async function readCapacityObservation(connection: IncusConnection, inventory: IncusInventory, poolName: string,
  runner: RemoteRunner = sshRunner(connection), verifyPin: typeof verifyKnownHostPin = verifyKnownHostPin,
  now?: () => Date): Promise<CapacityObservation> {
  const pool = inventory.storagePools.find(item => item.name === poolName);
  requireValue(pool, "reviewed pool is absent");
  requireValue(/^[a-z][a-z0-9-]{0,62}$/.test(pool.name), "pool name is invalid");
  await verifyPin(connection);
  const commands = [["cat", "/proc/meminfo"], ["cat", "/proc/loadavg"], ["cat", "/proc/sys/kernel/threads-max"],
    ["cat", "/proc/sys/kernel/pid_max"], ["incus", "--force-local", "query", `/1.0/storage-pools/${pool.name}/resources`]];
  const results = await Promise.all(commands.map(argv => runner(argv)));
  for (const result of results) requireValue(result.exitCode === 0 && !result.timedOut && result.stderr.trim() === "", "protected host read failed");
  const [memText, loadText, threadsText, pidText, poolText] = results.map((result, i) => boundedOutput(result.stdout, `host read ${i}`));
  const available = /^MemAvailable:\s+([0-9]+) kB$/m.exec(memText!);
  requireValue(available, "MemAvailable is absent");
  const availableMemoryBytes = whole(Number(available[1]) * 1024, "available memory");
  const tasks = /^\S+\s+\S+\s+\S+\s+\d+\/(\d+)\s+\d+$/.exec(loadText!);
  requireValue(tasks, "host task count is invalid");
  const availablePids = Math.min(positiveDecimal(threadsText, "threads maximum"), positiveDecimal(pidText, "PID maximum")) - Number(tasks[1]);
  requireValue(Number.isSafeInteger(availablePids) && availablePids > 0, "PID headroom is absent");
  let poolResources: unknown;
  try { poolResources = JSON.parse(poolText!); } catch { throw new Error("Incus capacity unavailable: pool resources are invalid JSON"); }
  requireValue(poolResources && typeof poolResources === "object" && !Array.isArray(poolResources), "pool resources are invalid");
  const space = (poolResources as Record<string, unknown>).space;
  requireValue(space && typeof space === "object" && !Array.isArray(space), "pool space is absent");
  const total = whole((space as Record<string, unknown>).total, "pool total");
  const used = whole((space as Record<string, unknown>).used, "pool used");
  requireValue(total > 0 && used <= total, "pool space is invalid");
  return { capturedAt: (now?.() ?? new Date()).toISOString(), hostId: inventory.host.hostname, availableMemoryBytes,
    poolFreeBytes: total - used, availablePids, cpuThreads: whole(inventory.host.cpuThreads, "CPU threads") };
}

function deriveCapacity(row: SetupRow, observation: CapacityObservation): SandboxHostCapacityInput {
  const project = row.recipe.project.config;
  requireValue(project.restricted === "true" && project["limits.virtual-machines"] === "0", "restricted project recipe changed");
  const projectMemory = binarySize(project["limits.memory"], "project memory");
  const projectDisk = binarySize(project[`limits.disk.pool.${row.recipe.storage.name}`], "project disk");
  const projectCpu = positiveDecimal(project["limits.cpu"], "project CPU");
  const projectPids = positiveDecimal(project["limits.processes"], "project PIDs");
  const projectSlots = positiveDecimal(project["limits.containers"], "project containers");
  const allocatable: SandboxResourceVector = {
    memoryBytes: Math.min(projectMemory, observation.availableMemoryBytes - EXTERNAL_MEMORY_RESERVE),
    cpuMillicores: Math.min(projectCpu, observation.cpuThreads - EXTERNAL_CPU_RESERVE) * 1000,
    pids: Math.min(projectPids, observation.availablePids - EXTERNAL_PID_RESERVE),
    diskBytes: Math.min(projectDisk, observation.poolFreeBytes - EXTERNAL_DISK_RESERVE),
    executionSlots: projectSlots,
  };
  const safetyMargin: SandboxResourceVector = { memoryBytes: 4 * GIB, cpuMillicores: 1000,
    pids: 512, diskBytes: 10 * GIB, executionSlots: 1 };
  for (const key of Object.keys(allocatable) as Array<keyof SandboxResourceVector>) {
    requireValue(Number.isSafeInteger(allocatable[key]) && allocatable[key] > safetyMargin[key], `${key} has no safe capacity`);
  }
  return { providerInstallationId: row.providerInstallationId, connectionId: row.connectionId, allocatable, safetyMargin };
}

function same(left: unknown, right: unknown): boolean { return digest(left) === digest(right); }

function assertUnexpired(plan: IncusCapacityPlan, now: Date): void {
  const captured = Date.parse(plan.observation.capturedAt);
  const expiry = Date.parse(plan.expiresAt);
  requireValue(Number.isFinite(captured) && Number.isFinite(expiry) && captured <= now.getTime()
    && expiry > now.getTime() && expiry - captured === PLAN_LIFETIME_MS,
  "capacity plan expired or clock changed");
}

export class IncusCapacityService {
  constructor(private readonly deps: CapacityDependencies) {}

  async status(setupId: string): Promise<CapacityReceipt | null> {
    return (await this.setup(setupId)).capacityReceipt;
  }

  private async setup(setupId: string, db: Database = this.deps.database, lock = false): Promise<SetupRow> {
    requireValue(ID.test(setupId), "setup ID is invalid");
    const rows = releaseRows<SetupRow>(await db.execute(sql`SELECT id, provider_installation_id AS "providerInstallationId",
      provider_release_id AS "providerReleaseId", provider_release_digest AS "providerReleaseDigest",
      provider_generation AS "providerGeneration", connection_id AS "connectionId", connection_revision AS "connectionRevision",
      recipe, plan, state, capacity_receipt AS "capacityReceipt" FROM incus_operator_setups WHERE id = ${setupId}
      ${lock ? sql`FOR UPDATE` : sql``}`));
    const row = rows[0];
    requireValue(row?.state === "verified", "exact setup is not verified");
    const latest = releaseRows<{ id: string }>(await db.execute(sql`SELECT id FROM incus_operator_setups
      WHERE provider_installation_id = ${row.providerInstallationId} ORDER BY created_at DESC, id DESC LIMIT 1`))[0];
    requireValue(latest?.id === row.id, "setup was replaced");
    return row;
  }

  private async current(row: SetupRow): Promise<{ inventory: IncusInventory; observation: CapacityObservation }> {
    const snapshot = await this.deps.activeRelease(row.providerInstallationId);
    requireValue(snapshot.release.id === row.providerReleaseId && snapshot.release.releaseDigest === row.providerReleaseDigest
      && snapshot.installation.generation === row.providerGeneration
      && snapshot.release.manifest.sandboxProviders?.some(provider => provider.id === "incus" && provider.kind === "sandbox"),
    "approved Incus release changed");
    await this.deps.connections.resolveForHost({ connectionId: row.connectionId,
      providerInstallationId: row.providerInstallationId, providerReleaseId: row.providerReleaseId,
      revision: row.connectionRevision });
    const inventory = await (this.deps.inspect ?? inspectIncus)(this.deps.bootstrap);
    requireValue(verifySetupPlan(row.plan, row.recipe, inventory).length === 0, "reviewed setup or server drifted");
    requireValue(inventory.host.hostname === row.recipe.expected.hostname && inventory.host.memoryBytes > EXTERNAL_MEMORY_RESERVE,
      "host identity or memory changed");
    const observation = await readCapacityObservation(this.deps.bootstrap, inventory, row.recipe.storage.name,
      this.deps.runner ?? sshRunner(this.deps.bootstrap), this.deps.verifyPin ?? verifyKnownHostPin, this.deps.now);
    return { inventory, observation };
  }

  async plan(setupId: string): Promise<IncusCapacityPlan> {
    const row = await this.setup(setupId);
    requireValue(!row.capacityReceipt, "capacity was already applied for this setup");
    const { observation } = await this.current(row);
    const now = this.deps.now?.() ?? new Date();
    requireValue(Math.abs(now.getTime() - Date.parse(observation.capturedAt)) < 30_000, "host sample is stale");
    const payload = { schemaVersion: 1 as const, setupId: row.id, installationId: row.providerInstallationId,
      releaseId: row.providerReleaseId, releaseDigest: row.providerReleaseDigest, generation: row.providerGeneration,
      connectionId: row.connectionId, connectionRevision: row.connectionRevision, recipeDigest: digest(row.recipe),
      setupPlanDigest: row.plan.planDigest, observation, capacity: deriveCapacity(row, observation),
      expiresAt: new Date(Date.parse(observation.capturedAt) + PLAN_LIFETIME_MS).toISOString() };
    return { ...payload, planDigest: digest(payload) };
  }

  async apply(input: IncusCapacityPlan, approvedDigest: string, principalId: string): Promise<CapacityReceipt> {
    requireValue(input && typeof input === "object" && !Array.isArray(input), "exact plan is required");
    const { planDigest, ...payload } = input;
    requireValue(/^[a-f0-9]{64}$/.test(approvedDigest) && planDigest === approvedDigest && digest(payload) === planDigest,
      "exact capacity plan digest must be approved");
    const row = await this.setup(input.setupId);
    if (row.capacityReceipt) {
      requireValue(row.capacityReceipt.plan.planDigest === planDigest && same(row.capacityReceipt.plan, input), "another capacity plan was applied");
      return row.capacityReceipt;
    }
    requireValue(input.schemaVersion === 1 && input.installationId === row.providerInstallationId
      && input.releaseId === row.providerReleaseId && input.releaseDigest === row.providerReleaseDigest
      && input.generation === row.providerGeneration && input.connectionId === row.connectionId
      && input.connectionRevision === row.connectionRevision && input.recipeDigest === digest(row.recipe)
      && input.setupPlanDigest === row.plan.planDigest && same(input.capacity, deriveCapacity(row, input.observation)),
    "capacity plan scope or derivation changed");
    assertUnexpired(input, this.deps.now?.() ?? new Date());
    const { observation } = await this.current(row);
    requireValue(observation.hostId === input.observation.hostId && observation.cpuThreads === input.observation.cpuThreads
      && observation.availableMemoryBytes >= input.capacity.allocatable.memoryBytes + EXTERNAL_MEMORY_RESERVE
      && observation.poolFreeBytes >= input.capacity.allocatable.diskBytes + EXTERNAL_DISK_RESERVE
      && observation.availablePids >= input.capacity.allocatable.pids + EXTERNAL_PID_RESERVE,
    "fresh host headroom no longer supports reviewed capacity");
    return this.deps.database.transaction(async (transaction: DbTransaction) => {
      const locked = await this.setup(input.setupId, transaction, true);
      if (locked.capacityReceipt) {
        requireValue(locked.capacityReceipt.plan.planDigest === planDigest && same(locked.capacityReceipt.plan, input),
          "another capacity plan was applied");
        return locked.capacityReceipt;
      }
      await this.deps.connections.assertCurrentScope({ connectionId: locked.connectionId,
        providerInstallationId: locked.providerInstallationId, providerReleaseId: locked.providerReleaseId,
        revision: locked.connectionRevision, releaseDigest: locked.providerReleaseDigest,
        generation: locked.providerGeneration }, transaction);
      assertUnexpired(input, this.deps.now?.() ?? new Date());
      await new SandboxAdmissionStore(this.deps.database).configureHostCapacity(input.capacity, transaction);
      const committedAt = this.deps.now?.() ?? new Date();
      assertUnexpired(input, committedAt);
      const receipt = { plan: input, appliedBy: principalId, appliedAt: committedAt.toISOString() };
      await transaction.execute(sql`UPDATE incus_operator_setups SET capacity_receipt = ${JSON.stringify(receipt)}::text::jsonb,
        capacity_applied_by = ${principalId}, capacity_applied_at = ${committedAt.toISOString()}::timestamptz, updated_at = NOW()
        WHERE id = ${row.id} AND capacity_receipt IS NULL`);
      return receipt;
    });
  }
}
