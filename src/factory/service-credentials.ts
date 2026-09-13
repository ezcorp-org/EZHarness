import { sql } from "drizzle-orm";
import type { FactoryServiceScope, FactoryServiceTokenClaims, FactoryServiceTokenIdentity } from "../auth/factory-service-token";
import { FACTORY_SERVICE_CREDENTIAL_MAX_SECONDS, canonicalScopes } from "../auth/factory-service-token";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { insertTransactionalAuditEntry } from "../db/queries/audit-log";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { digestObject } from "../extensions/v4/blobs";
import type { FactoryGrants, FactoryPrincipal } from "./grants";
import { FactoryMutations } from "./mutations";
import { assertFactoryIdentity } from "./records";

export interface FactoryServiceCredentialRecord extends FactoryServiceTokenIdentity {
  readonly issuedByUserId: string;
  readonly revoked: boolean;
}

export interface FactoryServiceCredentialIssue {
  readonly projectId: string;
  readonly serviceAccountId: string;
  readonly scopes: readonly FactoryServiceScope[];
  readonly expiresAtMs: number;
  readonly expectedRevision: 0;
}

export interface FactoryServiceCredentialRevoke {
  readonly projectId: string;
  readonly serviceAccountId: string;
  readonly credentialId: string;
  readonly expectedRevision: number;
}

type CredentialRow = {
  service_account_id: string;
  credential_id: string;
  scopes: unknown;
  revision: string | number;
  issued_by_user_id: string;
  issued_ms: string | number;
  expires_ms: string | number;
  revoked_at: unknown;
};

export class FactoryServiceCredentialError extends Error {
  constructor(readonly code: string) { super(code); this.name = "FactoryServiceCredentialError"; }
}

function actorSnapshot(actor: FactoryPrincipal): FactoryPrincipal {
  return Object.freeze({ kind: actor.kind, id: actor.id, authentication: actor.authentication });
}

function parseRow(projectId: string, row: CredentialRow): FactoryServiceCredentialRecord {
  const rawScopes = Array.isArray(row.scopes) ? row.scopes : null;
  const scopes = rawScopes ? canonicalScopes(rawScopes) : null;
  const revision = Number(row.revision);
  const issuedAtMs = Number(row.issued_ms);
  const expiresAtMs = Number(row.expires_ms);
  try { assertFactoryIdentity(projectId, row.service_account_id, row.credential_id, row.issued_by_user_id); }
  catch { throw new FactoryServiceCredentialError("factory_service_credential_corrupt"); }
  if (!scopes || !rawScopes || scopes.length !== rawScopes.length || !Number.isSafeInteger(revision) || revision < 1
    || !Number.isSafeInteger(issuedAtMs) || issuedAtMs < 0 || issuedAtMs % 1_000 !== 0
    || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= issuedAtMs || expiresAtMs % 1_000 !== 0
    || expiresAtMs > issuedAtMs + FACTORY_SERVICE_CREDENTIAL_MAX_SECONDS * 1_000) {
    throw new FactoryServiceCredentialError("factory_service_credential_corrupt");
  }
  return Object.freeze({
    projectId, serviceAccountId: row.service_account_id, credentialId: row.credential_id,
    scopes: Object.freeze(scopes), revision, issuedByUserId: row.issued_by_user_id,
    issuedAtMs, expiresAtMs, revoked: row.revoked_at !== null,
  });
}

async function readCredential(transaction: MigrationDb, tenantId: string, identity: Pick<FactoryServiceTokenIdentity, "projectId" | "serviceAccountId" | "credentialId">, lock: "share" | "update" = "share"): Promise<FactoryServiceCredentialRecord | null> {
  const suffix = lock === "update" ? sql`FOR UPDATE` : sql`FOR SHARE`;
  const row = rows<CredentialRow>(await transaction.execute(sql`SELECT service_account_id, credential_id, scopes, revision, issued_by_user_id,
    FLOOR(EXTRACT(EPOCH FROM issued_at) * 1000) AS issued_ms,
    FLOOR(EXTRACT(EPOCH FROM expires_at) * 1000) AS expires_ms, revoked_at
    FROM factory_service_credentials WHERE tenant_id=${tenantId} AND project_id=${identity.projectId}
      AND service_account_id=${identity.serviceAccountId} AND credential_id=${identity.credentialId} ${suffix}`))[0];
  return row ? parseRow(identity.projectId, row) : null;
}

/** Recheck public service authority inside the product transaction. */
export async function assertFactoryServiceCredentialInTransaction(
  transaction: MigrationDb,
  tenantId: string,
  claims: FactoryServiceTokenIdentity,
  requiredScope?: FactoryServiceScope,
): Promise<FactoryServiceCredentialRecord> {
  const current = await readCredential(transaction, tenantId, claims);
  if (!current || current.revoked || current.revision !== claims.revision
    || current.issuedAtMs !== claims.issuedAtMs || current.expiresAtMs !== claims.expiresAtMs
    || current.scopes.length !== claims.scopes.length || current.scopes.some((scope, index) => scope !== claims.scopes[index])
    || (requiredScope !== undefined && !current.scopes.includes(requiredScope))) {
    throw new FactoryServiceCredentialError("factory_service_credential_forbidden");
  }
  const live = rows(await transaction.execute(sql`SELECT s.id FROM service_accounts s
    JOIN factory_projects p ON p.tenant_id=${tenantId} AND p.project_id=${claims.projectId}
    WHERE s.id=${claims.serviceAccountId} AND s.project_id=${claims.projectId} AND s.enabled=TRUE
      AND (s.expires_at IS NULL OR s.expires_at > NOW()) AND ${new Date(current.expiresAtMs)} > NOW() FOR SHARE OF s, p`))[0];
  if (!live) throw new FactoryServiceCredentialError("factory_service_credential_forbidden");
  return current;
}

/** Durable issuance and revocation for project-scoped public service credentials. */
export class FactoryServiceCredentials {
  private readonly mutations: FactoryMutations;

  constructor(private readonly database: TransactionalDb, readonly tenantId: string, grants: FactoryGrants) {
    assertFactoryIdentity(tenantId);
    if (grants.tenantId !== tenantId) throw new FactoryServiceCredentialError("factory_scope_mismatch");
    this.mutations = new FactoryMutations(database, tenantId, grants);
  }

  async issue(actor: FactoryPrincipal, input: FactoryServiceCredentialIssue, idempotencyKey: string): Promise<FactoryServiceCredentialRecord> {
    actor = actorSnapshot(actor);
    const scopes = canonicalScopes([...input.scopes]);
    const request = Object.freeze({ projectId: input.projectId, serviceAccountId: input.serviceAccountId, scopes: scopes ? Object.freeze(scopes) : [], expiresAtMs: input.expiresAtMs, expectedRevision: input.expectedRevision as 0 });
    this.assertHuman(actor);
    assertFactoryIdentity(request.projectId, request.serviceAccountId);
    if (!scopes || scopes.length !== input.scopes.length || request.expectedRevision !== 0
      || !Number.isSafeInteger(request.expiresAtMs) || request.expiresAtMs % 1_000 !== 0) {
      throw new FactoryServiceCredentialError("factory_service_credential_invalid");
    }
    const result = await this.mutations.execute(
      { principal: actor, projectId: request.projectId, action: "factory.operate", idempotencyKey, input: { kind: "service-credential.issue", ...request } },
      transaction => this.insert(transaction, actor, request as FactoryServiceCredentialIssue),
      transaction => this.authorizeIssuer(transaction, actor, request, true),
    );
    return this.database.transaction(transaction => assertFactoryServiceCredentialInTransaction(transaction, this.tenantId, result));
  }

  async revoke(actor: FactoryPrincipal, input: FactoryServiceCredentialRevoke, idempotencyKey: string): Promise<FactoryServiceCredentialRecord> {
    actor = actorSnapshot(actor);
    const request = Object.freeze({ ...input });
    this.assertHuman(actor);
    assertFactoryIdentity(request.projectId, request.serviceAccountId, request.credentialId);
    if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1) throw new FactoryServiceCredentialError("factory_service_credential_invalid");
    return this.mutations.execute(
      { principal: actor, projectId: request.projectId, action: "factory.operate", idempotencyKey, input: { kind: "service-credential.revoke", ...request } },
      transaction => this.applyRevoke(transaction, actor, request),
      transaction => this.authorizeIssuer(transaction, actor, request, false),
    );
  }

  authenticate(claims: FactoryServiceTokenClaims, requiredScope: FactoryServiceScope): Promise<FactoryServiceCredentialRecord> {
    const snapshot = Object.freeze({ ...claims, scopes: Object.freeze([...claims.scopes]) });
    return this.database.transaction(transaction => assertFactoryServiceCredentialInTransaction(transaction, this.tenantId, snapshot, requiredScope));
  }

  private assertHuman(actor: FactoryPrincipal): void {
    if (actor.kind !== "user" || actor.authentication !== "session") throw new FactoryServiceCredentialError("factory_human_required");
  }

  private async authorizeIssuer(transaction: MigrationDb, actor: FactoryPrincipal, input: Pick<FactoryServiceCredentialIssue, "projectId" | "serviceAccountId" | "expiresAtMs"> | FactoryServiceCredentialRevoke, issuing: boolean): Promise<void> {
    const user = rows(await transaction.execute(sql`SELECT u.id FROM users u
      JOIN factory_projects p ON p.tenant_id=${this.tenantId} AND p.project_id=${input.projectId}
      WHERE u.id=${actor.id} AND u.status='active' AND u.role='admin' FOR SHARE OF u, p`))[0];
    const account = rows<{ expires_ms: string | number | null }>(await transaction.execute(sql`SELECT FLOOR(EXTRACT(EPOCH FROM expires_at) * 1000) AS expires_ms
      FROM service_accounts WHERE id=${input.serviceAccountId} AND project_id=${input.projectId} ${issuing ? sql`AND enabled=TRUE AND (expires_at IS NULL OR expires_at > NOW())` : sql``} FOR SHARE`))[0];
    if (!user || !account) throw new FactoryServiceCredentialError("factory_service_credential_forbidden");
    if (issuing && "expiresAtMs" in input) {
      const now = rows<{ now_ms: string | number }>(await transaction.execute(sql`SELECT FLOOR(EXTRACT(EPOCH FROM date_trunc('second', NOW())) * 1000) AS now_ms`))[0];
      const nowMs = Number(now?.now_ms);
      const accountExpiry = account.expires_ms === null ? null : Number(account.expires_ms);
      if (!Number.isSafeInteger(nowMs) || input.expiresAtMs <= nowMs
        || input.expiresAtMs > nowMs + FACTORY_SERVICE_CREDENTIAL_MAX_SECONDS * 1_000
        || accountExpiry !== null && input.expiresAtMs > accountExpiry) {
        throw new FactoryServiceCredentialError("factory_service_credential_invalid");
      }
    }
  }

  private async insert(transaction: MigrationDb, actor: FactoryPrincipal, input: FactoryServiceCredentialIssue): Promise<FactoryServiceCredentialRecord> {
    const credentialId = crypto.randomUUID();
    const scopesJson = JSON.stringify(input.scopes);
    const row = rows<CredentialRow>(await transaction.execute(sql`INSERT INTO factory_service_credentials
      (tenant_id, project_id, service_account_id, credential_id, scopes, revision, issued_by_user_id, issued_at, expires_at)
      VALUES (${this.tenantId}, ${input.projectId}, ${input.serviceAccountId}, ${credentialId}, ${scopesJson}::text::jsonb, 1, ${actor.id}, date_trunc('second', NOW()), ${new Date(input.expiresAtMs)})
      RETURNING service_account_id, credential_id, scopes, revision, issued_by_user_id,
        FLOOR(EXTRACT(EPOCH FROM issued_at) * 1000) AS issued_ms,
        FLOOR(EXTRACT(EPOCH FROM expires_at) * 1000) AS expires_ms, revoked_at`))[0];
    if (!row) throw new FactoryServiceCredentialError("factory_service_credential_storage");
    const record = parseRow(input.projectId, row);
    await this.audit(transaction, actor.id, record, "factory.service-credential.issued");
    return record;
  }

  private async applyRevoke(transaction: MigrationDb, actor: FactoryPrincipal, input: FactoryServiceCredentialRevoke): Promise<FactoryServiceCredentialRecord> {
    const prior = await readCredential(transaction, this.tenantId, input, "update");
    if (!prior) throw new FactoryServiceCredentialError("factory_service_credential_not_found");
    if (prior.revision !== input.expectedRevision || prior.revoked) throw new FactoryServiceCredentialError("factory_service_credential_conflict");
    const row = rows<CredentialRow>(await transaction.execute(sql`UPDATE factory_service_credentials SET revision=revision+1, revoked_at=NOW(), updated_at=NOW()
      WHERE tenant_id=${this.tenantId} AND project_id=${input.projectId} AND service_account_id=${input.serviceAccountId} AND credential_id=${input.credentialId}
      RETURNING service_account_id, credential_id, scopes, revision, issued_by_user_id,
        FLOOR(EXTRACT(EPOCH FROM issued_at) * 1000) AS issued_ms,
        FLOOR(EXTRACT(EPOCH FROM expires_at) * 1000) AS expires_ms, revoked_at`))[0];
    if (!row) throw new FactoryServiceCredentialError("factory_service_credential_storage");
    const record = parseRow(input.projectId, row);
    await this.audit(transaction, actor.id, record, "factory.service-credential.revoked");
    return record;
  }

  private audit(transaction: MigrationDb, userId: string, record: FactoryServiceCredentialRecord, action: string): Promise<void> {
    const target = digestObject({ tenantId: this.tenantId, projectId: record.projectId, serviceAccountId: record.serviceAccountId, credentialId: record.credentialId });
    return insertTransactionalAuditEntry(transaction, `factory-service-credential:${target}:${record.revision}`, userId, action, target, {
      tenantId: this.tenantId, projectId: record.projectId, serviceAccountId: record.serviceAccountId,
      credentialId: record.credentialId, scopes: record.scopes, revision: record.revision, expiresAtMs: record.expiresAtMs,
    });
  }
}
