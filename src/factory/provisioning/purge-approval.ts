/**
 * The administrator's approval to purge an installation (C12, contract row
 * "Tenant purge request: human administrator session").
 *
 * Two sides, one table:
 *
 *   - ISSUE runs inside the installation. An administrator, in a session
 *     (never an API key, never a service), sends the exact acknowledgement and
 *     a reason. The approval row and its audit entry commit together. The
 *     approval is bound to this installation and expires.
 *   - VERIFY runs in the operator's provisioner at purge time. It reads the
 *     approval from the installation's retained database and accepts it only
 *     when it names this installation, has not expired, and its approver is
 *     still an active administrator. The operator can name an approval; it
 *     cannot make one.
 *
 * The approval must be issued before teardown, while the installation still
 * serves its administrators. Purge drops the database, and the approval with
 * it, so an approval cannot be replayed.
 */
import { randomUUID } from "node:crypto";
import { openBunSql } from "../../db/bun-sql-pipelining";
import { sql } from "drizzle-orm";
import type { TransactionalDb } from "../../db/migrations/types";
import { releaseRows as rows } from "../../db/queries/extension-releases";
import { insertTransactionalAuditEntry } from "../../db/queries/audit-log";
import type { FactoryPrincipal } from "../grants";
import type { FactoryInstallationContext } from "./installation";
import type { FactoryPurgeApprovals } from "./local";
import { FactoryProvisioningError } from "./steps";

export const FACTORY_PURGE_ACKNOWLEDGEMENT = "I am an administrator of this installation and I approve the permanent deletion of its data after teardown.";
export const FACTORY_PURGE_APPROVAL_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const APPROVAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type FactoryPurgeApprovalErrorCode = "purge_approval_human_required" | "purge_approval_acknowledgement_required" | "purge_approval_reason_invalid" | "purge_approval_not_administrator";

export class FactoryPurgeApprovalError extends Error {
  constructor(readonly code: FactoryPurgeApprovalErrorCode) {
    super(code);
    this.name = "FactoryPurgeApprovalError";
  }
}

export interface FactoryIssuedPurgeApproval {
  readonly approvalId: string;
  readonly expiresAtMs: number;
}

/** The installation side: record an administrator's session approval, with its audit entry, in one transaction. */
export async function issueFactoryPurgeApproval(database: TransactionalDb, installationId: string, actor: FactoryPrincipal, input: { readonly acknowledgement: unknown; readonly reason: unknown }, nowMs: number): Promise<FactoryIssuedPurgeApproval> {
  if (actor.kind !== "user" || actor.authentication !== "session") throw new FactoryPurgeApprovalError("purge_approval_human_required");
  if (input.acknowledgement !== FACTORY_PURGE_ACKNOWLEDGEMENT) throw new FactoryPurgeApprovalError("purge_approval_acknowledgement_required");
  if (typeof input.reason !== "string" || input.reason.trim().length === 0 || input.reason.length > 256) throw new FactoryPurgeApprovalError("purge_approval_reason_invalid");
  const reason = input.reason.trim();
  const approvalId = randomUUID();
  const approvedAt = new Date(nowMs), expiresAt = new Date(nowMs + FACTORY_PURGE_APPROVAL_LIFETIME_MS);
  return database.transaction(async (transaction) => {
    const user = rows<{ role: string; status: string }>(await transaction.execute(sql`SELECT role, status FROM users WHERE id=${actor.id} FOR SHARE`))[0];
    if (user?.role !== "admin" || user.status !== "active") throw new FactoryPurgeApprovalError("purge_approval_not_administrator");
    await transaction.execute(sql`INSERT INTO factory_installation_purge_approvals (approval_id, installation_id, approved_by_user_id, reason, approved_at, expires_at) VALUES (${approvalId}, ${installationId}, ${actor.id}, ${reason}, ${approvedAt.toISOString()}, ${expiresAt.toISOString()})`);
    await insertTransactionalAuditEntry(transaction, `factory-purge-approval:${approvalId}`, actor.id, "factory.installation.purge_approved", installationId, { approvalId, reason, expiresAtMs: expiresAt.getTime() });
    return Object.freeze({ approvalId, expiresAtMs: expiresAt.getTime() });
  });
}

/** The one-connection client verify needs: a tagged query and close. `bun`'s SQL satisfies it. */
export interface FactoryPurgeApprovalClient {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
  close(): Promise<void>;
}

const connectSql = (url: string): FactoryPurgeApprovalClient => openBunSql(url, { max: 1 }) as unknown as FactoryPurgeApprovalClient;

/**
 * The provisioner side: verify a named approval in the installation's
 * retained database, over the cluster's administrative connection.
 */
export function factoryDatabasePurgeApprovals(adminUrl: string, connect: (url: string) => FactoryPurgeApprovalClient = connectSql): FactoryPurgeApprovals {
  return {
    async verify(installation: FactoryInstallationContext, approvalId: string) {
      const refuse = (): never => { throw new FactoryProvisioningError("purge_approval_invalid", "Purge needs an unexpired approval an active administrator of this installation issued in a session."); };
      if (!APPROVAL_ID.test(approvalId)) refuse();
      const url = new URL(adminUrl); url.pathname = `/${installation.productDatabase}`;
      const client = connect(url.toString());
      try {
        const present = (await client`SELECT to_regclass('public.factory_installation_purge_approvals') IS NOT NULL AS present`)[0] as { present: boolean };
        if (!present.present) refuse();
        const row = (await client`SELECT u.email FROM factory_installation_purge_approvals a JOIN users u ON u.id = a.approved_by_user_id
          WHERE a.approval_id = ${approvalId} AND a.installation_id = ${installation.installationId} AND a.expires_at > now() AND u.role = 'admin' AND u.status = 'active'`)[0] as { email: string } | undefined;
        if (!row) refuse();
        return Object.freeze({ approvedBy: `admin:${row!.email.toLowerCase()}` });
      } finally { await client.close(); }
    },
  };
}
