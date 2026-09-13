import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SQL } from "bun";

export interface LocalInstallationRequest { tenantId: string; hostname: string; administratorEmail: string }
export interface TemporalNamespaces { create(input: { tenantId: string; namespace: string; secretDirectory: string }): Promise<void> }
export interface LocalProvisionerOptions { controlDatabaseUrl: string; productDatabaseAdminUrl: string; ordinaryConfigPath: string; archiveConfigPath: string; secretsRoot: string; temporal: TemporalNamespaces }
export interface LocalInstallation { tenantId: string; installationId: string; productDatabase: string; productRole: string; temporalNamespace: string; secretBundlePath: string; state: "ready" | "partial" }
interface S3Identity { name: string; credentials: Array<{ accessKey: string; secretKey: string }> }
interface S3Config { identities: S3Identity[] }
interface SecretBundle { installationId: string; tenantId: string; product: { database: string; role: string; credentialsPath: string }; storage: { ordinaryCredentialsPath: string; archiveCredentialsPath: string }; application: { jwtSecretPath: string; encryptionSecretPath: string }; temporal: { namespace: string; credentialsPath: string }; invitationId: string }
const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
const localName = (prefix: string, tenantId: string) => `${prefix}_${createHash("sha256").update(tenantId).digest("hex").slice(0, 20)}`;
const secret = () => randomBytes(32).toString("base64url");
function assertRequest(request: LocalInstallationRequest): void { if (!/^tenant-\d{2}$/.test(request.tenantId)) throw new Error("Local provisioner requires a generated tenant-XX identity."); if (!/^[a-z0-9][a-z0-9.-]{0,252}$/.test(request.hostname)) throw new Error("Installation hostname is malformed."); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(request.administratorEmail)) throw new Error("First administrator email is malformed."); }
async function privateDirectory(path: string): Promise<void> { await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700); const status = await lstat(path); if (!status.isDirectory() || status.isSymbolicLink() || status.uid !== process.getuid?.() || (status.mode & 0o077) !== 0) throw new Error("Provisioner secret directory must be private and owned by this user."); }
async function writePrivateJson(path: string, value: unknown): Promise<void> { try { await lstat(path); } catch { await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" }); } await chmod(path, 0o600); }
async function writePrivateText(path: string): Promise<void> { try { await lstat(path); } catch { await writeFile(path, `${secret()}\n`, { mode: 0o600, flag: "wx" }); } await chmod(path, 0o600); }
async function identity(path: string, tenantId: string): Promise<{ accessKey: string; secretKey: string }> { const config = JSON.parse(await readFile(path, "utf8")) as S3Config; const credential = config.identities.find((entry) => entry.name === tenantId)?.credentials[0]; if (!credential?.accessKey || !credential.secretKey) throw new Error(`Storage identity for ${tenantId} is unavailable.`); return { accessKey: credential.accessKey, secretKey: credential.secretKey }; }
async function bundle(path: string): Promise<SecretBundle> { return JSON.parse(await readFile(path, "utf8")) as SecretBundle; }

/** Local C12 provisioner. Its control database has only public identifiers and private bundle paths. */
export class LocalFactoryProvisioner {
  private readonly control: SQL;
  private readonly productAdmin: SQL;
  constructor(private readonly options: LocalProvisionerOptions) { this.control = new SQL(options.controlDatabaseUrl, { max: 2 }); this.productAdmin = new SQL(options.productDatabaseAdminUrl, { max: 2 }); }
  async close(): Promise<void> { await this.control.close(); await this.productAdmin.close(); }
  async setup(): Promise<void> { await this.control.unsafe("CREATE TABLE IF NOT EXISTS factory_installations (tenant_id text PRIMARY KEY, installation_id text NOT NULL UNIQUE, hostname text NOT NULL UNIQUE, administrator_email text NOT NULL, product_database text NOT NULL UNIQUE, product_role text NOT NULL UNIQUE, temporal_namespace text NOT NULL UNIQUE, secret_bundle_path text NOT NULL, state text NOT NULL CHECK (state IN ('partial','ready')), current_step text NOT NULL, invitation_id text NOT NULL)"); }
  async provision(request: LocalInstallationRequest): Promise<LocalInstallation> {
    assertRequest(request); await this.setup();
    const database = localName("factory_product", request.tenantId), role = localName("factory_role", request.tenantId), namespace = request.tenantId, directory = resolve(this.options.secretsRoot, request.tenantId);
    const existing = (await this.control`SELECT tenant_id, installation_id, product_database, product_role, temporal_namespace, secret_bundle_path, state FROM factory_installations WHERE tenant_id = ${request.tenantId}`)[0] as Record<string, string> | undefined;
    if (existing?.state === "ready") return this.ready(existing);
    const installationId = existing?.installation_id ?? randomUUID(), invitationId = existing?.invitation_id ?? randomUUID();
    await this.control`INSERT INTO factory_installations(tenant_id, installation_id, hostname, administrator_email, product_database, product_role, temporal_namespace, secret_bundle_path, state, current_step, invitation_id) VALUES (${request.tenantId}, ${installationId}, ${request.hostname}, ${request.administratorEmail}, ${database}, ${role}, ${namespace}, ${directory}, 'partial', 'recorded', ${invitationId}) ON CONFLICT (tenant_id) DO NOTHING`;
    await privateDirectory(directory);
    const bundlePath = join(directory, "installation.json"), productCredentialsPath = join(directory, "product-database.json"), ordinaryPath = join(directory, "ordinary-storage.json"), archivePath = join(directory, "archive-storage.json"), jwtPath = join(directory, "application-jwt-secret"), encryptionPath = join(directory, "application-encryption-secret"), temporalPath = join(directory, "temporal.json");
    await writePrivateJson(productCredentialsPath, { role, password: secret() }); await writePrivateJson(ordinaryPath, await identity(this.options.ordinaryConfigPath, request.tenantId)); await writePrivateJson(archivePath, await identity(this.options.archiveConfigPath, request.tenantId)); await writePrivateText(jwtPath); await writePrivateText(encryptionPath);
    await writePrivateJson(bundlePath, { installationId, tenantId: request.tenantId, product: { database, role, credentialsPath: productCredentialsPath }, storage: { ordinaryCredentialsPath: ordinaryPath, archiveCredentialsPath: archivePath }, application: { jwtSecretPath: jwtPath, encryptionSecretPath: encryptionPath }, temporal: { namespace, credentialsPath: temporalPath }, invitationId } satisfies SecretBundle);
    const product = await bundle(bundlePath); const credentials = JSON.parse(await readFile(product.product.credentialsPath, "utf8")) as { password: string };
    const roleExists = (await this.productAdmin`SELECT 1 FROM pg_roles WHERE rolname = ${role}`)[0]; if (!roleExists) await this.productAdmin.unsafe(`CREATE ROLE ${quote(role)} LOGIN PASSWORD '${credentials.password}'`);
    const databaseExists = (await this.productAdmin`SELECT 1 FROM pg_database WHERE datname = ${database}`)[0]; if (!databaseExists) await this.productAdmin.unsafe(`CREATE DATABASE ${quote(database)} OWNER ${quote(role)}`);
    await this.control`UPDATE factory_installations SET current_step = 'database' WHERE tenant_id = ${request.tenantId}`;
    await this.options.temporal.create({ tenantId: request.tenantId, namespace, secretDirectory: directory });
    await this.control`UPDATE factory_installations SET state = 'ready', current_step = 'invitation' WHERE tenant_id = ${request.tenantId}`;
    return { tenantId: request.tenantId, installationId, productDatabase: database, productRole: role, temporalNamespace: namespace, secretBundlePath: directory, state: "ready" };
  }
  private ready(existing: Record<string, string>): LocalInstallation { const value = (field: string) => { const result = existing[field]; if (!result) throw new Error(`Ready installation has no ${field}.`); return result; }; return { tenantId: value("tenant_id"), installationId: value("installation_id"), productDatabase: value("product_database"), productRole: value("product_role"), temporalNamespace: value("temporal_namespace"), secretBundlePath: value("secret_bundle_path"), state: "ready" }; }
}
