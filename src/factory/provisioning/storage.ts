/**
 * C12 step 2: the product object-store credential and the separately
 * credentialed archive credential, each restricted to the tenant's prefix.
 *
 * Two issuers exist because two kinds of store exist on the local profile:
 *
 *   - `seeded`: a store whose identities were created by its own operator
 *     (the shared SeaweedFS pair on this host). The provisioner reads that
 *     store's server identity file, takes the ONE identity named for this
 *     tenant, and writes a private per-installation copy holding only it. It
 *     cannot revoke: revocation needs the store's own admin authority, which
 *     this provisioner does not hold, and it says so rather than pretending.
 *   - `minted`: a store this deployment administers. The issuer creates a
 *     fresh identity scoped to the tenant's prefix and deletes it on teardown.
 *
 * Whatever the issuer, the credential is then PROVEN scoped with read-only
 * requests: inside the prefix an absent key answers 404, outside it 403, in a
 * foreign tenant's bucket 403, and the same key with a wrong secret 403. The
 * wrong-secret control is what makes the 404 evidence: without it, "absent"
 * is indistinguishable from "never reached the store". Nothing is written.
 *
 * A seeded store names its buckets and identities for the tenant alone, so two
 * fleets on one store would share `tenant-01`'s objects. Before it takes a
 * credential, the step therefore CLAIMS each (store, bucket) for its fleet in
 * a registry every fleet on the database cluster shares, and refuses a bucket
 * another fleet holds (`FactoryStorageClaims`).
 */
import { createHash, randomBytes } from "node:crypto";
import { SQL } from "bun";
import { readFile } from "node:fs/promises";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { FactoryInstallationContext, FactoryProvisioningDriver, FactoryStepResources } from "./installation";
import { ensureFactoryPrivateFile, factoryPrivatePath, openFactoryPrivateDirectory, readFactoryPrivateJson, removeFactoryPrivateFile, replaceFactoryPrivateFile } from "./secret-files";
import { FactoryProvisioningError } from "./steps";

export type FactoryStorageDomain = "ordinary" | "archive";
export const FACTORY_STORAGE_DOMAINS: readonly FactoryStorageDomain[] = Object.freeze(["ordinary", "archive"]);

export interface FactoryStorageCredential { readonly accessKey: string; readonly secretKey: string }

export interface FactoryStorageCredentialIssuer {
  readonly kind: "seeded" | "minted";
  issue(installation: FactoryInstallationContext, scope: FactoryStorageScope): Promise<FactoryStorageCredential>;
  /** `unsupported` when this issuer holds no authority to revoke. Teardown records it by name. */
  revoke(installation: FactoryInstallationContext, scope: FactoryStorageScope): Promise<"revoked" | "unsupported">;
}

export interface FactoryStorageScope {
  readonly domain: FactoryStorageDomain;
  readonly endpoint: string;
  readonly bucket: string;
  readonly prefix: string;
}

/** One HEAD request. Returns the HTTP status; never a body, never a credential. */
export interface FactoryStorageScopeProbe {
  status(endpoint: string, credential: FactoryStorageCredential, bucket: string, key: string): Promise<number>;
}

export interface FactoryStorageDomainConfig {
  readonly endpoint: string;
  readonly prefix: string;
  readonly issuer: FactoryStorageCredentialIssuer;
  /** The failure domain this store is certified for. The local pair is `same-host-not-independent`. */
  readonly failureDomain: string;
}

/** Claims a (store, bucket) for one fleet, or refuses because another fleet holds it. Idempotent for the holder. */
export interface FactoryStorageClaims {
  claim(installation: FactoryInstallationContext, scope: FactoryStorageScope): Promise<void>;
  /** Drop this installation's claim, and only its own. Idempotent. */
  release(installation: FactoryInstallationContext, scope: FactoryStorageScope): Promise<void>;
}

export interface FactoryStorageStepOptions {
  readonly claims: FactoryStorageClaims;
  readonly ordinary: FactoryStorageDomainConfig;
  readonly archive: FactoryStorageDomainConfig;
  readonly probe: FactoryStorageScopeProbe;
  /** A different tenant's bucket, used only as a denial target. */
  readonly foreignBucket: (installation: FactoryInstallationContext) => string;
}

const FILES: Readonly<Record<FactoryStorageDomain, string>> = Object.freeze({ ordinary: "ordinary-storage.json", archive: "archive-storage.json" });
const MAX_SEEDED_CONFIG_BYTES = 1024 * 1024;

/** The credential-set file format `loadFactoryStorageCredentials` reads: one identity, this tenant's. */
export interface FactoryStorageCredentialFile {
  readonly identities: readonly [{ readonly name: string; readonly credentials: readonly [FactoryStorageCredential] }];
}

function credentialFile(tenantId: string, credential: FactoryStorageCredential): FactoryStorageCredentialFile {
  return { identities: [{ name: tenantId, credentials: [{ accessKey: credential.accessKey, secretKey: credential.secretKey }] }] };
}

function parseCredentialFile(value: unknown, tenantId: string): FactoryStorageCredential {
  const identities = (value as { identities?: unknown } | null)?.identities;
  if (!Array.isArray(identities) || identities.length !== 1) throw new FactoryProvisioningError("storage_credential_corrupt", "Installation storage credential must hold exactly one identity.");
  const identity = identities[0] as { name?: unknown; credentials?: unknown };
  const credentials = Array.isArray(identity.credentials) ? identity.credentials : [];
  const credential = credentials[0] as { accessKey?: unknown; secretKey?: unknown } | undefined;
  if (identity.name !== tenantId || credentials.length !== 1 || typeof credential?.accessKey !== "string" || typeof credential.secretKey !== "string" || !credential.accessKey || !credential.secretKey) {
    throw new FactoryProvisioningError("storage_credential_corrupt", "Installation storage credential names the wrong identity or no key.");
  }
  return { accessKey: credential.accessKey, secretKey: credential.secretKey };
}

export function factoryStorageScope(installation: FactoryInstallationContext, domain: FactoryStorageDomain, config: FactoryStorageDomainConfig): FactoryStorageScope {
  return Object.freeze({ domain, endpoint: config.endpoint, bucket: installation.tenantId, prefix: config.prefix });
}

/**
 * Prove a credential reaches exactly its own prefix, with read-only requests.
 *
 * Four HEADs, each with a key this installation never wrote, so nothing is
 * created and nothing a tenant stored is read.
 */
export async function verifyFactoryStorageScope(probe: FactoryStorageScopeProbe, scope: FactoryStorageScope, credential: FactoryStorageCredential, foreignBucket: string, nonce: string): Promise<void> {
  const inside = `${scope.prefix}/.provisioning-scope-probe/${nonce}`;
  const checks: ReadonlyArray<readonly [string, number, Promise<number>]> = [
    ["inside the prefix", 404, probe.status(scope.endpoint, credential, scope.bucket, inside)],
    ["outside the prefix", 403, probe.status(scope.endpoint, credential, scope.bucket, `.provisioning-scope-probe/${nonce}`)],
    ["a foreign tenant's bucket", 403, probe.status(scope.endpoint, credential, foreignBucket, inside)],
    ["a wrong secret", 403, probe.status(scope.endpoint, { accessKey: credential.accessKey, secretKey: `${credential.secretKey}-wrong` }, scope.bucket, inside)],
  ];
  for (const [label, expected, pending] of checks) {
    const actual = await pending;
    if (actual !== expected) throw new FactoryProvisioningError("storage_scope_unproven", `The ${scope.domain} credential answered ${actual} ${label}; ${expected} was required.`);
  }
}

export class FactoryStorageStep implements FactoryProvisioningDriver {
  readonly step = "storage" as const;
  constructor(private readonly options: FactoryStorageStepOptions) {}

  private config(domain: FactoryStorageDomain): FactoryStorageDomainConfig { return this.options[domain]; }

  async ensure(installation: FactoryInstallationContext): Promise<FactoryStepResources> {
    const directory = await openFactoryPrivateDirectory(installation.secretDirectory);
    try {
      for (const domain of FACTORY_STORAGE_DOMAINS) {
        const config = this.config(domain);
        const scope = factoryStorageScope(installation, domain, config);
        await this.options.claims.claim(installation, scope);
        // Issue only when no private copy exists yet: a rerun keeps the credential it already holds.
        let issued: FactoryStorageCredential | undefined;
        try { await readFactoryPrivateJson(directory, FILES[domain]); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          issued = await config.issuer.issue(installation, scope);
        }
        if (issued) await ensureFactoryPrivateFile(directory, FILES[domain], () => `${JSON.stringify(credentialFile(installation.tenantId, issued))}\n`);
      }
    } finally { await directory.close(); }
    const resources = this.resources(installation);
    await this.verify(installation, resources);
    return resources;
  }

  async verify(installation: FactoryInstallationContext, resources: FactoryStepResources): Promise<void> {
    const directory = await openFactoryPrivateDirectory(installation.secretDirectory);
    try {
      const credentials = new Map<FactoryStorageDomain, FactoryStorageCredential>();
      for (const domain of FACTORY_STORAGE_DOMAINS) credentials.set(domain, parseCredentialFile(await readFactoryPrivateJson(directory, FILES[domain]), installation.tenantId));
      // "Separately credentialed" is checked, not assumed: one key serving both
      // domains would make the archive fall with the product store.
      if (credentials.get("ordinary")!.accessKey === credentials.get("archive")!.accessKey) throw new FactoryProvisioningError("storage_archive_not_separate", "The archive credential must differ from the product credential.");
      const nonce = randomBytes(12).toString("hex");
      for (const domain of FACTORY_STORAGE_DOMAINS) {
        const scope = factoryStorageScope(installation, domain, this.config(domain));
        if (resources[`${domain}CredentialsPath`] !== factoryPrivatePath(installation.secretDirectory, FILES[domain])) throw new FactoryProvisioningError("storage_resource_mismatch", `The recorded ${domain} credential path does not match this installation.`);
        await this.options.claims.claim(installation, scope);
        await verifyFactoryStorageScope(this.options.probe, scope, credentials.get(domain)!, this.options.foreignBucket(installation), nonce);
      }
    } finally { await directory.close(); }
  }

  /**
   * Revoke both credentials where the issuer can, and destroy the private copies.
   *
   * The ARCHIVE OBJECTS are never touched. Teardown keeps the release archive
   * under C06; only the credential that could write to it is withdrawn.
   */
  async teardown(installation: FactoryInstallationContext): Promise<void> {
    const outcomes: string[] = [];
    for (const domain of FACTORY_STORAGE_DOMAINS) {
      const config = this.config(domain);
      outcomes.push(`${domain}:${await config.issuer.revoke(installation, factoryStorageScope(installation, domain, config))}`);
    }
    const directory = await openFactoryPrivateDirectory(installation.secretDirectory);
    try { for (const domain of FACTORY_STORAGE_DOMAINS) await removeFactoryPrivateFile(directory, FILES[domain]); }
    finally { await directory.close(); }
    const unsupported = outcomes.filter((outcome) => outcome.endsWith(":unsupported"));
    if (unsupported.length > 0) throw new FactoryStorageRevocationUnsupported(unsupported.map((outcome) => outcome.split(":")[0] as FactoryStorageDomain));
  }

  /**
   * Purge leaves no cluster-wide object behind: the claim roles go. The store's
   * objects stay, because removing them needs the store's own admin authority;
   * the purge's audit-loss record names that residue.
   */
  async purge(installation: FactoryInstallationContext): Promise<void> {
    for (const domain of FACTORY_STORAGE_DOMAINS) await this.options.claims.release(installation, factoryStorageScope(installation, domain, this.config(domain)));
  }

  async rotate(installation: FactoryInstallationContext, resources: FactoryStepResources): Promise<FactoryStepResources> {
    for (const domain of FACTORY_STORAGE_DOMAINS) {
      const config = this.config(domain);
      if (config.issuer.kind !== "minted") throw new FactoryProvisioningError("storage_rotation_unsupported", `The ${domain} store's identities are seeded by its own operator; rotation needs that store's admin authority.`);
      const scope = factoryStorageScope(installation, domain, config);
      await config.issuer.revoke(installation, scope);
      const credential = await config.issuer.issue(installation, scope);
      await replaceFactoryPrivateFile(factoryPrivatePath(installation.secretDirectory, FILES[domain]), `${JSON.stringify(credentialFile(installation.tenantId, credential))}\n`);
    }
    await this.verify(installation, resources);
    return resources;
  }

  private resources(installation: FactoryInstallationContext): FactoryStepResources {
    const entries: Record<string, string> = {};
    for (const domain of FACTORY_STORAGE_DOMAINS) {
      const config = this.config(domain);
      entries[`${domain}CredentialsPath`] = factoryPrivatePath(installation.secretDirectory, FILES[domain]);
      entries[`${domain}Issuer`] = config.issuer.kind;
      entries[`${domain}Endpoint`] = config.endpoint;
      entries[`${domain}Bucket`] = installation.tenantId;
      entries[`${domain}Prefix`] = config.prefix;
      entries[`${domain}FailureDomain`] = config.failureDomain;
    }
    return Object.freeze(entries);
  }
}

/**
 * Teardown finished everything it could and one credential outlives it.
 *
 * Raised AFTER the private copies are destroyed, so the installation can no
 * longer boot with it, and recorded on the ledger as a named row rather than
 * as a silent success.
 */
export class FactoryStorageRevocationUnsupported extends FactoryProvisioningError {
  constructor(readonly domains: readonly FactoryStorageDomain[]) {
    super("storage_revocation_unsupported", `Store identities for ${domains.join(", ")} are seeded by the store's own operator and were not revoked; the installation's private copies are destroyed.`, "storage");
  }
}

/** Adopts the one identity a store's own operator seeded for this tenant. Never revokes. */
export class FactorySeededStorageIssuer implements FactoryStorageCredentialIssuer {
  readonly kind = "seeded" as const;
  constructor(private readonly serverIdentityPath: string) {}

  async issue(installation: FactoryInstallationContext): Promise<FactoryStorageCredential> {
    const text = await readFile(this.serverIdentityPath, "utf8");
    if (Buffer.byteLength(text) > MAX_SEEDED_CONFIG_BYTES) throw new FactoryProvisioningError("storage_identity_unavailable", "The store identity file is too large.");
    let config: { identities?: Array<{ name?: unknown; credentials?: Array<{ accessKey?: unknown; secretKey?: unknown }> }> } | null;
    try { config = JSON.parse(text); } catch { throw new FactoryProvisioningError("storage_identity_unavailable", "The store identity file is not JSON."); }
    const identities = Array.isArray(config?.identities) ? config.identities : [];
    const credential = identities.find((entry) => entry?.name === installation.tenantId)?.credentials?.[0];
    if (typeof credential?.accessKey !== "string" || typeof credential.secretKey !== "string" || !credential.accessKey || !credential.secretKey) throw new FactoryProvisioningError("storage_identity_unavailable", `Storage identity for ${installation.tenantId} is unavailable.`);
    return { accessKey: credential.accessKey, secretKey: credential.secretKey };
  }

  async revoke(): Promise<"unsupported"> { return "unsupported"; }
}

/** The real probe: one unsigned-body HEAD through the AWS client, returning its status. */
export const factoryS3ScopeProbe: FactoryStorageScopeProbe = {
  async status(endpoint, credential, bucket, key) {
    const client = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, maxAttempts: 1, credentials: { accessKeyId: credential.accessKey, secretAccessKey: credential.secretKey } });
    try {
      const response = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return response.$metadata.httpStatusCode ?? 200;
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (typeof status !== "number") throw new FactoryProvisioningError("storage_unreachable", `The object store at ${endpoint} did not answer.`);
      return status;
    } finally { client.destroy(); }
  },
};

/** The cluster-wide role that records which fleet holds one (store, bucket). */
export function factoryStorageClaimRole(scope: Pick<FactoryStorageScope, "endpoint" | "bucket">): string {
  return `factory_store_claim_${createHash("sha256").update(`${scope.endpoint}\u0000${scope.bucket}`).digest("hex").slice(0, 20)}`;
}

/** The narrow client the claim registry needs; `bun`'s SQL satisfies it. */
export interface FactoryStorageClaimClient {
  begin<Result>(work: (transaction: FactoryStorageClaimTransaction) => Promise<Result>): Promise<Result>;
  close(): Promise<void>;
}
export interface FactoryStorageClaimTransaction {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
  unsafe(query: string): Promise<unknown>;
}

const CLAIM_MARKER = /^factory-store-claim:[a-z][a-z0-9-]{0,30}[a-z0-9]:tenant-\d{2}$/;
const connectClaims = (url: string): FactoryStorageClaimClient => new SQL(url, { max: 1 }) as unknown as FactoryStorageClaimClient;

/**
 * The claim registry on the database cluster: one NOLOGIN role per
 * (store, bucket), whose comment names the holding fleet and tenant. Roles are
 * cluster-wide, so every fleet whose databases share the cluster sees every
 * claim. A claim outlives teardown, while the installation's records are kept,
 * and is released at purge so no role of the fleet remains on the cluster.
 */
export function factoryDatabaseStorageClaims(adminUrl: string, connect: (url: string) => FactoryStorageClaimClient = connectClaims): FactoryStorageClaims {
  return {
    async claim(installation, scope) {
      const role = factoryStorageClaimRole(scope);
      const marker = `factory-store-claim:${installation.fleetId}:${installation.tenantId}`;
      if (!CLAIM_MARKER.test(marker)) throw new FactoryProvisioningError("storage_claim_invalid", "The store claim names a malformed fleet or tenant.");
      const client = connect(adminUrl);
      try {
        await client.begin(async (transaction) => {
          await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${role}::text, 0))`;
          const [held] = await transaction`SELECT shobj_description(oid, 'pg_authid') AS marker FROM pg_roles WHERE rolname = ${role}` as { marker: string | null }[];
          if (held === undefined) {
            await transaction.unsafe(`CREATE ROLE ${role} NOLOGIN`);
            await transaction.unsafe(`COMMENT ON ROLE ${role} IS '${marker}'`);
          } else if (held.marker !== marker) {
            throw new FactoryProvisioningError("storage_claimed_by_other_fleet", `The ${scope.domain} store's bucket ${scope.bucket} is held by another fleet or tenant; a seeded store serves one fleet.`);
          }
        });
      } finally { await client.close(); }
    },
    async release(installation, scope) {
      const role = factoryStorageClaimRole(scope);
      const marker = `factory-store-claim:${installation.fleetId}:${installation.tenantId}`;
      const client = connect(adminUrl);
      try {
        await client.begin(async (transaction) => {
          await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${role}::text, 0))`;
          const [held] = await transaction`SELECT shobj_description(oid, 'pg_authid') AS marker FROM pg_roles WHERE rolname = ${role}` as { marker: string | null }[];
          // Another fleet's claim, or none, is left exactly as it is.
          if (held?.marker === marker) await transaction.unsafe(`DROP ROLE ${role}`);
        });
      } finally { await client.close(); }
    },
  };
}
