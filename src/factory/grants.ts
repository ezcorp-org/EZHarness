import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { insertTransactionalAuditEntry } from "../db/queries/audit-log";
import { digestObject } from "../extensions/v4/blobs";
import { assertFactoryIdentity } from "./records";

export const FACTORY_ACTIONS = ["factory.author", "factory.publish", "factory.run", "factory.operate", "factory.approve", "factory.release", "factory.trust"] as const;
export type FactoryAction = typeof FACTORY_ACTIONS[number];
export interface FactoryPrincipal {
  readonly kind: "user" | "service";
  readonly id: string;
  /** Set only by the authenticated server boundary. Never copy this from JSON. */
  readonly authentication: "session" | "api-key" | "service";
}
export interface FactoryGrantKey { readonly projectId: string; readonly principal: FactoryPrincipal; readonly action: FactoryAction }
export interface FactoryGrantRevision { readonly revision: number; readonly expiresAtMs: number | null }
export interface FactoryGrantUpdate extends FactoryGrantKey { readonly expectedRevision: number; readonly expiresAtMs: number | null }
type GrantRow = { revision: string | number; expires_ms: string | number | null; revoked_at: unknown; issuer_id: string };

export class FactoryGrantError extends Error {
  constructor(readonly code: string) { super(code); this.name = "FactoryGrantError"; }
}

/** Current product authority. Call inside the same transaction as an effect claim. */
export class FactoryGrants {
  constructor(private readonly database: TransactionalDb, readonly tenantId: string, private readonly now: () => number = Date.now) { assertFactoryIdentity(tenantId); }

  authorize(principal: FactoryPrincipal, projectId: string, action: FactoryAction | "read", expectedRevision?: number): Promise<FactoryGrantRevision> {
    return this.database.transaction(transaction => this.authorizeInTransaction(transaction, principal, projectId, action, expectedRevision));
  }

  async authorizeInTransaction(transaction: MigrationDb, principal: FactoryPrincipal, projectId: string, action: FactoryAction | "read", expectedRevision?: number): Promise<FactoryGrantRevision> {
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

  set(actor: FactoryPrincipal, update: FactoryGrantUpdate): Promise<FactoryGrantRevision> {
    return this.mutate(actor, update, false);
  }

  revoke(actor: FactoryPrincipal, update: FactoryGrantKey & { readonly expectedRevision: number }): Promise<FactoryGrantRevision> {
    return this.mutate(actor, { ...update, expiresAtMs: null }, true);
  }

  private async mutate(actor: FactoryPrincipal, update: FactoryGrantUpdate, revoke: boolean): Promise<FactoryGrantRevision> {
    this.action(update.action);
    if (!revoke && update.principal.kind === "service" && update.expiresAtMs === null) throw new FactoryGrantError("factory_grant_invalid");
    if (actor.kind !== "user" || actor.authentication !== "session") throw new FactoryGrantError("factory_human_required");
    if (!Number.isSafeInteger(update.expectedRevision) || update.expectedRevision < 0 || (!revoke && update.expiresAtMs !== null && (!Number.isSafeInteger(update.expiresAtMs) || update.expiresAtMs <= this.now()))) throw new FactoryGrantError("factory_grant_invalid");
    return this.database.transaction(async transaction => {
      await this.lockProject(transaction, update.projectId, true);
      const issuer = await this.livePrincipal(transaction, actor, update.projectId, false);
      if (issuer.role !== "admin") {
        const owner = rows(await transaction.execute(sql`SELECT id FROM project_members WHERE project_id=${update.projectId} AND user_id=${actor.id} AND role='owner' FOR SHARE`))[0];
        if (!owner || update.action === "factory.trust") throw new FactoryGrantError("factory_forbidden");
        const authority = await this.authorizeInTransaction(transaction, actor, update.projectId, update.action);
        if (!revoke && authority.expiresAtMs !== null && (update.expiresAtMs === null || update.expiresAtMs > authority.expiresAtMs)) throw new FactoryGrantError("factory_grant_widening");
      }
      await this.livePrincipal(transaction, update.principal, update.projectId, update.principal.kind === "user");
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
    });
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
    const service = rows(await transaction.execute(sql`SELECT id FROM service_accounts WHERE id=${principal.id} AND enabled=TRUE AND (expires_at IS NULL OR expires_at > ${new Date(this.now())}) AND (project_id IS NULL OR project_id=${projectId}) FOR SHARE`))[0];
    const scoped = !membership || rows(await transaction.execute(sql`SELECT action FROM factory_grants WHERE tenant_id=${this.tenantId} AND project_id=${projectId} AND principal_kind='service' AND principal_id=${principal.id} AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ${new Date(this.now())}) LIMIT 1 FOR SHARE`))[0];
    if (!service || !scoped) throw new FactoryGrantError("factory_forbidden");
    return {};
  }

  private async find(transaction: MigrationDb, key: FactoryGrantKey): Promise<GrantRow | undefined> {
    return rows<GrantRow>(await transaction.execute(sql`SELECT revision, EXTRACT(EPOCH FROM expires_at) * 1000 AS expires_ms, revoked_at, issuer_id FROM factory_grants WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND principal_kind=${key.principal.kind} AND principal_id=${key.principal.id} AND action=${key.action} FOR SHARE`))[0];
  }
}
