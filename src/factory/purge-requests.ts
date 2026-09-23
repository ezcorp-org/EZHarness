import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { FactoryPurgePrecondition, FactoryPurgePreview, FactoryPurgeRequestBody, FactoryPurgeRequestResource } from "@ezcorp/factory-sdk";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { insertTransactionalAuditEntry } from "../db/queries/audit-log";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { idempotencyInputDigest, isBoundedIdempotencyKey } from "../idempotency";
import { FactoryConsoleError } from "./console-tokens";
import { factoryTenantAdministratorRefusalInTransaction } from "./tenant-administrator";
import { FactoryGrantError, type FactoryPrincipal } from "./grants";
import { FactoryMutationError } from "./mutations";
import { assertFactoryIdentity } from "./records";

/**
 * Each precondition is work that must be closed before a tenant can be purged
 * (plan W16: "human-admin purge after active/uncertain work closes"). A count
 * above zero refuses the request; the request itself never deletes anything.
 * Destructive purge and its certification belong to W19.
 */
const PRECONDITIONS: readonly { readonly id: string; readonly detail: string; readonly count: (tenant: string) => ReturnType<typeof sql> }[] = [
  { id: "live-runs", detail: "Runs that are queued, running, waiting, or cancelling", count: tenant => sql`SELECT COUNT(*) AS n FROM factory_run_lifecycle WHERE tenant_id=${tenant} AND status IN ('queued','running','waiting','cancelling')` },
  { id: "uncertain-runs", detail: "Runs whose outcome is uncertain", count: tenant => sql`SELECT COUNT(*) AS n FROM factory_run_lifecycle WHERE tenant_id=${tenant} AND status='uncertain'` },
  { id: "open-releases", detail: "Release operations that are pending, executing, or uncertain", count: tenant => sql`SELECT COUNT(*) AS n FROM factory_release_operations WHERE tenant_id=${tenant} AND state IN ('pending','executing','uncertain')` },
  { id: "uncertain-usage", detail: "Budget reservations whose provider usage is uncertain", count: tenant => sql`SELECT COUNT(*) AS n FROM factory_budget_reservations WHERE tenant_id=${tenant} AND (state='uncertain' OR uncertainty IS NOT NULL)` },
  { id: "uncertain-stops", detail: "Attempt stops that have not been proven", count: tenant => sql`SELECT COUNT(*) AS n FROM factory_task_stops WHERE tenant_id=${tenant} AND state='uncertain'` },
  { id: "pending-approvals", detail: "Approvals still waiting for a decision", count: tenant => sql`SELECT (SELECT COUNT(*) FROM factory_command_approvals WHERE tenant_id=${tenant} AND status='pending') + (SELECT COUNT(*) FROM factory_release_approvals WHERE tenant_id=${tenant} AND status='pending') AS n` },
  { id: "undelivered-commands", detail: "Durable commands not yet delivered", count: tenant => sql`SELECT COUNT(*) AS n FROM factory_command_outbox WHERE tenant_id=${tenant} AND state IN ('queued','leased','outcome_unknown')` },
];

type PurgeRequestRow = { metadata: unknown };

function requestIdFor(tenantId: string, principal: FactoryPrincipal, idempotencyKey: string): string {
  return `purge-${createHash("sha256").update(JSON.stringify([tenantId, principal.kind, principal.id, idempotencyKey])).digest("hex").slice(0, 32)}`;
}

/**
 * The administrator's tenant purge request (C09 "Tenant purge request", C06).
 *
 * Only a human tenant administrator in an interactive session may ask. The
 * request evaluates every closing precondition, counts the audit a purge would
 * destroy, and records that count in an audit row that the purge itself must
 * retain. Its idempotency is keyed to the audit row: the product receipt table
 * is project-scoped by foreign key, and a tenant purge names no project.
 */
export class FactoryPurgeRequests {
  constructor(private readonly database: TransactionalDb, readonly tenantId: string, private readonly now: () => number = Date.now) { assertFactoryIdentity(tenantId); }

  async preview(principal: FactoryPrincipal, tenantId: string): Promise<FactoryPurgePreview> {
    return this.database.transaction(async transaction => {
      await this.authorize(transaction, principal, tenantId);
      return this.evaluate(transaction);
    });
  }

  async request(principal: FactoryPrincipal, tenantId: string, body: FactoryPurgeRequestBody, idempotencyKey: string): Promise<FactoryPurgeRequestResource> {
    const input = JSON.parse(JSON.stringify({ principal, tenantId, body })) as { principal: FactoryPrincipal; tenantId: string; body: FactoryPurgeRequestBody };
    if (!isBoundedIdempotencyKey(idempotencyKey)) throw new FactoryMutationError("invalid_idempotency_key");
    if (input.body.confirmTenantId !== this.tenantId) throw new FactoryConsoleError("factory_purge_confirmation");
    const digest = idempotencyInputDigest({ action: "factory.tenant.purge.request", input: { tenantId: input.tenantId, body: input.body } });
    const requestId = requestIdFor(this.tenantId, input.principal, idempotencyKey);
    return this.database.transaction(async transaction => {
      // Authority is rechecked before a replay is served, as for every mutation.
      await this.authorize(transaction, input.principal, input.tenantId);
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`factory-purge:${this.tenantId}:${requestId}`}, 0))`);
      const [previous] = rows<PurgeRequestRow>(await transaction.execute(sql`SELECT metadata FROM audit_log WHERE id=${`factory-purge-request:${this.tenantId}:${requestId}`}`));
      if (previous) {
        const metadata = (typeof previous.metadata === "string" ? JSON.parse(previous.metadata) : previous.metadata) as { inputDigest: string; resource: FactoryPurgeRequestResource };
        if (metadata.inputDigest !== digest) throw new FactoryMutationError("idempotency_conflict");
        return metadata.resource;
      }
      const preview = await this.evaluate(transaction);
      const resource: FactoryPurgeRequestResource = {
        ...preview, requestId, state: preview.ready ? "queued" : "refused", requestedBy: input.principal.id, requestedAtMs: this.now(),
      };
      await insertTransactionalAuditEntry(transaction, `factory-purge-request:${this.tenantId}:${requestId}`, input.principal.id, "factory.tenant.purge.requested", this.tenantId, {
        tenantId: this.tenantId, inputDigest: digest, reason: input.body.reason, resource,
      });
      return resource;
    });
  }

  private async authorize(transaction: MigrationDb, principal: FactoryPrincipal, tenantId: string): Promise<void> {
    if (tenantId !== this.tenantId) throw new FactoryGrantError("factory_forbidden");
    const refusal = await factoryTenantAdministratorRefusalInTransaction(transaction, principal);
    if (refusal) throw new FactoryGrantError(refusal);
  }

  private async evaluate(transaction: MigrationDb): Promise<FactoryPurgePreview> {
    const preconditions: FactoryPurgePrecondition[] = [];
    for (const condition of PRECONDITIONS) {
      const [row] = rows<{ n: string | number }>(await transaction.execute(condition.count(this.tenantId)));
      const count = Number(row?.n ?? 0);
      preconditions.push({ id: condition.id, satisfied: count === 0, count, detail: condition.detail });
    }
    const [audit] = rows<{ n: string | number }>(await transaction.execute(sql`SELECT
      (SELECT COUNT(*) FROM audit_log WHERE metadata->>'tenantId'=${this.tenantId}) + (SELECT COUNT(*) FROM factory_audit_batches WHERE tenant_id=${this.tenantId}) AS n`));
    return { tenantId: this.tenantId, ready: preconditions.every(item => item.satisfied), preconditions, auditRowsLost: Number(audit?.n ?? 0) };
  }
}
