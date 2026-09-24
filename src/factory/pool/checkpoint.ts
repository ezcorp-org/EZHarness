import { randomUUID } from "node:crypto";
import { FACTORY_CHECKPOINT_LIMITS, type FactoryCheckpointPoolSnapshot, type FactoryCheckpointPoolSource, type FactoryCheckpointSlotSource } from "../checkpoint-barrier";
import type { FactoryRestorePoolLedger } from "../restore";
import type { FactoryPoolLedger } from "./ledger";
import { normalizePoolResourceVector, POOL_RESOURCE_CLASSES, POOL_SCHEDULER_LOCK_SQL, poolRows as rows, type PoolResourceVector, type PoolSql } from "./ledger";

/**
 * The pool ledger's half of a C06 checkpoint (C03.13).
 *
 * The pool database is shared by every tenant and is never restored per
 * tenant, so a barrier records the tenant's reservation rows as they stood
 * while the tenant was quiescent, and a restore compares them with the live
 * ledger. A reservation the live ledger has lost comes back as `uncertain` at a
 * new allocation generation: it holds its capacity, it cannot be renewed by the
 * old holder, and only a supervisor's stop proof (or a GPU reimage) releases
 * it. Restoring it as `held` or `running` would let two holders believe they
 * own one allocation.
 */

const SNAPSHOT_COLUMNS = ["reservation_id", "tenant_id", "grant_revision", "resources_json", "priority", "ready_sequence", "node_id", "queued_at", "admission_deadline", "state", "allocation_generation", "holder_generation", "fence", "lease_deadline", "host_id", "effects", "reason"] as const;
const LIVE_STATES = new Set(["held", "running", "revoking", "uncertain"]);

function normalized(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(SNAPSHOT_COLUMNS.map(column => {
    const value = row[column];
    if (value instanceof Date) return [column, value.toISOString()];
    if (column === "resources_json" && typeof value === "string") return [column, JSON.parse(value)];
    if (typeof value === "bigint") return [column, Number(value)];
    return [column, value ?? null];
  }));
}

/** Rows per checkpoint page. A page stays well inside the pool wire's 16 KiB body bound. */
export const POOL_CHECKPOINT_PAGE_ROWS = 16;

export interface PoolCheckpointPage {
  readonly position: string;
  readonly rows: readonly Record<string, unknown>[];
  /** The reservation id to continue after, or null when this page ended the snapshot. */
  readonly next: string | null;
}

export class FactoryPoolCheckpointSource implements FactoryCheckpointPoolSource {
  constructor(private readonly database: PoolSql) {}

  /**
   * One bounded page of the tenant's LIVE reservations — the only rows that
   * hold capacity and so the only ones a restore must reclaim. Settled and
   * rejected rows are history the pool keeps itself.
   */
  async page(tenantId: string, after: string | null, limit = POOL_CHECKPOINT_PAGE_ROWS): Promise<PoolCheckpointPage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error("Pool checkpoint page is malformed.");
    return this.database.begin(async transaction => {
      const position = rows<{ lsn: string }>(await transaction.unsafe("SELECT pg_current_wal_lsn()::text AS lsn"))[0]!.lsn;
      const found = rows<Record<string, unknown>>(await transaction.unsafe(`SELECT ${SNAPSHOT_COLUMNS.join(", ")} FROM factory_pool_requests WHERE tenant_id = $1 AND state IN ('held','running','revoking','uncertain') AND reservation_id > $2 ORDER BY reservation_id LIMIT $3`, [tenantId, after ?? "", limit + 1]));
      const page = found.slice(0, limit).map(normalized);
      return { position, rows: page, next: found.length > limit ? String(page.at(-1)!.reservation_id) : null };
    });
  }

  async snapshotTenant(tenantId: string): Promise<FactoryCheckpointPoolSnapshot> {
    return factoryPoolSnapshotFromPages(after => this.page(tenantId, after, 1_000));
  }

  /**
   * Compares a checkpoint's tenant rows with the live ledger and re-creates, as
   * `uncertain`, every live reservation the ledger lost, re-holding its
   * capacity in the same transaction. Rows the ledger still holds are left
   * exactly as they are: the live pool is newer than any checkpoint. A lost
   * reservation whose capacity another holder now has is NOT imported — adding
   * it would let a later stop confirmation release capacity it never held — and
   * is returned as `overcommitted` so the restore keeps its work blocked.
   */
  async importLost(tenantId: string, snapshot: readonly Record<string, unknown>[]): Promise<{ readonly present: readonly string[]; readonly imported: readonly string[]; readonly overcommitted: readonly string[] }> {
    return this.database.begin(async transaction => {
      await transaction.unsafe(POOL_SCHEDULER_LOCK_SQL);
      const present = new Set(rows<{ reservation_id: string }>(await transaction.unsafe("SELECT reservation_id FROM factory_pool_requests WHERE tenant_id = $1", [tenantId])).map(row => row.reservation_id));
      const imported: string[] = [];
      const overcommitted: string[] = [];
      for (const row of snapshot) {
        if (row.tenant_id !== tenantId || typeof row.reservation_id !== "string") throw new Error("Pool checkpoint row belongs to another tenant.");
        if (present.has(row.reservation_id) || !LIVE_STATES.has(String(row.state))) continue;
        const vector = normalizePoolResourceVector(row.resources_json as PoolResourceVector);
        // A GPU reservation must reclaim its exact host; a host another tenant now holds is overcommitted.
        const hostId = typeof row.host_id === "string" ? row.host_id : null;
        if (hostId !== null && rows(await transaction.unsafe("SELECT 1 FROM factory_pool_hosts WHERE host_id = $1 AND (state = 'available' OR reservation_id = $2) FOR UPDATE", [hostId, row.reservation_id])).length === 0) { overcommitted.push(row.reservation_id); continue; }
        const held = await this.rehold(transaction, vector);
        if (!held) { overcommitted.push(row.reservation_id); continue; }
        await transaction.unsafe(`INSERT INTO factory_pool_requests (reservation_id, tenant_id, grant_revision, resources_json, priority, ready_sequence, node_id, queued_at, admission_deadline, state, allocation_generation, holder_generation, fence, host_id, effects, reason)
          VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, 'uncertain', $10, $11, $12, $13, $14, 'restore-import')`, [
          row.reservation_id, tenantId, row.grant_revision, JSON.stringify(vector), row.priority, row.ready_sequence, row.node_id, row.queued_at, row.admission_deadline,
          Number(row.allocation_generation) + 1, row.holder_generation, randomUUID(), hostId, row.effects,
        ]);
        if (hostId !== null) await transaction.unsafe("UPDATE factory_pool_hosts SET state = 'quarantined', reservation_id = $1, tenant_id = $2, holder_generation = $3 WHERE host_id = $4", [row.reservation_id, tenantId, row.holder_generation, hostId]);
        imported.push(row.reservation_id);
      }
      return { present: [...present].sort(), imported, overcommitted };
    });
  }

  /** Adds a lost reservation's units back, all or none. A savepoint undoes a partial re-hold. */
  private async rehold(transaction: PoolSql, vector: PoolResourceVector): Promise<boolean> {
    await transaction.unsafe("SAVEPOINT factory_pool_rehold");
    for (const resourceClass of POOL_RESOURCE_CLASSES) {
      const units = vector[resourceClass];
      if (units === undefined) continue;
      const updated = rows(await transaction.unsafe("UPDATE factory_pool_resources SET allocated_units = allocated_units + $1 WHERE resource_class = $2 AND allocated_units + $1 <= total_units RETURNING resource_class", [units, resourceClass]));
      if (updated.length === 0) { await transaction.unsafe("ROLLBACK TO SAVEPOINT factory_pool_rehold"); return false; }
    }
    await transaction.unsafe("RELEASE SAVEPOINT factory_pool_rehold");
    return true;
  }
}

/**
 * Reads every page of one tenant's snapshot. The position is the first
 * page's: the pages are read while the tenant's barrier holds its product
 * writes, so no product-driven reservation can change between them.
 */
export async function factoryPoolSnapshotFromPages(read: (after: string | null) => Promise<PoolCheckpointPage>, maxPages = 1_000): Promise<FactoryCheckpointPoolSnapshot> {
  const first = await read(null);
  const all = [...first.rows];
  let next = first.next;
  for (let pages = 1; next !== null; pages += 1) {
    if (pages >= maxPages) throw new Error("Pool checkpoint snapshot exceeded its page bound.");
    const page = await read(next);
    all.push(...page.rows);
    next = page.next;
  }
  return { position: first.position, rows: all };
}

/** The restore's pool half over the pool database itself, for a coordinator that holds it. */
export function factoryDirectRestorePoolLedger(database: PoolSql, ledger: Pick<FactoryPoolLedger, "cancel">): FactoryRestorePoolLedger {
  const source = new FactoryPoolCheckpointSource(database);
  return {
    importLost: (tenantId, snapshot) => source.importLost(tenantId, snapshot),
    liveRows: async tenantId => (await source.snapshotTenant(tenantId)).rows,
    revoke: async (reservationId, allocationGeneration) => ({ state: (await ledger.cancel(reservationId, allocationGeneration)).state }),
  };
}

/**
 * How long a barrier slot is held before the pool reclaims it. A barrier aborts
 * at its ten-second maximum, so a slot outlives any barrier that holds it; the
 * margin covers the abort's rollback. A coordinator that dies mid-barrier
 * loses its slot when the hold runs out, never for good.
 */
export const POOL_CHECKPOINT_SLOT_HOLD_MS = FACTORY_CHECKPOINT_LIMITS.maximumMs + 5_000;

/** The cluster-wide barrier slots: one row per slot, so the limit is a row count the database enforces. */
export async function setupFactoryPoolCheckpointSlots(database: PoolSql): Promise<void> {
  const slots = FACTORY_CHECKPOINT_LIMITS.maxConcurrentBarriers;
  await database.unsafe(`CREATE TABLE IF NOT EXISTS factory_pool_checkpoint_slots (
    slot integer PRIMARY KEY CHECK (slot >= 0 AND slot < ${slots}),
    tenant_id text, token text, expires_at timestamptz,
    CHECK ((tenant_id IS NULL) = (token IS NULL) AND (token IS NULL) = (expires_at IS NULL))
  )`);
  await database.unsafe(`INSERT INTO factory_pool_checkpoint_slots (slot) SELECT generate_series(0, ${slots - 1}) ON CONFLICT (slot) DO NOTHING`);
}

/**
 * C06/C12: at most sixteen checkpoint barriers in flight across every tenant
 * that shares this pool. The pool is the one service every installation
 * reaches, so it holds the limit. A tenant holds at most one slot: a second
 * acquire by the same tenant renews the slot it already holds.
 */
export class FactoryPoolCheckpointSlots {
  constructor(private readonly database: PoolSql, private readonly holdMs = POOL_CHECKPOINT_SLOT_HOLD_MS) {
    if (!Number.isSafeInteger(holdMs) || holdMs < 1) throw new Error("Pool checkpoint slot hold is malformed.");
  }

  /** A free, expired, or already-held slot, or null when sixteen other tenants hold every slot. */
  async acquire(tenantId: string): Promise<PoolCheckpointSlot | null> {
    const token = randomUUID();
    const [row] = rows<{ slot: number; expires_at: Date | string }>(await this.database.unsafe(`UPDATE factory_pool_checkpoint_slots
      SET tenant_id = $1, token = $2, expires_at = clock_timestamp() + ($3::integer * interval '1 millisecond')
      WHERE slot = (SELECT slot FROM factory_pool_checkpoint_slots
        WHERE tenant_id IS NULL OR tenant_id = $1 OR expires_at <= clock_timestamp()
        ORDER BY (tenant_id IS NOT DISTINCT FROM $1) DESC, slot LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING slot, expires_at`, [tenantId, token, this.holdMs]));
    return row ? { slot: Number(row.slot), token, expiresAt: new Date(row.expires_at).toISOString() } : null;
  }

  /** Frees the slot this acquire returned. A slot the pool already reclaimed and gave away is left alone. */
  async release(tenantId: string, token: string): Promise<boolean> {
    return rows(await this.database.unsafe("UPDATE factory_pool_checkpoint_slots SET tenant_id = NULL, token = NULL, expires_at = NULL WHERE tenant_id = $1 AND token = $2 RETURNING slot", [tenantId, token])).length === 1;
  }
}

export interface PoolCheckpointSlot {
  readonly slot: number;
  readonly token: string;
  readonly expiresAt: string;
}

/** The barrier's slot source over the pool database directly, for a process that holds the pool connection. */
export function factoryDirectCheckpointSlots(slots: FactoryPoolCheckpointSlots, tenantId: string): FactoryCheckpointSlotSource {
  return {
    acquire: async () => { const slot = await slots.acquire(tenantId); return slot === null ? null : { token: slot.token }; },
    release: async token => { await slots.release(tenantId, token); },
  };
}
