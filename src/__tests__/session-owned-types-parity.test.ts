/**
 * The repo-owned session types vs the pi-agent-core types they replaced.
 *
 * `src/db/session-storage.ts` used to import `SessionTreeEntry`,
 * `SessionEntryCursorOptions`, `SessionMetadata`, `SessionStats`,
 * `SessionStorage` and `SessionError` from `@earendil-works/pi-agent-core`,
 * and to declare `implements SessionStorage<DbSessionMetadata>`. Nothing
 * redeemed that promise — no production code constructs pi's `Session` — so
 * the storage shapes are now declared in the module that owns the table.
 *
 * Through 0.83 this suite asserted the two models were still mutually
 * assignable, so re-coupling stayed a one-line import. **pi-ai 0.84.0 ended
 * that**, and deliberately: pi redesigned its session model, so the suite
 * now pins the DIVERGENCE instead. The four deltas, each asserted below:
 *
 *  | shape             | pi 0.84                       | owned (this repo)          |
 *  |-------------------|-------------------------------|----------------------------|
 *  | `EntryBase.seq`   | required `number`             | absent (a DB column)       |
 *  | `EntryBase.timestamp` | `number`                  | `string`, ISO-8601 verbatim|
 *  | entry union       | 7 variants                    | 11 variants                |
 *  | compaction bound  | required `retainedTail`       | `firstKeptEntryId`         |
 *
 * That divergence is SAFE because nothing in `src/` constructs pi's
 * `Session` or calls its context builder, and it is LOAD-BEARING because
 * `timestamp` is the durable form of a TEXT column — adopting pi's `number`
 * would be a schema migration, not a type edit.
 *
 * Pinning it is the point: `NotAssignable` fails to compile the day pi's
 * shape drifts back toward ours (or further from it), so the next bump
 * reports the change instead of silently re-typing the storage layer.
 * The suite still proves, unchanged by 0.84:
 *  - the owned `SessionError` is observationally identical to pi's — same
 *    `name`, `message`, `code` strings and `Error` ancestry — including the
 *    `invalid_session` code pi drops after 0.83;
 *  - `DbSessionStorage`'s method surface is exactly the set the product
 *    calls, with the five interface-only methods gone and nothing else.
 *
 * The `assignable<T>()` helper is deliberately identity: the ASSERTION is
 * the type argument (checked by `bun run typecheck`), and the `expect` keeps
 * it a real, non-vacuous runtime test too.
 */
import { test, expect, describe } from "bun:test";
import type {
  AgentMessage,
  CompactionEntry as PiCompactionEntry,
  Entry as PiEntry,
  SessionMetadata as PiSessionMetadata,
} from "@earendil-works/pi-agent-core";
import {
  SessionError,
  entryToRow,
  leafIdAfterEntry,
  rowToEntry,
  DbSessionStorage,
  type CompactionEntry,
  type DbSessionMetadata,
  type SessionEntryCursorOptions,
  type SessionTreeEntry,
} from "../db/session-storage";

/** Identity at run time; an assignability assertion at compile time. */
function assignable<T>(value: T): T {
  return value;
}

/**
 * Compile-time `true` ONLY while `A` is not assignable to `B`.
 *
 * The inverse of {@link assignable}, and the reason this file still fails
 * loudly: each `const _x: NotAssignable<…> = true` below stops compiling the
 * moment the two shapes converge, which is exactly when a human needs to
 * re-decide whether to re-couple.
 */
type NotAssignable<A, B> = [A] extends [B] ? false : true;

function userMsg(content: string): AgentMessage {
  return { role: "user", content } as unknown as AgentMessage;
}

/** One value of every owned variant, keyed by its discriminant. */
const OWNED_ENTRIES = {
  message: { type: "message", id: "e1", parentId: null, timestamp: "t", message: userMsg("hi") },
  thinking_level_change: { type: "thinking_level_change", id: "e2", parentId: "e1", timestamp: "t", thinkingLevel: "high" },
  model_change: { type: "model_change", id: "e3", parentId: "e2", timestamp: "t", provider: "anthropic", modelId: "claude" },
  active_tools_change: { type: "active_tools_change", id: "e4", parentId: "e3", timestamp: "t", activeToolNames: ["bash"] },
  compaction: { type: "compaction", id: "e5", parentId: "e4", timestamp: "t", summary: "s", tokensBefore: 7 },
  branch_summary: { type: "branch_summary", id: "e6", parentId: "e5", timestamp: "t", fromId: "e1", summary: "s" },
  custom: { type: "custom", id: "e7", parentId: "e6", timestamp: "t", customType: "ezcorp:filtered-row", data: { a: 1 } },
  custom_message: { type: "custom_message", id: "e8", parentId: "e7", timestamp: "t", customType: "x", content: "c", display: true },
  label: { type: "label", id: "e9", parentId: "e8", timestamp: "t", targetId: "e1", label: "L" },
  session_info: { type: "session_info", id: "e10", parentId: "e9", timestamp: "t", name: "n" },
  leaf: { type: "leaf", id: "e11", parentId: "e10", timestamp: "t", targetId: "e1" },
} as const satisfies Record<string, SessionTreeEntry>;

describe("owned session types — the divergence from pi, pinned", () => {
  // ── Compile-time half. Each `= true` stops compiling if pi's shape
  //    converges back on ours; `bun run typecheck` is the gate.
  const _ownedIsNotPiEntry: NotAssignable<SessionTreeEntry, PiEntry> = true;
  const _piEntryIsNotOwned: NotAssignable<PiEntry, SessionTreeEntry> = true;
  const _metaIsNotPiMeta: NotAssignable<DbSessionMetadata, PiSessionMetadata> = true;
  const _compactionIsNotPis: NotAssignable<CompactionEntry, PiCompactionEntry> = true;

  test("the owned union and pi's Entry are mutually unassignable", () => {
    // Non-vacuous at run time too: the four flags above are real values.
    expect([_ownedIsNotPiEntry, _piEntryIsNotOwned, _metaIsNotPiMeta, _compactionIsNotPis]).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  test("`NotAssignable` DOES resolve false for a shape against itself", () => {
    // Guards the guard: proves the four assertions above can fail, so a pi
    // release that re-converged on our shapes could not pass silently.
    const selfIsAssignable: NotAssignable<SessionTreeEntry, SessionTreeEntry> = false;
    expect(selfIsAssignable).toBe(false);
  });

  test("the owned union still carries all 11 variants, 4 of which pi has no name for", () => {
    expect(Object.keys(OWNED_ENTRIES)).toHaveLength(11);
    // pi 0.84's `Entry` is these 7 …
    const shared = ["message", "model_change", "thinking_level_change", "active_tools_change", "compaction", "branch_summary", "custom"];
    // … and these 4 are EZCorp-only. `rowToEntry` reconstructs whatever the
    // table holds, so dropping one would silently change what a stored tree
    // reads back as.
    const ezcorpOnly = ["custom_message", "label", "session_info", "leaf"];
    expect(Object.keys(OWNED_ENTRIES).sort()).toEqual([...shared, ...ezcorpOnly].sort());
    for (const [type, entry] of Object.entries(OWNED_ENTRIES)) {
      expect((entry as SessionTreeEntry).type as string).toBe(type);
    }
  });

  test("every owned entry keeps a STRING timestamp and no `seq` — the DB contract pi left", () => {
    // pi 0.84's `EntryBase` requires `seq: number` and `timestamp: number`.
    // Ours stores `timestamp` verbatim in a TEXT column and keeps `seq` as a
    // table column, off the entry. This is the delta that would cost a
    // migration, so it is asserted on real values, not just in the types.
    for (const entry of Object.values(OWNED_ENTRIES)) {
      expect(typeof (entry as SessionTreeEntry).timestamp).toBe("string");
      expect(entry).not.toHaveProperty("seq");
    }
  });

  test("compaction is bounded by firstKeptEntryId, not pi's required retainedTail", () => {
    // `getPathToRootOrCompaction` reads `firstKeptEntryId`; pi 0.84 removed
    // that field and made `retainedTail` required, spreading it unguarded.
    const compaction: CompactionEntry = {
      type: "compaction",
      id: "c1",
      parentId: "e1",
      timestamp: "2026-01-01T00:00:00.000Z",
      summary: "s",
      tokensBefore: 7,
      firstKeptEntryId: "e1",
    };
    expect(compaction.firstKeptEntryId).toBe("e1");
    // Optional here, required there — the reason pi's builder throws on ours.
    expect(compaction.retainedTail).toBeUndefined();
  });

  test("the cursor options are owned outright — pi no longer exports the type", () => {
    // `SessionEntryCursorOptions` was removed from pi's public surface in
    // 0.84; the shape below is now defined solely by `session-storage.ts`.
    const cursor: SessionEntryCursorOptions = { afterEntrySeq: 2, limit: 3 };
    expect(assignable<SessionEntryCursorOptions>(cursor)).toEqual({ afterEntrySeq: 2, limit: 3 });
    // Metadata keeps its ISO-8601 string; pi's `createdAt` is now a number.
    const meta: DbSessionMetadata = { id: "s1", createdAt: "2026-01-01T00:00:00.000Z", cwd: "/repo" };
    expect(typeof meta.createdAt).toBe("string");
    expect(meta.id).toBe("s1");
  });

  test("the pure helpers accept and return owned entries unchanged", () => {
    const entry = OWNED_ENTRIES.message;
    expect(leafIdAfterEntry(entry)).toBe("e1");
    expect(leafIdAfterEntry(OWNED_ENTRIES.leaf)).toBe("e1");
    const row = entryToRow("sess", entry, "ez1");
    expect(row).toMatchObject({ sessionId: "sess", entryId: "e1", type: "message", ezMessageId: "ez1" });
    expect(
      rowToEntry({
        type: row.type,
        entryId: row.entryId,
        parentId: row.parentId ?? null,
        timestamp: row.timestamp,
        payload: row.payload as Record<string, unknown>,
      }),
    ).toEqual(entry);
  });
});

describe("owned SessionError — observationally identical to pi's", () => {
  test("carries pi's name, message and Error ancestry", () => {
    const err = new SessionError("not_found", "Entry x not found");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SessionError");
    expect(err.message).toBe("Entry x not found");
    expect(err.code).toBe("not_found");
    expect(String(err)).toBe("SessionError: Entry x not found");
  });

  test("keeps `invalid_session`, the code pi drops after 0.83", () => {
    // Three throw sites in session-storage.ts classify a structurally broken
    // tree this way. Owning the type is what stops a pi bump from silently
    // reclassifying them.
    const err = new SessionError("invalid_session", "Entry y not found");
    expect(err.code).toBe("invalid_session");
  });

  test("threads an optional cause, exactly as pi's constructor did", () => {
    const cause = new Error("root cause");
    expect(new SessionError("not_found", "wrapped", cause).cause).toBe(cause);
    expect(new SessionError("not_found", "bare").cause).toBeUndefined();
  });
});

describe("DbSessionStorage — the surface after dropping the interface", () => {
  /** Every own prototype method, including the two TS-private ones (which
   *  are private only to the compiler). */
  const methods = Object.getOwnPropertyNames(DbSessionStorage.prototype)
    .filter((name) => name !== "constructor")
    .sort();

  test("is exactly the set the product calls, plus its two private writers", () => {
    expect(methods).toEqual([
      "appendEntry",
      "createEntryId",
      "getEntries",
      "getLeafId",
      "getMetadata",
      "getPathToRootOrCompaction",
      "persist",
      "reparentEntry",
      "setLeafId",
      "writeLeafCache",
    ]);
    expect(typeof DbSessionStorage.create).toBe("function");
    expect(typeof DbSessionStorage.open).toBe("function");
  });

  test("the five interface-only methods are gone", () => {
    // Each existed solely to satisfy pi's `SessionStorage`; a repo-wide grep
    // found callers only in this suite's predecessor.
    for (const name of ["getEntry", "findEntries", "getLabel", "getSessionName", "getSessionStats"]) {
      expect(methods).not.toContain(name);
    }
  });
});
