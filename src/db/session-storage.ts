import { and, eq } from "drizzle-orm";
import { SessionError, uuidv7 } from "@earendil-works/pi-agent-core";
import type {
  SessionEntryCursorOptions,
  SessionMetadata,
  SessionStats,
  SessionStorage,
  SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
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
export function generateEntryId(
  byId: Map<string, SessionTreeEntry>,
  gen: () => string = uuidv7,
): string {
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
  // biome-ignore format: kept on one line because bun's coverage emitter puts a zero-hit DA record on the continuation line of a split `as` TYPE, which no test can ever reach — splitting this drops the file below its 100% threshold for a purely cosmetic reason.
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

/**
 * Coerce an arbitrary value to a jsonb-safe object-or-null.
 *
 * The `agent_sessions.metadata` column is `jsonb`, which rejects a bare
 * string (e.g. `""`). The old `options.metadata ?? null` idiom only guarded
 * `null`/`undefined`, so a caller passing `metadata: ""` wrote an invalid
 * value straight into the column — Postgres/PGlite then rejected it on the
 * next read, surfacing as "Failed query" and 500-ing
 * `GET /api/conversations/[id]/tree`. Only a plain object survives here;
 * anything else (string, array, number, null, undefined) becomes `null`.
 */
export function asJsonbObject(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

// ── Ports of pi's private getSessionStats accumulator ───────────────
// Split out of the loop (and exported) so each guard is unit-testable and
// so no single expression spans lines a short-circuit can leave un-hit.

/** The four token counters `getSessionStats` sums. Named once — the guard
 *  below and the arithmetic must never disagree about the field set. */
const USAGE_TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;

/**
 * Port of memory-storage.js's inline `usage` guard: a usage blob counts only
 * when all four token fields AND `cost.total` are numbers. Same accept/reject
 * set as pi's, just hoisted. This is NOT belt-and-braces — the payload is
 * jsonb written by whatever produced the entry, so a partial usage object is
 * representable and would otherwise poison the totals with NaN.
 */
export function completeUsage(usage: Usage | undefined): Usage | undefined {
  if (!usage) return undefined;
  if (USAGE_TOKEN_FIELDS.some((field) => typeof usage[field] !== "number")) return undefined;
  return typeof usage.cost?.total === "number" ? usage : undefined;
}

/** Port of memory-storage.js's inline usage selector: assistant messages
 *  carry usage directly; compaction / branch_summary carry it on the entry;
 *  everything else (user turns, leaf pointers, labels, …) has none. */
export function entryUsage(entry: SessionTreeEntry): Usage | undefined {
  if (entry.type === "compaction" || entry.type === "branch_summary") return entry.usage;
  if (entry.type !== "message") return undefined;
  return entry.message.role === "assistant" ? entry.message.usage : undefined;
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
  static async create(
    options: DbSessionCreateOptions = {},
    db: Db = getDb(),
  ): Promise<DbSessionStorage> {
    const row: AgentSessionRow = {
      id: options.id ?? crypto.randomUUID(),
      conversationId: options.conversationId ?? null,
      cwd: options.cwd ?? null,
      parentSessionId: options.parentSessionId ?? null,
      leafEntryId: null,
      metadata: asJsonbObject(options.metadata),
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
      // Defensive: coerce any legacy/invalid persisted value (e.g. a bare
      // string written before the create-path fix) back to a safe shape so
      // reads never propagate a non-object.
      metadata: asJsonbObject(this.sessionRow.metadata) ?? undefined,
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
   * `byId` and `entries`), so a subsequent {@link getPathToRootOrCompaction} walks the new
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
      .where(
        and(
          eq(agentSessionEntries.sessionId, this.sessionRow.id),
          eq(agentSessionEntries.entryId, entryId),
        ),
      );
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

  /** Port of memory-storage.js `getSessionName`: the LAST `session_info`
   *  entry's trimmed name, or undefined when unset/blank. Nothing in EZCorp
   *  writes `session_info` today (only `session-sync.ts` appends, and only
   *  `message`/`custom`/`branch_summary`), so this is undefined in practice —
   *  but pi's `Session.appendSessionName()` writes one, and the interface
   *  requires it. */
  async getSessionName(): Promise<string | undefined> {
    const infos = await this.findEntries("session_info");
    return infos[infos.length - 1]?.name?.trim() || undefined;
  }

  /** Port of memory-storage.js `getSessionStats`: token/cost totals summed
   *  over the INSERTION axis (every entry, not just the active branch — pi
   *  counts what the session cost, including abandoned tails). */
  async getSessionStats(): Promise<SessionStats> {
    const stats: SessionStats = {
      messageCount: 0,
      cachedTokens: 0,
      uncachedTokens: 0,
      totalTokens: 0,
      costTotal: 0,
    };
    for (const entry of this.entries) {
      if (entry.type === "message") stats.messageCount += 1;
      const usage = completeUsage(entryUsage(entry));
      if (!usage) continue;
      stats.cachedTokens += usage.cacheRead;
      stats.uncachedTokens += usage.input + usage.cacheWrite;
      stats.totalTokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
      stats.costTotal += usage.cost.total;
    }
    return stats;
  }

  /**
   * Port of memory-storage.js `getPathToRootOrCompaction` (pi-agent-core
   * 0.83.0 renamed `getPathToRoot` to this and gave it the compaction stop).
   *
   * Walks leaf → root and STOPS EARLY at a compaction boundary: a compaction
   * with a `retainedTail` ends the walk at itself, otherwise the walk
   * continues only as far back as its `firstKeptEntryId`. Everything older
   * was summarized into the compaction entry, so re-walking it would hand
   * `buildContextEntries` a prefix it drops anyway.
   *
   * NOT a behaviour change for EZCorp's own reads: `session-sync.ts` is the
   * only producer and appends `message` / `custom` / `branch_summary` only —
   * never `compaction` — so no stored EZCorp tree can take the early exit and
   * `computeSessionBranch` walks exactly the entries it walked before. The
   * compaction arm is live only for trees driven through pi's `Session`
   * (`appendCompaction`), which is what `Session.getBranch()` now calls this
   * for.
   *
   * `parentMessageId` is NOT touched here — this is a pure read. The one
   * sanctioned tree mutation stays {@link reparentEntry}.
   */
  async getPathToRootOrCompaction(leafId: string | null): Promise<SessionTreeEntry[]> {
    if (leafId === null) return [];
    const path: SessionTreeEntry[] = [];
    let stopAtEntryId: string | null = null;
    let current = this.byId.get(leafId);
    if (!current) throw new SessionError("not_found", `Entry ${leafId} not found`);
    while (current) {
      path.unshift(current);
      if (stopAtEntryId !== null && current.id === stopAtEntryId) break;
      if (current.type === "compaction") {
        if (current.retainedTail) break;
        stopAtEntryId = current.firstKeptEntryId ?? null;
      }
      if (!current.parentId) break;
      const parent = this.byId.get(current.parentId);
      if (!parent) throw new SessionError("invalid_session", `Entry ${current.parentId} not found`);
      current = parent;
    }
    return path;
  }

  /**
   * Port of memory-storage.js `getEntries`: the insertion (`seq`) axis, with
   * pi's optional cursor window applied as `slice(start, start + limit)`.
   *
   * `afterEntrySeq` is a POSITION in this session's entry list, exactly as in
   * pi's own two implementations — it is NOT this table's `seq` column.
   * `agent_session_entries.seq` is a `bigserial` shared across every session,
   * so it is gappy per session and would make a cursor meaningless as an
   * index. The in-memory `entries` array is already ordered by that column, so
   * position N here is the Nth entry of THIS session, which is what pi means.
   */
  async getEntries(options?: SessionEntryCursorOptions): Promise<SessionTreeEntry[]> {
    const start = options?.afterEntrySeq ?? 0;
    const end = options?.limit === undefined ? undefined : start + options.limit;
    return this.entries.slice(start, end);
  }

  /** INSERT the entry (PK enforces intra-session id uniqueness — a
   *  duplicate rejects here BEFORE any in-memory mutation) then mirror it
   *  into the in-memory maps in append order. */
  private async persist(entry: SessionTreeEntry, ezMessageId: string | null = null): Promise<void> {
    await this.db
      .insert(agentSessionEntries)
      .values(entryToRow(this.sessionRow.id, entry, ezMessageId));
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
  }

  /** Refresh the O(1) `leaf_entry_id` cache column. The authoritative
   *  leaf is always re-derivable by replaying entries on open; this is a
   *  convenience for future readers that don't want to load the tree. */
  private async writeLeafCache(): Promise<void> {
    await this.db
      .update(agentSessions)
      .set({ leafEntryId: this.currentLeafId })
      .where(eq(agentSessions.id, this.sessionRow.id));
  }
}
