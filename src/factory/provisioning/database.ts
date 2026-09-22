/**
 * C12 step 1: the installation's PostgreSQL databases and login roles, each
 * with a generated password.
 *
 * Two pairs today. The PRODUCT pair is the tenant's own database. The POOL pair
 * backs the installation's pool admission ledger: the pool process pins its
 * database to one installation (`factory_pool_identity`), and the product only
 * accepts a pool readiness record carrying its own installation ID, so until
 * the shared-readiness ruling lands every installation runs its own pool over
 * its own ledger. Both pairs go through the same code.
 *
 * The algorithm is the v1 one, generalised to a pair and moved onto the step
 * ledger. A role and its ownership marker are created in ONE transaction, so a
 * crash leaves both or neither. `CREATE DATABASE` cannot share a transaction
 * with its marker, so the pre-DDL phase is committed first and the interrupted
 * case is RECOGNISED rather than guessed: the recorded phase, a marked role that
 * owns the database, and an actual login together identify a creation this
 * provisioner started. A same-named resource with any other provenance is
 * refused, never adopted, and never dropped.
 */
import { SQL } from "bun";
import type { FactoryInstallationContext, FactoryProvisioningDriver, FactoryStepResources } from "./installation";
import { factoryFleetResourceName } from "./installation";
import { ensureFactoryPrivateFile, factoryPrivatePath, openFactoryPrivateDirectory, readFactoryPrivateJson, replaceFactoryPrivateFile } from "./secret-files";
import { FactoryProvisioningError } from "./steps";
import { randomBytes } from "node:crypto";

export type FactoryDatabaseKind = "product" | "pool";
export const FACTORY_DATABASE_KINDS: readonly FactoryDatabaseKind[] = Object.freeze(["product", "pool"]);

export interface FactoryDatabasePair {
  readonly kind: FactoryDatabaseKind;
  readonly role: string;
  readonly database: string;
  readonly credentialFile: string;
}

export interface FactoryDatabaseCredential { readonly role: string; readonly password: string }

export interface FactoryDatabaseStepOptions {
  /** A superuser-capable URL on the cluster the databases live in. Operator-only. */
  readonly adminUrl: string;
  /** Records progress inside the step so a crash between two DDL statements keeps what was created. */
  readonly progress: (installation: FactoryInstallationContext, resources: FactoryStepResources) => Promise<void>;
  /** Fault injection for the crash-recovery tests; never set in production. */
  readonly afterExternalResourceCreated?: (resource: "role" | "database", kind: FactoryDatabaseKind) => Promise<void>;
}

const PASSWORD = /^[A-Za-z0-9_-]{43}$/;
const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

export function factoryDatabasePairs(installation: FactoryInstallationContext): readonly FactoryDatabasePair[] {
  return Object.freeze([
    Object.freeze({ kind: "product" as const, role: installation.productRole, database: installation.productDatabase, credentialFile: "product-database.json" }),
    Object.freeze({ kind: "pool" as const, role: factoryFleetResourceName("factory_poolrole", installation.fleetId, installation.tenantId), database: factoryFleetResourceName("factory_pool", installation.fleetId, installation.tenantId), credentialFile: "pool-database-credential.json" }),
  ]);
}

export function factoryDatabaseMarker(resource: "role" | "database", installation: FactoryInstallationContext, pair: FactoryDatabasePair, plan: string): string {
  return `factory-provisioner-${resource}:${installation.fleetId}:${installation.installationId}:${pair.kind}:${plan}`;
}

interface RoleRow { oid: string; rolcanlogin: boolean; marker: string | null }
interface DatabaseRow { oid: string; owner: string; marker: string | null }

export class FactoryDatabaseStep implements FactoryProvisioningDriver {
  readonly step = "database" as const;
  private readonly admin: SQL;
  constructor(private readonly options: FactoryDatabaseStepOptions) { this.admin = new SQL(options.adminUrl, { max: 2 }); }
  async close(): Promise<void> { await this.admin.close(); }

  async ensure(installation: FactoryInstallationContext, recorded: FactoryStepResources | undefined): Promise<FactoryStepResources> {
    const progress: Record<string, string> = { ...(recorded ?? {}) };
    const record = async (update: Record<string, string>) => { Object.assign(progress, update); await this.options.progress(installation, update); };
    for (const pair of factoryDatabasePairs(installation)) {
      const plan = progress[`${pair.kind}Plan`] ?? randomBytes(12).toString("hex");
      if (!progress[`${pair.kind}Plan`]) await record({ [`${pair.kind}Plan`]: plan });
      const credential = await this.credential(installation, pair);
      await this.ensureRole(installation, pair, plan, credential.password, progress, record);
      await this.ensureDatabase(installation, pair, plan, credential.password, progress, record);
      await this.admin.unsafe(`REVOKE ALL ON DATABASE ${quote(pair.database)} FROM PUBLIC`);
      await this.admin.unsafe(`GRANT CONNECT, TEMPORARY ON DATABASE ${quote(pair.database)} TO ${quote(pair.role)}`);
      await this.login(pair, credential.password);
    }
    const resources = this.resources(installation, progress);
    await this.verify(installation, resources);
    return resources;
  }

  async verify(installation: FactoryInstallationContext, resources: FactoryStepResources): Promise<void> {
    for (const pair of factoryDatabasePairs(installation)) {
      const plan = resources[`${pair.kind}Plan`];
      if (!plan) throw new FactoryProvisioningError("database_resource_mismatch", `The ${pair.kind} database has no recorded plan.`);
      const role = await this.roleRow(pair.role);
      const database = await this.databaseRow(pair.database);
      if (!role?.rolcanlogin || role.oid !== resources[`${pair.kind}RoleOid`] || role.marker !== factoryDatabaseMarker("role", installation, pair, plan)
        || !database || database.oid !== resources[`${pair.kind}DatabaseOid`] || database.owner !== pair.role || database.marker !== factoryDatabaseMarker("database", installation, pair, plan)) {
        throw new FactoryProvisioningError("database_lost", `The ${pair.kind} database or role lost its recorded provenance.`);
      }
      await this.login(pair, (await this.credential(installation, pair)).password);
    }
    // Each credential must be refused by the OTHER pair's database: the PUBLIC
    // revoke is what makes that true, and it is the same revoke that keeps one
    // tenant out of another's. The cluster's maintenance database is the
    // operator's to lock down and is deliberately not asserted here.
    const [product, pool] = factoryDatabasePairs(installation);
    if (await this.canLogin(product!.role, (await this.credential(installation, product!)).password, pool!.database) || await this.canLogin(pool!.role, (await this.credential(installation, pool!)).password, product!.database)) {
      throw new FactoryProvisioningError("database_not_isolated", "An installation credential reaches a database it does not own.");
    }
  }

  /**
   * Withdraw every login. The databases are KEPT: a torn-down tenant's product
   * records stay until a human purges them, and nothing can connect meanwhile.
   */
  async teardown(installation: FactoryInstallationContext, resources: FactoryStepResources): Promise<void> {
    for (const pair of factoryDatabasePairs(installation)) {
      const plan = resources[`${pair.kind}Plan`];
      const role = await this.roleRow(pair.role);
      if (!role) continue;
      if (!plan || role.marker !== factoryDatabaseMarker("role", installation, pair, plan)) throw new FactoryProvisioningError("database_foreign", `Refusing to tear down ${pair.kind} role without this installation's provenance.`);
      await this.admin.unsafe(`ALTER ROLE ${quote(pair.role)} NOLOGIN`);
      if (await this.databaseRow(pair.database)) {
        await this.admin.unsafe(`REVOKE CONNECT, TEMPORARY ON DATABASE ${quote(pair.database)} FROM ${quote(pair.role)}`);
        await this.admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${pair.database} AND usename = ${pair.role}`;
      }
    }
  }

  /** Drop both pairs for good. Only after teardown, only with this installation's markers. */
  async purge(installation: FactoryInstallationContext, resources: FactoryStepResources): Promise<void> {
    for (const pair of factoryDatabasePairs(installation)) {
      const plan = resources[`${pair.kind}Plan`];
      const database = await this.databaseRow(pair.database);
      if (database) {
        if (!plan || database.marker !== factoryDatabaseMarker("database", installation, pair, plan)) throw new FactoryProvisioningError("database_foreign", `Refusing to drop ${pair.kind} database without this installation's provenance.`);
        await this.admin.unsafe(`DROP DATABASE ${quote(pair.database)} WITH (FORCE)`);
      }
      const role = await this.roleRow(pair.role);
      if (role) {
        if (!plan || role.marker !== factoryDatabaseMarker("role", installation, pair, plan)) throw new FactoryProvisioningError("database_foreign", `Refusing to drop ${pair.kind} role without this installation's provenance.`);
        await this.admin.unsafe(`DROP ROLE ${quote(pair.role)}`);
      }
    }
  }

  /** A new password for both roles; the old one stops working before this returns. */
  async rotate(installation: FactoryInstallationContext, resources: FactoryStepResources): Promise<FactoryStepResources> {
    for (const pair of factoryDatabasePairs(installation)) {
      const previous = (await this.credential(installation, pair)).password;
      const password = randomBytes(32).toString("base64url");
      const statement = (await this.admin`SELECT format('ALTER ROLE %I PASSWORD %L', ${pair.role}::text, ${password}::text) AS statement`)[0] as { statement: string };
      await this.admin.unsafe(statement.statement);
      await replaceFactoryPrivateFile(factoryPrivatePath(installation.secretDirectory, pair.credentialFile), `${JSON.stringify({ role: pair.role, password })}\n`);
      if (await this.canLogin(pair.role, previous, pair.database)) throw new FactoryProvisioningError("database_rotation_incomplete", `The superseded ${pair.kind} password still logs in.`);
    }
    await this.verify(installation, resources);
    return resources;
  }

  /** Whether a credential logs in. Used as a positive check and, after teardown, a negative one. */
  async canLogin(role: string, password: string, database: string): Promise<boolean> {
    const url = new URL(this.options.adminUrl); url.pathname = `/${database}`; url.username = role; url.password = password;
    const client = new SQL(url.toString(), { max: 1, connectionTimeout: 5 });
    try { await client`SELECT 1`; return true; }
    catch { return false; }
    finally { await client.close(); }
  }

  private async credential(installation: FactoryInstallationContext, pair: FactoryDatabasePair): Promise<FactoryDatabaseCredential> {
    const directory = await openFactoryPrivateDirectory(installation.secretDirectory);
    try {
      await ensureFactoryPrivateFile(directory, pair.credentialFile, () => `${JSON.stringify({ role: pair.role, password: randomBytes(32).toString("base64url") })}\n`);
      const credential = await readFactoryPrivateJson<FactoryDatabaseCredential>(directory, pair.credentialFile);
      if (credential.role !== pair.role || !PASSWORD.test(credential.password)) throw new FactoryProvisioningError("database_credential_invalid", `The ${pair.kind} credential has an invalid format.`);
      return credential;
    } finally { await directory.close(); }
  }

  private async ensureRole(installation: FactoryInstallationContext, pair: FactoryDatabasePair, plan: string, password: string, progress: Record<string, string>, record: (update: Record<string, string>) => Promise<void>): Promise<void> {
    const marker = factoryDatabaseMarker("role", installation, pair, plan);
    let role = await this.roleRow(pair.role);
    if (role && (!role.rolcanlogin || role.marker !== marker || (progress[`${pair.kind}RoleOid`] && progress[`${pair.kind}RoleOid`] !== role.oid))) throw new FactoryProvisioningError("database_foreign", `The ${pair.kind} role exists without recorded provisioning provenance.`);
    if (!role) {
      const statements = (await this.admin`SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', ${pair.role}::text, ${password}::text) AS create_statement, format('COMMENT ON ROLE %I IS %L', ${pair.role}::text, ${marker}::text) AS marker_statement`)[0] as { create_statement: string; marker_statement: string };
      // Roles are transactional: a fault after CREATE but before COMMENT rolls both back.
      await this.admin.begin(async (admin) => { await admin.unsafe(statements.create_statement); await this.options.afterExternalResourceCreated?.("role", pair.kind); await admin.unsafe(statements.marker_statement); });
      role = await this.roleRow(pair.role);
      if (!role?.rolcanlogin || role.marker !== marker) throw new FactoryProvisioningError("database_marker_lost", `The ${pair.kind} role did not persist its trusted marker.`);
    }
    if (progress[`${pair.kind}RoleOid`] !== role.oid) await record({ [`${pair.kind}RoleOid`]: role.oid });
  }

  private async ensureDatabase(installation: FactoryInstallationContext, pair: FactoryDatabasePair, plan: string, password: string, progress: Record<string, string>, record: (update: Record<string, string>) => Promise<void>): Promise<void> {
    const marker = factoryDatabaseMarker("database", installation, pair, plan);
    let database = await this.databaseRow(pair.database);
    const reconcilable = database?.owner === pair.role && database.marker === null && !progress[`${pair.kind}DatabaseOid`] && progress[`${pair.kind}DatabasePhase`] === "creating";
    if (database && !reconcilable && (database.owner !== pair.role || database.marker !== marker || (progress[`${pair.kind}DatabaseOid`] && progress[`${pair.kind}DatabaseOid`] !== database.oid))) throw new FactoryProvisioningError("database_foreign", `The ${pair.kind} database exists without recorded provisioning provenance.`);
    if (reconcilable) {
      await this.login(pair, password);
      const statement = (await this.admin`SELECT format('COMMENT ON DATABASE %I IS %L', ${pair.database}::text, ${marker}::text) AS statement`)[0] as { statement: string };
      await this.admin.unsafe(statement.statement);
      database = await this.databaseRow(pair.database);
    }
    if (!database) {
      // Commit the pre-DDL phase first; CREATE DATABASE cannot share a transaction with its COMMENT.
      await record({ [`${pair.kind}DatabasePhase`]: "creating" });
      const statements = (await this.admin`SELECT format('CREATE DATABASE %I OWNER %I', ${pair.database}::text, ${pair.role}::text) AS create_statement, format('COMMENT ON DATABASE %I IS %L', ${pair.database}::text, ${marker}::text) AS marker_statement`)[0] as { create_statement: string; marker_statement: string };
      await this.admin.unsafe(statements.create_statement); await this.options.afterExternalResourceCreated?.("database", pair.kind); await this.admin.unsafe(statements.marker_statement);
      database = await this.databaseRow(pair.database);
    }
    if (!database || database.owner !== pair.role || database.marker !== marker) throw new FactoryProvisioningError("database_marker_lost", `The ${pair.kind} database did not persist its trusted marker.`);
    if (progress[`${pair.kind}DatabaseOid`] !== database.oid) await record({ [`${pair.kind}DatabaseOid`]: database.oid, [`${pair.kind}DatabasePhase`]: "created" });
  }

  private async login(pair: FactoryDatabasePair, password: string): Promise<void> {
    const url = new URL(this.options.adminUrl); url.pathname = `/${pair.database}`; url.username = pair.role; url.password = password;
    const client = new SQL(url.toString(), { max: 1 });
    try {
      const row = (await client`SELECT current_database() AS name, current_user AS role`)[0] as { name: string; role: string } | undefined;
      if (row?.name !== pair.database || row.role !== pair.role) throw new FactoryProvisioningError("database_login_wrong", `The ${pair.kind} credential connected to the wrong database.`);
    } finally { await client.close(); }
  }

  private async roleRow(role: string): Promise<RoleRow | undefined> {
    return (await this.admin`SELECT oid::text, rolcanlogin, shobj_description(oid, 'pg_authid') AS marker FROM pg_roles WHERE rolname = ${role}`)[0] as RoleRow | undefined;
  }

  private async databaseRow(database: string): Promise<DatabaseRow | undefined> {
    return (await this.admin`SELECT oid::text, pg_get_userbyid(datdba) AS owner, shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = ${database}`)[0] as DatabaseRow | undefined;
  }

  private resources(installation: FactoryInstallationContext, progress: Readonly<Record<string, string>>): FactoryStepResources {
    const entries: Record<string, string> = {};
    for (const pair of factoryDatabasePairs(installation)) {
      for (const field of ["Plan", "RoleOid", "DatabaseOid", "DatabasePhase"]) entries[`${pair.kind}${field}`] = progress[`${pair.kind}${field}`]!;
      entries[`${pair.kind}Role`] = pair.role;
      entries[`${pair.kind}Database`] = pair.database;
      entries[`${pair.kind}CredentialsPath`] = factoryPrivatePath(installation.secretDirectory, pair.credentialFile);
    }
    return Object.freeze(entries);
  }
}
