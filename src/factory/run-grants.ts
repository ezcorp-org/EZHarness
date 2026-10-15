import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import type { FactoryAttemptAuthority } from "./executions";
import { FactoryGrants, FactoryGrantError } from "./grants";
import { FactoryRecords } from "./records";

type RunGrantAuthority = Readonly<Pick<FactoryAttemptAuthority, "tenantId" | "projectId" | "runId" | "executionEpoch" | "grantRevision">>;

function snapshotRunGrantAuthority(authority: FactoryAttemptAuthority): RunGrantAuthority {
  return Object.freeze({ tenantId: authority.tenantId, projectId: authority.projectId, runId: authority.runId, executionEpoch: authority.executionEpoch, grantRevision: authority.grantRevision });
}

/** Resolves effect authority from the durable initiator, never a runner callback. */
export class FactoryRunGrants {
  private readonly records: FactoryRecords;
  private readonly grants: FactoryGrants;

  constructor(private readonly database: TransactionalDb, private readonly tenantId: string, now: () => number = Date.now) {
    this.records = new FactoryRecords(database, tenantId);
    this.grants = new FactoryGrants(database, tenantId, now);
  }

  readonly authorize = (authority: FactoryAttemptAuthority): Promise<void> => {
    const snapshot = snapshotRunGrantAuthority(authority);
    return this.database.transaction(transaction => this.authorizeSnapshotInTransaction(transaction, snapshot));
  };

  readonly authorizeInTransaction = (transaction: MigrationDb, authority: FactoryAttemptAuthority): Promise<void> => this.authorizeSnapshotInTransaction(transaction, snapshotRunGrantAuthority(authority));

  private readonly authorizeSnapshotInTransaction = async (transaction: MigrationDb, authority: RunGrantAuthority): Promise<void> => {
    if (authority.tenantId !== this.tenantId) throw new FactoryGrantError("factory_forbidden");
    const request = await this.records.readRunRequestInTransaction(transaction, authority);
    if (request.executionEpoch !== authority.executionEpoch) throw new FactoryGrantError("factory_forbidden");
    const kind = request.principalKind ?? "user";
    await this.grants.authorizeInTransaction(transaction, { kind, id: request.principalId, authentication: kind === "service" ? "service" : "api-key", ...(request.serviceCredential === undefined ? {} : { credential: request.serviceCredential }) }, request.projectId, "factory.run", authority.grantRevision);
  };
}
