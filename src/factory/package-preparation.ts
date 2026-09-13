import type { FactoryRunnerRequest, RunnerReference } from "@ezcorp/factory-sdk";
import { canonicalJson, validateArtifactFiles, type ReleaseRecord, type Runner, type WorkspaceFiles } from "@ezcorp/extension-contract";
import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { type DatabaseLifecycleRepository, releaseRows as rows } from "../db/queries/extension-releases";
import { insertTransactionalAuditEntry } from "../db/queries/audit-log";
import { digestObject, type BlobStore } from "../extensions/v4";
import { getFiles } from "../extensions/v4/blobs";
import { lockFactoryScope } from "./locks";
import { FactoryMutations } from "./mutations";
import { assertFactoryIdentity, encodeFactoryPayload } from "./records";
import type { FactoryGrants, FactoryPrincipal } from "./grants";
import type { FactoryReleaseTrustRecord } from "./release-authority";

const MAX_BUILD_ID_BYTES = 512;

type BindingRow = {
  package_name: string; package_version: string; package_digest: string; export_name: string;
  installation_id: string; release_id: string; release_digest: string; source_digest: string; artifact_digest: string; image_digest: string; manifest_digest: string;
  issuer_id: string; issuer_grant_revision: number | string; protected_digest: string;
};
type ReceiptRow = {
  trust_revision: number | string; package_trust_digest: string; release_digest: string; source_digest: string; artifact_digest: string; image_digest: string; build_identity: string; receipt_digest: string;
};

export interface FactoryPackageTrustReader {
  readonly tenantId: string;
  readActiveTrustInTransaction(transaction: MigrationDb, projectId: string): Promise<FactoryReleaseTrustRecord>;
}

export interface FactoryV4PackageBindingInput {
  readonly projectId: string;
  readonly reference: RunnerReference;
  readonly installationId: string;
  readonly releaseId: string;
}

export interface FactoryV4PackageBinding extends FactoryV4PackageBindingInput {
  readonly releaseDigest: string;
  readonly sourceDigest: string;
  readonly artifactDigest: string;
  readonly imageDigest: string;
  readonly manifestDigest: string;
  readonly issuerId: string;
  readonly issuerGrantRevision: number;
  readonly protectedDigest: string;
}

/** Dispatcher calls this after durable claim, before token minting and runner invocation. */
export interface FactoryRunnerDispatchReadiness {
  assertDispatchReady(request: Pick<FactoryRunnerRequest, "authority" | "runner">): Promise<FactoryPreparedPackageReceipt>;
}

export interface FactoryPreparedPackageReceipt {
  readonly projectId: string;
  readonly reference: RunnerReference;
  readonly trustRevision: number;
  readonly packageTrustDigest: string;
  readonly releaseDigest: string;
  readonly sourceDigest: string;
  readonly artifactDigest: string;
  readonly imageDigest: string;
  readonly buildIdentity: string;
  readonly receiptDigest: string;
}

export class FactoryPackagePreparationError extends Error {
  constructor(readonly code: string) { super(code); this.name = "FactoryPackagePreparationError"; }
}

/** Only an absent current receipt is retryable at dispatcher pre-execution readiness. */
export function factoryPackageDispatchDisposition(error: unknown): "retry" | "deny" {
  if (error instanceof FactoryPackagePreparationError) return error.code === "factory_package_not_prepared" ? "retry" : "deny";
  return "retry";
}

function snapshot<T>(value: T): T { return JSON.parse(encodeFactoryPayload(value)) as T; }
function sha(value: unknown): string { return `sha256:${digestObject(value)}`; }
function rawDigest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function runner(reference: RunnerReference): RunnerReference {
  const value = snapshot(reference);
  const keys = Object.keys(value);
  if (!keys.every(key => ["package", "version", "digest", "export", "model", "configurationDigest"].includes(key))
    || [value.package, value.version, value.digest, value.export].some(part => typeof part !== "string" || part.length < 1 || part.length > 512 || part.includes("\0"))
    || value.version === "latest" || value.version.includes("*") || !/^sha256:[a-f0-9]{64}$/.test(value.digest)
    || value.model !== undefined && (typeof value.model !== "string" || value.model.length < 1 || value.model.length > 512)
    || value.configurationDigest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(value.configurationDigest)) throw new FactoryPackagePreparationError("factory_package_reference_invalid");
  assertFactoryIdentity(value.package, value.version, value.export);
  return Object.freeze(value);
}
function same(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }
function key(reference: RunnerReference): [string, string, string, string] { return [reference.package, reference.version, reference.digest, reference.export]; }
function bindingSeal(tenantId: string, input: Omit<FactoryV4PackageBinding, "protectedDigest">): string {
  return sha({ tenantId, projectId: input.projectId, reference: input.reference, installationId: input.installationId, releaseId: input.releaseId, releaseDigest: input.releaseDigest, sourceDigest: input.sourceDigest, artifactDigest: input.artifactDigest, imageDigest: input.imageDigest, manifestDigest: input.manifestDigest, issuerId: input.issuerId, issuerGrantRevision: input.issuerGrantRevision });
}
function receiptSeal(tenantId: string, value: Omit<FactoryPreparedPackageReceipt, "receiptDigest">): string {
  return sha({ tenantId, projectId: value.projectId, reference: value.reference, trustRevision: value.trustRevision, packageTrustDigest: value.packageTrustDigest, releaseDigest: value.releaseDigest, sourceDigest: value.sourceDigest, artifactDigest: value.artifactDigest, imageDigest: value.imageDigest, buildIdentity: value.buildIdentity });
}
function releaseFacts(binding: FactoryV4PackageBinding, release: ReleaseRecord): void {
  if (release.id !== binding.releaseId || release.installationId !== binding.installationId || release.releaseDigest !== binding.releaseDigest || release.sourceDigest !== binding.sourceDigest || release.artifactDigest !== binding.artifactDigest || release.imageDigest !== binding.imageDigest || digestObject(release.manifest) !== binding.manifestDigest || release.manifest.name !== binding.reference.package || release.manifest.version !== binding.reference.version || !release.manifest.tools?.some(tool => tool.name === binding.reference.export)) throw new FactoryPackagePreparationError("factory_package_release_stale");
}

/** Concrete, scoped reader over the existing immutable v4 release repository and blobs. */
export class FactoryV4PackageCatalog {
  constructor(private readonly repository: DatabaseLifecycleRepository, private readonly blobs: BlobStore) {}

  async loadForBindingInTransaction(transaction: MigrationDb, installationId: string, releaseId: string): Promise<ReleaseRecord> {
    const state = await this.repository.read(installationId, transaction);
    const release = state?.releases[releaseId];
    if (!state || !release || !state.installation.enabled || state.installation.uninstalled || state.installation.activeReleaseId !== releaseId || release.id !== releaseId || release.installationId !== installationId) throw new FactoryPackagePreparationError("factory_package_release_unavailable");
    return snapshot(release);
  }

  async loadInTransaction(transaction: MigrationDb, binding: FactoryV4PackageBinding): Promise<ReleaseRecord> {
    const release = await this.loadForBindingInTransaction(transaction, binding.installationId, binding.releaseId);
    releaseFacts(binding, release);
    return release;
  }

  async loadSource(binding: FactoryV4PackageBinding): Promise<WorkspaceFiles> {
    return getFiles(this.blobs, binding.sourceDigest, "workspace");
  }
}

/** Maps one factory runner tuple to one immutable release; it never copies v4 release bytes. */
export class FactoryPackagePreparations implements FactoryRunnerDispatchReadiness {
  private readonly mutations: FactoryMutations;
  private readonly local = new Map<string, FactoryPreparedPackageReceipt>();

  constructor(
    private readonly database: TransactionalDb,
    readonly tenantId: string,
    private readonly grants: FactoryGrants,
    private readonly trust: FactoryPackageTrustReader,
    private readonly catalog: FactoryV4PackageCatalog,
    private readonly runnerClient: Pick<Runner, "build" | "collectArtifacts">,
    private readonly buildLimits: Parameters<Runner["build"]>[0]["limits"],
  ) {
    assertFactoryIdentity(tenantId);
    if (grants.tenantId !== tenantId || trust.tenantId !== tenantId) throw new FactoryPackagePreparationError("factory_package_scope");
    this.mutations = new FactoryMutations(database, tenantId, grants);
  }

  async bind(actor: FactoryPrincipal, input: FactoryV4PackageBindingInput, idempotencyKey: string): Promise<FactoryV4PackageBinding> {
    const principal = snapshot(actor);
    const captured = { projectId: input.projectId, reference: runner(input.reference), installationId: input.installationId, releaseId: input.releaseId };
    assertFactoryIdentity(captured.projectId, captured.installationId, captured.releaseId);
    if (principal.kind !== "user" || principal.authentication !== "session") throw new FactoryPackagePreparationError("factory_package_human_required");
    return this.mutations.execute({ principal, projectId: captured.projectId, action: "factory.trust", idempotencyKey, input: { kind: "factory.package.bind", ...captured } }, transaction => this.bindInTransaction(transaction, principal, captured));
  }

  /** Creates intent under locks, builds outside product transactions, then commits only a revalidated receipt. */
  async prepare(projectId: string, rawReference: RunnerReference): Promise<FactoryPreparedPackageReceipt> {
    const reference = runner(rawReference);
    assertFactoryIdentity(projectId);
    const intent = await this.database.transaction(transaction => this.intentInTransaction(transaction, projectId, reference));
    const artifacts = await this.hydrate(intent);
    return this.database.transaction(transaction => this.commitInTransaction(transaction, intent, artifacts));
  }

  /** Call before the dispatcher claims a delivery. It does no build and checks the current revocable trust. */
  async assertDispatchReady(request: Pick<FactoryRunnerRequest, "authority" | "runner">): Promise<FactoryPreparedPackageReceipt> {
    const captured = snapshot(request);
    if (captured.authority.tenantId !== this.tenantId) throw new FactoryPackagePreparationError("factory_package_scope");
    return this.database.transaction(transaction => this.assertPreparedInTransaction(transaction, captured.authority.projectId, captured.runner));
  }

  async assertPreparedInTransaction(transaction: MigrationDb, projectId: string, rawReference: RunnerReference): Promise<FactoryPreparedPackageReceipt> {
    const reference = runner(rawReference);
    if (!await lockFactoryScope(transaction, this.tenantId, projectId)) throw new FactoryPackagePreparationError("factory_package_scope");
    const binding = await this.readBinding(transaction, projectId, reference);
    const trust = await this.currentTrust(transaction, projectId, reference);
    await this.catalog.loadInTransaction(transaction, binding);
    const receipt = await this.readReceipt(transaction, projectId, reference, trust.revision);
    if (!receipt || receipt.packageTrustDigest !== trust.packageTrustDigest || receipt.releaseDigest !== binding.releaseDigest || receipt.sourceDigest !== binding.sourceDigest || receipt.artifactDigest !== binding.artifactDigest || receipt.imageDigest !== binding.imageDigest) throw new FactoryPackagePreparationError("factory_package_not_prepared");
    return receipt;
  }

  /** Rejects run dispatch unless this process completed a verified prepare for the exact tuple. It never builds. */
  assertLocal(request: Pick<FactoryRunnerRequest, "authority" | "runner">): FactoryPreparedPackageReceipt {
    const captured = snapshot(request);
    if (captured.authority.tenantId !== this.tenantId) throw new FactoryPackagePreparationError("factory_package_scope");
    const receipt = this.local.get(this.localKey(captured.authority.projectId, runner(captured.runner)));
    if (!receipt) throw new FactoryPackagePreparationError("factory_package_not_ready");
    return receipt;
  }

  private async bindInTransaction(transaction: MigrationDb, actor: FactoryPrincipal, input: FactoryV4PackageBindingInput): Promise<FactoryV4PackageBinding> {
    if (!await lockFactoryScope(transaction, this.tenantId, input.projectId, "write")) throw new FactoryPackagePreparationError("factory_package_scope");
    const trust = await this.currentTrust(transaction, input.projectId, input.reference);
    const state = await this.catalog.loadForBindingInTransaction(transaction, input.installationId, input.releaseId);
    // Derive a one-time trusted binding from immutable repository state.
    if (state.id !== input.releaseId || state.installationId !== input.installationId || state.manifest.name !== input.reference.package || state.manifest.version !== input.reference.version || !state.manifest.tools?.some(tool => tool.name === input.reference.export)) throw new FactoryPackagePreparationError("factory_package_release_unavailable");
    const authorization = await this.grants.authorizeInTransaction(transaction, actor, input.projectId, "factory.trust");
    const value: Omit<FactoryV4PackageBinding, "protectedDigest"> = { ...input, reference: input.reference, releaseDigest: state.releaseDigest, sourceDigest: state.sourceDigest, artifactDigest: state.artifactDigest, imageDigest: state.imageDigest, manifestDigest: digestObject(state.manifest), issuerId: actor.id, issuerGrantRevision: authorization.revision };
    const binding: FactoryV4PackageBinding = { ...value, protectedDigest: bindingSeal(this.tenantId, value) };
    const existing = rows<BindingRow>(await transaction.execute(sql`SELECT package_name,package_version,package_digest,export_name,installation_id,release_id,release_digest,source_digest,artifact_digest,image_digest,manifest_digest,issuer_id,issuer_grant_revision,protected_digest FROM factory_runner_package_bindings WHERE tenant_id=${this.tenantId} AND project_id=${input.projectId} AND package_name=${input.reference.package} AND package_version=${input.reference.version} AND package_digest=${input.reference.digest} AND export_name=${input.reference.export} FOR UPDATE`))[0];
    if (existing) {
      const present = this.binding(input.projectId, input.reference, existing);
      if (!same(present, binding)) throw new FactoryPackagePreparationError("factory_package_binding_conflict");
      return present;
    }
    await transaction.execute(sql`INSERT INTO factory_runner_package_bindings (tenant_id,project_id,package_name,package_version,package_digest,export_name,installation_id,release_id,release_digest,source_digest,artifact_digest,image_digest,manifest_digest,issuer_id,issuer_grant_revision,protected_digest) VALUES (${this.tenantId},${input.projectId},${input.reference.package},${input.reference.version},${input.reference.digest},${input.reference.export},${input.installationId},${input.releaseId},${binding.releaseDigest},${binding.sourceDigest},${binding.artifactDigest},${binding.imageDigest},${binding.manifestDigest},${actor.id},${authorization.revision},${binding.protectedDigest})`);
    await insertTransactionalAuditEntry(transaction, `factory-package-binding:${binding.protectedDigest}`, actor.id, "factory.package.bound", input.projectId, { tenantId: this.tenantId, projectId: input.projectId, reference: input.reference, installationId: input.installationId, releaseId: input.releaseId, trustRevision: trust.revision });
    return binding;
  }

  private async intentInTransaction(transaction: MigrationDb, projectId: string, reference: RunnerReference): Promise<{ binding: FactoryV4PackageBinding; trust: FactoryReleaseTrustRecord; buildIdentity: string; entrypoint: string; evidenceDigest: string }> {
    const receipt = await this.assertPreparedInTransaction(transaction, projectId, reference).catch(error => {
      if (!(error instanceof FactoryPackagePreparationError) || error.code !== "factory_package_not_prepared") throw error;
      return undefined;
    });
    const binding = await this.readBinding(transaction, projectId, reference);
    const trust = await this.currentTrust(transaction, projectId, reference);
    const release = await this.catalog.loadInTransaction(transaction, binding);
    const entrypoint = (release.manifest.entrypoint ?? "extension.ts").replace(/^\.\//, "");
    return { binding, trust, buildIdentity: receipt?.buildIdentity ?? `factory-package-${digestObject({ tenantId: this.tenantId, projectId, reference, releaseDigest: binding.releaseDigest, trustRevision: trust.revision })}`, entrypoint, evidenceDigest: digestObject(release.evidence) };
  }

  private async hydrate(intent: { binding: FactoryV4PackageBinding; trust: FactoryReleaseTrustRecord; buildIdentity: string; entrypoint: string; evidenceDigest: string }): Promise<WorkspaceFiles> {
    try {
      const cached = await this.runnerClient.collectArtifacts(intent.binding.artifactDigest);
      this.verifyArtifacts(intent.binding, cached);
      return cached;
    } catch {
      const source = await this.catalog.loadSource(intent.binding);
      const result = await this.runnerClient.build({ operationId: intent.buildIdentity, sourceDigest: intent.binding.sourceDigest, files: source, entrypoint: intent.entrypoint, limits: this.buildLimits });
      if (result.state !== "succeeded" || result.operationId !== intent.buildIdentity || result.sourceDigest !== intent.binding.sourceDigest || result.artifactDigest !== intent.binding.artifactDigest || result.imageDigest !== intent.binding.imageDigest || !result.manifest || digestObject(result.manifest) !== intent.binding.manifestDigest || result.manifest.name !== intent.binding.reference.package || result.manifest.version !== intent.binding.reference.version || !result.manifest.tools?.some(tool => tool.name === intent.binding.reference.export) || digestObject(result.evidence) !== intent.evidenceDigest || !result.evidence.tests.length || result.evidence.tests.some(test => !test.passed)) throw new FactoryPackagePreparationError("factory_package_build_mismatch");
      const artifacts = await this.runnerClient.collectArtifacts(intent.binding.artifactDigest);
      this.verifyArtifacts(intent.binding, artifacts);
      return artifacts;
    }
  }

  private async commitInTransaction(transaction: MigrationDb, intent: { binding: FactoryV4PackageBinding; trust: FactoryReleaseTrustRecord; buildIdentity: string; entrypoint: string; evidenceDigest: string }, artifacts: WorkspaceFiles): Promise<FactoryPreparedPackageReceipt> {
    if (!await lockFactoryScope(transaction, this.tenantId, intent.binding.projectId)) throw new FactoryPackagePreparationError("factory_package_scope");
    const binding = await this.readBinding(transaction, intent.binding.projectId, intent.binding.reference);
    if (!same(binding, intent.binding)) throw new FactoryPackagePreparationError("factory_package_binding_stale");
    const trust = await this.currentTrust(transaction, binding.projectId, binding.reference);
    if (trust.revision !== intent.trust.revision || trust.packageTrustDigest !== intent.trust.packageTrustDigest) throw new FactoryPackagePreparationError("factory_package_trust_stale");
    await this.catalog.loadInTransaction(transaction, binding);
    this.verifyArtifacts(binding, artifacts);
    const existing = await this.readReceipt(transaction, binding.projectId, binding.reference, trust.revision);
    if (existing) {
      if (existing.packageTrustDigest !== trust.packageTrustDigest || existing.releaseDigest !== binding.releaseDigest || existing.sourceDigest !== binding.sourceDigest || existing.artifactDigest !== binding.artifactDigest || existing.imageDigest !== binding.imageDigest) throw new FactoryPackagePreparationError("factory_package_receipt_corrupt");
      this.local.set(this.localKey(binding.projectId, binding.reference), existing);
      return existing;
    }
    const unsigned: Omit<FactoryPreparedPackageReceipt, "receiptDigest"> = { projectId: binding.projectId, reference: binding.reference, trustRevision: trust.revision, packageTrustDigest: trust.packageTrustDigest, releaseDigest: binding.releaseDigest, sourceDigest: binding.sourceDigest, artifactDigest: binding.artifactDigest, imageDigest: binding.imageDigest, buildIdentity: intent.buildIdentity };
    const receipt: FactoryPreparedPackageReceipt = { ...unsigned, receiptDigest: receiptSeal(this.tenantId, unsigned) };
    await transaction.execute(sql`INSERT INTO factory_runner_preparation_receipts (tenant_id,project_id,package_name,package_version,package_digest,export_name,trust_revision,package_trust_digest,release_digest,source_digest,artifact_digest,image_digest,build_identity,receipt_digest) VALUES (${this.tenantId},${binding.projectId},${binding.reference.package},${binding.reference.version},${binding.reference.digest},${binding.reference.export},${trust.revision},${trust.packageTrustDigest},${binding.releaseDigest},${binding.sourceDigest},${binding.artifactDigest},${binding.imageDigest},${intent.buildIdentity},${receipt.receiptDigest})`);
    this.local.set(this.localKey(binding.projectId, binding.reference), receipt);
    return receipt;
  }

  private async currentTrust(transaction: MigrationDb, projectId: string, reference: RunnerReference): Promise<FactoryReleaseTrustRecord> {
    try {
      const trust = await this.trust.readActiveTrustInTransaction(transaction, projectId);
      if (!same(trust.packageLock, reference)) throw new FactoryPackagePreparationError("factory_package_untrusted");
      return trust;
    } catch (error) {
      if (error instanceof FactoryPackagePreparationError) throw error;
      const code = error instanceof Error && "code" in error ? (error as { code?: unknown }).code : undefined;
      if (code === "factory_release_trust_inactive") throw new FactoryPackagePreparationError("factory_package_revoked");
      if (code === "factory_release_trust_missing" || code === "factory_release_trust_corrupt") throw new FactoryPackagePreparationError("factory_package_trust_invalid");
      throw error;
    }
  }

  private async readBinding(transaction: MigrationDb, projectId: string, reference: RunnerReference): Promise<FactoryV4PackageBinding> {
    const [name, version, digest, exported] = key(reference);
    const row = rows<BindingRow>(await transaction.execute(sql`SELECT package_name,package_version,package_digest,export_name,installation_id,release_id,release_digest,source_digest,artifact_digest,image_digest,manifest_digest,issuer_id,issuer_grant_revision,protected_digest FROM factory_runner_package_bindings WHERE tenant_id=${this.tenantId} AND project_id=${projectId} AND package_name=${name} AND package_version=${version} AND package_digest=${digest} AND export_name=${exported} FOR UPDATE`))[0];
    if (!row) throw new FactoryPackagePreparationError("factory_package_binding_missing");
    return this.binding(projectId, reference, row);
  }

  private binding(projectId: string, reference: RunnerReference, row: BindingRow): FactoryV4PackageBinding {
    const value: Omit<FactoryV4PackageBinding, "protectedDigest"> = { projectId, reference, installationId: row.installation_id, releaseId: row.release_id, releaseDigest: row.release_digest, sourceDigest: row.source_digest, artifactDigest: row.artifact_digest, imageDigest: row.image_digest, manifestDigest: row.manifest_digest, issuerId: row.issuer_id, issuerGrantRevision: Number(row.issuer_grant_revision) };
    if (![value.releaseDigest, value.sourceDigest, value.artifactDigest, value.manifestDigest].every(rawDigest) || !Number.isSafeInteger(value.issuerGrantRevision) || value.issuerGrantRevision < 1 || row.protected_digest !== bindingSeal(this.tenantId, value)) throw new FactoryPackagePreparationError("factory_package_binding_corrupt");
    return { ...value, protectedDigest: row.protected_digest };
  }

  private async readReceipt(transaction: MigrationDb, projectId: string, reference: RunnerReference, trustRevision: number): Promise<FactoryPreparedPackageReceipt | undefined> {
    const [name, version, digest, exported] = key(reference);
    const row = rows<ReceiptRow>(await transaction.execute(sql`SELECT trust_revision,package_trust_digest,release_digest,source_digest,artifact_digest,image_digest,build_identity,receipt_digest FROM factory_runner_preparation_receipts WHERE tenant_id=${this.tenantId} AND project_id=${projectId} AND package_name=${name} AND package_version=${version} AND package_digest=${digest} AND export_name=${exported} AND trust_revision=${trustRevision} FOR UPDATE`))[0];
    if (!row) return undefined;
    const value: Omit<FactoryPreparedPackageReceipt, "receiptDigest"> = { projectId, reference, trustRevision: Number(row.trust_revision), packageTrustDigest: row.package_trust_digest, releaseDigest: row.release_digest, sourceDigest: row.source_digest, artifactDigest: row.artifact_digest, imageDigest: row.image_digest, buildIdentity: row.build_identity };
    if (!Number.isSafeInteger(value.trustRevision) || value.trustRevision < 1 || !/^sha256:[a-f0-9]{64}$/.test(value.packageTrustDigest) || ![value.releaseDigest, value.sourceDigest, value.artifactDigest].every(rawDigest) || !value.imageDigest || new TextEncoder().encode(value.buildIdentity).byteLength > MAX_BUILD_ID_BYTES || row.receipt_digest !== receiptSeal(this.tenantId, value)) throw new FactoryPackagePreparationError("factory_package_receipt_corrupt");
    return { ...value, receiptDigest: row.receipt_digest };
  }

  private verifyArtifacts(binding: FactoryV4PackageBinding, artifacts: WorkspaceFiles): void {
    try { validateArtifactFiles(artifacts); } catch { throw new FactoryPackagePreparationError("factory_package_artifact_corrupt"); }
    if (digestObject(artifacts) !== binding.artifactDigest) throw new FactoryPackagePreparationError("factory_package_artifact_corrupt");
  }
  private localKey(projectId: string, reference: RunnerReference): string { return canonicalJson([projectId, reference]); }
}
