import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { idempotencyInputDigest, isBoundedIdempotencyKey } from "../idempotency";
import { assertFactoryIdentity, encodeFactoryPayload } from "./records";
import type { FactoryAction, FactoryGrants, FactoryPrincipal } from "./grants";

export class FactoryMutationError extends Error {
  constructor(readonly code: string) { super(code); this.name = "FactoryMutationError"; }
}

export interface FactoryMutation {
  readonly projectId: string;
  readonly principal: FactoryPrincipal;
  readonly action: FactoryAction;
  readonly idempotencyKey: string;
  readonly expectedGrantRevision?: number;
  /** Includes the operation name, target identity and expected revision. */
  readonly input: unknown;
}

type ReceiptRow = { input_digest: string; response_json: string | null; response_digest: string | null };

/** One durable receipt protocol for product mutations; authorization always runs. */
export class FactoryMutations {
  constructor(private readonly database: TransactionalDb, readonly tenantId: string, private readonly grants: FactoryGrants) {
    assertFactoryIdentity(tenantId);
    if (grants.tenantId !== tenantId) throw new FactoryMutationError("factory_scope_mismatch");
  }

  /**
   * The stored response for an exact request, read without starting the mutation.
   *
   * A mutation whose external work must happen outside its transaction — a provider proof, an
   * archive write — calls this first, so a replay returns the recorded outcome instead of
   * repeating that work against an operation the first call already moved. A completed receipt is
   * only ever visible from outside a transaction, because the insert and the response land
   * together, so an incomplete row here simply means "not recorded yet".
   */
  async replay<Result>(request: FactoryMutation): Promise<{ readonly found: true; readonly response: Result } | { readonly found: false }> {
    const digest = this.assertRequest(request);
    const row = rows<ReceiptRow>(await this.database.execute(sql`SELECT input_digest, response_json, response_digest FROM factory_mutation_receipts WHERE tenant_id=${this.tenantId} AND project_id=${request.projectId} AND principal_kind=${request.principal.kind} AND principal_id=${request.principal.id} AND idempotency_key=${request.idempotencyKey}`))[0];
    if (!row?.response_json) return { found: false };
    if (row.input_digest !== digest) throw new FactoryMutationError("idempotency_conflict");
    return { found: true, response: this.decodeResponse<Result>(row) };
  }

  private assertRequest(request: FactoryMutation): string {
    if (typeof request.idempotencyKey !== "string" || !isBoundedIdempotencyKey(request.idempotencyKey)) throw new FactoryMutationError("invalid_idempotency_key");
    return idempotencyInputDigest({ action: request.action, input: request.input });
  }

  private decodeResponse<Result>(previous: ReceiptRow): Result {
    const response = JSON.parse(previous.response_json!) as Result;
    if (encodeFactoryPayload(response) !== previous.response_json || idempotencyInputDigest(response) !== previous.response_digest) throw new FactoryMutationError("factory_receipt_corrupt");
    return response;
  }

  async execute<Result>(
    request: FactoryMutation,
    apply: (transaction: MigrationDb) => Promise<Result>,
    authorize?: (transaction: MigrationDb) => Promise<void>,
  ): Promise<Result> {
    const digest = this.assertRequest(request);
    const { projectId, idempotencyKey, action, expectedGrantRevision } = request;
    const principal = { ...request.principal };
    return this.database.transaction(async transaction => {
      if (authorize) await authorize(transaction);
      else await this.grants.authorizeInTransaction(transaction, principal, projectId, action, expectedGrantRevision);
      const inserted = rows(await transaction.execute(sql`INSERT INTO factory_mutation_receipts
        (tenant_id, project_id, principal_kind, principal_id, idempotency_key, input_digest)
        VALUES (${this.tenantId}, ${projectId}, ${principal.kind}, ${principal.id}, ${idempotencyKey}, ${digest})
        ON CONFLICT DO NOTHING RETURNING input_digest`));
      const where = sql`tenant_id=${this.tenantId} AND project_id=${projectId} AND principal_kind=${principal.kind} AND principal_id=${principal.id} AND idempotency_key=${idempotencyKey}`;
      if (!inserted.length) {
        const previous = rows<ReceiptRow>(await transaction.execute(sql`SELECT input_digest, response_json, response_digest FROM factory_mutation_receipts WHERE ${where} FOR UPDATE`))[0]!;
        if (previous.input_digest !== digest) throw new FactoryMutationError("idempotency_conflict");
        if (previous.response_json === null) throw new FactoryMutationError("factory_receipt_incomplete");
        return this.decodeResponse<Result>(previous);
      }
      const response = encodeFactoryPayload(await apply(transaction));
      await transaction.execute(sql`UPDATE factory_mutation_receipts SET response_json=${response}, response_digest=${idempotencyInputDigest(JSON.parse(response))} WHERE ${where}`);
      return JSON.parse(response) as Result;
    });
  }
}
