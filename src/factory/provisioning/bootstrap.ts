/**
 * The installation's side of human bootstrap (C01, C12 step 7).
 *
 * Two acts, by one human, in two requests:
 *
 *   1. REDEEM. First-run setup presents the provisioned invitation token; the
 *      account it creates is the first administrator, and a `redeemed` row
 *      binds that account to the invitation. Identity only.
 *   2. CONSENT. That administrator, in a SESSION (never an API key, never a
 *      service), explicitly consents for a bootstrap project. In one
 *      transaction this writes the consent record, the project's approve,
 *      trust, and release grants, and the fail-closed audit entry
 *      (`insertTransactionalAuditEntry`). If any of them fails, none exists.
 *
 * Creating the invitation established nothing, and redeeming it established
 * nothing beyond who the administrator is. Only the second act is consent.
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../../db/migrations/types";
import { releaseRows as rows } from "../../db/queries/extension-releases";
import { insertTransactionalAuditEntry } from "../../db/queries/audit-log";
import { FactoryGrants, type FactoryAction, type FactoryPrincipal } from "../grants";
import { loadFactoryBootstrapInvitation, type FactoryBootstrapInvitation } from "./invitation";

export const FACTORY_BOOTSTRAP_CONSENT_ACTIONS: readonly FactoryAction[] = Object.freeze(["factory.approve", "factory.trust", "factory.release"]);
export const FACTORY_BOOTSTRAP_ACKNOWLEDGEMENT = "I am the first administrator of this installation and I consent to act as its consent authority.";

export type FactoryBootstrapState = "invited" | "redeemed" | "consented";

export class FactoryBootstrapError extends Error {
  constructor(readonly code: "bootstrap_not_redeemed" | "bootstrap_already_consented" | "bootstrap_not_administrator" | "bootstrap_human_required" | "bootstrap_acknowledgement_required" | "bootstrap_project_invalid") {
    super(code);
    this.name = "FactoryBootstrapError";
  }
}

interface BootstrapRow { installation_id: string; invitation_id: string; admin_user_id: string; state: "redeemed" | "consented"; project_id: string | null }

export interface FactoryBootstrapStatus {
  readonly state: FactoryBootstrapState;
  readonly invitationId: string | null;
}

/** The invitation setup verified, for adopting a setup whose redemption row never committed. */
export interface FactoryBootstrapOrphan {
  readonly invitation: FactoryBootstrapInvitation;
  readonly nowMs: number;
}

export interface FactoryBootstrapConsent {
  readonly projectId: string;
  readonly acknowledgement: string;
}

export class FactoryInstallationBootstrap {
  private readonly grants: FactoryGrants;
  constructor(private readonly database: TransactionalDb, readonly installationId: string, readonly tenantId: string, grants?: FactoryGrants) {
    this.grants = grants ?? new FactoryGrants(database, tenantId);
  }

  private async row(transaction: MigrationDb, lock: boolean): Promise<BootstrapRow | undefined> {
    return rows<BootstrapRow>(await transaction.execute(sql`SELECT installation_id, invitation_id, admin_user_id, state, project_id FROM factory_installation_bootstrap WHERE installation_id=${this.installationId} ${lock ? sql`FOR UPDATE` : sql``}`))[0];
  }

  /** What the operator may observe from outside: a state and the invitation it concerns. No person, no project. */
  async status(): Promise<FactoryBootstrapStatus> {
    const row = await this.database.transaction((transaction) => this.row(transaction, false));
    return Object.freeze({ state: row?.state ?? "invited", invitationId: row?.invitation_id ?? null });
  }

  /**
   * Bind the first administrator to the invitation that admitted them.
   *
   * Idempotent for the same administrator and invitation; a second, different
   * redemption is refused, so one invitation makes exactly one administrator.
   */
  async recordRedeemed(invitation: FactoryBootstrapInvitation, adminUserId: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction.execute(sql`INSERT INTO factory_installation_bootstrap (installation_id, tenant_id, invitation_id, admin_user_id, state) VALUES (${this.installationId}, ${this.tenantId}, ${invitation.invitationId}, ${adminUserId}, 'redeemed') ON CONFLICT (installation_id) DO NOTHING`);
      const row = await this.row(transaction, false);
      if (!row || row.admin_user_id !== adminUserId || row.invitation_id !== invitation.invitationId) throw new FactoryBootstrapError("bootstrap_not_administrator");
      await insertTransactionalAuditEntry(transaction, `factory-bootstrap-redeemed:${this.installationId}`, adminUserId, "factory.bootstrap.redeemed", this.installationId, { tenantId: this.tenantId, invitationId: invitation.invitationId });
    });
  }

  /**
   * The explicit consent act. Everything it writes commits together.
   *
   * The acknowledgement must be the exact sentence, so consent is something a
   * human reads and sends rather than a flag a client defaults to true.
   */
  /**
   * Adopt a setup whose redemption row never committed.
   *
   * First-run setup creates the administrator before it records the
   * redemption, so a failure between the two leaves an administrator and no
   * row, and setup refuses a second run. The consent act closes that gap, in
   * its own transaction and under the same proof setup demanded: the
   * invitation has not expired, and the caller is the installation's only
   * user, an administrator, with the invited email.
   */
  private async adoptOrphan(transaction: MigrationDb, actor: FactoryPrincipal, orphan: FactoryBootstrapOrphan): Promise<BootstrapRow | undefined> {
    const { invitation } = orphan;
    if (invitation.installationId !== this.installationId || orphan.nowMs >= invitation.expiresAtMs) return undefined;
    const users = rows<{ id: string; email: string; role: string }>(await transaction.execute(sql`SELECT id, email, role FROM users ORDER BY created_at LIMIT 2 FOR SHARE`));
    const [only] = users;
    if (users.length !== 1 || only!.id !== actor.id || only!.role !== "admin" || only!.email.toLowerCase() !== invitation.administratorEmail.toLowerCase()) return undefined;
    await transaction.execute(sql`INSERT INTO factory_installation_bootstrap (installation_id, tenant_id, invitation_id, admin_user_id, state) VALUES (${this.installationId}, ${this.tenantId}, ${invitation.invitationId}, ${actor.id}, 'redeemed')`);
    await insertTransactionalAuditEntry(transaction, `factory-bootstrap-redeemed:${this.installationId}`, actor.id, "factory.bootstrap.redeemed", this.installationId, { tenantId: this.tenantId, invitationId: invitation.invitationId, adopted: true });
    return this.row(transaction, true);
  }

  async consent(actor: FactoryPrincipal, input: FactoryBootstrapConsent, orphan?: FactoryBootstrapOrphan): Promise<{ readonly consentDigest: string; readonly grants: Readonly<Record<string, number>> }> {
    if (actor.kind !== "user" || actor.authentication !== "session") throw new FactoryBootstrapError("bootstrap_human_required");
    if (input.acknowledgement !== FACTORY_BOOTSTRAP_ACKNOWLEDGEMENT) throw new FactoryBootstrapError("bootstrap_acknowledgement_required");
    if (typeof input.projectId !== "string" || input.projectId.length === 0 || input.projectId.length > 256) throw new FactoryBootstrapError("bootstrap_project_invalid");
    return this.database.transaction(async (transaction) => {
      const row = await this.row(transaction, true) ?? (orphan ? await this.adoptOrphan(transaction, actor, orphan) : undefined);
      if (!row) throw new FactoryBootstrapError("bootstrap_not_redeemed");
      if (row.state === "consented") throw new FactoryBootstrapError("bootstrap_already_consented");
      if (row.admin_user_id !== actor.id) throw new FactoryBootstrapError("bootstrap_not_administrator");
      const project = rows(await transaction.execute(sql`SELECT project_id FROM factory_projects WHERE tenant_id=${this.tenantId} AND project_id=${input.projectId} FOR SHARE`))[0];
      if (!project) throw new FactoryBootstrapError("bootstrap_project_invalid");
      const granted: Record<string, number> = {};
      for (const action of FACTORY_BOOTSTRAP_CONSENT_ACTIONS) {
        const prior = rows<{ revision: string | number }>(await transaction.execute(sql`SELECT revision FROM factory_grants WHERE tenant_id=${this.tenantId} AND project_id=${input.projectId} AND principal_kind='user' AND principal_id=${actor.id} AND action=${action} FOR UPDATE`))[0];
        const revision = await this.grants.setInTransaction(transaction, actor, { projectId: input.projectId, principal: { kind: "user", id: actor.id, authentication: "session" }, action, expectedRevision: Number(prior?.revision ?? 0), expiresAtMs: null });
        granted[action] = revision.revision;
      }
      const consentDigest = `sha256:${createHash("sha256").update(JSON.stringify({ installationId: this.installationId, tenantId: this.tenantId, invitationId: row.invitation_id, adminUserId: actor.id, projectId: input.projectId, acknowledgement: input.acknowledgement, grants: granted })).digest("hex")}`;
      await transaction.execute(sql`UPDATE factory_installation_bootstrap SET state='consented', project_id=${input.projectId}, consent_digest=${consentDigest}, consented_at=NOW() WHERE installation_id=${this.installationId} AND state='redeemed'`);
      await insertTransactionalAuditEntry(transaction, `factory-bootstrap-consent:${this.installationId}`, actor.id, "factory.bootstrap.consent", this.installationId, { tenantId: this.tenantId, invitationId: row.invitation_id, projectId: input.projectId, consentDigest, grants: granted });
      return Object.freeze({ consentDigest, grants: Object.freeze(granted) });
    });
  }
}

export interface FactoryBootstrapHost {
  readonly invitation: FactoryBootstrapInvitation;
  readonly bootstrap: FactoryInstallationBootstrap;
}

/**
 * The bootstrap a provisioned installation runs, or `null` for one that was
 * not provisioned (no invitation declared), which keeps today's first-run
 * setup unchanged, and never touches the database. A DECLARED invitation that cannot be read fails closed:
 * setup must not fall back to "first caller wins" because a file is missing.
 */
export async function factoryBootstrapHost(env: Readonly<Record<string, string | undefined>>, database: () => TransactionalDb): Promise<FactoryBootstrapHost | null> {
  const path = env.EZCORP_FACTORY_BOOTSTRAP_INVITATION?.trim();
  if (!path) return null;
  const installationId = env.EZCORP_INSTALLATION_ID?.trim() ?? "";
  const invitation = await loadFactoryBootstrapInvitation(path, installationId);
  return Object.freeze({ invitation, bootstrap: new FactoryInstallationBootstrap(database(), installationId, invitation.tenantId) });
}
