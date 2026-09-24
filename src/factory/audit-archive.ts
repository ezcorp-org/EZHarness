import type { TransactionalDb } from "../db/migrations/types";
import { FactoryRecordError, verifyFactoryAuditStream, type FactoryAuditBatch, type FactoryRecords, type FactoryRunKey } from "./records";
import { readFactoryRecoveryJson, writeFactoryRecoveryJson, type FactoryRecoveryArchive } from "./recovery-archive";
import type { FactoryArchiveObject } from "./releases";

/**
 * One run's canonical audit stream in the independent archive.
 *
 * C06 requires the stream to be archived before its primary rows may expire,
 * and the archived copy to be enough to rebuild the promised run view. Pages
 * hold at most `FACTORY_AUDIT_ARCHIVE_PAGE` batches (64 KiB each at most, so a
 * page stays under 8 MiB); the index names every page and the stream head. A
 * reader verifies the whole stream with `verifyFactoryAuditStream`, the same
 * check the database path uses, so a gap or a conflicting digest in the
 * archive stops a rebuild exactly as it would stop a projection.
 */

export const FACTORY_AUDIT_ARCHIVE_SCHEMA = "factory.audit-archive.v1";
export const FACTORY_AUDIT_ARCHIVE_PAGE = 128;
const READ_PAGE = 200;

export interface FactoryAuditArchivePage {
  readonly schemaVersion: typeof FACTORY_AUDIT_ARCHIVE_SCHEMA;
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly batches: readonly FactoryAuditBatch[];
}

export interface FactoryAuditArchiveIndex {
  readonly schemaVersion: typeof FACTORY_AUDIT_ARCHIVE_SCHEMA;
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly throughSequence: number;
  readonly headDigest: string | null;
  readonly pages: readonly { readonly first: number; readonly last: number; readonly object: FactoryArchiveObject }[];
}

export interface FactoryArchivedAudit {
  readonly index: FactoryArchiveObject;
  readonly throughSequence: number;
  readonly headDigest: string | null;
}

function recordId(key: FactoryRunKey): string { return `${key.projectId}/${key.runId}`; }

/** Reads every committed batch for the run through the verifying database reader. */
export async function readFactoryRunAudit(records: FactoryRecords, key: FactoryRunKey): Promise<readonly FactoryAuditBatch[]> {
  const batches: FactoryAuditBatch[] = [];
  for (;;) {
    const page = await records.readAudit(key, batches.length, READ_PAGE);
    batches.push(...page);
    if (page.length < READ_PAGE) return verifyFactoryAuditStream(records.tenantId, key, batches);
  }
}

/** Archives the run's complete stream and returns the verified index reference. */
export async function archiveFactoryRunAudit(records: FactoryRecords, archive: FactoryRecoveryArchive, key: FactoryRunKey, signal?: AbortSignal): Promise<FactoryArchivedAudit> {
  const batches = await readFactoryRunAudit(records, key);
  const tenantId = records.tenantId;
  const pages: FactoryAuditArchiveIndex["pages"][number][] = [];
  for (let offset = 0; offset < batches.length; offset += FACTORY_AUDIT_ARCHIVE_PAGE) {
    const slice = batches.slice(offset, offset + FACTORY_AUDIT_ARCHIVE_PAGE);
    const page: FactoryAuditArchivePage = { schemaVersion: FACTORY_AUDIT_ARCHIVE_SCHEMA, tenantId, projectId: key.projectId, runId: key.runId, batches: slice };
    pages.push({ first: slice[0]!.sequence, last: slice.at(-1)!.sequence, object: await writeFactoryRecoveryJson(archive, tenantId, "audit", recordId(key), page, signal) });
  }
  const index: FactoryAuditArchiveIndex = {
    schemaVersion: FACTORY_AUDIT_ARCHIVE_SCHEMA, tenantId, projectId: key.projectId, runId: key.runId,
    throughSequence: batches.length, headDigest: batches.at(-1)?.digest ?? null, pages,
  };
  return { index: await writeFactoryRecoveryJson(archive, tenantId, "audit", recordId(key), index, signal), throughSequence: index.throughSequence, headDigest: index.headDigest };
}

/**
 * Reads an archived stream back and verifies it end to end. The index must name
 * this tenant and run, pages must be contiguous, and the stream must end at the
 * index's head; any mismatch is a gap or a conflict, never a partial answer.
 */
export async function readFactoryArchivedRunAudit(archive: Pick<FactoryRecoveryArchive, "read">, reference: FactoryArchiveObject, tenantId: string, key: FactoryRunKey, signal?: AbortSignal): Promise<readonly FactoryAuditBatch[]> {
  const index = await readFactoryRecoveryJson<FactoryAuditArchiveIndex>(archive, reference, signal);
  const scoped = (value: { schemaVersion?: unknown; tenantId?: unknown; projectId?: unknown; runId?: unknown }) => value?.schemaVersion === FACTORY_AUDIT_ARCHIVE_SCHEMA && value.tenantId === tenantId && value.projectId === key.projectId && value.runId === key.runId;
  if (!scoped(index) || !Array.isArray(index.pages) || !Number.isSafeInteger(index.throughSequence)) throw new FactoryRecordError("factory_scope_mismatch");
  const batches: FactoryAuditBatch[] = [];
  for (const entry of index.pages) {
    if (entry.first !== batches.length + 1) throw new FactoryRecordError("factory_audit_gap");
    const page = await readFactoryRecoveryJson<FactoryAuditArchivePage>(archive, entry.object, signal);
    if (!scoped(page) || !Array.isArray(page.batches) || page.batches.length === 0 || page.batches.at(-1)?.sequence !== entry.last) throw new FactoryRecordError("factory_audit_conflict");
    batches.push(...page.batches);
  }
  if (batches.length !== index.throughSequence || (batches.at(-1)?.digest ?? null) !== index.headDigest) throw new FactoryRecordError("factory_audit_gap");
  return verifyFactoryAuditStream(tenantId, key, batches);
}

/**
 * Re-materializes a verified archived stream into the product database in one
 * transaction: all of it lands or none of it does. Rows already held must match
 * byte for byte, so this is also how a restored database proves it agrees with
 * the archive.
 */
export async function importFactoryArchivedRunAudit(database: TransactionalDb, records: FactoryRecords, batches: readonly FactoryAuditBatch[]): Promise<number> {
  return database.transaction(async transaction => {
    let imported = 0;
    for (const batch of batches) if ((await records.importArchivedAuditInTransaction(transaction, batch)).imported) imported += 1;
    return imported;
  });
}
