import { sql } from "drizzle-orm";
import type { MigrationDb } from "../migrations/types";
import type { ReleaseDatabase } from "./extension-releases";
import { releaseRows } from "./extension-releases";
import { LifecycleError } from "../../extensions/v4/types";

export interface BrowserInvocationIdentity {
  principalId: string;
  installationId: string;
  releaseBinding: string;
  conversationId: string | null;
}
export interface BrowserInvocationInput extends BrowserInvocationIdentity { payloadDigest: string; deadline: number }
export type BrowserInvocationState = "issued" | "running" | "cancel_requested" | "cancelled" | "finished" | "outcome_unknown";
export type BrowserInvocationOutcome = "succeeded" | "failed" | "outcome_unknown";
export interface BrowserInvocationRow extends BrowserInvocationInput { requestId: string; state: BrowserInvocationState; executionId: string | null }
export const BROWSER_REQUEST_RETENTION_MS = 24 * 60 * 60 * 1000;
export const BROWSER_REQUEST_MAX_MS = 60_000;
const columns = sql`id AS "requestId",principal_id AS "principalId",installation_id AS "installationId",release_binding AS "releaseBinding",conversation_id AS "conversationId",payload_digest AS "payloadDigest",deadline,state,execution_id AS "executionId"`;

function invalid(): never { throw new LifecycleError("browser_request_invalid", "A valid owner-bound browser request is required."); }
function unavailable(): never { throw new LifecycleError("browser_request_unavailable", "Browser request is cancelled, expired, already claimed or unavailable."); }
function validateIdentity(identity: BrowserInvocationIdentity): void {
  if (!identity || [identity.principalId, identity.installationId].some(value => typeof value !== "string" || !value || value.length > 256) || !/^[a-f0-9]{64}$/.test(identity.releaseBinding) || identity.conversationId !== null && (typeof identity.conversationId !== "string" || !identity.conversationId || identity.conversationId.length > 256)) invalid();
}
function matches(row: BrowserInvocationRow, identity: BrowserInvocationIdentity): boolean {
  return row.principalId === identity.principalId && row.installationId === identity.installationId && row.releaseBinding === identity.releaseBinding && row.conversationId === identity.conversationId;
}

export class BrowserInvocationStore {
  constructor(readonly database: ReleaseDatabase, readonly now: () => number = Date.now) {}

  private async read(database: MigrationDb, identity: BrowserInvocationIdentity, requestId: string, lock: "share" | "update" | "none"): Promise<BrowserInvocationRow> {
    validateIdentity(identity);
    if (typeof requestId !== "string" || !/^[a-f0-9-]{36}$/.test(requestId)) invalid();
    const suffix = lock === "share" ? sql`FOR SHARE` : lock === "update" ? sql`FOR UPDATE` : sql``;
    const [row] = releaseRows<BrowserInvocationRow>(await database.execute(sql`SELECT ${columns} FROM extension_browser_requests WHERE id=${requestId} ${suffix}`));
    if (!row || !matches(row, identity)) unavailable();
    return row;
  }

  async prepare(input: BrowserInvocationInput): Promise<{ requestId: string; deadline: number }> {
    input = { ...input };
    validateIdentity(input);
    const now = this.now();
    if (typeof input.payloadDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.payloadDigest) || !Number.isSafeInteger(input.deadline) || input.deadline <= now || input.deadline > now + BROWSER_REQUEST_MAX_MS) invalid();
    return this.database.transaction(async transaction => {
      const locks = releaseRows(await transaction.execute(sql`SELECT id FROM extension_browser_admission_lock WHERE id=1 FOR UPDATE`));
      if (locks.length !== 1) unavailable();
      await this.purge(transaction);
      const [count] = releaseRows<{ total: number; owned: number; active: number; ownedActive: number }>(await transaction.execute(sql`SELECT COUNT(*)::int AS total,COUNT(*) FILTER(WHERE principal_id=${input.principalId})::int AS owned,COUNT(*) FILTER(WHERE state IN ('issued','running','cancel_requested'))::int AS active,COUNT(*) FILTER(WHERE principal_id=${input.principalId} AND state IN ('issued','running','cancel_requested'))::int AS "ownedActive" FROM extension_browser_requests`));
      if (!count || count.total >= 10000 || count.owned >= 512 || count.active >= 1024 || count.ownedActive >= 64) throw new LifecycleError("browser_request_capacity", "Browser request capacity is exhausted.");
      const requestId = crypto.randomUUID();
      await transaction.execute(sql`INSERT INTO extension_browser_requests(id,principal_id,installation_id,release_binding,conversation_id,payload_digest,deadline,retain_until,state) VALUES (${requestId},${input.principalId},${input.installationId},${input.releaseBinding},${input.conversationId},${input.payloadDigest},${input.deadline},${input.deadline + BROWSER_REQUEST_RETENTION_MS},'issued')`);
      return { requestId, deadline: input.deadline };
    });
  }

  async claim(identity: BrowserInvocationIdentity, requestId: string, payloadDigest: string): Promise<{ executionId: string; deadline: number }> {
    identity = { ...identity };
    return this.database.transaction(async transaction => {
      const row = await this.read(transaction, identity, requestId, "update");
      if (row.state !== "issued" || Number(row.deadline) <= this.now() || row.payloadDigest !== payloadDigest) unavailable();
      const executionId = crypto.randomUUID();
      await transaction.execute(sql`UPDATE extension_browser_requests SET state='running',execution_id=${executionId} WHERE id=${requestId}`);
      return { executionId, deadline: Number(row.deadline) };
    });
  }

  async assertActive(identity: BrowserInvocationIdentity, requestId: string, executionId: string, transaction?: MigrationDb): Promise<void> {
    const row = await this.read(transaction ?? this.database, identity, requestId, transaction ? "share" : "none");
    if (row.state !== "running" || row.executionId !== executionId || Number(row.deadline) <= this.now()) unavailable();
  }

  async cancel(identity: BrowserInvocationIdentity, requestId: string): Promise<{ state: BrowserInvocationState }> {
    identity = { ...identity };
    return this.database.transaction(async transaction => {
      const row = await this.read(transaction, identity, requestId, "update");
      const state = row.state === "issued" ? "cancelled" : row.state === "running" ? "cancel_requested" : row.state;
      await transaction.execute(sql`UPDATE extension_browser_requests SET state=${state} WHERE id=${requestId}`);
      return { state };
    });
  }

  async finish(identity: BrowserInvocationIdentity, requestId: string, executionId: string, outcome: BrowserInvocationOutcome): Promise<void> {
    identity = { ...identity };
    if (!["succeeded", "failed", "outcome_unknown"].includes(outcome)) invalid();
    await this.database.transaction(async transaction => {
      const row = await this.read(transaction, identity, requestId, "update");
      if (row.executionId !== executionId) unavailable();
      if (!["running", "cancel_requested"].includes(row.state)) return;
      const state = outcome === "outcome_unknown" ? "outcome_unknown" : row.state === "cancel_requested" ? "cancelled" : "finished";
      await transaction.execute(sql`UPDATE extension_browser_requests SET state=${state} WHERE id=${requestId}`);
    });
  }

  async purge(transaction: MigrationDb = this.database): Promise<void> {
    const now = this.now();
    await transaction.execute(sql`UPDATE extension_browser_requests SET state=CASE WHEN state='issued' THEN 'cancelled' ELSE 'outcome_unknown' END WHERE id IN (SELECT id FROM extension_browser_requests WHERE deadline<=${now} AND state IN ('issued','running','cancel_requested') ORDER BY deadline,id LIMIT 1000 FOR UPDATE SKIP LOCKED)`);
    await transaction.execute(sql`DELETE FROM extension_browser_requests WHERE id IN (SELECT id FROM extension_browser_requests WHERE retain_until<=${now} AND state IN ('cancelled','finished','outcome_unknown') ORDER BY retain_until,id LIMIT 1000 FOR UPDATE SKIP LOCKED)`);
  }
}
