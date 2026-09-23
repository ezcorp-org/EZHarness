import { randomUUID, X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { sql } from "drizzle-orm";
import { sandboxPresetDigest } from "@ezcorp/extension-contract";
import recipeTemplate from "../../../scripts/incus/recipe.json";
import { applySetupPlan } from "../../../scripts/incus/apply";
import { inspectIncus, sshRunner, type RemoteRunner } from "../../../scripts/incus/inspect";
import type { ApplyReceipt, IncusConnection, IncusSetupPlan, IncusSetupRecipe } from "../../../scripts/incus/model";
import { assertSetupPlanDigest, digest } from "../../../scripts/incus/model";
import { createSetupPlan, verifySetupPlan } from "../../../scripts/incus/plan";
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

export type PublicSetup = Pick<SetupRow, "id" | "providerInstallationId" | "providerReleaseId" | "providerReleaseDigest" | "providerGeneration" | "connectionId" | "connectionRevision" | "plannedBy" | "appliedBy" | "plan" | "state" | "receipt" | "failures" | "createdAt" | "updatedAt">;

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
  runner?: (connection: IncusConnection) => RemoteRunner;
  identity?: typeof issueIncusClientIdentity;
  recipe?: IncusSetupRecipe;
  process?: (installationId: string) => Pick<ReleaseProcess, "callIncusProbe">;
}

const columns = sql`id, provider_installation_id AS "providerInstallationId", provider_release_id AS "providerReleaseId",
  provider_release_digest AS "providerReleaseDigest", provider_generation AS "providerGeneration",
  connection_id AS "connectionId", connection_revision AS "connectionRevision", planned_by AS "plannedBy", applied_by AS "appliedBy", apply_token AS "applyToken",
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
  const endpoint = env.EZCORP_INCUS_SETUP_ENDPOINT;
  if (![target, identity, knownHosts, hostKey, endpoint].every(Boolean)) return null;
  let url: URL;
  try { url = new URL(endpoint!); }
  catch { throw new Error("Incus setup endpoint must be a bare HTTPS origin"); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Incus setup endpoint must be a bare HTTPS origin");
  }
  return { ssh: { sshTarget: target!, sshIdentityFile: identity!, sshKnownHostsFile: knownHosts!, sshHostKeySha256: hostKey! }, endpoint: url.origin };
}

/** One saved review controls one exact release, connection, recipe, and plan. */
export class IncusOperatorSetupService {
  constructor(private readonly deps: SetupDependencies) {}

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
    const identity = await (this.deps.identity ?? issueIncusClientIdentity)(connectionId);
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

  async apply(id: string, approvedPlanDigest: string, principalId: string): Promise<PublicSetup> {
    const initial = await this.row(id);
    await this.recoverInterrupted(initial.providerInstallationId);
    const row = await this.row(id);
    assertSetupPlanDigest(row.plan);
    if (row.plan.planDigest !== approvedPlanDigest || row.state === "blocked") {
      throw new Error("The exact ready plan digest must be approved");
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
      const receipt = await applySetupPlan(row.plan, (this.deps.runner ?? sshRunner)(this.deps.bootstrap.ssh),
        { execute: true, approvedPlanDigest, preflightPlan });
      let state: SetupState = receipt.state === "dry_run" || receipt.state === "blocked" ? "review_required" : receipt.state;
      let failures: string[] = receipt.blockedReasons ?? [];
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
