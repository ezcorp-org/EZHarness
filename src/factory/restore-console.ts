import { sql } from "drizzle-orm";
import type { FactoryRestoreFindingResource, FactoryRestoreResource, FactoryRestoreSignatureResource, FactoryRestoreSignBody } from "@ezcorp/factory-sdk";
import type { TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import type { MigrationDb } from "../db/migrations/types";
import { FactoryConsoleError } from "./console-tokens";
import type { FactoryPrincipal } from "./grants";
import { assertFactoryIdentity } from "./records";
import { factoryRestoreReportDigest, FactoryRestoreError, type FactoryRestore, type FactoryRestoreReport } from "./restore";
import { assertFactoryTenantAdministratorInTransaction } from "./tenant-administrator";

/**
 * Builds the installation's restore on demand, only to sign: W15's `sign` needs
 * the composed restore, and a console that never signs should not compose one.
 * Absent when this process has no startup document to compose it from.
 */
export type FactoryRestoreSigner = () => Promise<Pick<FactoryRestore, "sign">>;

/** At most this many restore epochs, newest first, and this many findings per report. */
const RESTORE_LIMIT = 20;
const FINDING_LIMIT = 200;

type EpochRow = {
  restore_id: string; mode: string; state: string; checkpoint_id: string; previous_epoch: number | string; execution_epoch: number | string;
  started_at_ms: number | string; report_json: string | null; report_digest: string | null; signed_by: string | null; signed_at_ms: number | string | null;
};

/** Blocked findings first, so a bounded list never hides one. */
function findings(report: FactoryRestoreReport): readonly FactoryRestoreFindingResource[] {
  return [...report.findings]
    .sort((left, right) => Number(right.disposition === "blocked") - Number(left.disposition === "blocked"))
    .slice(0, FINDING_LIMIT)
    .map(({ findingId, subjectKind, subjectId, disposition, reason }) => ({ findingId, subjectKind, subjectId, disposition, reason }));
}

function resource(row: EpochRow): FactoryRestoreResource {
  const report = row.report_json === null ? null : JSON.parse(row.report_json) as FactoryRestoreReport;
  return {
    restoreId: row.restore_id, mode: row.mode as FactoryRestoreResource["mode"], state: row.state as FactoryRestoreResource["state"], checkpointId: row.checkpoint_id,
    previousEpoch: Number(row.previous_epoch), executionEpoch: Number(row.execution_epoch), startedAtMs: Number(row.started_at_ms),
    ...(row.report_digest === null ? {} : { reportDigest: row.report_digest }),
    ...(report === null ? {} : {
      report: {
        checkpointId: report.checkpointId, manifestDigest: report.manifestDigest, findings: findings(report), findingCount: report.findings.length,
        blockedChecks: report.blockedChecks, blockedRuns: report.blockedRuns, releaseIdentities: report.releaseIdentities,
        recoveryMs: report.measured.recoveryMs, reportedAtMs: report.reportedAtMs,
      },
    }),
    ...(row.signed_by === null ? {} : { signedBy: row.signed_by }),
    ...(row.signed_at_ms === null ? {} : { signedAtMs: Number(row.signed_at_ms) }),
  };
}

/**
 * The console's view of C06 restores (W14 with W15): the recovery reports a
 * human tenant administrator reads, and the signature that reopens service.
 * W15's `FactoryRestore.sign` records the signature. Before it runs, the
 * console re-derives the digest of the stored report and refuses a report that
 * no longer matches the digest it was stored under.
 */
export class FactoryRestoreReports {
  constructor(private readonly database: TransactionalDb, readonly tenantId: string, private readonly signer?: FactoryRestoreSigner) {
    assertFactoryIdentity(tenantId);
  }

  async list(principal: FactoryPrincipal, tenantId: string): Promise<readonly FactoryRestoreResource[]> {
    return this.database.transaction(async transaction => {
      await this.authorize(transaction, principal, tenantId);
      const found = rows<EpochRow>(await transaction.execute(sql`SELECT restore_id, mode, state, checkpoint_id, previous_epoch, execution_epoch, started_at_ms, report_json, report_digest, signed_by, signed_at_ms
        FROM factory_restore_epochs WHERE tenant_id=${this.tenantId} ORDER BY started_at_ms DESC, restore_id LIMIT ${RESTORE_LIMIT}`));
      return found.map(resource);
    });
  }

  async sign(principal: FactoryPrincipal, tenantId: string, restoreId: string, body: FactoryRestoreSignBody): Promise<FactoryRestoreSignatureResource> {
    assertFactoryIdentity(restoreId);
    if (!/^sha256:[0-9a-f]{64}$/.test(body.reportDigest)) throw new FactoryRestoreError("factory_restore_invalid");
    await this.database.transaction(async transaction => {
      await this.authorize(transaction, principal, tenantId);
      const [epoch] = rows<{ report_json: string | null; report_digest: string | null }>(await transaction.execute(sql`SELECT report_json, report_digest FROM factory_restore_epochs WHERE tenant_id=${this.tenantId} AND restore_id=${restoreId}`));
      if (epoch?.report_json && factoryRestoreReportDigest(JSON.parse(epoch.report_json) as FactoryRestoreReport) !== epoch.report_digest) throw new FactoryRestoreError("factory_restore_report_mismatch");
    });
    if (this.signer === undefined) throw new FactoryConsoleError("factory_restore_unavailable");
    const signature = await (await this.signer()).sign(restoreId, principal, body.reportDigest);
    return { restoreId, ...signature };
  }

  private authorize(transaction: MigrationDb, principal: FactoryPrincipal, tenantId: string): Promise<void> {
    return assertFactoryTenantAdministratorInTransaction(transaction, this.tenantId, tenantId, principal);
  }
}
