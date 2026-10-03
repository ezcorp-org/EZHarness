import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { FACTORY_EVENT_SCHEMA_VERSION, type FactoryEventCursor, type FactoryRunEvent, type FactoryRunStatus, type JsonValue } from "@ezcorp/factory-sdk";
import type { TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { FactoryConsoleError, type FactoryEventCursors } from "./console-tokens";
import type { FactoryGrants, FactoryPrincipal } from "./grants";
import { assertFactoryIdentity, encodeFactoryPayload, type FactoryRunKey } from "./records";
import { FactoryRunLifecycleError } from "./run-lifecycle";

/** Above this, a frame carries the payload's size and digest instead of its bytes. */
export const FACTORY_EVENT_INLINE_BYTES = 16 * 1024;
export const FACTORY_EVENT_BATCH_LIMIT = 50;
const TERMINAL: ReadonlySet<string> = new Set(["succeeded", "failed", "cancelled"]);

export interface FactoryRunEventBatch {
  readonly events: readonly FactoryRunEvent[];
  /** Resumes after the last event served, or at the presented position when none was. */
  readonly cursor: FactoryEventCursor;
  readonly status: FactoryRunStatus;
  /** True once the run is terminal and every committed event has been served. */
  readonly drained: boolean;
}

function eventId(digest: string): string {
  return /^[0-9a-f]{64}$/.test(digest) ? digest : createHash("sha256").update(digest).digest("hex");
}

/**
 * The contiguous event stream behind a console snapshot (C09). Each batch is
 * read in one transaction that first rechecks the caller's current read
 * authority, so a grant revoked mid-stream refuses the next batch.
 */
export class FactoryRunEvents {
  constructor(
    private readonly database: TransactionalDb,
    readonly tenantId: string,
    private readonly grants: FactoryGrants,
    private readonly cursors: FactoryEventCursors,
  ) { assertFactoryIdentity(tenantId); if (grants.tenantId !== tenantId) throw new Error("factory_scope_mismatch"); }

  async read(principal: FactoryPrincipal, key: FactoryRunKey, token: string, limit = FACTORY_EVENT_BATCH_LIMIT): Promise<FactoryRunEventBatch> {
    const input = JSON.parse(encodeFactoryPayload({ principal, key, token, limit })) as { principal: FactoryPrincipal; key: FactoryRunKey; token: string; limit: number };
    assertFactoryIdentity(input.key.projectId, input.key.runId);
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > FACTORY_EVENT_BATCH_LIMIT) throw new FactoryConsoleError("factory_page_invalid");
    return this.database.transaction(async transaction => {
      await this.grants.authorizeInTransaction(transaction, input.principal, input.key.projectId, "read");
      // Verified only after authority: a caller without read learns nothing
      // from the difference between an invalid and an expired position.
      const after = this.cursors.verify(this.tenantId, input.key, input.token);
      const [run] = rows<{ status: string; committed: string | number }>(await transaction.execute(sql`SELECT l.status,
          COALESCE((SELECT MAX(sequence) FROM factory_audit_batches a WHERE a.tenant_id=l.tenant_id AND a.project_id=l.project_id AND a.run_id=l.run_id), 0) AS committed
        FROM factory_run_lifecycle l WHERE l.tenant_id=${this.tenantId} AND l.project_id=${input.key.projectId} AND l.run_id=${input.key.runId}`));
      if (!run) throw new FactoryRunLifecycleError("factory_run_not_found");
      const committed = Number(run.committed);
      // A position past the committed log belongs to a store this one is not.
      // That is an expired view, not a request to wait: take a new snapshot.
      if (after > committed) throw new FactoryConsoleError("factory_cursor_expired");
      const found = rows<{ sequence: string | number; digest: string; payload: string }>(await transaction.execute(sql`SELECT sequence, digest, payload FROM factory_audit_batches
        WHERE tenant_id=${this.tenantId} AND project_id=${input.key.projectId} AND run_id=${input.key.runId} AND sequence > ${after} ORDER BY sequence LIMIT ${input.limit}`));
      let expected = after + 1;
      const events = found.map(row => {
        const sequence = Number(row.sequence);
        // The log is contiguous by construction; a hole here is corruption.
        if (sequence !== expected++) throw new FactoryRunLifecycleError("factory_run_corrupt");
        const payloadBytes = Buffer.byteLength(row.payload);
        return {
          schemaVersion: FACTORY_EVENT_SCHEMA_VERSION, runId: input.key.runId, sequence, eventId: eventId(row.digest), payloadBytes,
          ...(payloadBytes <= FACTORY_EVENT_INLINE_BYTES ? { payload: JSON.parse(row.payload) as JsonValue } : {}),
        } satisfies FactoryRunEvent;
      });
      const last = events.at(-1)?.sequence ?? after;
      return {
        events,
        cursor: this.cursors.issue(this.tenantId, input.key, last),
        status: run.status as FactoryRunStatus,
        drained: TERMINAL.has(run.status) && last === committed,
      };
    });
  }
}
