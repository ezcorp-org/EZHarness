import { and, eq } from "drizzle-orm";
import { SessionError, uuidv7 } from "@earendil-works/pi-agent-core";
import type { SessionMetadata, SessionStorage, SessionTreeEntry } from "@earendil-works/pi-agent-core";
import { getDb } from "./connection";
import {
  agentSessionEntries,
  agentSessions,
  type AgentSessionEntryRow,
  type AgentSessionRow,
  type NewAgentSessionEntryRow,
} from "./schema";

/**
 * DbSessionStorage — a faithful port of pi-agent-core's
 * `JsonlSessionStorage` / `InMemorySessionStorage` onto Postgres/PGlite.
 *
 * This is P1 of the Postgres SessionStorage design
 * (tasks/2026-07-11-postgres-session-storage-design.md §7): the durable
 * substrate ONLY. Nothing in the runtime imports it yet — zero product
 * risk. Wiring (history producer, append seams, rewind API/UI) lands in
 * later slices.
 *
 * Port fidelity (see node_modules/@earendil-works/pi-agent-core/dist/
 * harness/session/{jsonl-storage,memory-storage}.js):
 *  - On `open()` we `SELECT ... ORDER BY seq` and rebuild the exact same
 *    in-memory `byId` / `labelsById` / `currentLeafId` maps the JSONL
 *    impl holds. Reads are served entirely from memory; only
 *    `appendEntry` / `setLeafId` touch the DB (one INSERT + a
 *    `leaf_entry_id` cache UPDATE).
 *  - The leaf is AUTHORITATIVELY recovered by replaying every entry in
 *    insertion (`seq`) order through the leaf rule — pi ids are 8-char
 *    uuidv7 slices and NOT monotonic, so tree order ≠ insertion order.
 *  - `timestamp` is stored VERBATIM (TEXT column) so pi's ISO string
 *    round-trips byte-for-byte.
 *  - Every jsonb payload is written via a column-mapped drizzle insert,
 *    never `${JSON.stringify(x)}::jsonb` — that double-encodes under the
 *    Bun.sql driver (see src/db/connection.ts's mapToDriverValue swap).
 *  - The PK is `(session_id, entry_id)`: forked entries reuse their
 *    source ids across sessions, so ids are unique only WITHIN a
 *    session. A duplicate append within one session hits the PK and
 *    rejects — the DB-level analog of the JSONL impl's id-uniqueness.
 */

/** Extended metadata surfaced by {@link DbSessionStorage}. pi's base
 *  `SessionMetadata` is `{id, createdAt}`; we additionally expose the
 *  fork lineage / cwd we persist on the `sessions` row, mirroring the
 *  way `JsonlSessionMetadata` augments the base with cwd/parentSession. */
export interface DbSessionMetadata extends SessionMetadata {
  cwd?: string;
  parentSessionId?: string;
  conversationId?: string;
  metadata?: Record<string, unknown>;
}

export interface DbSessionCreateOptions {
  id?: string;
  conversationId?: string;
  cwd?: string;
  parentSessionId?: string;
  metadata?: Record<string, unknown>;
}

type Db = ReturnType<typeof getDb>;

// ── Ports of pi's private JsonlSessionStorage helpers ───────────────
// Kept byte-faithful to jsonl-storage.js so DB + JSONL storage stay
// drop-in interchangeable behind the SessionStorage interface. Exported
// so they can be unit-tested in isolation.

/** Port of jsonl-storage.js `leafIdAfterEntry`: a `leaf` entry is a
 *  POINTER that moves the leaf to `targetId`; every other entry advances
 *  the leaf to its own id. */
export function leafIdAfterEntry(entry: SessionTreeEntry): string | null {
  return entry.type === "leaf" ? entry.targetId : entry.id;
}

/** Port of jsonl-storage.js `updateLabelCache`: latest non-empty label
 *  per targetId wins; an empty/whitespace label clears it. */
export function updateLabelCache(labelsById: Map<string, string>, entry: SessionTreeEntry): void {
  if (entry.type !== "label") return;
  const label = entry.label?.trim();
  if (label) labelsById.set(entry.targetId, label);
  else labelsById.delete(entry.targetId);
}

/** Port of jsonl-storage.js `buildLabelsById`. */
export function buildLabelsById(entries: SessionTreeEntry[]): Map<string, string> {
  const labelsById = new Map<string, string>();
  for (const entry of entries) updateLabelCache(labelsById, entry);
  return labelsById;
}

/** Port of jsonl-storage.js `generateEntryId`: an 8-char slice of the
 *  uuidv7 RANDOM TAIL (the timestamp prefix is near-constant between
 *  calls), retried on collision, with a full uuidv7 as the
 *  after-100-tries fallback. `gen` is a testability seam only — the
 *  default is pi's exact `uuidv7`, so behaviour is identical. */
export function generateEntryId(byId: Map<string, SessionTreeEntry>, gen: () => string = uuidv7): string {
  for (let i = 0; i < 100; i++) {
    const id = gen().slice(-8);
    if (!byId.has(id)) return id;
  }
  return gen();
}

/** Decompose a pi entry into its `agent_session_entries` row: the base fields
 *  (type/id/parentId/timestamp) become columns; everything else is the
 *  jsonb payload. */
export function entryToRow(
  sessionId: string,
  entry: SessionTreeEntry,
  ezMessageId: string | null = null,
): NewAgentSessionEntryRow {
  const { type, id, parentId, timestamp, ...payload } = entry as SessionTreeEntry & Record<string, unknown>;
  return {
    sessionId,
    entryId: id,
    type,
    parentId,
    timestamp,
    payload: payload as Record<string, unknown>,
    // Cross-link to the source EZCorp `messages` row. Set only for
    // `message` entries by the backfill (src/db/session-backfill.ts); the
    // live JSONL-parity append path leaves it null.
    ezMessageId,
  };
}

/** Reconstruct a pi entry from a row: base columns + spread payload. The
 *  payload never carries the base keys (entryToRow stripped them), so no
 *  key can shadow a column. */
export function rowToEntry(
  row: Pick<AgentSessionEntryRow, "type" | "entryId" | "parentId" | "timestamp" | "payload">,
): SessionTreeEntry {
  return {
    type: row.type,
    id: row.entryId,
    parentId: row.parentId,
    timestamp: row.timestamp,
    ...(row.payload as Record<string, unknown>),
  } as SessionTreeEntry;
}

export class DbSessionStorage implements SessionStorage<DbSessionMetadata> {
  private constructor(
    private readonly db: Db,
    private readonly sessionRow: AgentSessionRow,
    private readonly entries: SessionTreeEntry[],
    private readonly byId: Map<string, SessionTreeEntry>,
    private readonly labelsById: Map<string, string>,
    private currentLeafId: string | null,
  ) {}

  /** Insert a fresh `agent_sessions` row and return empty storage over it. */
  static async create(options: DbSessionCreateOptions = {}, db: Db = getDb()): Promise<DbSessionStorage> {
    const row: AgentSessionRow = {
      id: options.id ?? crypto.randomUUID(),
      conversationId: options.conversationId ?? null,
      cwd: options.cwd ?? null,
      parentSessionId: options.parentSessionId ?? null,
      leafEntryId: null,
      metadata: options.metadata ?? null,
      createdAt: new Date(),
    };
    await db.insert(agentSessions).values(row);
    return new DbSessionStorage(db, row, [], new Map(), new Map(), null);
  }

  /** Load an existing session, rebuilding the in-memory maps + leaf from
   *  the persisted entries in insertion (`seq`) order. */
  static async open(sessionId: string, db: Db = getDb()): Promise<DbSessionStorage> {
    const [sessionRow] = (await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))) as AgentSessionRow[];
    if (!sessionRow) throw new SessionError("not_found", `Session ${sessionId} not found`);

    const rows = (await db
      .select()
      .from(agentSessionEntries)
      .where(eq(agentSessionEntries.sessionId, sessionId))
      .orderBy(agentSessionEntries.seq)) as AgentSessionEntryRow[];

    const entries = rows.map(rowToEntry);
    const byId = new Map(entries.map((entry) => [entry.id, entry] as const));
    const labelsById = buildLabelsById(entries);
    let currentLeafId: string | null = null;
    for (const entry of entries) currentLeafId = leafIdAfterEntry(entry);
    if (currentLeafId !== null && !byId.has(currentLeafId)) {
      throw new SessionError("invalid_session", `Entry ${currentLeafId} not found`);
    }
    return new DbSessionStorage(db, sessionRow, entries, byId, labelsById, currentLeafId);
  }

  async getMetadata(): Promise<DbSessionMetadata> {
    return {
      id: this.sessionRow.id,
      createdAt: this.sessionRow.createdAt.toISOString(),
      cwd: this.sessionRow.cwd ?? undefined,
      parentSessionId: this.sessionRow.parentSessionId ?? undefined,
      conversationId: this.sessionRow.conversationId ?? undefined,
      metadata: this.sessionRow.metadata ?? undefined,
    };
  }

  async getLeafId(): Promise<string | null> {
    if (this.currentLeafId !== null && !this.byId.has(this.currentLeafId)) {
      throw new SessionError("invalid_session", `Entry ${this.currentLeafId} not found`);
    }
    return this.currentLeafId;
  }

  async setLeafId(leafId: string | null): Promise<void> {
    if (leafId !== null && !this.byId.has(leafId)) {
      throw new SessionError("not_found", `Entry ${leafId} not found`);
    }
    const entry: SessionTreeEntry = {
      type: "leaf",
      id: generateEntryId(this.byId),
      parentId: this.currentLeafId,
      timestamp: new Date().toISOString(),
      targetId: leafId,
    };
    await this.persist(entry);
    this.currentLeafId = leafId;
    await this.writeLeafCache();
  }

  async createEntryId(): Promise<string> {
    return generateEntryId(this.byId);
  }

  async appendEntry(entry: SessionTreeEntry, ezMessageId: string | null = null): Promise<void> {
    await this.persist(entry, ezMessageId);
    updateLabelCache(this.labelsById, entry);
    this.currentLeafId = leafIdAfterEntry(entry);
    await this.writeLeafCache();
  }

  async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
    return this.byId.get(id);
  }

  /**
   * Reconcile an existing entry's `parentId` to mirror an out-of-band
   * `messages` row reparent (P3 topology sync — e.g. a steer row reparented
   * at delivery). Updates the DB row + the in-memory entry object (shared by
   * `byId` and `entries`), so a subsequent {@link getPathToRoot} walks the new
   * parent. A no-op when unchanged. This is the ONLY tree-structure mutation of
   * an existing message entry; P4's rewind moves the leaf via `leaf` pointer
   * entries, never by rewriting a message entry's parent, so `messages` stays
   * the authority for message-entry parents.
   */
  async reparentEntry(entryId: string, newParentId: string | null): Promise<void> {
    const entry = this.byId.get(entryId);
    if (!entry) throw new SessionError("not_found", `Entry ${entryId} not found`);
    if (entry.parentId === newParentId) return;
    entry.parentId = newParentId;
    await this.db
      .update(agentSessionEntries)
      .set({ parentId: newParentId })
      .where(and(eq(agentSessionEntries.sessionId, this.sessionRow.id), eq(agentSessionEntries.entryId, entryId)));
  }

  async findEntries<TType extends SessionTreeEntry["type"]>(
    type: TType,
  ): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>> {
    // Single-line body (no wrapped cast) — a multi-line `as Array<Extract…>`
    // leaves a type-only continuation line that Bun's per-line coverage marks
    // executable-but-unhittable; once a 2nd shard instruments this file the
    // merged lcov reads it as a 0-hit miss. Keep it on one statement.
    const matches = this.entries.filter((entry) => entry.type === type);
    return matches as Array<Extract<SessionTreeEntry, { type: TType }>>;
  }

  async getLabel(id: string): Promise<string | undefined> {
    return this.labelsById.get(id);
  }

  async getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]> {
    if (leafId === null) return [];
    const path: SessionTreeEntry[] = [];
    let current = this.byId.get(leafId);
    if (!current) throw new SessionError("not_found", `Entry ${leafId} not found`);
    while (current) {
      path.unshift(current);
      if (!current.parentId) break;
      const parent = this.byId.get(current.parentId);
      if (!parent) throw new SessionError("invalid_session", `Entry ${current.parentId} not found`);
      current = parent;
    }
    return path;
  }

  async getEntries(): Promise<SessionTreeEntry[]> {
    return [...this.entries];
  }

  /** INSERT the entry (PK enforces intra-session id uniqueness — a
   *  duplicate rejects here BEFORE any in-memory mutation) then mirror it
   *  into the in-memory maps in append order. */
  private async persist(entry: SessionTreeEntry, ezMessageId: string | null = null): Promise<void> {
    await this.db.insert(agentSessionEntries).values(entryToRow(this.sessionRow.id, entry, ezMessageId));
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
  }

  /** Refresh the O(1) `leaf_entry_id` cache column. The authoritative
   *  leaf is always re-derivable by replaying entries on open; this is a
   *  convenience for future readers that don't want to load the tree. */
  private async writeLeafCache(): Promise<void> {
    await this.db.update(agentSessions).set({ leafEntryId: this.currentLeafId }).where(eq(agentSessions.id, this.sessionRow.id));
  }
}
