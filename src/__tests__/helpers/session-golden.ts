/**
 * Golden-baseline capture for the session / chat-history surface.
 *
 * Seeds ONE fixed, fully deterministic conversation and dumps every
 * externally observable artefact the session layer produces from it:
 * the raw `agent_session_entries` rows, the `agent_sessions` row, the
 * durable leaf, `getPathToRootOrCompaction` walks, the producer branch,
 * the `/tree` view, the pi-shaped `loadHistory` output, and the state
 * after a rewind.
 *
 * The snapshot is compared against a committed JSON file by
 * `src/__tests__/session-golden-baseline.test.ts`, so a refactor that
 * claims to be behaviour-preserving has to reproduce it byte for byte.
 *
 * DETERMINISM. Three things in the real code are wall-clock or random and
 * therefore normalised rather than dropped (dropping them would stop
 * pinning their PRESENCE):
 *   - `agent_sessions.id` / `.createdAt`  → "<session-id>" / "<wall-clock>"
 *   - generated entry ids (`leaf`, `branch_summary` — 8-char uuidv7 tails)
 *     → "<gen-N>", numbered by first appearance in seq order, so their
 *     IDENTITY across parent links is still asserted.
 *   - timestamps that are not one of the fixture's message `createdAt`
 *     values → "<wall-clock>".
 *   - `agent_session_entries.seq` is a table-global bigserial, so the
 *     snapshot records the per-session RANK (which is what pi's
 *     `afterEntrySeq` cursor actually means) plus a boolean asserting the
 *     raw column is strictly increasing in that order.
 */

import { asc, eq } from "drizzle-orm";
import { getTestDb } from "./test-pglite";
import { agentSessionEntries, agentSessions, conversations, messages, projects } from "../../db/schema";
import { computeSessionBranch, computeSessionTree, rewindSession } from "../../db/session-sync";
import { DbSessionStorage } from "../../db/session-storage";
import { loadHistory } from "../../runtime/stream-chat/load-history";
import type { StreamChatContext } from "../../runtime/stream-chat/context";

/** Epoch anchor for every fixture row — a fixed instant, never `Date.now()`. */
export const GOLDEN_BASE_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
export const GOLDEN_PROJECT_ID = "golden-project";
export const GOLDEN_CONV_ID = "golden-conv";
export const GOLDEN_OTHER_CONV_ID = "golden-other-conv";

export interface GoldenSeedRow {
  id: string;
  role: string;
  content: string;
  parentId: string | null;
  excluded: boolean;
  /** Seconds from {@link GOLDEN_BASE_MS}; may be NEGATIVE on purpose. */
  offsetSec: number;
}

/**
 * The fixture conversation. Shaped to hit every branch of the session layer
 * in one tree:
 *
 *   m01 user ── m02 assistant ── m03 user ─┬─ m04 assistant   (durable leaf)
 *                                          └─ m05 assistant   (A/B sibling)
 *                                                └─ m06 capability-event
 *                                                      └─ m07 user
 *                                                            └─ m08 assistant EXCLUDED
 *                                                                  └─ m09 user
 *                                                                        └─ m10 user
 *   m11 user  (parent points into ANOTHER conversation → re-rooted to null)
 *
 * `m10` and `m11` carry NEGATIVE offsets, so `getMessages`' `createdAt ASC`
 * order hands the backfill a CHILD (m10) before its PARENT (m09). The final
 * tree must still link them: insertion order is not tree order.
 *
 * Leaf selection is deterministic: the childless rows are m04, m10, m11 and
 * `getLatestLeaf` orders `created_at DESC, id DESC`, so m04 (offset 3) wins.
 */
export const GOLDEN_ROWS: readonly GoldenSeedRow[] = [
  { id: "m01", role: "user", content: "hello", parentId: null, excluded: false, offsetSec: 0 },
  { id: "m02", role: "assistant", content: "hi there", parentId: "m01", excluded: false, offsetSec: 1 },
  { id: "m03", role: "user", content: "second question", parentId: "m02", excluded: false, offsetSec: 2 },
  { id: "m04", role: "assistant", content: "answer A", parentId: "m03", excluded: false, offsetSec: 3 },
  { id: "m05", role: "assistant", content: "answer B", parentId: "m03", excluded: false, offsetSec: 4 },
  { id: "m06", role: "capability-event", content: '{"kind":"cap"}', parentId: "m05", excluded: false, offsetSec: 5 },
  { id: "m07", role: "user", content: "third", parentId: "m06", excluded: false, offsetSec: 6 },
  { id: "m08", role: "assistant", content: "excluded reply", parentId: "m07", excluded: true, offsetSec: 7 },
  { id: "m09", role: "user", content: "after excluded", parentId: "m08", excluded: false, offsetSec: 8 },
  { id: "m10", role: "user", content: "child seeded before its parent", parentId: "m09", excluded: false, offsetSec: -5 },
  { id: "m11", role: "user", content: "cross-conversation parent", parentId: "x01", excluded: false, offsetSec: -6 },
];

/** The single row of the OTHER conversation that `m11` illegally points at. */
export const GOLDEN_FOREIGN_ROW: GoldenSeedRow = {
  id: "x01", role: "user", content: "foreign root", parentId: null, excluded: false, offsetSec: -100,
};

export function goldenDate(offsetSec: number): Date {
  return new Date(GOLDEN_BASE_MS + offsetSec * 1000);
}

/** Insert the fixture. Idempotent per fresh test DB; call once. */
export async function seedGoldenConversation(): Promise<void> {
  const db = getTestDb();
  await db.insert(projects).values({ id: GOLDEN_PROJECT_ID, name: "Golden", path: "/tmp/golden" });
  await db.insert(conversations).values({ id: GOLDEN_OTHER_CONV_ID, projectId: GOLDEN_PROJECT_ID, title: "Other" });
  await db.insert(conversations).values({ id: GOLDEN_CONV_ID, projectId: GOLDEN_PROJECT_ID, title: "Golden" });
  await db.insert(messages).values({
    id: GOLDEN_FOREIGN_ROW.id,
    conversationId: GOLDEN_OTHER_CONV_ID,
    role: GOLDEN_FOREIGN_ROW.role,
    content: GOLDEN_FOREIGN_ROW.content,
    parentMessageId: null,
    excluded: false,
    createdAt: goldenDate(GOLDEN_FOREIGN_ROW.offsetSec),
  });
  for (const row of GOLDEN_ROWS) {
    await db.insert(messages).values({
      id: row.id,
      conversationId: GOLDEN_CONV_ID,
      role: row.role,
      content: row.content,
      parentMessageId: row.parentId,
      excluded: row.excluded,
      createdAt: goldenDate(row.offsetSec),
    });
  }
}

// ── normalisation ───────────────────────────────────────────────────

const KNOWN_ROW_IDS: ReadonlySet<string> = new Set([...GOLDEN_ROWS.map((r) => r.id), GOLDEN_FOREIGN_ROW.id]);
const KNOWN_TIMESTAMPS: ReadonlySet<string> = new Set(
  [...GOLDEN_ROWS, GOLDEN_FOREIGN_ROW].map((r) => goldenDate(r.offsetSec).toISOString()),
);

/** Stable placeholder allocator for the ids/timestamps the code generates. */
class Normalizer {
  private readonly gen = new Map<string, string>();

  id(value: string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    if (KNOWN_ROW_IDS.has(value)) return value;
    const seen = this.gen.get(value);
    if (seen) return seen;
    const placeholder = `<gen-${this.gen.size + 1}>`;
    this.gen.set(value, placeholder);
    return placeholder;
  }

  timestamp(value: string): string {
    return KNOWN_TIMESTAMPS.has(value) ? value : "<wall-clock>";
  }
}

/** Recursively replace any `timestamp: <number>` that is not a fixture
 *  `createdAt` epoch-ms (loadHistory stamps `Date.now()` at map time). */
const KNOWN_EPOCH_MS: ReadonlySet<number> = new Set(
  [...GOLDEN_ROWS, GOLDEN_FOREIGN_ROW].map((r) => goldenDate(r.offsetSec).getTime()),
);

function normalizeEpochTimestamps(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeEpochTimestamps);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = k === "timestamp" && typeof v === "number" && !KNOWN_EPOCH_MS.has(v)
        ? "<wall-clock-ms>"
        : normalizeEpochTimestamps(v);
    }
    return out;
  }
  return value;
}

// ── capture ─────────────────────────────────────────────────────────

interface EntryRowSnapshot {
  rank: number;
  entryId: string | null;
  type: string;
  parentId: string | null;
  timestamp: string;
  ezMessageId: string | null;
  payload: unknown;
}

async function dumpEntryRows(norm: Normalizer): Promise<{ rows: EntryRowSnapshot[]; seqStrictlyIncreasing: boolean }> {
  const raw = await getTestDb()
    .select()
    .from(agentSessionEntries)
    .orderBy(asc(agentSessionEntries.seq));
  let increasing = true;
  for (let i = 1; i < raw.length; i++) {
    if (!(BigInt(raw[i]!.seq) > BigInt(raw[i - 1]!.seq))) increasing = false;
  }
  return {
    seqStrictlyIncreasing: increasing,
    rows: raw.map((r, i) => ({
      rank: i,
      entryId: norm.id(r.entryId),
      type: r.type,
      parentId: norm.id(r.parentId),
      timestamp: norm.timestamp(r.timestamp),
      ezMessageId: norm.id(r.ezMessageId),
      payload: r.payload,
    })),
  };
}

function mkCtx(): StreamChatContext {
  return { system: undefined } as unknown as StreamChatContext;
}

/** Everything a `/api/*` client or the LLM can observe, for one conversation. */
export interface GoldenSnapshot {
  version: number;
  fixture: { conversationId: string; rows: readonly GoldenSeedRow[]; foreignRow: GoldenSeedRow };
  sessionRow: Record<string, unknown>;
  entries: { rows: EntryRowSnapshot[]; seqStrictlyIncreasing: boolean };
  leafId: string | null;
  pathToRoot: Record<string, (string | null)[]>;
  entriesCursorWindows: Record<string, (string | null)[]>;
  sessionStats: unknown;
  sessionName: string | undefined;
  tree: unknown;
  branches: Record<string, unknown>;
  loadHistory: Record<string, unknown>;
  afterRewind: {
    outcome: unknown;
    entries: { rows: EntryRowSnapshot[]; seqStrictlyIncreasing: boolean };
    leafId: string | null;
    sessionRow: Record<string, unknown>;
    messageParentsUnchanged: boolean;
  };
}

/**
 * Seed + drive the whole surface and return the normalised snapshot.
 * The DB must be freshly migrated and EMPTY (one `setupTestDb()` per call).
 */
export async function captureGoldenSnapshot(): Promise<GoldenSnapshot> {
  await seedGoldenConversation();

  // First observable use — backfills the tree, then syncs it.
  const tree = await computeSessionTree(GOLDEN_CONV_ID);

  const norm = new Normalizer();
  const entries = await dumpEntryRows(norm);

  const [sessionRowRaw] = await getTestDb()
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.conversationId, GOLDEN_CONV_ID));
  const sessionId = sessionRowRaw!.id;
  const sessionRow = {
    id: "<session-id>",
    conversationId: sessionRowRaw!.conversationId,
    cwd: sessionRowRaw!.cwd,
    parentSessionId: sessionRowRaw!.parentSessionId,
    leafEntryId: norm.id(sessionRowRaw!.leafEntryId),
    metadata: sessionRowRaw!.metadata,
    createdAt: "<wall-clock>",
  };

  const storage = await DbSessionStorage.open(sessionId);
  const leafId = norm.id(await storage.getLeafId());

  const pathToRoot: Record<string, (string | null)[]> = {};
  for (const from of ["m04", "m10", "m11", "m08"]) {
    pathToRoot[from] = (await storage.getPathToRootOrCompaction(from)).map((e) => norm.id(e.id));
  }
  pathToRoot["null"] = (await storage.getPathToRootOrCompaction(null)).map((e) => norm.id(e.id));

  const entriesCursorWindows: Record<string, (string | null)[]> = {
    "limit=3": (await storage.getEntries({ limit: 3 })).map((e) => norm.id(e.id)),
    "afterEntrySeq=2,limit=2": (await storage.getEntries({ afterEntrySeq: 2, limit: 2 })).map((e) => norm.id(e.id)),
    "afterEntrySeq=99": (await storage.getEntries({ afterEntrySeq: 99 })).map((e) => norm.id(e.id)),
  };

  const branches: Record<string, unknown> = {
    default: await computeSessionBranch(GOLDEN_CONV_ID, undefined),
    "parent=m10": await computeSessionBranch(GOLDEN_CONV_ID, "m10"),
    "parent=m04": await computeSessionBranch(GOLDEN_CONV_ID, "m04"),
    "parent=m11": await computeSessionBranch(GOLDEN_CONV_ID, "m11"),
  };

  const history: Record<string, unknown> = {
    default: normalizeEpochTimestamps((await loadHistory(mkCtx(), GOLDEN_CONV_ID, {})).history),
    "parent=m10": normalizeEpochTimestamps(
      (await loadHistory(mkCtx(), GOLDEN_CONV_ID, { parentMessageId: "m10" })).history,
    ),
  };

  // Rewind LAST — it mutates the tree.
  const parentsBefore = new Map(
    entries.rows.filter((r) => r.type === "message").map((r) => [r.entryId, r.parentId] as const),
  );
  const outcome = await rewindSession(GOLDEN_CONV_ID, "m03", "abandoning branch B");
  const rewindNorm = new Normalizer();
  const entriesAfter = await dumpEntryRows(rewindNorm);
  const messageParentsUnchanged = entriesAfter.rows
    .filter((r) => r.type === "message")
    .every((r) => parentsBefore.get(r.entryId) === r.parentId);
  const storageAfter = await DbSessionStorage.open(sessionId);
  const [sessionRowAfter] = await getTestDb()
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.conversationId, GOLDEN_CONV_ID));

  return {
    version: 1,
    fixture: { conversationId: GOLDEN_CONV_ID, rows: GOLDEN_ROWS, foreignRow: GOLDEN_FOREIGN_ROW },
    sessionRow,
    entries,
    leafId,
    pathToRoot,
    entriesCursorWindows,
    sessionStats: await storage.getSessionStats(),
    sessionName: await storage.getSessionName(),
    tree: { ...tree, currentLeaf: norm.id(tree.currentLeaf) },
    branches,
    loadHistory: history,
    afterRewind: {
      outcome: outcome.ok ? { ok: true, tree: { ...outcome.tree, currentLeaf: rewindNorm.id(outcome.tree.currentLeaf) } } : outcome,
      entries: entriesAfter,
      leafId: rewindNorm.id(await storageAfter.getLeafId()),
      sessionRow: {
        leafEntryId: rewindNorm.id(sessionRowAfter!.leafEntryId),
        metadata: sessionRowAfter!.metadata,
      },
      messageParentsUnchanged,
    },
  };
}
