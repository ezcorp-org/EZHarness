import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { insertTransactionalAuditEntry } from "../db/queries/audit-log";
import { digestObject } from "../extensions/v4/blobs";
import { FactoryRecords, assertFactoryIdentity } from "./records";
import { FactoryMutations } from "./mutations";
import type { FactoryServiceTokenIdentity } from "../auth/factory-service-token";
import { assertFactoryServiceCredentialInTransaction } from "./service-credentials";

export const FACTORY_ACTIONS = ["factory.author", "factory.publish", "factory.run", "factory.operate", "factory.approve", "factory.release", "factory.trust"] as const;
export type FactoryAction = typeof FACTORY_ACTIONS[number];
export interface FactoryPrincipal {
  readonly kind: "user" | "service";
  readonly id: string;
  /** Set only by the authenticated server boundary. Never copy this from JSON. */
  readonly authentication: "session" | "api-key" | "service";
  /** Present only for a public, HTTP-authenticated service credential. */
  readonly credential?: FactoryServiceTokenIdentity;
}
export interface FactoryGrantKey { readonly projectId: string; readonly principal: FactoryPrincipal; readonly action: FactoryAction }
export interface FactoryGrantRevision { readonly revision: number; readonly expiresAtMs: number | null }
export interface FactoryGrantUpdate extends FactoryGrantKey { readonly expectedRevision: number; readonly expiresAtMs: number | null }
export interface FactoryGrantRecord {
  readonly projectId: string;
  readonly principalKind: FactoryPrincipal["kind"];
  readonly principalId: string;
  readonly action: FactoryAction;
  readonly revision: number;
  readonly expiresAtMs: number | null;
  readonly revoked: boolean;
  readonly issuerId: string;
  readonly updatedAtMs: number;
}
export interface FactoryGrantListOptions { readonly cursor?: string; readonly limit?: number; readonly principalKind?: FactoryPrincipal["kind"]; readonly action?: FactoryAction }
type GrantRow = { principal_kind?: string; principal_id?: string; action?: string; revision: string | number; expires_ms: string | number | null; revoked_at: unknown; issuer_id: string; updated_ms?: string | number };

function snapshotPrincipal(principal: FactoryPrincipal): FactoryPrincipal {
  return Object.freeze({
    kind: principal.kind,
    id: principal.id,
    authentication: principal.authentication,
    ...(principal.credential === undefined ? {} : {
      credential: Object.freeze({ ...principal.credential, scopes: Object.freeze([...principal.credential.scopes]) }),
    }),
  });
}

function snapshotKey(key: FactoryGrantKey): FactoryGrantKey {
  return Object.freeze({ projectId: key.projectId, principal: snapshotPrincipal(key.principal), action: key.action });
}

function snapshotUpdate(update: FactoryGrantUpdate): FactoryGrantUpdate {
  return Object.freeze({ ...snapshotKey(update), expectedRevision: update.expectedRevision, expiresAtMs: update.expiresAtMs });
}

export class FactoryGrantError extends Error {
  constructor(readonly code: string) { super(code); this.name = "FactoryGrantError"; }
}

/** Current product authority. Call inside the same transaction as an effect claim. */
export class FactoryGrants {
  constructor(private readonly database: TransactionalDb, readonly tenantId: string, private readonly now: () => number = Date.now) { assertFactoryIdentity(tenantId); }

  authorize(principal: FactoryPrincipal, projectId: string, action: FactoryAction | "read", expectedRevision?: number): Promise<FactoryGrantRevision> {
    const currentPrincipal = snapshotPrincipal(principal);
    return this.database.transaction(transaction => this.authorizeInTransaction(transaction, currentPrincipal, projectId, action, expectedRevision));
  }

  async authorizeInTransaction(transaction: MigrationDb, principal: FactoryPrincipal, projectId: string, action: FactoryAction | "read", expectedRevision?: number): Promise<FactoryGrantRevision> {
    principal = snapshotPrincipal(principal);
    await this.lockProject(transaction, projectId);
    const currentPrincipal = await this.livePrincipal(transaction, principal, projectId, true);
    if (action === "read") return { revision: 0, expiresAtMs: null };
    this.action(action);
    if (action === "factory.trust" && currentPrincipal.role !== "admin") throw new FactoryGrantError("factory_forbidden");
    if ((action === "factory.approve" || action === "factory.trust") && (principal.kind !== "user" || principal.authentication !== "session")) throw new FactoryGrantError("factory_human_required");
    const grant = await this.find(transaction, { projectId, principal, action });
    if (!grant || grant.revoked_at !== null || (grant.expires_ms !== null && Number(grant.expires_ms) <= this.now())) throw new FactoryGrantError("factory_forbidden");
    const revision = Number(grant.revision);
    if (!Number.isSafeInteger(revision) || revision < 1 || (expectedRevision !== undefined && expectedRevision !== revision)) throw new FactoryGrantError("factory_grant_stale");
    return { revision, expiresAtMs: grant.expires_ms === null ? null : Number(grant.expires_ms) };
  }

  /** Trusted project creation only: owner rights do not include consent or release. */
  async initializeProjectInTransaction(transaction: MigrationDb, projectId: string, ownerId: string): Promise<void> {
    assertFactoryIdentity(projectId, ownerId);
    const owner: FactoryPrincipal = { kind: "user", id: ownerId, authentication: "api-key" };
    await this.livePrincipal(transaction, owner, projectId, true);
    const membership = rows(await transaction.execute(sql`SELECT id FROM project_members WHERE project_id=${projectId} AND user_id=${ownerId} AND role='owner' FOR SHARE`))[0];
    if (!membership) throw new FactoryGrantError("factory_forbidden");
    if (!await new FactoryRecords(this.database, this.tenantId).bindProjectInTransaction(transaction, projectId)) throw new FactoryGrantError("factory_project_already_initialized");
    for (const action of ["factory.author", "factory.publish", "factory.run", "factory.operate"] as const) {
      await this.applyMutation(transaction, owner, { projectId, principal: owner, action, expectedRevision: 0, expiresAtMs: null }, false);
    }
  }

  set(actor: FactoryPrincipal, update: FactoryGrantUpdate, idempotencyKey?: string): Promise<FactoryGrantRevision> {
    return this.mutate(snapshotPrincipal(actor), snapshotUpdate(update), false, idempotencyKey);
  }

  revoke(actor: FactoryPrincipal, update: FactoryGrantKey & { readonly expectedRevision: number }, idempotencyKey?: string): Promise<FactoryGrantRevision> {
    const key = snapshotKey(update);
    return this.mutate(snapshotPrincipal(actor), { ...key, expectedRevision: update.expectedRevision, expiresAtMs: null }, true, idempotencyKey);
  }

  async read(actor: FactoryPrincipal, key: FactoryGrantKey): Promise<FactoryGrantRecord> {
    actor = snapshotPrincipal(actor);
    key = snapshotKey(key);
    return this.database.transaction(async transaction => {
      await this.authorizeInTransaction(transaction, actor, key.projectId, "read");
      const row = await this.find(transaction, key);
      if (!row) throw new FactoryGrantError("factory_grant_not_found");
      return this.record(key.projectId, row, key);
    });
  }

  async list(actor: FactoryPrincipal, projectId: string, options: FactoryGrantListOptions = {}): Promise<{ items: readonly FactoryGrantRecord[]; nextCursor: string | null }> {
    actor = snapshotPrincipal(actor);
    options = Object.freeze({ cursor: options.cursor, limit: options.limit, principalKind: options.principalKind, action: options.action });
    const limit = options.limit ?? 50;
    const principalKind = options.principalKind;
    const action = options.action;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new FactoryGrantError("factory_page_invalid");
    if (principalKind !== undefined && principalKind !== "user" && principalKind !== "service") throw new FactoryGrantError("factory_page_invalid");
    if (action !== undefined) this.action(action);
    const after = this.decodeCursor(options.cursor);
    return this.database.transaction(async transaction => {
      await this.authorizeInTransaction(transaction, actor, projectId, "read");
      const principalFilter = principalKind === undefined ? sql`` : sql`AND principal_kind=${principalKind}`;
      const actionFilter = action === undefined ? sql`` : sql`AND action=${action}`;
      const cursorFilter = after === null ? sql`` : sql`AND (principal_kind, principal_id, action) > (${after.kind}, ${after.id}, ${after.action})`;
      const selected = rows<GrantRow>(await transaction.execute(sql`SELECT principal_kind, principal_id, action, revision, EXTRACT(EPOCH FROM expires_at) * 1000 AS expires_ms, revoked_at, issuer_id, FLOOR(EXTRACT(EPOCH FROM updated_at) * 1000) AS updated_ms
        FROM factory_grants WHERE tenant_id=${this.tenantId} AND project_id=${projectId} ${principalFilter} ${actionFilter} ${cursorFilter}
        ORDER BY principal_kind, principal_id, action LIMIT ${limit + 1}`));
      const items = selected.slice(0, limit).map(row => this.record(projectId, row));
      const last = items[items.length - 1];
      return { items, nextCursor: selected.length > limit && last ? this.encodeCursor(last) : null };
    });
  }

  private async mutate(actor: FactoryPrincipal, update: FactoryGrantUpdate, revoke: boolean, idempotencyKey?: string): Promise<FactoryGrantRevision> {
    actor = snapshotPrincipal(actor);
    update = snapshotUpdate(update);
    this.action(update.action);
    if (!revoke && update.principal.kind === "service" && update.expiresAtMs === null) throw new FactoryGrantError("factory_grant_invalid");
    if (actor.kind !== "user" || actor.authentication !== "session") throw new FactoryGrantError("factory_human_required");
    if (!Number.isSafeInteger(update.expectedRevision) || update.expectedRevision < 0 || (!revoke && update.expiresAtMs !== null && (!Number.isSafeInteger(update.expiresAtMs) || update.expiresAtMs <= this.now()))) throw new FactoryGrantError("factory_grant_invalid");
    if (idempotencyKey === undefined) return this.database.transaction(async transaction => {
      await this.authorizeMutation(transaction, actor, update, revoke);
      return this.applyMutation(transaction, actor, update, revoke);
    });
    const mutations = new FactoryMutations(this.database, this.tenantId, this);
    return mutations.execute(
      { principal: actor, projectId: update.projectId, action: update.action, idempotencyKey, input: { kind: revoke ? "grant.revoke" : "grant.set", principalKind: update.principal.kind, principalId: update.principal.id, action: update.action, expectedRevision: update.expectedRevision, expiresAtMs: update.expiresAtMs } },
      transaction => this.applyMutation(transaction, actor, update, revoke),
      transaction => this.authorizeMutation(transaction, actor, update, revoke),
    );
  }

  private async authorizeMutation(transaction: MigrationDb, actor: FactoryPrincipal, update: FactoryGrantUpdate, revoke: boolean): Promise<void> {
    await this.lockProject(transaction, update.projectId, true);
    const issuer = await this.livePrincipal(transaction, actor, update.projectId, false);
    if (issuer.role !== "admin") {
      const owner = rows(await transaction.execute(sql`SELECT id FROM project_members WHERE project_id=${update.projectId} AND user_id=${actor.id} AND role='owner' FOR SHARE`))[0];
      if (!owner || update.action === "factory.trust") throw new FactoryGrantError("factory_forbidden");
      const authority = await this.authorizeInTransaction(transaction, actor, update.projectId, update.action);
      if (!revoke && authority.expiresAtMs !== null && (update.expiresAtMs === null || update.expiresAtMs > authority.expiresAtMs)) throw new FactoryGrantError("factory_grant_widening");
    }
    await this.livePrincipal(transaction, update.principal, update.projectId, update.principal.kind === "user");
  }

  private async applyMutation(transaction: MigrationDb, actor: FactoryPrincipal, update: FactoryGrantUpdate, revoke: boolean): Promise<FactoryGrantRevision> {
      const prior = await this.find(transaction, update);
      if (Number(prior?.revision ?? 0) !== update.expectedRevision || (revoke && !prior)) throw new FactoryGrantError("factory_grant_conflict");
      const revision = update.expectedRevision + 1;
      if (!Number.isSafeInteger(revision)) throw new FactoryGrantError("factory_grant_invalid");
      const expiresAtMs = revoke ? prior!.expires_ms === null ? null : Number(prior!.expires_ms) : update.expiresAtMs;
      await transaction.execute(sql`INSERT INTO factory_grants (tenant_id, project_id, principal_kind, principal_id, action, issuer_id, expires_at, revision, revoked_at)
        VALUES (${this.tenantId}, ${update.projectId}, ${update.principal.kind}, ${update.principal.id}, ${update.action}, ${actor.id}, ${expiresAtMs === null ? null : new Date(expiresAtMs)}, ${revision}, ${revoke ? new Date(this.now()) : null})
        ON CONFLICT (tenant_id, project_id, principal_kind, principal_id, action) DO UPDATE SET issuer_id=EXCLUDED.issuer_id, expires_at=EXCLUDED.expires_at, revision=EXCLUDED.revision, revoked_at=EXCLUDED.revoked_at, updated_at=NOW()`);
      const target = digestObject({ tenantId: this.tenantId, projectId: update.projectId, kind: update.principal.kind, id: update.principal.id, action: update.action });
      await insertTransactionalAuditEntry(transaction, `factory-grant:${target}:${revision}`, actor.id, revoke ? "factory.grant.revoked" : "factory.grant.issued", target, { tenantId: this.tenantId, projectId: update.projectId, principalKind: update.principal.kind, principalId: update.principal.id, action: update.action, revision, expiresAtMs });
      return { revision, expiresAtMs };
  }

  private action(action: FactoryAction): void {
    if (!FACTORY_ACTIONS.includes(action)) throw new FactoryGrantError("factory_grant_invalid");
  }

  private async lockProject(transaction: MigrationDb, projectId: string, write = false): Promise<void> {
    assertFactoryIdentity(projectId);
    const lock = write ? sql`FOR UPDATE` : sql`FOR SHARE`;
    const project = rows(await transaction.execute(sql`SELECT project_id FROM factory_projects WHERE tenant_id=${this.tenantId} AND project_id=${projectId} ${lock}`))[0];
    if (!project) throw new FactoryGrantError("factory_forbidden");
  }

  private async livePrincipal(transaction: MigrationDb, principal: FactoryPrincipal, projectId: string, membership: boolean): Promise<{ role?: string }> {
    assertFactoryIdentity(principal.id);
    if (principal.kind === "user") {
      if (principal.authentication !== "session" && principal.authentication !== "api-key") throw new FactoryGrantError("factory_forbidden");
      const user = rows<{ role: string }>(await transaction.execute(sql`SELECT role FROM users WHERE id=${principal.id} AND status='active' FOR SHARE`))[0];
      const member = !membership || rows(await transaction.execute(sql`SELECT id FROM project_members WHERE project_id=${projectId} AND user_id=${principal.id} FOR SHARE`))[0];
      if (!user || !member) throw new FactoryGrantError("factory_forbidden");
      return user;
    }
    if (principal.kind !== "service" || principal.authentication !== "service") throw new FactoryGrantError("factory_forbidden");
    if (principal.credential) {
      if (principal.credential.serviceAccountId !== principal.id || principal.credential.projectId !== projectId) throw new FactoryGrantError("factory_forbidden");
      await assertFactoryServiceCredentialInTransaction(transaction, this.tenantId, principal.credential);
    }
    const service = rows(await transaction.execute(sql`SELECT id FROM service_accounts WHERE id=${principal.id} AND enabled=TRUE AND (expires_at IS NULL OR expires_at > ${new Date(this.now())}) AND (project_id IS NULL OR project_id=${projectId}) FOR SHARE`))[0];
    const scoped = !membership || rows(await transaction.execute(sql`SELECT action FROM factory_grants WHERE tenant_id=${this.tenantId} AND project_id=${projectId} AND principal_kind='service' AND principal_id=${principal.id} AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ${new Date(this.now())}) LIMIT 1 FOR SHARE`))[0];
    if (!service || !scoped) throw new FactoryGrantError("factory_forbidden");
    return {};
  }

  private async find(transaction: MigrationDb, key: FactoryGrantKey): Promise<GrantRow | undefined> {
    return rows<GrantRow>(await transaction.execute(sql`SELECT principal_kind, principal_id, action, revision, EXTRACT(EPOCH FROM expires_at) * 1000 AS expires_ms, revoked_at, issuer_id, FLOOR(EXTRACT(EPOCH FROM updated_at) * 1000) AS updated_ms FROM factory_grants WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND principal_kind=${key.principal.kind} AND principal_id=${key.principal.id} AND action=${key.action} FOR SHARE`))[0];
  }

  private record(projectId: string, row: GrantRow, key?: FactoryGrantKey): FactoryGrantRecord {
    const principalKind = (row.principal_kind ?? key?.principal.kind) as FactoryPrincipal["kind"];
    const principalId = row.principal_id ?? key?.principal.id;
    const action = (row.action ?? key?.action) as FactoryAction;
    if ((principalKind !== "user" && principalKind !== "service") || !principalId || !FACTORY_ACTIONS.includes(action)) throw new FactoryGrantError("factory_grant_corrupt");
    const revision = Number(row.revision);
    const updatedAtMs = Number(row.updated_ms);
    const expiresAtMs = row.expires_ms === null ? null : Number(row.expires_ms);
    try { assertFactoryIdentity(principalId, row.issuer_id); } catch { throw new FactoryGrantError("factory_grant_corrupt"); }
    if (!Number.isSafeInteger(revision) || revision < 1 || !Number.isSafeInteger(updatedAtMs) || updatedAtMs < 0 || expiresAtMs !== null && (!Number.isSafeInteger(expiresAtMs) || expiresAtMs < 0)) throw new FactoryGrantError("factory_grant_corrupt");
    return { projectId, principalKind, principalId, action, revision, expiresAtMs, revoked: row.revoked_at !== null, issuerId: row.issuer_id, updatedAtMs };
  }

  private encodeCursor(record: Pick<FactoryGrantRecord, "principalKind" | "principalId" | "action">): string {
    return Buffer.from(JSON.stringify([record.principalKind, record.principalId, record.action]), "utf8").toString("base64url");
  }

  private decodeCursor(cursor: string | undefined): { kind: FactoryPrincipal["kind"]; id: string; action: FactoryAction } | null {
    if (cursor === undefined) return null;
    if (cursor.length < 1 || cursor.length > 2_048) throw new FactoryGrantError("factory_page_invalid");
    try {
      const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (!Array.isArray(parsed) || parsed.length !== 3 || (parsed[0] !== "user" && parsed[0] !== "service") || typeof parsed[1] !== "string" || !parsed[1] || !FACTORY_ACTIONS.includes(parsed[2])) throw new Error("invalid");
      const canonical = Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url");
      if (canonical !== cursor) throw new Error("invalid");
      return { kind: parsed[0], id: parsed[1], action: parsed[2] };
    } catch {
      throw new FactoryGrantError("factory_page_invalid");
    }
  }
}
