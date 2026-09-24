import { randomUUID, X509Certificate } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { sql } from "drizzle-orm";
import { sandboxPresetDigest } from "@ezcorp/extension-contract";
import recipeTemplate from "../../../scripts/incus/recipe.json";
import { applySetupPlan } from "../../../scripts/incus/apply";
import { inspectIncus, sshRunner, type RemoteRunner } from "../../../scripts/incus/inspect";
import type { ApplyReceipt, IncusConnection, IncusInventory, IncusSetupPlan, IncusSetupRecipe } from "../../../scripts/incus/model";
import { assertSetupPlanDigest, digest } from "../../../scripts/incus/model";
import { createSetupPlan, validateRecipe, verifySetupPlan } from "../../../scripts/incus/plan";
import { createSshGatePolicy, type SshGatePolicy } from "../../../scripts/incus/ssh-gate-policy";
import { insertTransactionalAuditEntry } from "../../db/queries/audit-log";
import { releaseRows, type ReleaseDatabase } from "../../db/queries/extension-releases";
import { ReleaseProcess, type ActiveExtensionRelease } from "../../extensions/release-process";
import type { ProviderConnectionStore } from "../provider-connections/store";
import { issueIncusClientIdentity } from "./identity";

type SetupState = "planned" | "applying" | "applied" | "verified" | "blocked" | "review_required" | "reconcile_required";
// The first deployment has one control-plane process. A new process ID after
// restart turns an unfinished apply into an explicit reconciliation task.
const BOOT_ID = randomUUID();
interface SetupRow {
  id: string;
  providerInstallationId: string;
  providerReleaseId: string;
  providerReleaseDigest: string;
  providerGeneration: number;
  connectionId: string;
  connectionRevision: number;
  plannedBy: string;
  approvedPlanDigest: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  appliedBy: string | null;
  applyToken: string | null;
  recipe: IncusSetupRecipe;
  plan: IncusSetupPlan;
  state: SetupState;
  receipt: ApplyReceipt | null;
  failures: string[] | null;
  createdAt: Date;
  updatedAt: Date;
}

export type PublicSetup = Pick<SetupRow, "id" | "providerInstallationId" | "providerReleaseId" | "providerReleaseDigest" | "providerGeneration" | "connectionId" | "connectionRevision" | "plannedBy" | "approvedPlanDigest" | "approvedBy" | "approvedAt" | "appliedBy" | "plan" | "state" | "receipt" | "failures" | "createdAt" | "updatedAt">;

export interface IncusOperatorBootstrap {
  ssh: IncusConnection;
  endpoint: string;
}

interface SetupDependencies {
  database: ReleaseDatabase;
  connections: ProviderConnectionStore;
  bootstrap: IncusOperatorBootstrap;
  activeRelease(installationId: string): Promise<ActiveExtensionRelease>;
  inspect?: typeof inspectIncus;
  runner?: (connection: IncusConnection, planDigest?: string) => RemoteRunner;
  identity?: typeof issueIncusClientIdentity;
  recipe?: IncusSetupRecipe;
  now?: () => Date;
  process?: (installationId: string) => Pick<ReleaseProcess, "callIncusProbe">;
}

const columns = sql`id, provider_installation_id AS "providerInstallationId", provider_release_id AS "providerReleaseId",
  provider_release_digest AS "providerReleaseDigest", provider_generation AS "providerGeneration",
  connection_id AS "connectionId", connection_revision AS "connectionRevision", planned_by AS "plannedBy",
  approved_plan_digest AS "approvedPlanDigest", approved_by AS "approvedBy", approved_at AS "approvedAt",
  applied_by AS "appliedBy", apply_token AS "applyToken",
  recipe, plan, state, receipt, failures, created_at AS "createdAt", updated_at AS "updatedAt"`;

function publicSetup(row: SetupRow): PublicSetup {
  const { recipe: _recipe, applyToken: _applyToken, ...publicRow } = row;
  return publicRow;
}

function assertIncusRelease(snapshot: ActiveExtensionRelease): void {
  if (!snapshot.release.manifest.sandboxProviders?.some(provider => provider.id === "incus" && provider.kind === "sandbox") ||
    !snapshot.release.manifest.methods?.some(method => method.name === "incus/preflight")) {
    throw new Error("The active approved release is not an Incus sandbox provider");
  }
}

function incusPresets(snapshot: ActiveExtensionRelease) {
  const presets = snapshot.release.manifest.sandboxProviders?.find(provider => provider.id === "incus" && provider.kind === "sandbox")?.presets;
  if (!presets?.length) throw new Error("Incus provider release has no reviewed presets");
  return presets;
}

function assertSnapshot(row: SetupRow, snapshot: ActiveExtensionRelease): void {
  assertIncusRelease(snapshot);
  if (snapshot.release.id !== row.providerReleaseId || snapshot.release.releaseDigest !== row.providerReleaseDigest ||
    snapshot.installation.generation !== row.providerGeneration) {
    throw new Error("The provider release changed. Make a new setup plan.");
  }
}

/** Only server process configuration can select an SSH key, host pin, or endpoint. */
export function bootstrapFromEnvironment(env: NodeJS.ProcessEnv = process.env): IncusOperatorBootstrap | null {
  const target = env.EZCORP_INCUS_SETUP_SSH_TARGET;
  const identity = env.EZCORP_INCUS_SETUP_SSH_IDENTITY_FILE;
  const knownHosts = env.EZCORP_INCUS_SETUP_SSH_KNOWN_HOSTS_FILE;
  const hostKey = env.EZCORP_INCUS_SETUP_SSH_HOST_KEY_SHA256;
  const sshMode = env.EZCORP_INCUS_SETUP_SSH_MODE;
  const endpoint = env.EZCORP_INCUS_SETUP_ENDPOINT;
  if (![target, identity, knownHosts, hostKey, endpoint].every(Boolean)) return null;
  if (sshMode !== undefined && sshMode !== "reviewed-envelope-v1") throw new Error("Incus setup SSH mode is unsupported");
  let url: URL;
  try { url = new URL(endpoint!); }
  catch { throw new Error("Incus setup endpoint must be a bare HTTPS origin"); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Incus setup endpoint must be a bare HTTPS origin");
  }
  return { ssh: { sshTarget: target!, sshIdentityFile: identity!, sshKnownHostsFile: knownHosts!, sshHostKeySha256: hostKey!,
    ...(sshMode ? { sshMode } : {}) }, endpoint: url.origin };
}

/** The engine reads one operator-owned recipe; its saved plan pins the exact bytes used for Apply. */
export function loadReviewedIncusRecipe(path: string): IncusSetupRecipe {
  if (!isAbsolute(path)) throw new Error("Reviewed Incus recipe path must be absolute");
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { throw new Error("Reviewed Incus recipe cannot be opened"); }
  try {
    const status = fstatSync(fd);
    const uid = process.getuid?.();
    if (!status.isFile() || status.size < 1 || status.size > 64 * 1024 || (status.mode & 0o022) !== 0 ||
      uid !== undefined && status.uid !== uid && status.uid !== 0) {
      throw new Error("Reviewed Incus recipe must be a bounded, operator-owned, non-writable file");
    }
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(fd, "utf8")); }
    catch { throw new Error("Reviewed Incus recipe is not valid JSON"); }
    const recipe = parsed as IncusSetupRecipe;
    validateRecipe(recipe);
    const image = recipe.guestImage;
    if (!image?.fingerprint || !image.sourceFingerprint || !image.pythonPackageVersion ||
      !image.dockerArchiveSha256 || !image.composeSha256 || recipe.providerClient) {
      throw new Error("Reviewed Incus recipe must pin the image and leave client identity to the engine");
    }
    return recipe;
  } finally { closeSync(fd); }
}

/** One saved review controls one exact release, connection, recipe, and plan. */
export class IncusOperatorSetupService {
  constructor(private readonly deps: SetupDependencies) {}

  private async reviewedIdentity(installationId: string, releaseId: string,
    recipe: IncusSetupRecipe, inventory: IncusInventory): Promise<{
      fingerprint: string; certificatePem: string; privateKeyPem: string;
    } | null> {
    const [prior] = releaseRows<SetupRow>(await this.deps.database.execute(sql`SELECT ${columns}
      FROM incus_operator_setups WHERE provider_installation_id = ${installationId}
      AND state = 'verified' ORDER BY created_at DESC, id DESC LIMIT 1`));
    if (!prior?.recipe.providerClient) return null;
    const scope = { connectionId: prior.connectionId, providerInstallationId: installationId,
      providerReleaseId: prior.providerReleaseId, revision: prior.connectionRevision };
    const old = prior.providerReleaseId === releaseId
      ? await this.deps.connections.resolveForHost(scope)
      : await this.deps.connections.resolveRetiredForUpgrade(scope, prior.providerReleaseDigest);
    const client = prior.recipe.providerClient;
    const certificate = new X509Certificate(old.clientCertificatePem);
    const fingerprint = certificate.fingerprint256.replaceAll(":", "").toLowerCase();
    const trust = inventory.trust.find(entry => entry.fingerprint === fingerprint);
    const validFrom = Date.parse(certificate.validFrom);
    const validTo = Date.parse(certificate.validTo);
    if (old.endpoint !== this.deps.bootstrap.endpoint || old.serverCertificatePem !== inventory.server.certificatePem
      || old.project !== recipe.project.name || old.configuration.kind !== "incus"
      || old.configuration.profile !== recipe.profile.name || old.configuration.helperVersion !== "0.1.0"
      || old.configuration.guestUser !== "sandbox" || client.certificatePem !== old.clientCertificatePem
      || client.certificateFingerprint !== fingerprint || client.name !== "engine"
      || client.restricted !== true || client.projects.length !== 1 || client.projects[0] !== recipe.project.name
      || !trust || trust.name !== "engine" || trust.type !== "client" || trust.restricted !== true
      || trust.projects.length !== 1 || trust.projects[0] !== recipe.project.name
      || !Number.isFinite(validFrom) || !Number.isFinite(validTo)
      || validFrom > Date.now() || validTo <= Date.now()) {
      throw new Error("Reviewed Incus client identity cannot be reused; inspect the prior setup and trust");
    }
    return { fingerprint, certificatePem: old.clientCertificatePem, privateKeyPem: old.privateKeyPem };
  }

  private async row(id: string): Promise<SetupRow> {
    const found = releaseRows<SetupRow>(await this.deps.database.execute(sql`SELECT ${columns} FROM incus_operator_setups WHERE id = ${id}`))[0];
    if (!found) throw new Error("Incus setup was not found");
    return found;
  }

  async latest(installationId: string): Promise<PublicSetup | null> {
    await this.recoverInterrupted(installationId);
    const found = releaseRows<SetupRow>(await this.deps.database.execute(sql`SELECT ${columns} FROM incus_operator_setups
      WHERE provider_installation_id = ${installationId} ORDER BY created_at DESC, id DESC LIMIT 1`))[0];
    return found ? publicSetup(found) : null;
  }

  private async recoverInterrupted(installationId: string): Promise<void> {
    await this.deps.database.execute(sql`UPDATE incus_operator_setups SET state = 'reconcile_required',
      failures = ${JSON.stringify(["The engine restarted during setup. Inspect the server before retrying the exact plan."])}::text::jsonb,
      apply_token = NULL, updated_at = NOW()
      WHERE provider_installation_id = ${installationId} AND state = 'applying'
        AND apply_token IS DISTINCT FROM ${BOOT_ID}`);
  }

  async plan(installationId: string, principalId: string): Promise<PublicSetup> {
    const snapshot = await this.deps.activeRelease(installationId);
    assertIncusRelease(snapshot);
    const inventory = await (this.deps.inspect ?? inspectIncus)(this.deps.bootstrap.ssh);
    if (!inventory.server.certificatePem) throw new Error("Incus did not report a usable server certificate");
    const recipe = structuredClone(this.deps.recipe ?? recipeTemplate) as IncusSetupRecipe;
    const endpoint = new URL(this.deps.bootstrap.endpoint);
    const certificate = new X509Certificate(inventory.server.certificatePem);
    const fingerprint = certificate.fingerprint256.replaceAll(":", "").toLowerCase();
    const hostMatches = isIP(endpoint.hostname) ? certificate.checkIP(endpoint.hostname) : certificate.checkHost(endpoint.hostname);
    if (fingerprint !== inventory.server.certificateFingerprint || !hostMatches) {
      throw new Error("Incus server certificate does not match the configured endpoint");
    }
    if (recipe.expected.sshHostKeySha256 !== this.deps.bootstrap.ssh.sshHostKeySha256 ||
      recipe.server.httpsAddress.split(":")[1] !== endpoint.port ||
      !inventory.host.addresses.includes(recipe.server.httpsAddress.split(":")[0]!)) {
      throw new Error("Host-owned SSH and HTTPS settings do not match the reviewed recipe");
    }
    const connectionId = randomUUID();
    const identity = await this.reviewedIdentity(installationId, snapshot.release.id, recipe, inventory)
      ?? await (this.deps.identity ?? issueIncusClientIdentity)(connectionId);
    recipe.providerClient = { name: "engine", certificateFingerprint: identity.fingerprint,
      certificatePem: identity.certificatePem, projects: [recipe.project.name], restricted: true };
    const plan = createSetupPlan(recipe, inventory, incusPresets(snapshot));
    const connection = await this.deps.connections.create({
      id: connectionId, providerInstallationId: installationId, providerReleaseId: snapshot.release.id,
      endpoint: this.deps.bootstrap.endpoint, serverCertificatePem: inventory.server.certificatePem,
      project: recipe.project.name, configuration: { kind: "incus", profile: recipe.profile.name,
        helperVersion: "0.1.0", guestUser: "sandbox" }, clientCertificatePem: identity.certificatePem,
      privateKeyPem: identity.privateKeyPem,
    });
    const id = randomUUID();
    try {
      await this.deps.database.execute(sql`INSERT INTO incus_operator_setups
        (id, provider_installation_id, provider_release_id, provider_release_digest, provider_generation,
         connection_id, connection_revision, planned_by, recipe, plan, state)
        VALUES (${id}, ${installationId}, ${snapshot.release.id}, ${snapshot.release.releaseDigest},
          ${snapshot.installation.generation}, ${connectionId}, ${connection.revision}, ${principalId},
          ${JSON.stringify(recipe)}::text::jsonb, ${JSON.stringify(plan)}::text::jsonb,
          ${plan.status === "ready" ? "planned" : "blocked"})`);
    } catch (error) {
      await this.deps.connections.revoke(connectionId, connection.revision);
      throw error;
    }
    return publicSetup(await this.row(id));
  }

  /** Operator review artifact. Never includes the client private key. */
  async gatePolicy(id: string): Promise<SshGatePolicy> {
    const row = await this.row(id);
    if (row.state !== "planned" || row.plan.sshMode !== "reviewed-envelope-v1" ||
      row.approvedPlanDigest !== row.plan.planDigest || !row.approvedBy) {
      throw new Error("Approve the exact reviewed SSH gate setup plan before exporting write authority");
    }
    const snapshot = await this.deps.activeRelease(row.providerInstallationId);
    assertSnapshot(row, snapshot);
    await this.deps.connections.resolveForHost({ connectionId: row.connectionId,
      providerInstallationId: row.providerInstallationId, providerReleaseId: row.providerReleaseId,
      revision: row.connectionRevision });
    if (this.deps.bootstrap.ssh.sshMode !== row.plan.sshMode) throw new Error("SSH mode changed. Make a new reviewed setup plan.");
    const current = await (this.deps.inspect ?? inspectIncus)(this.deps.bootstrap.ssh);
    const policy = createSshGatePolicy(row.recipe, current, row.plan, incusPresets(snapshot), this.deps.now?.() ?? new Date());
    const latest = releaseRows<{ id: string }>(await this.deps.database.execute(sql`SELECT id FROM incus_operator_setups
      WHERE provider_installation_id = ${row.providerInstallationId} ORDER BY created_at DESC, id DESC LIMIT 1`))[0];
    if (latest?.id !== id) throw new Error("A newer Incus setup plan replaced this SSH gate policy review");
    return policy;
  }

  async approveGatePlan(id: string, planDigest: string, principalId: string): Promise<PublicSetup> {
    const row = await this.row(id);
    assertSetupPlanDigest(row.plan);
    if (row.state !== "planned" || row.plan.status !== "ready" || row.plan.sshMode !== "reviewed-envelope-v1" ||
      row.plan.planDigest !== planDigest || this.deps.bootstrap.ssh.sshMode !== row.plan.sshMode) {
      throw new Error("Approve the exact current reviewed SSH gate setup plan");
    }
    const snapshot = await this.deps.activeRelease(row.providerInstallationId);
    assertSnapshot(row, snapshot);
    await this.deps.connections.resolveForHost({ connectionId: row.connectionId,
      providerInstallationId: row.providerInstallationId, providerReleaseId: row.providerReleaseId,
      revision: row.connectionRevision });
    await this.deps.database.transaction(async transaction => {
      const approved = releaseRows(await transaction.execute(sql`UPDATE incus_operator_setups
        SET approved_plan_digest = ${planDigest}, approved_by = ${principalId}, approved_at = NOW(), updated_at = NOW()
        WHERE id = ${id} AND state = 'planned' AND approved_plan_digest IS NULL
          AND id = (SELECT id FROM incus_operator_setups WHERE provider_installation_id = ${row.providerInstallationId}
            ORDER BY created_at DESC, id DESC LIMIT 1) RETURNING id`));
      if (approved.length !== 1) throw new Error("The setup approval is stale or already recorded");
      await insertTransactionalAuditEntry(transaction, `incus-gate-approval:${id}:${planDigest}`, principalId,
        "incus:gate-plan-approved", id, { planDigest, releaseId: row.providerReleaseId,
          releaseDigest: row.providerReleaseDigest, generation: row.providerGeneration,
          connectionId: row.connectionId, connectionRevision: row.connectionRevision });
    });
    return publicSetup(await this.row(id));
  }

  async apply(id: string, approvedPlanDigest: string, principalId: string): Promise<PublicSetup> {
    const initial = await this.row(id);
    await this.recoverInterrupted(initial.providerInstallationId);
    const row = await this.row(id);
    assertSetupPlanDigest(row.plan);
    if (row.plan.planDigest !== approvedPlanDigest || row.state === "blocked") {
      throw new Error("The exact ready plan digest must be approved");
    }
    if (row.plan.sshMode !== this.deps.bootstrap.ssh.sshMode) throw new Error("SSH mode changed. Make a new reviewed setup plan.");
    if (row.plan.sshMode === "reviewed-envelope-v1" && (row.approvedPlanDigest !== approvedPlanDigest || !row.approvedBy)) {
      throw new Error("Approve the exact reviewed SSH gate setup plan before Apply");
    }
    const snapshot = await this.deps.activeRelease(row.providerInstallationId);
    assertSnapshot(row, snapshot);
    await this.deps.connections.resolveForHost({ connectionId: row.connectionId,
      providerInstallationId: row.providerInstallationId, providerReleaseId: row.providerReleaseId,
      revision: row.connectionRevision });
    const claimed = releaseRows(await this.deps.database.execute(sql`UPDATE incus_operator_setups
      SET state = 'applying', applied_by = ${principalId}, apply_token = ${BOOT_ID}, updated_at = NOW()
      WHERE id = ${id} AND state IN ('planned', 'review_required', 'reconcile_required')
        AND id = (SELECT id FROM incus_operator_setups WHERE provider_installation_id = ${row.providerInstallationId}
          ORDER BY created_at DESC, id DESC LIMIT 1) RETURNING id`));
    if (claimed.length !== 1) throw new Error("The setup is already running, has completed, or was replaced by a newer plan");
    try {
      const inventory = await (this.deps.inspect ?? inspectIncus)(this.deps.bootstrap.ssh);
      const preflightPlan = createSetupPlan(row.recipe, inventory, incusPresets(snapshot));
      const receipt = await applySetupPlan(row.plan, (this.deps.runner ?? sshRunner)(this.deps.bootstrap.ssh, row.plan.planDigest),
        { execute: true, approvedPlanDigest, preflightPlan });
      let state: SetupState = receipt.state === "dry_run" || receipt.state === "blocked" ? "review_required" : receipt.state;
      let failures: string[] = receipt.blockedReasons ?? [];
      const rejected = receipt.steps.find(step => step.diagnostic?.code === "UNSUPPORTED_CONFIG_KEY");
      if (state === "review_required" && rejected?.diagnostic) {
        failures = [`Incus rejected reviewed configuration key ${rejected.diagnostic.rejectedKey} at ${rejected.id}. Update the recipe and make a new reviewed plan.`];
      }
      if (state === "applied") {
        const current = await (this.deps.inspect ?? inspectIncus)(this.deps.bootstrap.ssh);
        failures = verifySetupPlan(row.plan, row.recipe, current, incusPresets(snapshot));
        state = failures.length ? "review_required" : "verified";
      }
      await this.deps.database.execute(sql`UPDATE incus_operator_setups SET state = ${state},
        receipt = ${JSON.stringify(receipt)}::text::jsonb, failures = ${JSON.stringify(failures)}::text::jsonb,
        apply_token = NULL, updated_at = NOW() WHERE id = ${id} AND state = 'applying' AND apply_token = ${BOOT_ID}`);
      return publicSetup(await this.row(id));
    } catch {
      await this.deps.database.execute(sql`UPDATE incus_operator_setups SET state = 'reconcile_required',
        failures = ${JSON.stringify(["The setup outcome is unknown. Inspect the server before retrying."])}::text::jsonb,
        apply_token = NULL, updated_at = NOW() WHERE id = ${id} AND state = 'applying' AND apply_token = ${BOOT_ID}`);
      return publicSetup(await this.row(id));
    }
  }

  async probe(id: string): Promise<{ setup: PublicSetup; result: unknown }> {
    const row = await this.row(id);
    if (row.state !== "verified") throw new Error("Verify the reviewed server setup before probing the provider");
    const snapshot = await this.deps.activeRelease(row.providerInstallationId);
    assertSnapshot(row, snapshot);
    await this.deps.connections.resolveForHost({ connectionId: row.connectionId,
      providerInstallationId: row.providerInstallationId, providerReleaseId: row.providerReleaseId,
      revision: row.connectionRevision });
    const preset = incusPresets(snapshot).find(item => item.profile === "persistent-web-compose.v1");
    if (!preset) throw new Error("Incus provider release has no reviewed Compose preset");
    const presetDigest = await sandboxPresetDigest(preset);
    const result = await (this.deps.process?.(row.providerInstallationId) ?? new ReleaseProcess(row.providerInstallationId))
      .callIncusProbe({ providerId: "incus", connectionId: row.connectionId, profile: preset.profile,
        presetId: preset.id, presetDigest, effectiveSettingsDigest: digest({ presetDigest, connectionRevision: row.connectionRevision }) }, row.connectionId);
    return { setup: publicSetup(row), result };
  }
}
