import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { and, eq } from "drizzle-orm";
import { getDb, type Database, type DbTransaction } from "../db/connection";
import { projectWorkspaceBindings, projects, sandboxAdmissionRequests, sandboxBindings,
  sandboxHostCapacities, sandboxOperations, sandboxProjectQuotas, sandboxReservations } from "../db/schema";
import { IncusQualificationStore, type IncusQualificationScope } from "./incus-qualification";
import type { IncusControlDenial, IncusControlProbeConfig } from "./incus-live-control-probes";

const kinds = ["unsupported", "missingControl", "drift", "unqualified"] as const satisfies readonly IncusControlDenial[];
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

interface Dependencies {
  db?: Database;
  qualifications?: IncusQualificationStore;
  /** Operator configured, existing 0700 directory. Never taken from request data. */
  rootDirectory: string;
}

export interface IncusProbeFixturePlan {
  digest: string;
  operationId: string;
  scope: IncusQualificationScope;
  directory: string;
  config: IncusControlProbeConfig;
  presetDigest: string;
  effectiveSettingsDigest: string;
  connectionRevision: number;
  profile: string;
}

export interface IncusProbeFixtureReceipt {
  planDigest: string;
  state: "ready" | "cleaned";
  projectIds: string[];
  bindingIds: string[];
  canaryPaths: string[];
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertScope(scope: IncusQualificationScope, operationId: string): void {
  if (!identifier.test(operationId) || !Object.values(scope).every(value => identifier.test(value))) {
    throw new Error("Invalid Incus probe fixture scope or operation ID");
  }
}

function identity(scope: IncusQualificationScope, operationId: string): string {
  return digest([scope.installationId, scope.releaseId, scope.connectionId, scope.presetId, operationId]);
}

function canaryContent(id: string, kind: IncusControlDenial): string {
  return `EZHarness AMD control canary ${id} ${kind}\n`;
}

async function privateDirectory(path: string): Promise<void> {
  if (!isAbsolute(path) || await realpath(path) !== path) throw new Error("Incus probe fixture directory is not canonical");
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("Incus probe fixture directory is not private to the operator");
  }
}

async function ensureCanary(path: string, content: string): Promise<void> {
  try {
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(content); }
    finally { await file.close(); }
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0
      || typeof process.getuid === "function" && stat.uid !== process.getuid()
      || await file.readFile({ encoding: "utf8" }) !== content) {
      throw new Error("Incus probe fixture canary changed");
    }
  } finally { await file.close(); }
}

function expectedCases(directory: string, id: string): IncusControlProbeConfig["cases"] {
  const cases = {} as IncusControlProbeConfig["cases"];
  for (const kind of kinds) {
    cases[kind] = { projectId: `incus-probe-project-${id}-${kind}`,
      canaryPath: join(directory, `${kind}.canary`),
      ...((kind === "missingControl" || kind === "drift")
        ? { bindingId: `incus-probe-binding-${id}-${kind}` } : {}) };
  }
  return cases;
}

/** Creates local operator controls only. It has no provider dispatch path. */
export class IncusLiveProbeFixtureService {
  private readonly db: Database;
  private readonly qualifications: IncusQualificationStore;

  constructor(private readonly deps: Dependencies) {
    this.db = deps.db ?? getDb();
    this.qualifications = deps.qualifications ?? new IncusQualificationStore({ db: this.db });
  }

  async plan(scope: IncusQualificationScope, operationId: string): Promise<IncusProbeFixturePlan> {
    assertScope(scope, operationId);
    await privateDirectory(this.deps.rootDirectory);
    const selected = await this.qualifications.authorizeFixture(scope);
    const alternate = selected.snapshot.release.manifest.sandboxProviders
      ?.find(provider => provider.kind === "sandbox" && provider.id === "incus")
      ?.presets.find(preset => preset.id !== scope.presetId);
    if (!alternate || await this.qualifications.load({ ...scope, presetId: alternate.id })) {
      throw new Error("Incus probe fixture needs an unqualified declared preset");
    }
    const id = identity(scope, operationId);
    const [capacity] = await this.db.select().from(sandboxHostCapacities).where(and(
      eq(sandboxHostCapacities.providerInstallationId, scope.installationId),
      eq(sandboxHostCapacities.connectionId, scope.connectionId))).limit(1);
    if (!capacity) throw new Error("Incus probe fixture host capacity is unavailable");
    const directory = join(this.deps.rootDirectory, id);
    const config = { cases: expectedCases(directory, id), unqualifiedPresetId: alternate.id };
    const plan = { operationId, scope, directory, config,
      presetDigest: selected.presetDigest, effectiveSettingsDigest: selected.effectiveSettingsDigest,
      connectionRevision: selected.connection.revision, profile: selected.preset.profile };
    return { ...plan, digest: digest(plan) };
  }

  private async assertOwned(tx: DbTransaction, plan: IncusProbeFixturePlan, present: boolean): Promise<void> {
    for (const kind of kinds) {
      const item = plan.config.cases[kind];
      const [project] = await tx.select().from(projects).where(eq(projects.id, item.projectId)).limit(1);
      const [binding] = item.bindingId
        ? await tx.select().from(sandboxBindings).where(eq(sandboxBindings.id, item.bindingId)).limit(1) : [];
      if (present !== !!project || present && (project?.purpose !== "user"
        || project.name !== item.projectId || project.path !== `/__incus_control_probe__/${identity(plan.scope, plan.operationId)}/${kind}`
        || !!item.bindingId !== !!binding)) {
        throw new Error("Incus probe fixture ownership changed");
      }
      if (binding && (binding.projectId !== item.projectId || binding.resourceKey !== item.bindingId
        || binding.providerInstallationId !== plan.scope.installationId
        || binding.providerReleaseId !== plan.scope.releaseId || binding.connectionId !== plan.scope.connectionId
        || binding.connectionRevision !== plan.connectionRevision || binding.presetId !== plan.scope.presetId
        || binding.presetDigest !== plan.presetDigest
        || binding.effectiveSettingsDigest !== plan.effectiveSettingsDigest
        || binding.profile !== plan.profile || binding.generation !== 1
        || binding.tombstonedAt || binding.currentOperationId)) {
        throw new Error("Incus probe fixture binding changed");
      }
    }
  }

  async apply(scope: IncusQualificationScope, operationId: string, reviewedDigest: string): Promise<{
    config: IncusControlProbeConfig; receipt: IncusProbeFixtureReceipt;
  }> {
    const plan = await this.plan(scope, operationId);
    if (reviewedDigest !== plan.digest) throw new Error("Incus probe fixture review digest changed");
    const existing = await this.db.select({ id: projects.id }).from(projects)
      .where(eq(projects.id, plan.config.cases.unsupported.projectId)).limit(1);
    await this.assertOwned(this.db, plan, existing.length > 0);
    await mkdir(plan.directory, { mode: 0o700 }).catch((error: unknown) => {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
    });
    await privateDirectory(plan.directory);
    await ensureCanary(join(plan.directory, "plan.json"), `${JSON.stringify(plan)}\n`);
    for (const kind of kinds) await ensureCanary(plan.config.cases[kind].canaryPath,
      canaryContent(identity(scope, operationId), kind));
    await this.db.transaction(async (tx: DbTransaction) => {
      if (existing.length) { await this.assertOwned(tx, plan, true); return; }
      await this.assertOwned(tx, plan, false);
      for (const kind of kinds) {
        const item = plan.config.cases[kind];
        await tx.insert(projects).values({ id: item.projectId, name: item.projectId,
          purpose: "user", path: `/__incus_control_probe__/${identity(scope, operationId)}/${kind}` });
        if (item.bindingId) await tx.insert(sandboxBindings).values({ id: item.bindingId,
          projectId: item.projectId, providerInstallationId: scope.installationId,
          providerReleaseId: scope.releaseId, connectionId: scope.connectionId,
          connectionRevision: plan.connectionRevision, profile: plan.profile,
          presetId: scope.presetId, presetDigest: plan.presetDigest,
          effectiveSettingsDigest: plan.effectiveSettingsDigest, resourceKey: item.bindingId,
          desiredState: "STOPPED", observedState: "UNKNOWN" });
      }
    });
    return { config: plan.config, receipt: this.receipt(plan, "ready") };
  }

  private receipt(plan: IncusProbeFixturePlan, state: IncusProbeFixtureReceipt["state"]): IncusProbeFixtureReceipt {
    return { planDigest: plan.digest, state,
      projectIds: kinds.map(kind => plan.config.cases[kind].projectId),
      bindingIds: kinds.flatMap(kind => plan.config.cases[kind].bindingId ? [plan.config.cases[kind].bindingId] : []),
      canaryPaths: kinds.map(kind => plan.config.cases[kind].canaryPath) };
  }

  private async savedPlan(scope: IncusQualificationScope, operationId: string): Promise<IncusProbeFixturePlan | null> {
    assertScope(scope, operationId);
    await privateDirectory(this.deps.rootDirectory);
    const id = identity(scope, operationId);
    const directory = join(this.deps.rootDirectory, id);
    try { await privateDirectory(directory); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
    const file = await open(join(directory, "plan.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    let content: string;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > 16_384 || (stat.mode & 0o077) !== 0
        || typeof process.getuid === "function" && stat.uid !== process.getuid()) {
        throw new Error("Incus probe fixture receipt is not private");
      }
      content = await file.readFile({ encoding: "utf8" });
    } finally { await file.close(); }
    let plan: IncusProbeFixturePlan;
    try { plan = JSON.parse(content) as IncusProbeFixturePlan; }
    catch { throw new Error("Incus probe fixture receipt is invalid"); }
    const { digest: savedDigest, ...body } = plan;
    if (savedDigest !== digest(body) || plan.operationId !== operationId
      || JSON.stringify(plan.scope) !== JSON.stringify(scope) || plan.directory !== directory
      || JSON.stringify(plan.config?.cases) !== JSON.stringify(expectedCases(directory, id))
      || !identifier.test(plan.config?.unqualifiedPresetId)
      || !Number.isSafeInteger(plan.connectionRevision) || plan.connectionRevision < 1
      || typeof plan.presetDigest !== "string" || typeof plan.effectiveSettingsDigest !== "string"
      || typeof plan.profile !== "string") {
      throw new Error("Incus probe fixture receipt changed");
    }
    return plan;
  }

  async cleanup(scope: IncusQualificationScope, operationId: string, reviewedDigest: string): Promise<IncusProbeFixtureReceipt> {
    if (!/^[a-f0-9]{64}$/.test(reviewedDigest)) throw new Error("Incus probe fixture review digest is invalid");
    const plan = await this.savedPlan(scope, operationId);
    if (!plan) {
      const id = identity(scope, operationId);
      const directory = join(this.deps.rootDirectory, id);
      const cases = expectedCases(directory, id);
      const [project] = await this.db.select({ id: projects.id }).from(projects)
        .where(eq(projects.id, cases.unsupported.projectId)).limit(1);
      if (project) throw new Error("Incus probe fixture receipt is missing");
      return { planDigest: reviewedDigest, state: "cleaned",
        projectIds: kinds.map(kind => cases[kind].projectId),
        bindingIds: kinds.flatMap(kind => cases[kind].bindingId ? [cases[kind].bindingId] : []),
        canaryPaths: kinds.map(kind => cases[kind].canaryPath) };
    }
    if (plan.digest !== reviewedDigest) throw new Error("Incus probe fixture review digest changed");
    const listed = await readdir(plan.directory);
    if (listed.some(name => name !== "plan.json" && !kinds.some(kind => name === `${kind}.canary`))) {
      throw new Error("Incus probe fixture directory contains unexpected files");
    }
    for (const kind of kinds) {
      const path = plan.config.cases[kind].canaryPath;
      if (listed.includes(`${kind}.canary`)) await ensureCanary(path, canaryContent(identity(scope, operationId), kind));
    }
    await this.db.transaction(async (tx: DbTransaction) => {
      const [first] = await tx.select({ id: projects.id }).from(projects)
        .where(eq(projects.id, plan.config.cases.unsupported.projectId)).limit(1);
      if (!first) { await this.assertOwned(tx, plan, false); return; }
      await this.assertOwned(tx, plan, true);
      for (const kind of kinds) {
        const item = plan.config.cases[kind];
        const [workspace] = await tx.select().from(projectWorkspaceBindings)
          .where(eq(projectWorkspaceBindings.projectId, item.projectId)).limit(1);
        const [quota] = await tx.select().from(sandboxProjectQuotas)
          .where(eq(sandboxProjectQuotas.projectId, item.projectId)).limit(1);
        if (workspace || quota) throw new Error("Incus probe fixture gained project authority");
        if (!item.bindingId) continue;
        const [operation] = await tx.select().from(sandboxOperations)
          .where(eq(sandboxOperations.bindingId, item.bindingId)).limit(1);
        const [reservation] = await tx.select().from(sandboxReservations)
          .where(eq(sandboxReservations.bindingId, item.bindingId)).limit(1);
        const admissions = await tx.select().from(sandboxAdmissionRequests)
          .where(eq(sandboxAdmissionRequests.bindingId, item.bindingId));
        if (operation || reservation || admissions.some((entry: { state: string }) => entry.state !== "REJECTED")) {
          throw new Error("Incus probe fixture may have a provider effect");
        }
        await tx.delete(sandboxAdmissionRequests).where(eq(sandboxAdmissionRequests.bindingId, item.bindingId));
        await tx.delete(sandboxBindings).where(eq(sandboxBindings.id, item.bindingId));
      }
      for (const kind of kinds) await tx.delete(projects).where(eq(projects.id, plan.config.cases[kind].projectId));
    });
    for (const kind of kinds) {
      const path = plan.config.cases[kind].canaryPath;
      if (listed.includes(`${kind}.canary`)) await unlink(path);
    }
    if (listed.length) {
      await unlink(join(plan.directory, "plan.json"));
      await rmdir(plan.directory);
    }
    return this.receipt(plan, "cleaned");
  }
}
