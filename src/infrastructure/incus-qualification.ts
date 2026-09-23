import { createHash, X509Certificate } from "node:crypto";
import {
  sandboxPresetDigest,
  validateLiveSandboxPresetQualification,
  type LiveSandboxPresetQualification,
  type LiveSandboxQualificationResult,
  type SandboxCompatibilityObservation,
  type SandboxPreset,
} from "@ezcorp/extension-contract";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, type Database, type DbTransaction } from "../db/connection";
import { incusQualificationFixtures, projectWorkspaceBindings, projects, sandboxAdmissionRequests,
  sandboxBindings, sandboxOperations, sandboxProjectQuotas, sandboxReservations,
  type SandboxOperation } from "../db/schema";
import { releaseRows } from "../db/queries/extension-releases";
import { getReleaseRuntime, resolveActiveRelease, type ActiveExtensionRelease } from "../extensions/release-process";
import { digest } from "../../scripts/incus/model";
import type { IncusSetupRecipe } from "../../scripts/incus/model";
import { GUEST_HELPER_VERSION, guestHelperSha256 } from "./incus-guest/protocol";
import { HostIncusProbeTransport } from "./incus-transport/transport";
import { SandboxAdmissionStore } from "../sandboxes/admission";
import { SandboxController } from "../sandboxes/controller";
import { IncusSandboxProviderDispatcher } from "../sandboxes/incus-dispatcher";
import { IncusMethodCaller } from "./incus-method-caller";
import { inspectRelease, readIncusProviderGeneration, type IncusFeatureServiceDependencies } from "./incus-feature-service";
import { ProviderConnectionStore, type ProviderConnectionCredentials, type ProviderConnectionScope } from "./provider-connections/store";
import type { IncusProbeResult, IncusTransportRequest } from "../../extensions/incus-sandbox/transport";

export interface IncusQualificationScope {
  installationId: string;
  releaseId: string;
  connectionId: string;
  presetId: string;
}

/** Results must come from an operator-run guest fixture. The store does not
 * provide a synthetic runner or treat a successful HTTP probe as SP04/SP06. */
export interface IncusLiveCaseEvidence {
  observation: SandboxCompatibilityObservation;
  observedProfile: string;
  observedImageDigest: string;
  observedHelperDigest: string;
  verifiedAt: string;
  validUntil: string;
  cases: LiveSandboxQualificationResult[];
}

export interface IncusQualificationDependencies {
  db?: Database;
  activeRelease?: (installationId: string) => Promise<ActiveExtensionRelease>;
  resolveConnection?: (scope: ProviderConnectionScope) => Promise<ProviderConnectionCredentials>;
  connectionRevision?: (connectionId: string) => Promise<number | null>;
  imageReceipt?: (installationId: string) => Promise<IncusImageReceipt | null>;
  /** Read-only host transport observation, never a synthetic readiness verdict. */
  probe?: (scope: IncusQualificationScope, connection: ProviderConnectionCredentials,
    preset: SandboxPreset, presetDigest: string, effectiveSettingsDigest: string) => Promise<IncusProbeResult>;
  /** Must execute all eight live SP cases against a real guest. No default. */
  runLiveCases?: (scope: IncusQualificationScope, preset: SandboxPreset) => Promise<IncusLiveCaseEvidence>;
  now?: () => number;
}

export interface IncusImageReceipt {
  providerReleaseId: string;
  providerReleaseDigest: string;
  connectionId: string;
  connectionRevision: number;
  state: string;
  recipe: IncusSetupRecipe;
}

interface QualificationRow {
  installationId: string;
  releaseId: string;
  releaseDigest: string;
  connectionId: string;
  connectionRevision: number;
  presetId: string;
  presetDigest: string;
  effectiveSettingsDigest: string;
  profile: string;
  imageDigest: string;
  helperDigest: string;
  probeObservation: unknown;
  liveObservation: unknown;
  qualification: unknown;
  verifiedAt: string | Date;
  validUntil: string | Date;
}

const columns = sql`installation_id AS "installationId", release_id AS "releaseId", release_digest AS "releaseDigest",
  connection_id AS "connectionId", connection_revision AS "connectionRevision", preset_id AS "presetId",
  preset_digest AS "presetDigest", effective_settings_digest AS "effectiveSettingsDigest", profile,
  image_digest AS "imageDigest", helper_digest AS "helperDigest", probe_observation AS "probeObservation",
  live_observation AS "liveObservation",
  qualification, verified_at AS "verifiedAt", valid_until AS "validUntil"`;

async function latestImageReceipt(db: Database, installationId: string): Promise<IncusImageReceipt | null> {
  const [row] = releaseRows<IncusImageReceipt>(await db.execute(sql`SELECT
    provider_release_id AS "providerReleaseId", provider_release_digest AS "providerReleaseDigest",
    connection_id AS "connectionId", connection_revision AS "connectionRevision", state, recipe
    FROM incus_operator_setups WHERE provider_installation_id = ${installationId}
    ORDER BY created_at DESC, id DESC LIMIT 1`));
  return row ?? null;
}

function publishedImage(receipt: IncusImageReceipt | null, scope: IncusQualificationScope,
  releaseDigest: string, revision: number, preset: SandboxPreset, helperDigest: string,
  backendProfile: string): boolean {
  const image = receipt?.recipe?.guestImage;
  const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  return receipt?.state === "verified" && receipt.providerReleaseId === scope.releaseId
    && receipt.providerReleaseDigest === releaseDigest && receipt.connectionId === scope.connectionId
    && receipt.connectionRevision === revision && receipt.recipe.profile?.name === backendProfile
    && !!image && sha(image.fingerprint) && image.fingerprint === preset.imageDigest
    && sha(image.sourceFingerprint) && sha(image.helperSha256) && image.helperSha256 === helperDigest
    && sha(image.dockerArchiveSha256) && sha(image.composeSha256)
    && typeof image.pythonPackageVersion === "string" && image.pythonPackageVersion.length > 0
    && typeof image.alias === "string" && image.alias.length > 0 && image.user === "sandbox";
}

function certificateDigest(pem: string): string {
  return createHash("sha256").update(new X509Certificate(pem).raw).digest("hex");
}

async function probeHost(db: Database, scope: IncusQualificationScope, connection: ProviderConnectionCredentials,
  preset: SandboxPreset, presetDigest: string, effectiveSettingsDigest: string): Promise<IncusProbeResult> {
  const pins = { connectionId: scope.connectionId, serverCertificateSha256: certificateDigest(connection.serverCertificatePem),
    project: connection.project, profile: connection.configuration.profile,
    helperVersion: connection.configuration.helperVersion, guestUser: connection.configuration.guestUser };
  const command: IncusTransportRequest = {
    action: "probe", connectionId: scope.connectionId, deadlineMs: Date.now() + 30_000,
    pins, tags: { managedBy: "ezharness-incus-sandbox", connectionId: scope.connectionId },
    payload: { providerId: "incus", profile: preset.profile, presetId: preset.id,
      presetDigest, effectiveSettingsDigest, allocate: false },
  };
  return new HostIncusProbeTransport(new ProviderConnectionStore(db), {
    providerInstallationId: scope.installationId, providerReleaseId: scope.releaseId,
    revision: connection.revision,
  }).request(command);
}

function compatible(preset: SandboxPreset, observation: SandboxCompatibilityObservation): boolean {
  const required = preset.requirements;
  return required.backendApis.includes(observation.backendApi)
    && required.architectures.includes(observation.architecture)
    && required.storageDrivers.includes(observation.storageDriver)
    && required.isolation.includes(observation.isolation)
    && (!required.nestedCompose || observation.nestedCompose);
}

/** Persist only after a real provider preflight and host live-case runner pass.
 * Every load re-resolves the active release and exact connection revision. */
export class IncusQualificationStore {
  private readonly db: Database;
  private readonly activeRelease: NonNullable<IncusQualificationDependencies["activeRelease"]>;
  private readonly resolveConnection: NonNullable<IncusQualificationDependencies["resolveConnection"]>;
  private readonly connectionRevision: NonNullable<IncusQualificationDependencies["connectionRevision"]>;
  private readonly imageReceipt: NonNullable<IncusQualificationDependencies["imageReceipt"]>;
  private readonly probe: NonNullable<IncusQualificationDependencies["probe"]>;
  private readonly now: () => number;

  constructor(private readonly deps: IncusQualificationDependencies = {}) {
    this.db = deps.db ?? getDb();
    this.activeRelease = deps.activeRelease ?? (id => resolveActiveRelease(id, getReleaseRuntime()));
    this.resolveConnection = deps.resolveConnection ?? (scope => new ProviderConnectionStore(this.db).resolveForHost(scope));
    this.connectionRevision = deps.connectionRevision ?? (async id => (await new ProviderConnectionStore(this.db).getMetadata(id))?.revision ?? null);
    this.imageReceipt = deps.imageReceipt ?? (id => latestImageReceipt(this.db, id));
    this.probe = deps.probe ?? ((...args) => probeHost(this.db, ...args));
    this.now = deps.now ?? Date.now;
  }

  private async current(scope: IncusQualificationScope): Promise<{
    snapshot: ActiveExtensionRelease; connection: ProviderConnectionCredentials;
    preset: SandboxPreset; presetDigest: string; effectiveSettingsDigest: string; helperDigest: string;
  }> {
    const snapshot = await this.activeRelease(scope.installationId);
    if (snapshot.installation.id !== scope.installationId || snapshot.release.id !== scope.releaseId
      || snapshot.installation.activeReleaseId !== scope.releaseId) throw new Error("Incus qualification release is unavailable");
    const provider = snapshot.release.manifest.sandboxProviders?.find(item => item.kind === "sandbox" && item.id === "incus");
    const preset = provider?.presets.find(item => item.id === scope.presetId);
    if (!preset || provider?.protocolMajor !== 1) throw new Error("Incus qualification preset is unavailable");
    const revision = await this.connectionRevision(scope.connectionId);
    if (!revision || !Number.isSafeInteger(revision)) throw new Error("Incus qualification connection is unavailable");
    const connection = await this.resolveConnection({ connectionId: scope.connectionId,
      providerInstallationId: scope.installationId, providerReleaseId: scope.releaseId, revision });
    if (connection.id !== scope.connectionId || connection.revision !== revision || connection.revokedAt
      || connection.providerInstallationId !== scope.installationId || connection.providerReleaseId !== scope.releaseId
      || connection.configuration.kind !== "incus"
      || connection.configuration.helperVersion !== GUEST_HELPER_VERSION || connection.configuration.guestUser !== "sandbox") {
      throw new Error("Incus qualification connection changed");
    }
    const helperDigest = guestHelperSha256();
    if (!preset.helperDigests.includes(helperDigest)) throw new Error("Incus qualification helper is unavailable");
    const receipt = await this.imageReceipt(scope.installationId);
    if (!publishedImage(receipt, scope, snapshot.release.releaseDigest, revision, preset,
      helperDigest, connection.configuration.profile)) throw new Error("Incus qualification image is unpublished");
    const presetDigest = await sandboxPresetDigest(preset);
    return { snapshot, connection, preset, presetDigest,
      effectiveSettingsDigest: digest({ presetDigest, connectionRevision: revision }), helperDigest };
  }

  /** Host fixture code reuses the exact release, connection and image gate. */
  async authorizeFixture(scope: IncusQualificationScope): ReturnType<IncusQualificationStore["current"]> {
    return this.current(scope);
  }

  async recordVerified(scope: IncusQualificationScope): Promise<LiveSandboxPresetQualification> {
    if (!this.deps.runLiveCases) throw new Error("Live Incus qualification runner is unavailable");
    const selected = await this.current(scope);
    const probe = await this.probe(scope, selected.connection, selected.preset,
      selected.presetDigest, selected.effectiveSettingsDigest);
    if (probe.serverCertificateSha256 !== certificateDigest(selected.connection.serverCertificatePem)
      || probe.project !== selected.connection.project || probe.profile !== selected.connection.configuration.profile
      || probe.backendApi === "unverified" || !probe.backendVersion
      || !selected.preset.requirements.backendApis.includes(probe.backendApi)
      || !selected.preset.requirements.architectures.includes(probe.architecture)) {
      throw new Error("Live Incus backend probe is incompatible");
    }
    const cases = await this.deps.runLiveCases(scope, selected.preset);
    const afterCases = await this.current(scope);
    if (afterCases.snapshot.release.releaseDigest !== selected.snapshot.release.releaseDigest
      || afterCases.connection.revision !== selected.connection.revision
      || afterCases.presetDigest !== selected.presetDigest
      || afterCases.effectiveSettingsDigest !== selected.effectiveSettingsDigest) {
      throw new Error("Incus qualification changed during live cases");
    }
    if (cases.observedProfile !== selected.preset.profile
      || cases.observedImageDigest !== selected.preset.imageDigest
      || cases.observedHelperDigest !== selected.helperDigest
      || !compatible(selected.preset, cases.observation)
      || cases.observation.backendApi !== probe.backendApi
      || cases.observation.backendVersion !== probe.backendVersion
      || cases.observation.architecture !== probe.architecture) {
      throw new Error("Live Incus artifact observation changed");
    }
    const qualification: LiveSandboxPresetQualification = {
      producer: "live-provider", connectionId: scope.connectionId, providerId: "incus",
      presetId: scope.presetId, profile: selected.preset.profile,
      releaseDigest: selected.snapshot.release.releaseDigest, presetDigest: selected.presetDigest,
      effectiveSettingsDigest: selected.effectiveSettingsDigest,
      backendVersion: probe.backendVersion,
      verifiedAt: cases.verifiedAt, validUntil: cases.validUntil, cases: cases.cases,
    };
    await validateLiveSandboxPresetQualification(selected.preset, qualification, {
      providerId: "incus", releaseDigest: selected.snapshot.release.releaseDigest,
      connectionId: scope.connectionId, effectiveSettingsDigest: selected.effectiveSettingsDigest,
      now: this.now(),
    });
    await this.db.execute(sql`INSERT INTO incus_live_qualifications (
      installation_id, release_id, release_digest, connection_id, connection_revision,
      preset_id, preset_digest, effective_settings_digest, profile, image_digest,
      helper_digest, probe_observation, live_observation, qualification, verified_at, valid_until
    ) VALUES (${scope.installationId}, ${scope.releaseId}, ${selected.snapshot.release.releaseDigest},
      ${scope.connectionId}, ${selected.connection.revision}, ${scope.presetId}, ${selected.presetDigest},
      ${selected.effectiveSettingsDigest}, ${selected.preset.profile}, ${selected.preset.imageDigest},
      ${selected.helperDigest}, ${JSON.stringify(probe)}::jsonb, ${JSON.stringify(cases.observation)}::jsonb,
      ${JSON.stringify(qualification)}::jsonb,
      ${new Date(cases.verifiedAt)}, ${new Date(cases.validUntil)})
    ON CONFLICT (installation_id, connection_id, preset_id) DO UPDATE SET
      release_id = EXCLUDED.release_id, release_digest = EXCLUDED.release_digest,
      connection_revision = EXCLUDED.connection_revision, preset_digest = EXCLUDED.preset_digest,
      effective_settings_digest = EXCLUDED.effective_settings_digest, profile = EXCLUDED.profile,
      image_digest = EXCLUDED.image_digest, helper_digest = EXCLUDED.helper_digest,
      probe_observation = EXCLUDED.probe_observation, live_observation = EXCLUDED.live_observation,
      qualification = EXCLUDED.qualification,
      verified_at = EXCLUDED.verified_at, valid_until = EXCLUDED.valid_until, updated_at = NOW()`);
    return qualification;
  }

  async load(scope: IncusQualificationScope): Promise<LiveSandboxPresetQualification | null> {
    try {
      const [row] = releaseRows<QualificationRow>(await this.db.execute(sql`SELECT ${columns}
        FROM incus_live_qualifications WHERE installation_id = ${scope.installationId}
          AND connection_id = ${scope.connectionId} AND preset_id = ${scope.presetId}`));
      if (!row || row.releaseId !== scope.releaseId
        || new Date(row.validUntil).getTime() <= this.now()) return null;
      const selected = await this.current(scope);
      if (row.releaseDigest !== selected.snapshot.release.releaseDigest
        || row.connectionRevision !== selected.connection.revision
        || row.presetDigest !== selected.presetDigest || row.effectiveSettingsDigest !== selected.effectiveSettingsDigest
        || row.profile !== selected.preset.profile || row.imageDigest !== selected.preset.imageDigest
        || row.helperDigest !== selected.helperDigest) return null;
      const probe = row.probeObservation as IncusProbeResult;
      const observation = row.liveObservation as SandboxCompatibilityObservation;
      if (!probe || probe.serverCertificateSha256 !== certificateDigest(selected.connection.serverCertificatePem)
        || probe.project !== selected.connection.project || probe.profile !== selected.connection.configuration.profile
        || probe.backendApi !== observation?.backendApi || probe.backendVersion !== observation?.backendVersion
        || probe.architecture !== observation?.architecture || !compatible(selected.preset, observation)
        || probe.backendVersion !== (row.qualification as LiveSandboxPresetQualification)?.backendVersion) return null;
      return await validateLiveSandboxPresetQualification(selected.preset, row.qualification, {
        providerId: "incus", releaseDigest: selected.snapshot.release.releaseDigest,
        connectionId: scope.connectionId, effectiveSettingsDigest: selected.effectiveSettingsDigest,
        now: this.now(),
      });
    } catch {
      return null;
    }
  }
}

export interface IncusQualificationFixtureDependencies {
  db?: Database;
  qualifications?: IncusQualificationStore;
  admission?: SandboxAdmissionStore;
  controller?: SandboxController;
  inspect?: IncusFeatureServiceDependencies["inspect"];
  now?: () => number;
}

function uniqueViolation(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4; depth++) {
    if (!current || typeof current !== "object") return false;
    if ("code" in current && current.code === "23505") return true;
    current = "cause" in current ? current.cause : null;
  }
  return false;
}

/** Dedicated host fixture path. It creates no user workspace binding and does
 * not relax IncusFeatureService's live-qualification requirement. */
export class IncusQualificationFixtureService {
  private readonly db: Database;
  private readonly qualifications: IncusQualificationStore;
  private readonly admission: SandboxAdmissionStore;
  private readonly controller: SandboxController;
  private readonly inspect: NonNullable<IncusFeatureServiceDependencies["inspect"]>;
  private readonly now: () => number;
  private readonly fixtureLocks = new Map<string, Promise<void>>();

  constructor(deps: IncusQualificationFixtureDependencies = {}) {
    this.db = deps.db ?? getDb();
    this.qualifications = deps.qualifications ?? new IncusQualificationStore({ db: this.db });
    this.admission = deps.admission ?? new SandboxAdmissionStore(this.db);
    this.controller = deps.controller ?? new SandboxController(this.db,
      new IncusSandboxProviderDispatcher(new IncusMethodCaller()));
    this.inspect = deps.inspect ?? inspectRelease;
    this.now = deps.now ?? Date.now;
  }

  private async fixture(operationId: string) {
    const [row] = await this.db.select().from(incusQualificationFixtures)
      .where(eq(incusQualificationFixtures.operationId, operationId)).limit(1);
    return row ?? null;
  }

  private async ownedFixture(scope: IncusQualificationScope, operationId: string) {
    const row = await this.fixture(operationId);
    if (!row || row.installationId !== scope.installationId || row.releaseId !== scope.releaseId
      || row.connectionId !== scope.connectionId || row.presetId !== scope.presetId) {
      throw new Error("Incus qualification fixture is unavailable");
    }
    const [project] = await this.db.select({ purpose: projects.purpose }).from(projects)
      .where(eq(projects.id, row.projectId)).limit(1);
    const binding = await this.controller.getBinding(row.bindingId);
    if (project?.purpose !== "incus-qualification" || !binding || binding.projectId !== row.projectId
      || binding.resourceKey !== row.bindingId || binding.providerInstallationId !== row.installationId
      || binding.providerReleaseId !== row.releaseId || binding.connectionId !== row.connectionId
      || binding.connectionRevision !== row.connectionRevision || binding.presetId !== row.presetId
      || binding.presetDigest !== row.presetDigest
      || binding.effectiveSettingsDigest !== row.effectiveSettingsDigest) {
      throw new Error("Incus qualification fixture binding changed");
    }
    return { row, binding };
  }

  /** Read only the durable state owned by this exact operator fixture. */
  async status(scope: IncusQualificationScope, operationId: string) {
    const { row, binding } = await this.ownedFixture(scope, operationId);
    const [operation] = await this.db.select({ id: sandboxOperations.id, kind: sandboxOperations.kind,
      state: sandboxOperations.state, generation: sandboxOperations.generation,
      providerOperationId: sandboxOperations.providerOperationId, errorCode: sandboxOperations.errorCode,
      createdAt: sandboxOperations.createdAt, updatedAt: sandboxOperations.updatedAt })
      .from(sandboxOperations).where(eq(sandboxOperations.bindingId, row.bindingId))
      .orderBy(desc(sandboxOperations.createdAt), desc(sandboxOperations.id)).limit(1);
    return { fixture: { operationId: row.operationId, installationId: row.installationId,
      releaseId: row.releaseId, connectionId: row.connectionId, connectionRevision: row.connectionRevision,
      presetId: row.presetId, projectId: row.projectId, bindingId: row.bindingId },
      binding: { id: binding.id, generation: binding.generation, desiredState: binding.desiredState,
        observedState: binding.observedState }, operation: operation ?? null };
  }

  private assertFixture(row: NonNullable<Awaited<ReturnType<IncusQualificationFixtureService["fixture"]>>>,
    scope: IncusQualificationScope, revision: number, presetDigest: string, settingsDigest: string): void {
    if (row.installationId !== scope.installationId || row.releaseId !== scope.releaseId
      || row.connectionId !== scope.connectionId || row.connectionRevision !== revision
      || row.presetId !== scope.presetId || row.presetDigest !== presetDigest
      || row.effectiveSettingsDigest !== settingsDigest) {
      throw new Error("Incus qualification fixture operation changed scope");
    }
  }

  private async withFixtureLock<T>(operationId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.fixtureLocks.get(operationId);
    let release = () => {};
    const current = new Promise<void>(resolve => { release = resolve; });
    this.fixtureLocks.set(operationId, current);
    if (previous) await previous;
    try { return await action(); }
    finally {
      release();
      if (this.fixtureLocks.get(operationId) === current) this.fixtureLocks.delete(operationId);
    }
  }

  async create(scope: IncusQualificationScope, operationId: string): Promise<SandboxOperation> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(operationId)) {
      throw new Error("Invalid Incus qualification fixture operation ID");
    }
    return this.withFixtureLock(operationId, () => this.createLocked(scope, operationId));
  }

  private async createLocked(scope: IncusQualificationScope, operationId: string): Promise<SandboxOperation> {
    const selected = await this.qualifications.authorizeFixture(scope);
    const identity = createHash("sha256").update(JSON.stringify([scope, operationId])).digest("hex");
    const projectId = `incus-qual-project-${identity}`;
    const bindingId = `incus-qual-binding-${identity}`;
    let row = await this.fixture(operationId);
    if (!row) {
      try {
        await this.db.transaction(async (tx: DbTransaction) => {
          await tx.insert(projects).values({ id: projectId, name: projectId, purpose: "incus-qualification",
            path: `/__incus_qualification__/${identity}` });
          await tx.insert(sandboxBindings).values({ id: bindingId, projectId,
            providerInstallationId: scope.installationId, providerReleaseId: scope.releaseId,
            connectionId: scope.connectionId, connectionRevision: selected.connection.revision,
            resourceKey: bindingId, profile: selected.preset.profile, presetId: scope.presetId,
            presetDigest: selected.presetDigest, effectiveSettingsDigest: selected.effectiveSettingsDigest,
            desiredState: "STOPPED", observedState: "UNKNOWN" });
          await tx.insert(incusQualificationFixtures).values({ operationId, projectId, bindingId,
            installationId: scope.installationId, releaseId: scope.releaseId,
            connectionId: scope.connectionId, connectionRevision: selected.connection.revision,
            presetId: scope.presetId, presetDigest: selected.presetDigest,
            effectiveSettingsDigest: selected.effectiveSettingsDigest });
        });
      } catch (error) {
        if (!uniqueViolation(error)) throw error;
        row = await this.fixture(operationId);
        if (!row) throw error;
      }
      row ??= await this.fixture(operationId);
    }
    if (!row || row.projectId !== projectId || row.bindingId !== bindingId) {
      throw new Error("Incus qualification fixture identity changed");
    }
    this.assertFixture(row, scope, selected.connection.revision,
      selected.presetDigest, selected.effectiveSettingsDigest);
    const resources = { memoryBytes: selected.preset.limits.memoryBytes,
      cpuMillicores: selected.preset.limits.cpuMillis, pids: selected.preset.limits.pids,
      diskBytes: selected.preset.limits.diskBytes, executionSlots: 1 };
    const request = { bindingId, generation: 1, idempotencyScope: "incus-qualification",
      idempotencyKey: operationId };
    try {
      await this.admission.configureProjectQuota({ projectId, providerInstallationId: scope.installationId,
        connectionId: scope.connectionId, limit: resources });
      const admitted = await this.admission.requestAdmission({ ...request, kind: "CREATE", resources });
      if (admitted.state !== "ADMITTED") {
        throw new Error(`Incus qualification fixture admission ${admitted.state}: ${admitted.reason}`);
      }
    } catch (error) {
      try { await this.cancelNeverAdmittedLocked(scope, operationId); }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Incus qualification fixture admission and cleanup failed");
      }
      throw error;
    }
    const operation = await this.controller.requestAndDispatch({ ...request, kind: "CREATE",
      payload: { profile: selected.preset.profile, presetId: scope.presetId,
        presetDigest: selected.presetDigest,
        effectiveSettingsDigest: selected.effectiveSettingsDigest } });
    if (operation.state === "SUCCEEDED" && (await this.controller.getBinding(bindingId))?.observedState === "STOPPED") {
      const intent = `incus-qualification-create-${identity}`;
      await this.admission.markStopIntent(bindingId, 1, intent);
      await this.admission.recordObservedState(bindingId, 1, "STOPPED", intent);
    }
    return operation;
  }

  /** Recover an old failed pre-admission attempt. Any durable effect or
   * reservation keeps the fixture for normal controller reconciliation. */
  async cancelNeverAdmitted(scope: IncusQualificationScope, operationId: string): Promise<boolean> {
    return this.withFixtureLock(operationId, () => this.cancelNeverAdmittedLocked(scope, operationId));
  }

  private async cancelNeverAdmittedLocked(scope: IncusQualificationScope, operationId: string): Promise<boolean> {
    return this.db.transaction(async (tx: DbTransaction) => {
      const [fixture] = await tx.select().from(incusQualificationFixtures)
        .where(eq(incusQualificationFixtures.operationId, operationId)).limit(1).for("update");
      if (!fixture) return false;
      if (fixture.installationId !== scope.installationId || fixture.releaseId !== scope.releaseId
        || fixture.connectionId !== scope.connectionId || fixture.presetId !== scope.presetId) {
        throw new Error("Incus qualification fixture operation changed scope");
      }
      // Admission locks this same binding row before it can persist a reservation.
      // The row lock is the cross-process fence for this recovery path.
      const [binding] = await tx.select().from(sandboxBindings)
        .where(eq(sandboxBindings.id, fixture.bindingId)).limit(1).for("update");
      const [project] = await tx.select().from(projects)
        .where(eq(projects.id, fixture.projectId)).limit(1).for("update");
      if (!binding || !project || project.purpose !== "incus-qualification"
        || binding.projectId !== fixture.projectId || binding.resourceKey !== fixture.bindingId
        || binding.providerInstallationId !== fixture.installationId
        || binding.providerReleaseId !== fixture.releaseId
        || binding.connectionId !== fixture.connectionId
        || binding.connectionRevision !== fixture.connectionRevision
        || binding.presetId !== fixture.presetId || binding.presetDigest !== fixture.presetDigest
        || binding.effectiveSettingsDigest !== fixture.effectiveSettingsDigest) {
        throw new Error("Incus qualification fixture ownership changed");
      }
      const [operation] = await tx.select({ id: sandboxOperations.id }).from(sandboxOperations)
        .where(eq(sandboxOperations.bindingId, fixture.bindingId)).limit(1);
      const [reservation] = await tx.select({ bindingId: sandboxReservations.bindingId }).from(sandboxReservations)
        .where(eq(sandboxReservations.bindingId, fixture.bindingId)).limit(1);
      const [workspace] = await tx.select({ projectId: projectWorkspaceBindings.projectId })
        .from(projectWorkspaceBindings).where(eq(projectWorkspaceBindings.projectId, fixture.projectId)).limit(1);
      const admissions = await tx.select().from(sandboxAdmissionRequests)
        .where(eq(sandboxAdmissionRequests.bindingId, fixture.bindingId));
      if (operation || reservation || workspace || admissions.some((item: { state: string }) => item.state === "ADMITTED")) {
        throw new Error("Incus qualification fixture may have a provider effect");
      }
      await tx.delete(sandboxAdmissionRequests).where(eq(sandboxAdmissionRequests.bindingId, fixture.bindingId));
      await tx.delete(sandboxProjectQuotas).where(eq(sandboxProjectQuotas.projectId, fixture.projectId));
      await tx.delete(incusQualificationFixtures).where(eq(incusQualificationFixtures.operationId, operationId));
      await tx.delete(sandboxBindings).where(eq(sandboxBindings.id, fixture.bindingId));
      await tx.delete(projects).where(eq(projects.id, fixture.projectId));
      return true;
    });
  }

  async setPower(scope: IncusQualificationScope, operationId: string,
    desiredState: "running" | "stopped", idempotencyKey: string): Promise<SandboxOperation> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(idempotencyKey)) {
      throw new Error("Invalid Incus qualification fixture power operation ID");
    }
    const { row, binding } = await this.ownedFixture(scope, operationId);
    const kind = desiredState === "running" ? "START" : "STOP";
    const request = { bindingId: row.bindingId, generation: binding.generation,
      idempotencyScope: "incus-qualification-power", idempotencyKey: `${operationId}:${idempotencyKey}` };
    const [replay] = await this.db.select().from(sandboxOperations).where(and(
      eq(sandboxOperations.bindingId, row.bindingId),
      eq(sandboxOperations.idempotencyScope, request.idempotencyScope),
      eq(sandboxOperations.idempotencyKey, request.idempotencyKey))).limit(1);
    if (replay) {
      if (replay.kind !== kind) throw new Error("Incus qualification fixture power identity changed");
      return replay;
    }
    const expectedGeneration = await readIncusProviderGeneration(binding, this.inspect, this.now,
      desiredState === "running" ? "stopped" : "running");
    if (desiredState === "running") {
      const selected = await this.qualifications.authorizeFixture(scope);
      this.assertFixture(row, scope, selected.connection.revision,
        selected.presetDigest, selected.effectiveSettingsDigest);
      const resources = { memoryBytes: selected.preset.limits.memoryBytes,
        cpuMillicores: selected.preset.limits.cpuMillis, pids: selected.preset.limits.pids,
        diskBytes: selected.preset.limits.diskBytes, executionSlots: 1 };
      const admitted = await this.admission.requestAdmission({ ...request, kind: "START", resources });
      if (admitted.state !== "ADMITTED") {
        throw new Error(`Incus qualification fixture admission ${admitted.state}: ${admitted.reason}`);
      }
    }
    if (desiredState === "stopped") {
      await this.admission.markStopIntent(row.bindingId, binding.generation,
        `incus-qualification-stop-${operationId}-${idempotencyKey}`);
    }
    const operation = await this.controller.requestAndDispatch({ ...request, kind,
      payload: { expectedGeneration } });
    const observedState = desiredState === "running" ? "RUNNING" : "STOPPED";
    if (operation.state === "SUCCEEDED" && (await this.controller.getBinding(row.bindingId))?.observedState === observedState) {
      await this.admission.recordObservedState(row.bindingId, binding.generation, observedState,
        `incus-qualification-${kind.toLowerCase()}-${operationId}-${idempotencyKey}`);
    }
    return operation;
  }

  async destroy(scope: IncusQualificationScope, operationId: string): Promise<SandboxOperation> {
    const { row, binding } = await this.ownedFixture(scope, operationId);
    const request = { bindingId: row.bindingId, generation: binding.generation,
      idempotencyScope: "incus-qualification", idempotencyKey: `${operationId}:destroy` };
    const [replay] = await this.db.select().from(sandboxOperations).where(and(
      eq(sandboxOperations.bindingId, row.bindingId),
      eq(sandboxOperations.idempotencyScope, request.idempotencyScope),
      eq(sandboxOperations.idempotencyKey, request.idempotencyKey))).limit(1);
    if (replay) {
      if (replay.kind !== "DESTROY") throw new Error("Incus qualification fixture cleanup identity changed");
      return replay;
    }
    const expectedGeneration = await readIncusProviderGeneration(binding, this.inspect, this.now);
    await this.admission.markCleanupIntent(row.bindingId, binding.generation,
      `incus-qualification-destroy-${operationId}`);
    const operation = await this.controller.requestAndDispatch({ ...request, kind: "DESTROY",
      payload: { expectedGeneration } });
    if (operation.state === "SUCCEEDED" && (await this.controller.getBinding(row.bindingId))?.observedState === "ABSENT") {
      await this.admission.recordObservedState(row.bindingId, binding.generation, "ABSENT",
        `incus-qualification-destroy-${operationId}`);
    }
    return operation;
  }
}
