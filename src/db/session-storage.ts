import { and, eq } from "drizzle-orm";
import { uuidv7 } from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent, Usage } from "@earendil-works/pi-ai";
import { getDb } from "./connection";
import {
  agentSessionEntries,
  agentSessions,
  type AgentSessionEntryRow,
  type AgentSessionRow,
  type NewAgentSessionEntryRow,
} from "./schema";

/**
 * DbSessionStorage — the session tree on Postgres/PGlite, originally ported
 * from pi-agent-core's `JsonlSessionStorage` / `InMemorySessionStorage`.
 *
 * WHY THE TYPES BELOW ARE REPO-OWNED. This class used to declare
 * `implements SessionStorage<DbSessionMetadata>` and import its entry/cursor
 * /metadata types straight out of `@earendil-works/pi-agent-core`. Nothing
 * ever redeemed that promise: no production code constructs pi's `Session`,
 * or hands a `DbSessionStorage` to anything inside pi. All it bought was a
 * hard coupling — any pi release that touches the storage interface (adds a
 * method, narrows an error code) turns into a Postgres migration for us,
 * for a contract with no consumer. So the shapes the TABLE stores are now
 * declared here, in the module that owns the table.
 *
 * What is still pi's, deliberately:
 *  - `AgentMessage` — the ENGINE-side message a `message` entry carries.
 *    It is what the runtime actually feeds pi-ai; re-declaring it would be
 *    forking the engine contract, not decoupling from it.
 *  - `uuidv7` — pi's id generator, so entry ids stay byte-identical to the
 *    ones already in the table.
 *  - `Usage` / `TextContent` / `ImageContent` from `@earendil-works/pi-ai`,
 *    for the same reason: they are provider-response shapes, not storage
 *    shapes.
 *
 * Port fidelity (see node_modules/@earendil-works/pi-agent-core/dist/
 * harness/session/{jsonl-storage,memory-storage}.js):
 *  - On `open()` we `SELECT ... ORDER BY seq` and rebuild the exact same
 *    in-memory `byId` / `currentLeafId` state the JSONL impl holds. Reads
 *    are served entirely from memory; only `appendEntry` / `setLeafId`
 *    touch the DB (one INSERT + a `leaf_entry_id` cache UPDATE).
 *  - The leaf is AUTHORITATIVELY recovered by replaying every entry in
 *    insertion (`seq`) order through the leaf rule — entry ids are 8-char
 *    uuidv7 slices and NOT monotonic, so tree order ≠ insertion order.
 *  - `timestamp` is stored VERBATIM (TEXT column) so the ISO string
 *    round-trips byte-for-byte.
 *  - Every jsonb payload is written via a column-mapped drizzle insert,
 *    never `${JSON.stringify(x)}::jsonb` — that double-encodes under the
 *    Bun.sql driver (see src/db/connection.ts's mapToDriverValue swap).
 *  - The PK is `(session_id, entry_id)`: forked entries reuse their
 *    source ids across sessions, so ids are unique only WITHIN a
 *    session. A duplicate append within one session hits the PK and
 *    rejects — the DB-level analog of the JSONL impl's id-uniqueness.
 */

// ── The session-tree data model (repo-owned) ────────────────────────
// A structural port of the entry union `agent_session_entries` already
// stores. Every member is declared even though EZCorp's own producer emits
// only `message` / `custom` / `branch_summary` / `leaf`: the table is the
// durable form of the whole tree, and `rowToEntry` reconstructs whatever is
// in it. Types only — these erase at build time and cost nothing at runtime.

/** Columns every entry carries; the rest of an entry is its jsonb payload. */
export interface SessionTreeEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  /** ISO-8601, stored verbatim in a TEXT column. */
  timestamp: string;
}

/** An LLM-visible turn. `message` is the engine-side payload, unmodified. */
export interface MessageEntry extends SessionTreeEntryBase {
  type: "message";
  message: AgentMessage;
}

export interface ThinkingLevelChangeEntry extends SessionTreeEntryBase {
  type: "thinking_level_change";
  thinkingLevel: string;
}

export interface ModelChangeEntry extends SessionTreeEntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}

export interface ActiveToolsChangeEntry extends SessionTreeEntryBase {
  type: "active_tools_change";
  activeToolNames: string[];
}

/** A summarized prefix. `firstKeptEntryId` / `retainedTail` bound how far
 *  back {@link DbSessionStorage.getPathToRootOrCompaction} walks. */
export interface CompactionEntry extends SessionTreeEntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId?: string;
  tokensBefore: number;
  retainedTail?: AgentMessage[];
  details?: unknown;
  usage?: Usage;
  fromHook?: boolean;
}

/** The record a rewind leaves behind for the branch it abandoned. */
export interface BranchSummaryEntry extends SessionTreeEntryBase {
  type: "branch_summary";
  fromId: string;
  summary: string;
  details?: unknown;
  usage?: Usage;
  fromHook?: boolean;
}

/** A non-emitting node that keeps the parent chain whole — how the backfill
 *  preserves `excluded` / synthetic-role rows (`ezcorp:filtered-row`). */
export interface CustomEntry extends SessionTreeEntryBase {
  type: "custom";
  customType: string;
  data?: unknown;
}

export interface CustomMessageEntry extends SessionTreeEntryBase {
  type: "custom_message";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  details?: unknown;
  display: boolean;
}

export interface LabelEntry extends SessionTreeEntryBase {
  type: "label";
  targetId: string;
  label: string | undefined;
}

export interface SessionInfoEntry extends SessionTreeEntryBase {
  type: "session_info";
  name?: string;
}

/** A POINTER that moves the active leaf — how a rewind is recorded, so no
 *  existing entry's `parentId` is ever rewritten by one. */
export interface LeafEntry extends SessionTreeEntryBase {
  type: "leaf";
  targetId: string | null;
}

/** One row of `agent_session_entries`, reconstructed. */
export type SessionTreeEntry =
  | MessageEntry
  | ThinkingLevelChangeEntry
  | ModelChangeEntry
  | ActiveToolsChangeEntry
  | CompactionEntry
  | BranchSummaryEntry
  | CustomEntry
  | CustomMessageEntry
  | LabelEntry
  | SessionInfoEntry
  | LeafEntry;

/** Window over the INSERTION axis for {@link DbSessionStorage.getEntries}.
 *  `afterEntrySeq` is a POSITION in this session's entry list, not the
 *  table's global `seq` column — see `getEntries`. */
export interface SessionEntryCursorOptions {
  afterEntrySeq?: number;
  limit?: number;
}

/** Failure classes {@link DbSessionStorage} raises. `invalid_session` means
 *  the persisted tree is internally inconsistent (a leaf or parent pointer
 *  with no entry behind it) as opposed to a caller naming something that
 *  isn't there (`not_found`) — a distinction this module has always drawn
 *  and that pi-agent-core drops after 0.83. */
export type SessionErrorCode = "not_found" | "invalid_session";

/**
 * Error thrown by {@link DbSessionStorage}.
 *
 * Repo-owned rather than pi's `SessionError` because the two codes above are
 * OUR taxonomy: pi 0.84 removes `invalid_session` from its union, which would
 * silently reclassify three throw sites here on the next bump. Same `name`,
 * same message, same `code` strings as before, so nothing observable moved —
 * and nothing in the repo does `instanceof SessionError` or reads `.code`.
 */
export class SessionError extends Error {
  /** Session subsystem error code. */
  readonly code: SessionErrorCode;
  constructor(code: SessionErrorCode, message: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SessionError";
    this.code = code;
  }
}

/** Metadata surfaced by {@link DbSessionStorage} — the `agent_sessions` row's
 *  identity plus the fork lineage / cwd / conversation link it persists. */
export interface DbSessionMetadata {
  id: string;
  /** ISO-8601 form of the row's `created_at`. */
  createdAt: string;
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
// Kept byte-faithful to jsonl-storage.js so an entry written by either
// implementation replays to the same tree. Exported so they can be
// unit-tested in isolation.

/** Port of jsonl-storage.js `leafIdAfterEntry`: a `leaf` entry is a
 *  POINTER that moves the leaf to `targetId`; every other entry advances
 *  the leaf to its own id. */
export function leafIdAfterEntry(entry: SessionTreeEntry): string | null {
  return entry.type === "leaf" ? entry.targetId : entry.id;
}

/** Port of jsonl-storage.js `generateEntryId`: an 8-char slice of the
 *  uuidv7 RANDOM TAIL (the timestamp prefix is near-constant between
 *  calls), retried on collision, with a full uuidv7 as the
 *  after-100-tries fallback. `gen` is a testability seam only — the
 *  default is pi's exact `uuidv7`, so ids stay byte-identical to the ones
 *  already in the table. */
export function generateEntryId(byId: Map<string, SessionTreeEntry>, gen: () => string = uuidv7): string {
  for (let i = 0; i < 100; i++) {
    const id = gen().slice(-8);
    if (!byId.has(id)) return id;
  }
  return gen();
}

/** Decompose an entry into its `agent_session_entries` row: the base fields
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

/** Reconstruct an entry from a row: base columns + spread payload. The
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

/**
 * The session tree on `agent_sessions` + `agent_session_entries`.
 *
 * The surface is exactly what this repo calls: the two constructors, the
 * metadata/leaf accessors, the append + reparent writes, and the two read
 * axes (`getEntries` = insertion order, `getPathToRootOrCompaction` = tree
 * order). It is not an implementation of any third-party interface, so a
 * method exists here only because something calls it.
 */
export class DbSessionStorage {
  private constructor(
    private readonly db: Db,
    private readonly sessionRow: AgentSessionRow,
    private readonly entries: SessionTreeEntry[],
    private readonly byId: Map<string, SessionTreeEntry>,
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
      metadata: asJsonbObject(options.metadata),
      createdAt: new Date(),
    };
    await db.insert(agentSessions).values(row);
    return new DbSessionStorage(db, row, [], new Map(), null);
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
    let currentLeafId: string | null = null;
    for (const entry of entries) currentLeafId = leafIdAfterEntry(entry);
    if (currentLeafId !== null && !byId.has(currentLeafId)) {
      throw new SessionError("invalid_session", `Entry ${currentLeafId} not found`);
    }
    return new DbSessionStorage(db, sessionRow, entries, byId, currentLeafId);
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
    this.currentLeafId = leafIdAfterEntry(entry);
    await this.writeLeafCache();
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
      .where(and(eq(agentSessionEntries.sessionId, this.sessionRow.id), eq(agentSessionEntries.entryId, entryId)));
  }

  /**
   * Port of memory-storage.js `getPathToRootOrCompaction` (pi-agent-core
   * 0.83.0 renamed `getPathToRoot` to this and gave it the compaction stop).
   *
   * Walks leaf → root and STOPS EARLY at a compaction boundary: a compaction
   * with a `retainedTail` ends the walk at itself, otherwise the walk
   * continues only as far back as its `firstKeptEntryId`. Everything older
   * was summarized into the compaction entry, so re-walking it would hand a
   * context builder a prefix it drops anyway.
   *
   * NOT a behaviour change for EZCorp's own reads: `session-sync.ts` is the
   * only producer and appends `message` / `custom` / `branch_summary` only —
   * never `compaction` — so no stored EZCorp tree can take the early exit and
   * `computeSessionBranch` walks exactly the entries it walked before. The
   * compaction arm stays because the COLUMN can hold a compaction entry: a
   * tree written by anything that compacts must still replay correctly.
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
   * the optional cursor window applied as `slice(start, start + limit)`.
   *
   * `afterEntrySeq` is a POSITION in this session's entry list, exactly as in
   * the two implementations this was ported from — it is NOT this table's
   * `seq` column. `agent_session_entries.seq` is a `bigserial` shared across
   * every session, so it is gappy per session and would make a cursor
   * meaningless as an index. The in-memory `entries` array is already ordered
   * by that column, so position N here is the Nth entry of THIS session.
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
