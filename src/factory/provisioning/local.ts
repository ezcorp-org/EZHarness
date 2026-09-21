import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, type FileHandle } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { SQL } from "bun";
import { privateDirectory, readPrivateBounded } from "../private-files";

export interface LocalInstallationRequest { tenantId: string; hostname: string; administratorEmail: string }
export interface TemporalNamespaces { create(input: { tenantId: string; namespace: string; secretDirectory: string }): Promise<void> }
export interface LocalProvisionerOptions { controlDatabaseUrl: string; productDatabaseAdminUrl: string; ordinaryConfigPath: string; archiveConfigPath: string; secretsRoot: string; temporal: TemporalNamespaces; afterExternalResourceCreated?: (resource: "role" | "database") => Promise<void> }
export interface LocalInstallation { tenantId: string; installationId: string; productDatabase: string; productRole: string; temporalNamespace: string; secretBundlePath: string; state: "ready" | "partial" }
interface S3Identity { name: string; credentials: Array<{ accessKey: string; secretKey: string }> }
interface S3Config { identities: S3Identity[] }
interface SecretBundle { installationId: string; tenantId: string; product: { database: string; role: string; credentialsPath: string }; storage: { ordinaryCredentialsPath: string; archiveCredentialsPath: string }; application: { jwtSecretPath: string; encryptionSecretPath: string }; temporal: { namespace: string; credentialsPath: string }; invitationId: string }
interface InstallationRecord extends Record<string, string | undefined> { role_oid?: string; database_oid?: string; role_plan?: string; database_plan?: string }
type ProvisionOutcome = { installation: LocalInstallation } | { failure: string };

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
const localName = (prefix: string, tenantId: string) => `${prefix}_${createHash("sha256").update(tenantId).digest("hex").slice(0, 20)}`;
const secret = () => randomBytes(32).toString("base64url");
const resourceMarker = (kind: "role" | "database", record: InstallationRecord): string => kind === "role" ? `factory-provisioner-role:${stored(record, "installation_id")}:${stored(record, "role_plan")}:${stored(record, "database_plan")}` : `factory-provisioner-database:${stored(record, "installation_id")}:${stored(record, "database_plan")}`;
const stored = (record: Record<string, string | undefined>, field: string): string => { const value = record[field]; if (!value) throw new Error(`Installation record has no ${field}.`); return value; };
function assertRequest(request: LocalInstallationRequest): void { if (!/^tenant-\d{2}$/.test(request.tenantId)) throw new Error("Local provisioner requires a generated tenant-XX identity."); if (!/^[a-z0-9][a-z0-9.-]{0,252}$/.test(request.hostname)) throw new Error("Installation hostname is malformed."); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(request.administratorEmail)) throw new Error("First administrator email is malformed."); }
async function privateFile(directory: FileHandle, name: string, value?: string): Promise<void> {
  if (basename(name) !== name) throw new Error("Provisioner secret leaf is invalid.");
  const path = `/proc/self/fd/${directory.fd}/${name}`;
  let handle: FileHandle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || value === undefined) throw error;
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(value); } finally { await handle.close(); }
    return;
  }
  try {
    const status = await handle.stat();
    if (!status.isFile() || status.uid !== process.getuid?.() || (status.mode & 0o077) !== 0) throw new Error("Provisioner secret file must be private and owned by this user.");
  } finally { await handle.close(); }
}
async function readPrivate(directory: FileHandle, name: string): Promise<string> { return new TextDecoder("utf-8", { fatal: true }).decode(await readPrivateBounded(directory, name, 64 * 1024)); }
async function writePrivateJson(directory: FileHandle, name: string, value: unknown): Promise<void> { await privateFile(directory, name, `${JSON.stringify(value)}\n`); }
async function writePrivateText(directory: FileHandle, name: string): Promise<void> { await privateFile(directory, name, `${secret()}\n`); }
async function identity(path: string, tenantId: string): Promise<{ accessKey: string; secretKey: string }> { const config = JSON.parse(await readFile(path, "utf8")) as S3Config; const credential = config.identities.find((entry) => entry.name === tenantId)?.credentials[0]; if (!credential?.accessKey || !credential.secretKey) throw new Error(`Storage identity for ${tenantId} is unavailable.`); return { accessKey: credential.accessKey, secretKey: credential.secretKey }; }

/** C12 resource provisioning. A ready record only means its infrastructure resources exist; application boot status belongs to product composition. */
export class LocalFactoryProvisioner {
  private readonly control: SQL;
  private readonly productAdmin: SQL;
  constructor(private readonly options: LocalProvisionerOptions) { this.control = new SQL(options.controlDatabaseUrl, { max: 4 }); this.productAdmin = new SQL(options.productDatabaseAdminUrl, { max: 2 }); }
  async close(): Promise<void> { await this.control.close(); await this.productAdmin.close(); }
  async setup(): Promise<void> {
    await this.control.begin(async (control) => {
      await control.unsafe("SELECT pg_advisory_xact_lock(hashtext('factory-provisioner-schema-v1'))");
      await control.unsafe("CREATE TABLE IF NOT EXISTS factory_installations (tenant_id text PRIMARY KEY, installation_id text NOT NULL UNIQUE, hostname text NOT NULL UNIQUE, administrator_email text NOT NULL, product_database text NOT NULL UNIQUE, product_role text NOT NULL UNIQUE, temporal_namespace text NOT NULL UNIQUE, secret_bundle_path text NOT NULL, state text NOT NULL CHECK (state IN ('partial','ready')), current_step text NOT NULL, invitation_id text NOT NULL, role_oid oid, database_oid oid, role_plan text, database_plan text)");
      await control.unsafe("ALTER TABLE factory_installations ADD COLUMN IF NOT EXISTS role_oid oid");
      await control.unsafe("ALTER TABLE factory_installations ADD COLUMN IF NOT EXISTS database_oid oid");
      await control.unsafe("ALTER TABLE factory_installations ADD COLUMN IF NOT EXISTS role_plan text");
      await control.unsafe("ALTER TABLE factory_installations ADD COLUMN IF NOT EXISTS database_plan text");
    });
  }
  async provision(request: LocalInstallationRequest): Promise<LocalInstallation> {
    assertRequest(request); await this.setup();
    const database = localName("factory_product", request.tenantId), role = localName("factory_role", request.tenantId), namespace = request.tenantId, directory = resolve(this.options.secretsRoot, request.tenantId);
    // This commit is the durable intent that makes an external DDL crash recoverable.
    await this.control`INSERT INTO factory_installations(tenant_id, installation_id, hostname, administrator_email, product_database, product_role, temporal_namespace, secret_bundle_path, state, current_step, invitation_id, role_plan, database_plan) VALUES (${request.tenantId}, ${randomUUID()}, ${request.hostname}, ${request.administratorEmail}, ${database}, ${role}, ${namespace}, ${directory}, 'partial', 'recorded', ${randomUUID()}, ${randomUUID()}, ${randomUUID()}) ON CONFLICT (tenant_id) DO NOTHING`;
    const outcome = await this.control.begin<ProvisionOutcome>(async (control) => {
      await control`SELECT pg_advisory_xact_lock(hashtextextended(${`factory-provisioner-v1:${request.tenantId}`}::text, 0))`;
      try {
      const existing = (await control`SELECT tenant_id, installation_id, hostname, administrator_email, product_database, product_role, temporal_namespace, secret_bundle_path, state, current_step, invitation_id, role_oid::text, database_oid::text, role_plan, database_plan FROM factory_installations WHERE tenant_id = ${request.tenantId}`)[0] as InstallationRecord | undefined;
      if (existing?.hostname && (existing.hostname !== request.hostname || existing.administrator_email !== request.administratorEmail)) throw new Error("Provisioning request conflicts with its persisted tenant identity.");
      if (existing?.state === "ready") { await this.verifyReady(existing); await this.options.temporal.create({ tenantId: stored(existing, "tenant_id"), namespace: stored(existing, "temporal_namespace"), secretDirectory: stored(existing, "secret_bundle_path") }); return { installation: this.ready(existing) }; }
      const persisted = existing;
      if (!persisted || persisted.hostname !== request.hostname || persisted.administrator_email !== request.administratorEmail || persisted.product_database !== database || persisted.product_role !== role || persisted.temporal_namespace !== namespace || persisted.secret_bundle_path !== directory) throw new Error("Concurrent provisioning record conflicts with its deterministic tenant resources.");
      const stableInstallationId = stored(persisted, "installation_id"), stableInvitationId = stored(persisted, "invitation_id");
      const secrets = await privateDirectory(directory, { createLeaf: true, repairOwnedLeaf: true });
      try {
        const credentials = await this.writeSecretBundle(secrets, request, { directory, database, role, namespace, installationId: stableInstallationId, invitationId: stableInvitationId });
        await this.ensureProductRole(persisted, request.tenantId, role, credentials.password);
        await this.ensureProductDatabase(persisted, request.tenantId, database, role, credentials.password);
        await this.productAdmin.unsafe(`REVOKE ALL ON DATABASE ${quote(database)} FROM PUBLIC`); await this.productAdmin.unsafe(`GRANT CONNECT, TEMPORARY ON DATABASE ${quote(database)} TO ${quote(role)}`);
        await this.verifyProductLogin(database, role, credentials.password);
      } finally { await secrets.close(); }
      await this.options.temporal.create({ tenantId: request.tenantId, namespace, secretDirectory: directory });
      await control`UPDATE factory_installations SET state = 'ready', current_step = 'invitation' WHERE tenant_id = ${request.tenantId}`;
      return { installation: { tenantId: request.tenantId, installationId: stableInstallationId, productDatabase: database, productRole: role, temporalNamespace: namespace, secretBundlePath: directory, state: "ready" } };
      } catch (error) { return { failure: error instanceof Error ? error.message : String(error) }; }
    });
    if ("failure" in outcome) throw new Error(outcome.failure);
    return outcome.installation;
  }
  /**
   * Writes the tenant's secret bundle and hands back the product credential it generated.
   *
   * Every file is written before the bundle that names them, and the product credential is read
   * BACK from disk rather than kept in memory: a bundle that cannot be re-read is not a bundle the
   * installation can boot from.
   */
  private async writeSecretBundle(secrets: FileHandle, request: LocalInstallationRequest, names: { directory: string; database: string; role: string; namespace: string; installationId: string; invitationId: string }): Promise<{ password: string }> {
    const { directory, database, role, namespace } = names;
    const files = { bundle: "installation.json", product: "product-database.json", ordinary: "ordinary-storage.json", archive: "archive-storage.json", jwt: "application-jwt-secret", encryption: "application-encryption-secret", temporal: "temporal.json" } as const;
    await writePrivateJson(secrets, files.product, { role, password: secret() }); await writePrivateJson(secrets, files.ordinary, await identity(this.options.ordinaryConfigPath, request.tenantId)); await writePrivateJson(secrets, files.archive, await identity(this.options.archiveConfigPath, request.tenantId)); await writePrivateText(secrets, files.jwt); await writePrivateText(secrets, files.encryption);
    await writePrivateJson(secrets, files.bundle, { installationId: names.installationId, tenantId: request.tenantId, product: { database, role, credentialsPath: join(directory, files.product) }, storage: { ordinaryCredentialsPath: join(directory, files.ordinary), archiveCredentialsPath: join(directory, files.archive) }, application: { jwtSecretPath: join(directory, files.jwt), encryptionSecretPath: join(directory, files.encryption) }, temporal: { namespace, credentialsPath: join(directory, files.temporal) }, invitationId: names.invitationId } satisfies SecretBundle);
    const credentials = JSON.parse(await readPrivate(secrets, files.product)) as { password: string }; if (!/^[A-Za-z0-9_-]{43}$/.test(credentials.password)) throw new Error("Product credential has an invalid format.");
    return credentials;
  }

  /**
   * Brings the product role into existence exactly once, and records its oid.
   *
   * The control updates here deliberately run on `this.control`, OUTSIDE the provisioning
   * transaction: an oid recorded only on commit would be lost by a fault between the external DDL
   * and the commit, and the next attempt would meet a role it could not prove it created.
   */
  private async ensureProductRole(persisted: InstallationRecord, tenantId: string, role: string, password: string): Promise<void> {
    const expectedRoleMarker = resourceMarker("role", persisted);
    let roleRecord = (await this.productAdmin`SELECT oid::text, rolcanlogin, shobj_description(oid, 'pg_authid') AS marker FROM pg_roles WHERE rolname = ${role}`)[0] as { oid: string; rolcanlogin: boolean; marker: string | null } | undefined;
    if (roleRecord && (!roleRecord.rolcanlogin || roleRecord.marker !== expectedRoleMarker || (persisted.role_oid && persisted.role_oid !== roleRecord.oid))) throw new Error("Product role exists without recorded provisioning provenance.");
    if (!roleRecord) {
      const statements = (await this.productAdmin`SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', ${role}::text, ${password}::text) AS create_statement, format('COMMENT ON ROLE %I IS %L', ${role}::text, ${expectedRoleMarker}::text) AS marker_statement`)[0] as { create_statement: string; marker_statement: string };
      // Roles are transactional. A fault after CREATE but before COMMENT rolls both back.
      await this.productAdmin.begin(async (product) => { await product.unsafe(statements.create_statement); await this.options.afterExternalResourceCreated?.("role"); await product.unsafe(statements.marker_statement); });
      roleRecord = (await this.productAdmin`SELECT oid::text, rolcanlogin, shobj_description(oid, 'pg_authid') AS marker FROM pg_roles WHERE rolname = ${role}`)[0] as { oid: string; rolcanlogin: boolean; marker: string | null } | undefined;
      if (!roleRecord?.rolcanlogin || roleRecord.marker !== expectedRoleMarker) throw new Error("Product role creation did not persist its trusted marker.");
    }
    if (!roleRecord) throw new Error("Product role creation did not persist.");
    if (persisted.role_oid !== roleRecord.oid) { await this.control`UPDATE factory_installations SET current_step = 'role', role_oid = ${roleRecord.oid}::oid WHERE tenant_id = ${tenantId}`; persisted.role_oid = roleRecord.oid; persisted.current_step = "role"; }
  }

  /**
   * Brings the product database into existence exactly once, and records its oid.
   *
   * `CREATE DATABASE` cannot share a transaction with its `COMMENT`, so the interrupted case is
   * recognised rather than guessed: the recorded phase, a marked role, and an actual credential
   * login together identify a creation this provisioner started and nothing else.
   */
  private async ensureProductDatabase(persisted: InstallationRecord, tenantId: string, database: string, role: string, password: string): Promise<void> {
    const expectedDatabaseMarker = resourceMarker("database", persisted);
    let databaseRecord = (await this.productAdmin`SELECT oid::text, pg_get_userbyid(datdba) AS owner, shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = ${database}`)[0] as { oid: string; owner: string; marker: string | null } | undefined;
    const mayReconcileUnmarkedDatabase = databaseRecord?.owner === role && databaseRecord.marker === null && !persisted.database_oid && persisted.current_step === "database-creating";
    if (databaseRecord && !mayReconcileUnmarkedDatabase && (databaseRecord.owner !== role || databaseRecord.marker !== expectedDatabaseMarker || (persisted.database_oid && persisted.database_oid !== databaseRecord.oid))) throw new Error("Product database exists without recorded provisioning provenance.");
    if (mayReconcileUnmarkedDatabase) {
      await this.verifyProductLogin(database, role, password);
      const markerStatement = (await this.productAdmin`SELECT format('COMMENT ON DATABASE %I IS %L', ${database}::text, ${expectedDatabaseMarker}::text) AS statement`)[0] as { statement: string };
      await this.productAdmin.unsafe(markerStatement.statement);
      databaseRecord = (await this.productAdmin`SELECT oid::text, pg_get_userbyid(datdba) AS owner, shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = ${database}`)[0] as { oid: string; owner: string; marker: string | null } | undefined;
    }
    if (!databaseRecord) {
      // Commit the precise pre-DDL phase before CREATE DATABASE; unlike roles, databases cannot use a transaction for CREATE plus COMMENT.
      await this.control`UPDATE factory_installations SET current_step = 'database-creating' WHERE tenant_id = ${tenantId} AND state = 'partial' AND database_oid IS NULL`;
      persisted.current_step = "database-creating";
      const statements = (await this.productAdmin`SELECT format('CREATE DATABASE %I OWNER %I', ${database}::text, ${role}::text) AS create_statement, format('COMMENT ON DATABASE %I IS %L', ${database}::text, ${expectedDatabaseMarker}::text) AS marker_statement`)[0] as { create_statement: string; marker_statement: string };
      await this.productAdmin.unsafe(statements.create_statement); await this.options.afterExternalResourceCreated?.("database"); await this.productAdmin.unsafe(statements.marker_statement);
      databaseRecord = (await this.productAdmin`SELECT oid::text, pg_get_userbyid(datdba) AS owner, shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = ${database}`)[0] as { oid: string; owner: string; marker: string | null } | undefined;
      if (!databaseRecord || databaseRecord.owner !== role || databaseRecord.marker !== expectedDatabaseMarker) throw new Error("Product database creation did not persist its trusted marker.");
    }
    if (!databaseRecord || databaseRecord.marker !== expectedDatabaseMarker) throw new Error("Product database creation did not persist its trusted marker.");
    if (persisted.database_oid !== databaseRecord.oid) { await this.control`UPDATE factory_installations SET current_step = 'database', database_oid = ${databaseRecord.oid}::oid WHERE tenant_id = ${tenantId}`; persisted.database_oid = databaseRecord.oid; persisted.current_step = "database"; }
  }

  private async verifyProductLogin(database: string, role: string, password: string): Promise<void> {
    const productUrl = new URL(this.options.productDatabaseAdminUrl); productUrl.pathname = `/${database}`; productUrl.username = role; productUrl.password = password;
    const product = new SQL(productUrl.toString(), { max: 1 }); try { const row = (await product`SELECT current_database() AS name`)[0] as { name: string } | undefined; if (row?.name !== database) throw new Error("Product credential connected to the wrong database."); } finally { await product.close(); }
  }
  private ready(existing: InstallationRecord): LocalInstallation { return { tenantId: stored(existing, "tenant_id"), installationId: stored(existing, "installation_id"), productDatabase: stored(existing, "product_database"), productRole: stored(existing, "product_role"), temporalNamespace: stored(existing, "temporal_namespace"), secretBundlePath: stored(existing, "secret_bundle_path"), state: "ready" }; }
  private async verifyReady(existing: InstallationRecord): Promise<void> {
    const directory = stored(existing, "secret_bundle_path"), role = stored(existing, "product_role"), database = stored(existing, "product_database");
    const secrets = await privateDirectory(directory);
    try {
      for (const file of ["installation.json", "product-database.json", "ordinary-storage.json", "archive-storage.json", "application-jwt-secret", "application-encryption-secret", "temporal.json", "temporal-token"]) await privateFile(secrets, file);
      const manifest = JSON.parse(await readPrivate(secrets, "installation.json")) as SecretBundle;
      if (manifest.installationId !== stored(existing, "installation_id") || manifest.tenantId !== stored(existing, "tenant_id") || manifest.invitationId !== stored(existing, "invitation_id") || manifest.product.database !== database || manifest.product.role !== role || manifest.temporal.namespace !== stored(existing, "temporal_namespace")) throw new Error("Ready installation bundle does not match its persisted identity.");
      const credentials = JSON.parse(await readPrivate(secrets, "product-database.json")) as { role: string; password: string };
      if (credentials.role !== role || !/^[A-Za-z0-9_-]{43}$/.test(credentials.password)) throw new Error("Ready installation product credentials are invalid.");
      const ordinary = JSON.parse(await readPrivate(secrets, "ordinary-storage.json")) as { accessKey?: string; secretKey?: string };
      const archive = JSON.parse(await readPrivate(secrets, "archive-storage.json")) as { accessKey?: string; secretKey?: string };
      const expectedOrdinary = await identity(this.options.ordinaryConfigPath, stored(existing, "tenant_id")); const expectedArchive = await identity(this.options.archiveConfigPath, stored(existing, "tenant_id"));
      if (ordinary.accessKey !== expectedOrdinary.accessKey || ordinary.secretKey !== expectedOrdinary.secretKey || archive.accessKey !== expectedArchive.accessKey || archive.secretKey !== expectedArchive.secretKey) throw new Error("Ready installation storage credentials are invalid.");
      await this.verifyProductLogin(database, role, credentials.password);
    } finally { await secrets.close(); }
    const roleRecord = (await this.productAdmin`SELECT oid::text, rolcanlogin, shobj_description(oid, 'pg_authid') AS marker FROM pg_roles WHERE rolname = ${role}`)[0] as { oid: string; rolcanlogin: boolean; marker: string | null } | undefined;
    const databaseRecord = (await this.productAdmin`SELECT oid::text, pg_get_userbyid(datdba) AS owner, shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = ${database}`)[0] as { oid: string; owner: string; marker: string | null } | undefined;
    if (!roleRecord?.rolcanlogin || roleRecord.oid !== existing.role_oid || roleRecord.marker !== resourceMarker("role", existing) || !databaseRecord || databaseRecord.oid !== existing.database_oid || databaseRecord.owner !== role || databaseRecord.marker !== resourceMarker("database", existing)) throw new Error("Ready installation lost verified product resources.");
    await this.productAdmin.unsafe(`REVOKE ALL ON DATABASE ${quote(database)} FROM PUBLIC`); await this.productAdmin.unsafe(`GRANT CONNECT, TEMPORARY ON DATABASE ${quote(database)} TO ${quote(role)}`);
  }
}
