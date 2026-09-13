import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import type { FactoryAttemptAuthority } from "./executions";
import { FactoryGrants, FactoryGrantError } from "./grants";
import { FactoryRecords } from "./records";

/** Resolves effect authority from the durable initiator, never a runner callback. */
export class FactoryRunGrants {
  private readonly records: FactoryRecords;
  private readonly grants: FactoryGrants;

  constructor(private readonly database: TransactionalDb, private readonly tenantId: string, now: () => number = Date.now) {
    this.records = new FactoryRecords(database, tenantId);
    this.grants = new FactoryGrants(database, tenantId, now);
  }

  readonly authorize = (authority: FactoryAttemptAuthority): Promise<void> => this.database.transaction(transaction => this.authorizeInTransaction(transaction, authority));

  readonly authorizeInTransaction = async (transaction: MigrationDb, authority: FactoryAttemptAuthority): Promise<void> => {
    if (authority.tenantId !== this.tenantId) throw new FactoryGrantError("factory_forbidden");
    const request = await this.records.readRunRequestInTransaction(transaction, authority);
    if (request.executionEpoch !== authority.executionEpoch) throw new FactoryGrantError("factory_forbidden");
    const kind = request.principalKind ?? "user";
    await this.grants.authorizeInTransaction(transaction, { kind, id: request.principalId, authentication: kind === "service" ? "service" : "api-key" }, request.projectId, "factory.run", authority.grantRevision);
  };
}
