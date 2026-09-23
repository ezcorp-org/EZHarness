import { sql } from "drizzle-orm";
import { DatabaseLifecycleRepository, releaseRows, type ReleaseDatabase } from "../../db/queries/extension-releases";
import { decryptWithAad, encryptWithAad } from "../../providers/encryption";

/** Reviewed provider setup values. Add another kind only with a host parser. */
export type ProviderConnectionConfiguration = {
  kind: "incus";
  profile: string;
  helperVersion: string;
  guestUser: string;
};

export interface ProviderConnectionMetadata {
  id: string;
  revision: number;
  providerInstallationId: string;
  providerReleaseId: string;
  endpoint: string;
  serverCertificatePem: string;
  project: string;
  configuration: ProviderConnectionConfiguration;
  clientCertificatePem: string;
  revokedAt: Date | null;
}

export type CreateProviderConnection = Omit<ProviderConnectionMetadata, "revision" | "revokedAt"> & { privateKeyPem: string };
export type ProviderConnectionCredentials = ProviderConnectionMetadata & { privateKeyPem: string };
export type ProviderConnectionScope = { connectionId: string; providerInstallationId: string; providerReleaseId: string; revision: number };

type DatabaseRow = Omit<ProviderConnectionMetadata, "configuration"> & { configuration: unknown };
type Row = DatabaseRow & { privateKeyCiphertext: string };
const metadataColumns = sql`id, revision, provider_installation_id AS "providerInstallationId", provider_release_id AS "providerReleaseId",
  endpoint, server_certificate_pem AS "serverCertificatePem", project, configuration,
  client_certificate_pem AS "clientCertificatePem", revoked_at AS "revokedAt"`;
const credentialColumns = sql`${metadataColumns}, private_key_ciphertext AS "privateKeyCiphertext"`;

function parseConfiguration(value: unknown): ProviderConnectionConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid provider configuration");
  const config = value as Record<string, unknown>;
  if (Object.keys(config).sort().join(",") !== "guestUser,helperVersion,kind,profile" || config.kind !== "incus" ||
    typeof config.profile !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(config.profile) || config.profile === "default" ||
    typeof config.helperVersion !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/.test(config.helperVersion) ||
    typeof config.guestUser !== "string" || !/^[a-z_][a-z0-9_-]{0,31}$/.test(config.guestUser)) {
    throw new Error("Invalid provider configuration");
  }
  return { kind: "incus", profile: config.profile, helperVersion: config.helperVersion, guestUser: config.guestUser };
}

function aadFor(row: ProviderConnectionMetadata): string {
  // All pinned identity and destination fields are authenticated. Changing any
  // field, copying a ciphertext, or reading an older revision fails GCM.
  return JSON.stringify(["provider-connection-v1", row.id, row.revision, row.providerInstallationId,
    row.providerReleaseId, row.endpoint, row.serverCertificatePem, row.project, row.clientCertificatePem,
    row.configuration.kind, row.configuration.profile, row.configuration.helperVersion, row.configuration.guestUser]);
}

function metadata(row: DatabaseRow): ProviderConnectionMetadata {
  return {
    id: row.id, revision: row.revision, providerInstallationId: row.providerInstallationId,
    providerReleaseId: row.providerReleaseId, endpoint: row.endpoint,
    serverCertificatePem: row.serverCertificatePem, project: row.project,
    configuration: parseConfiguration(row.configuration),
    clientCertificatePem: row.clientCertificatePem, revokedAt: row.revokedAt,
  };
}

function assertInput(input: CreateProviderConnection): void {
  for (const value of [input.id, input.providerInstallationId, input.providerReleaseId, input.serverCertificatePem,
    input.project, input.clientCertificatePem, input.privateKeyPem]) {
    if (typeof value !== "string" || value.length === 0) throw new Error("Invalid provider connection");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(input.id) ||
    !/^[a-z][a-z0-9-]{0,62}$/.test(input.project) || input.project === "default") {
    throw new Error("Invalid provider connection");
  }
  let url: URL;
  try { url = new URL(input.endpoint); } catch { throw new Error("Invalid provider endpoint"); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Invalid provider endpoint");
  }
  parseConfiguration(input.configuration);
}

export class ProviderConnectionStore {
  private readonly lifecycle: DatabaseLifecycleRepository;

  constructor(private readonly database: ReleaseDatabase) {
    this.lifecycle = new DatabaseLifecycleRepository(database);
  }

  private async assertActive(installationId: string, releaseId: string, transaction: Parameters<DatabaseLifecycleRepository["read"]>[1]): Promise<void> {
    const state = await this.lifecycle.read(installationId, transaction);
    if (!state) throw new Error("Provider release is not active and approved");
    const installation = state.installation;
    const release = state.releases[releaseId];
    if (!installation.enabled || installation.uninstalled || installation.status !== "active" ||
      installation.activeReleaseId !== releaseId || installation.acknowledgedGeneration !== installation.generation || !release ||
      !Object.values(state.approvals).some((approval) => approval.status === "consumed" &&
        approval.releaseId === releaseId && approval.releaseDigest === release.releaseDigest &&
        approval.expectedGeneration === installation.generation - 1 &&
        approval.principalId === installation.ownerId && approval.scope === installation.scope)) {
      throw new Error("Provider release is not active and approved");
    }
  }

  async create(input: CreateProviderConnection): Promise<ProviderConnectionMetadata> {
    assertInput(input);
    return this.database.transaction(async (transaction) => {
      await this.assertActive(input.providerInstallationId, input.providerReleaseId, transaction);
      const row: ProviderConnectionMetadata = { ...input, configuration: parseConfiguration(input.configuration), revision: 1, revokedAt: null };
      const ciphertext = encryptWithAad(input.privateKeyPem, aadFor(row));
      await transaction.execute(sql`INSERT INTO provider_connections
        (id, revision, provider_installation_id, provider_release_id, endpoint, server_certificate_pem,
         project, configuration, client_certificate_pem, private_key_ciphertext)
        VALUES (${input.id}, 1, ${input.providerInstallationId}, ${input.providerReleaseId}, ${input.endpoint},
          ${input.serverCertificatePem}, ${input.project}, ${JSON.stringify(row.configuration)}::text::jsonb,
          ${input.clientCertificatePem}, ${ciphertext})`);
      return metadata(row);
    });
  }

  async getMetadata(id: string): Promise<ProviderConnectionMetadata | null> {
    const rows = releaseRows<DatabaseRow>(await this.database.execute(sql`SELECT ${metadataColumns} FROM provider_connections WHERE id = ${id}`));
    return rows[0] ? metadata(rows[0]) : null;
  }

  /** Trusted host use only. Never expose this result to an extension or RPC reply. */
  async resolveForHost(scope: ProviderConnectionScope): Promise<ProviderConnectionCredentials> {
    return this.resolveScoped(scope, null);
  }

  /** Cleanup only: the caller must also prove a retained binding and journal. */
  async resolveRetiredForHost(scope: ProviderConnectionScope, releaseDigest: string): Promise<ProviderConnectionCredentials> {
    if (!releaseDigest) throw new Error("Retired provider release is unavailable");
    return this.resolveScoped(scope, releaseDigest);
  }

  /** Read the immutable release and historical approval for exact host cleanup. */
  async loadRetiredRelease(installationId: string, releaseId: string) {
    return this.database.transaction(transaction => this.retiredRelease(installationId, releaseId, transaction));
  }

  private async retiredRelease(installationId: string, releaseId: string,
    transaction: Parameters<DatabaseLifecycleRepository["read"]>[1], digest?: string) {
    const state = await this.lifecycle.read(installationId, transaction);
    const release = state?.releases[releaseId];
    if (!state || state.installation.id !== installationId || !release || release.id !== releaseId
      || release.installationId !== installationId || digest && release.releaseDigest !== digest
      || state.installation.enabled && state.installation.status === "active"
        && state.installation.activeReleaseId === releaseId
      || !Object.values(state.approvals).some(approval => approval.status === "consumed"
        && approval.releaseId === releaseId && approval.releaseDigest === release.releaseDigest
        && approval.principalId === state.installation.ownerId && approval.scope === state.installation.scope)) {
      throw new Error("Retired provider release is unavailable");
    }
    return { installation: state.installation, release };
  }

  private async resolveScoped(scope: ProviderConnectionScope, retiredDigest: string | null): Promise<ProviderConnectionCredentials> {
    return this.database.transaction(async (transaction) => {
      const rows = releaseRows<Row>(await transaction.execute(sql`SELECT ${credentialColumns} FROM provider_connections
        WHERE id = ${scope.connectionId} FOR SHARE`));
      const row = rows[0];
      if (!row || row.revokedAt || row.revision !== scope.revision ||
        row.providerInstallationId !== scope.providerInstallationId || row.providerReleaseId !== scope.providerReleaseId) {
        throw new Error("Provider connection is missing, stale, or revoked");
      }
      if (retiredDigest === null) await this.assertActive(row.providerInstallationId, row.providerReleaseId, transaction);
      else await this.retiredRelease(scope.providerInstallationId, scope.providerReleaseId, transaction, retiredDigest);
      try {
        const publicRow = metadata(row);
        return { ...publicRow, privateKeyPem: decryptWithAad(row.privateKeyCiphertext, aadFor(publicRow)) };
      } catch {
        throw new Error("Provider connection authentication failed");
      }
    });
  }

  async revoke(id: string, expectedRevision: number): Promise<void> {
    const rows = releaseRows(await this.database.execute(sql`UPDATE provider_connections
      SET revision = revision + 1, revoked_at = NOW(), updated_at = NOW()
      WHERE id = ${id} AND revision = ${expectedRevision} AND revoked_at IS NULL RETURNING id`));
    if (rows.length !== 1) throw new Error("Provider connection is missing, stale, or revoked");
  }
}
