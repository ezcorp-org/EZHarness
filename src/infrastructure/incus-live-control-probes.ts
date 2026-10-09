import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { createHash, X509Certificate } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { sandboxPresetDigest, type SandboxPreset } from "@ezcorp/extension-contract";
import { getDb, type Database } from "../db/connection";
import { projects, sandboxBindings, sandboxHostCapacities, sandboxOperations,
  sandboxProjectQuotas, sandboxReservations } from "../db/schema";
import { releaseRows } from "../db/queries/extension-releases";
import { SandboxAdmissionStore } from "../sandboxes/admission";
import { IncusFeatureService } from "./incus-feature-service";
import { IncusQualificationStore, type IncusImageReceipt, type IncusQualificationScope } from "./incus-qualification";
import { HostIncusLifecycleTransport } from "./incus-transport/lifecycle";
import { HostIncusLiveReadback, type LiveReadbackContext } from "./incus-transport/live-readback";
import { ProviderConnectionStore } from "./provider-connections/store";

export type IncusControlDenial = "unsupported" | "missingControl" | "drift" | "unqualified";

export interface IncusControlCase {
  /** Exact user project reserved for this operator probe. */
  projectId: string;
  /** Required only for admission controls; must have no reservation or backend instance. */
  bindingId?: string;
  /** Existing, operator-owned, regular file on AMD. Each case uses a different file. */
  canaryPath: string;
}

export interface IncusControlProbeConfig {
  cases: Record<IncusControlDenial, IncusControlCase>;
  /** A declared preset on the active release that has no live qualification. */
  unqualifiedPresetId: string;
}

interface Snapshot {
  reservationIds: string[];
  operationIds: string[];
  backendIds: string[];
  canaryIdentity: string;
  canaryBytes: Uint8Array;
}

interface ProbeDependencies {
  db?: Database;
  qualifications?: IncusQualificationStore;
  inventory?: (context: LiveReadbackContext) => Promise<string[]>;
  backendImage?: (context: LiveReadbackContext) => Promise<void>;
  inventoryTransport?: Pick<HostIncusLifecycleTransport, "request">;
  readback?: Pick<HostIncusLiveReadback, "image">;
  feature?: IncusFeatureService;
  admission?: SandboxAdmissionStore;
  /** Test seam; production always re-reads the approved release and setup. */
  context?: (scope: IncusQualificationScope) => Promise<LiveReadbackContext>;
}

function unavailable(reason: string): never {
  throw new Error(`Incus control probe unavailable: ${reason}`);
}

function exactDenial(error: unknown, expected: string, code: string): string {
  if (!(error instanceof Error) || error.message !== expected) unavailable(`${code} was not denied by the expected production policy`);
  return code;
}

async function localCanary(path: string): Promise<Uint8Array> {
  if (!path.startsWith("/") || await realpath(path) !== path) unavailable("AMD canary path is not canonical");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 64 * 1024) unavailable("AMD canary is not a bounded regular file");
    return new Uint8Array(await file.readFile());
  } finally {
    await file.close();
  }
}

export function createIncusControlInventoryTransport(context: LiveReadbackContext,
  db: Database): HostIncusLifecycleTransport {
  const { scope, connection, preset, presetDigest, effectiveSettingsDigest, recipe } = context;
  return new HostIncusLifecycleTransport(new ProviderConnectionStore(db), {
    providerInstallationId: scope.installationId, providerReleaseId: scope.releaseId,
    revision: connection.revision,
    approvedPreset: { profile: preset.profile, incusProfile: recipe.profile.name,
      presetId: preset.id, presetDigest, effectiveSettingsDigest,
      imageFingerprint: preset.imageDigest, limits: preset.limits },
  });
}

export async function listIncusControlBackendInventory(context: LiveReadbackContext, db: Database,
  transport: Pick<HostIncusLifecycleTransport, "request"> = createIncusControlInventoryTransport(context, db)): Promise<string[]> {
  const certificate = new X509Certificate(context.connection.serverCertificatePem);
  return listIncusControlInventory(context, transport,
    createHash("sha256").update(certificate.raw).digest("hex"));
}

/** Read every page of the protected, connection-scoped Incus inventory. */
export async function listIncusControlInventory(context: LiveReadbackContext,
  transport: Pick<HostIncusLifecycleTransport, "request">,
  certificateSha256: string): Promise<string[]> {
  const { scope, connection, preset, presetDigest, effectiveSettingsDigest } = context;
  const ids: string[] = [];
  let cursor: { connectionId: string; afterSandboxId: string } | undefined;
  for (let page = 0; page < 100; page++) {
    const result = await transport.request({
      action: "instance.list", connectionId: scope.connectionId, deadlineMs: Date.now() + 30_000,
      pins: { connectionId: scope.connectionId,
        serverCertificateSha256: certificateSha256,
        project: connection.project, profile: connection.configuration.profile,
        helperVersion: connection.configuration.helperVersion, guestUser: connection.configuration.guestUser },
      tags: { managedBy: "ezharness-incus-sandbox", connectionId: scope.connectionId },
      payload: { providerId: "incus", profile: preset.profile, presetId: preset.id,
        presetDigest, effectiveSettingsDigest, allocate: false, limit: 100,
        ...(cursor ? { cursor } : {}) },
    }) as { ok?: unknown; sandboxes?: Array<{ sandboxId: string }>; nextCursor?: unknown };
    if (result.ok !== true || !Array.isArray(result.sandboxes)) unavailable("scoped Incus inventory is invalid");
    for (const item of result.sandboxes) {
      if (!item || typeof item.sandboxId !== "string") unavailable("scoped Incus identity is invalid");
      ids.push(item.sandboxId);
    }
    if (!result.nextCursor) return ids;
    const next = result.nextCursor as Record<string, unknown>;
    if (next.connectionId !== scope.connectionId || typeof next.afterSandboxId !== "string") {
      unavailable("scoped Incus inventory cursor is invalid");
    }
    cursor = { connectionId: scope.connectionId, afterSandboxId: next.afterSandboxId };
  }
  return unavailable("scoped Incus inventory exceeds bounded pages");
}

/** Operator-owned negative probes. Configuration is exact and absent by default. */
export class IncusLiveControlProbes {
  private readonly db: Database;
  private readonly qualifications: IncusQualificationStore;
  private readonly inventory: NonNullable<ProbeDependencies["inventory"]>;
  private readonly backendImage: NonNullable<ProbeDependencies["backendImage"]>;
  private readonly inventoryTransport?: ProbeDependencies["inventoryTransport"];
  private readonly readback: Pick<HostIncusLiveReadback, "image">;
  private readonly feature: IncusFeatureService;
  private readonly admission: SandboxAdmissionStore;
  private readonly contextOverride?: ProbeDependencies["context"];

  constructor(private readonly config: IncusControlProbeConfig, deps: ProbeDependencies = {}) {
    this.db = deps.db ?? getDb();
    this.qualifications = deps.qualifications ?? new IncusQualificationStore({ db: this.db });
    this.inventoryTransport = deps.inventoryTransport;
    this.readback = deps.readback ?? new HostIncusLiveReadback(new ProviderConnectionStore(this.db));
    this.inventory = deps.inventory ?? this.listInventory.bind(this);
    this.backendImage = deps.backendImage ?? this.readBackendImage.bind(this);
    this.feature = deps.feature ?? new IncusFeatureService({ db: this.db,
      loadQualification: this.qualifications.load.bind(this.qualifications) });
    this.admission = deps.admission ?? new SandboxAdmissionStore(this.db);
    this.contextOverride = deps.context;
    const cases = Object.values(config.cases);
    if (cases.length !== 4 || cases.some(item => !item?.projectId || !item.canaryPath)
      || new Set(cases.map(item => item.canaryPath)).size !== 4
      || !config.unqualifiedPresetId) unavailable("four distinct operator controls are required");
  }

  private listInventory(context: LiveReadbackContext): Promise<string[]> {
    return listIncusControlBackendInventory(context, this.db, this.inventoryTransport
      ?? createIncusControlInventoryTransport(context, this.db));
  }

  private async readBackendImage(context: LiveReadbackContext): Promise<void> {
    await this.readback.image(context);
  }

  private async context(scope: IncusQualificationScope): Promise<LiveReadbackContext> {
    if (this.contextOverride) return this.contextOverride(scope);
    const selected = await this.qualifications.authorizeFixture(scope);
    const [setup] = releaseRows<IncusImageReceipt>(await this.db.execute(sql`SELECT
      provider_release_id AS "providerReleaseId", provider_release_digest AS "providerReleaseDigest",
      connection_id AS "connectionId", connection_revision AS "connectionRevision", state, recipe
      FROM incus_operator_setups WHERE provider_installation_id = ${scope.installationId}
      ORDER BY created_at DESC, id DESC LIMIT 1`));
    if (setup?.state !== "verified" || setup.providerReleaseId !== scope.releaseId
      || setup.connectionId !== scope.connectionId || setup.connectionRevision !== selected.connection.revision
      || setup.recipe.guestImage?.fingerprint !== selected.preset.imageDigest) unavailable("reviewed setup changed");
    return { scope, connection: selected.connection, preset: selected.preset,
      presetDigest: selected.presetDigest, effectiveSettingsDigest: selected.effectiveSettingsDigest,
      recipe: setup.recipe };
  }

  private async control(kind: IncusControlDenial, scope: IncusQualificationScope) {
    const item = this.config.cases[kind];
    if (!item) unavailable("control case is missing");
    const [project] = await this.db.select({ purpose: projects.purpose }).from(projects)
      .where(eq(projects.id, item.projectId)).limit(1);
    if (project?.purpose !== "user") unavailable("control project is not a user project");
    if (item.bindingId) {
      const [binding] = await this.db.select().from(sandboxBindings)
        .where(eq(sandboxBindings.id, item.bindingId)).limit(1);
      if (!binding || binding.projectId !== item.projectId
        || binding.providerInstallationId !== scope.installationId
        || binding.providerReleaseId !== scope.releaseId
        || binding.connectionId !== scope.connectionId
        || binding.presetId !== scope.presetId || binding.tombstonedAt) {
        unavailable("control binding is not scoped to the reviewed release");
      }
      return { item, binding };
    }
    return { item, binding: null };
  }

  async snapshot(kind: IncusControlDenial, scope: IncusQualificationScope): Promise<Snapshot> {
    const { item } = await this.control(kind, scope);
    const context = await this.context(scope);
    const [reservations, operations, backendIds, canaryBytes] = await Promise.all([
      this.db.select({ bindingId: sandboxReservations.bindingId }).from(sandboxReservations)
        .where(and(eq(sandboxReservations.providerInstallationId, scope.installationId),
          eq(sandboxReservations.connectionId, scope.connectionId))),
      this.db.select({ id: sandboxOperations.id }).from(sandboxOperations).innerJoin(sandboxBindings,
        eq(sandboxOperations.bindingId, sandboxBindings.id))
        .where(and(eq(sandboxBindings.providerInstallationId, scope.installationId),
          eq(sandboxBindings.connectionId, scope.connectionId))),
      this.inventory(context), localCanary(item.canaryPath),
    ]);
    return { reservationIds: reservations.map((row: { bindingId: string }) => row.bindingId),
      operationIds: operations.map((row: { id: string }) => row.id), backendIds,
      canaryIdentity: item.canaryPath, canaryBytes };
  }

  async attempt(kind: IncusControlDenial, scope: IncusQualificationScope, preset: SandboxPreset): Promise<string> {
    const { item, binding } = await this.control(kind, scope);
    const context = await this.context(scope);
    if (preset.id !== context.preset.id || await sandboxPresetDigest(preset) !== context.presetDigest) {
      unavailable("control preset changed");
    }
    if (kind === "unsupported") {
      const unsupportedId = "operator-probe-unsupported-preset";
      if (context.preset.id === unsupportedId) unavailable("unsupported control name collides with a preset");
      try {
        await this.feature.prepare({ projectId: item.projectId, installationId: scope.installationId,
          connectionId: scope.connectionId, presetId: unsupportedId });
      } catch (error) { return exactDenial(error, "Approved Incus preset is unavailable", "DENIED_UNSUPPORTED"); }
      return unavailable("unsupported preset allocated a feature binding");
    }
    if (kind === "unqualified") {
      if (this.config.unqualifiedPresetId === scope.presetId) unavailable("unqualified control uses the qualified preset");
      if (await this.qualifications.load({ ...scope, presetId: this.config.unqualifiedPresetId })) {
        unavailable("unqualified control has live evidence");
      }
      try {
        await this.feature.prepare({ projectId: item.projectId, installationId: scope.installationId,
          connectionId: scope.connectionId, presetId: this.config.unqualifiedPresetId });
      } catch (error) { return exactDenial(error, "Live Incus preset qualification is unavailable", "DENIED_UNQUALIFIED"); }
      return unavailable("unqualified preset allocated a feature binding");
    }
    if (!binding || await this.admission.getReservation(binding.id)) unavailable("control binding has a reservation");
    if ((await this.inventory(context)).includes(binding.id)) unavailable("control binding has a backend instance");
    const resources = { memoryBytes: preset.limits.memoryBytes, cpuMillicores: preset.limits.cpuMillis,
      pids: preset.limits.pids, diskBytes: preset.limits.diskBytes, executionSlots: 1 };
    if (kind === "missingControl") {
      const [host] = await this.db.select().from(sandboxHostCapacities).where(and(
        eq(sandboxHostCapacities.providerInstallationId, scope.installationId),
        eq(sandboxHostCapacities.connectionId, scope.connectionId))).limit(1);
      const [quota] = await this.db.select().from(sandboxProjectQuotas)
        .where(eq(sandboxProjectQuotas.projectId, item.projectId)).limit(1);
      if (!host || quota) unavailable("missing quota control prerequisites changed");
      const result = await this.admission.requestAdmission({ bindingId: binding.id,
        generation: binding.generation, kind: "CREATE", idempotencyScope: "incus-control-probe",
        idempotencyKey: `missing-control-${crypto.randomUUID()}`, resources });
      if (result.state !== "REJECTED" || result.reason !== "PROJECT_QUOTA_NOT_CONFIGURED") {
        unavailable("admission did not reject the missing quota");
      }
      return "DENIED_CONTROL";
    }
    // An actual stale generation must be rejected by admission. Independently,
    // the pinned backend image readback must reject an alias absent on Incus.
    const result = await this.admission.requestAdmission({ bindingId: binding.id,
      generation: binding.generation + 1, kind: "CREATE", idempotencyScope: "incus-control-probe",
      idempotencyKey: `drift-${crypto.randomUUID()}`, resources });
    if (result.state !== "REJECTED" || result.reason !== "STALE_GENERATION") {
      unavailable("admission did not reject stale generation");
    }
    if (!context.recipe.guestImage) unavailable("reviewed image is unavailable");
    const drifted: LiveReadbackContext = { ...context, recipe: { ...context.recipe,
      guestImage: { ...context.recipe.guestImage, alias: `ezh-probe-absent-${crypto.randomUUID()}` } } };
    try { await this.backendImage(drifted); }
    catch (error) {
      if (error instanceof Error && error.message.includes("backend image fingerprint, type, or alias changed")) {
        return "DENIED_DRIFT";
      }
      throw error;
    }
    return unavailable("backend accepted an unreviewed image alias");
  }
}
