import { createHash, X509Certificate } from "node:crypto";
import {
  sandboxPresetDigest,
  validateLiveSandboxPresetQualification,
  type LiveSandboxPresetQualification,
  type LiveSandboxQualificationResult,
  type SandboxCompatibilityObservation,
  type SandboxPreset,
} from "@ezcorp/extension-contract";
import { sql } from "drizzle-orm";
import { getDb, type Database } from "../db/connection";
import { releaseRows } from "../db/queries/extension-releases";
import { getReleaseRuntime, resolveActiveRelease, type ActiveExtensionRelease } from "../extensions/release-process";
import { digest } from "../../scripts/incus/model";
import type { IncusSetupRecipe } from "../../scripts/incus/model";
import { GUEST_HELPER_VERSION, guestHelperSha256 } from "./incus-guest/protocol";
import { HostIncusProbeTransport } from "./incus-transport/transport";
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
